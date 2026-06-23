/**
 * Интеграционные тесты голосового ввода (STT, issue #118).
 *
 * Проверяем главное требование issue: если игрок присылает голосовое сообщение
 * И у него есть активная игра — речь распознаётся и распознанный текст
 * выполняется как игровое действие. Аудио нигде не сохраняется: буфер живёт
 * только в памяти и передаётся провайдеру STT.
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { VOICE_IN_PROGRESS_TEXT } from '../src/bot/progress.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { IMediaProvider } from '@tg-games/core/media/IMediaProvider.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import { mockActiveSchemasByType } from './fixtures/schemas.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as userMediaConfigRepo from '@tg-games/core/db/repositories/userMediaConfig.js';

// issue #238: бот исполняет ходы только через активные схемы — мокируем
// репозиторий схем (action повторяет прежний 5-фазный пайплайн).
const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

vi.mock('@tg-games/core/db/repositories/users.js', () => ({
  getUserByTelegramId: vi.fn(),
  setActiveSession: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/sessions.js', () => ({
  acquireProcessingLock: vi.fn().mockResolvedValue(true),
  addAllocatedMillicents: vi.fn().mockResolvedValue(undefined),
  addUsedCredits: vi.fn().mockResolvedValue(undefined),
  addTokenUsageAndCost: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn(),
  finishSession: vi.fn(),
  getActiveSession: vi.fn(),
  getSessionById: vi.fn(),
  listUserSessions: vi.fn(),
  releaseProcessingLock: vi.fn().mockResolvedValue(undefined),
  updateSessionState: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/steps.js', () => ({
  insertStep: vi.fn(),
  listSteps: vi.fn().mockResolvedValue([]),
  getStepWithOwner: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/payments.js', () => ({
  createPayment: vi.fn(),
  markPaymentPaid: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/userMediaConfig.js', () => ({
  getUserMediaConfig: vi.fn(),
  setUserImageModel: vi.fn(),
  setUserImageSize: vi.fn(),
  setUserTtsModel: vi.fn(),
  setUserTtsVoice: vi.fn(),
  userMediaConfigValues: vi.fn(() => null),
}));

// Аудит LLM не должен ходить в БД в тестах.
vi.mock('@tg-games/core/db/repositories/llmLogs.js', () => ({
  buildLlmRequestLogInputs: vi.fn(() => []),
  insertLlmRequestLogsSafely: vi.fn().mockResolvedValue(undefined),
}));

const config = {
  telegramBotToken: '000:test',
  llm: { provider: 'GOOGLE', apiKey: 'key', modelName: 'model', temperature: 0.5, maxRetries: 3 },
  db: { host: 'localhost', port: 5432, user: 'postgres', password: 'p', database: 'db' },
  millicentsPerStar: 200,
  support: {
    clientBotToken: '',
    adminBotToken: '',
    botUsername: '',
    adminIds: [],
    llmConsultation: true,
  },
  media: {
    provider: 'OPENAI',
    apiKey: 'media-key',
    tts: { enabled: true, model: 'gpt-4o-mini-tts', voice: 'alloy' },
    image: { enabled: true, model: 'gpt-image-1', size: '1024x1024' },
    stt: { enabled: true, model: 'whisper-1' },
  },
} as AppConfig;

const player = {
  id: 'user-1',
  telegram_id: '123',
  username: 'alice',
  active_session_id: 'sess-1',
  is_tester: false,
  created_at: new Date('2026-06-02T10:00:00Z'),
};

const session: SessionRow = {
  id: 'sess-1',
  game_id: 'bomj',
  user_id: player.id,
  is_active: true,
  is_processing: false,
  current_state: { ...buildInitialState(GAMES.bomj), turn_count: 2 },
  allocated_millicents: 200,
  used_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-06-02T10:01:00Z'),
};

const SCENE_TEXT = 'Вы свернули налево и нашли монету';

const step: StepRow = {
  id: 'step-77',
  session_id: session.id,
  action_text: 'иди налево',
  llm_raw_response: null,
  changes_summary: SCENE_TEXT,
  step_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-06-02T10:02:00Z'),
};

/** Фейковый медиа-провайдер с включённым распознаванием речи. */
function fakeMedia(over: Partial<IMediaProvider> = {}): IMediaProvider {
  return {
    name: 'Fake',
    canSpeak: true,
    canDraw: true,
    canTranscribe: true,
    generateSpeech: vi.fn(),
    generateImage: vi.fn(),
    transcribe: vi.fn(async () => ({ text: 'иди налево' })),
    ...over,
  };
}

/** Update с голосовым сообщением игрока. */
function voiceUpdate(mimeType = 'audio/ogg') {
  return {
    update_id: 1,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      voice: {
        file_id: 'voice-file-1',
        file_unique_id: 'u1',
        duration: 3,
        mime_type: mimeType,
      },
    },
  } as any;
}

function makeBot(media: IMediaProvider | null) {
  const provider: ILLMProvider = {
    name: 'mock',
    generateText: vi.fn(),
    generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
      // issue #238: совмещённый ответ удовлетворяет все типизированные узлы action-схемы.
      text: JSON.stringify({
        narrative: SCENE_TEXT,
        inventory: [],
        characteristics: {},
        world_flags: {},
        updated_state: { ...session.current_state, narrative: SCENE_TEXT },
      }),
      usage: { promptTokens: 80, completionTokens: 19, totalTokens: 99 },
    })),
  };
  const bot = createBot(config, provider, media);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' } as any;
  return bot;
}

/** Перехватывает callApi: getFile отдаёт путь к файлу, sendMessage — id. */
function spyCallApi() {
  return vi
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === 'getFile') {
        return { file_id: 'voice-file-1', file_path: 'voice/file_1.oga' };
      }
      if (method === 'sendMessage') return { message_id: 777, chat: { id: 123 } };
      return {};
    });
}

type CallApiSpy = ReturnType<typeof spyCallApi>;
function callsOf(spy: CallApiSpy, method: string) {
  return spy.mock.calls.filter(([m]) => m === method);
}

const AUDIO_BYTES = Buffer.from('ogg-voice-bytes');

beforeEach(() => {
  vi.clearAllMocks();
  schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
  mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
  vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
  vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
  vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
  vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue();
  vi.mocked(sessionsRepo.updateSessionState).mockResolvedValue();
  vi.mocked(stepsRepo.insertStep).mockResolvedValue(step);
  vi.mocked(stepsRepo.listSteps).mockResolvedValue([]);
  vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue(null);
  // Скачивание аудио из Telegram — отдаём байты, на диск ничего не пишем.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(AUDIO_BYTES, { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('голосовое сообщение → игровое действие (#118)', () => {
  it('распознаёт речь и выполняет распознанный текст как ход', async () => {
    const media = fakeMedia();
    spyCallApi();
    await makeBot(media).handleUpdate(voiceUpdate());

    // 1. Аудио скачано и передано провайдеру STT ровно теми же байтами.
    expect(media.transcribe).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(media.transcribe).mock.calls[0][0];
    expect(passed.audio).toEqual(AUDIO_BYTES);
    expect(passed.mimeType).toBe('audio/ogg');

    // 2. Распознанный текст выполнен как игровое действие (создан шаг).
    expect(stepsRepo.insertStep).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stepsRepo.insertStep).mock.calls[0][0]).toMatchObject({
      actionText: 'иди налево',
    });
    expect(sessionsRepo.updateSessionState).toHaveBeenCalledTimes(1);
  });

  it('показывает прогресс распознавания голосового', async () => {
    const media = fakeMedia();
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(voiceUpdate());

    const progress = callsOf(callApi, 'sendMessage').find(
      ([, p]) => (p as { text?: string }).text === VOICE_IN_PROGRESS_TEXT,
    );
    expect(progress).toBeTruthy();
  });

  it('не сохраняет аудио на диск (используется только сетевое скачивание в память)', async () => {
    const media = fakeMedia();
    spyCallApi();
    await makeBot(media).handleUpdate(voiceUpdate());

    // Единственный источник аудио — fetch по ссылке Telegram; буфер не пишется
    // на файловую систему (провайдер получает Buffer напрямую).
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(media.transcribe).mock.calls[0][0].audio).toBeInstanceOf(Buffer);
  });

  it('при пустом распознавании не выполняет ход и просит повторить', async () => {
    const media = fakeMedia({ transcribe: vi.fn(async () => ({ text: '   ' })) });
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(voiceUpdate());

    expect(stepsRepo.insertStep).not.toHaveBeenCalled();
    const editText = callsOf(callApi, 'editMessageText').find(([, p]) =>
      String((p as { text?: string }).text).includes('Не удалось распознать речь'),
    );
    expect(editText).toBeTruthy();
  });
});

describe('голосовое без активной игры / без STT (#118)', () => {
  it('без активной игры предлагает меню и не зовёт STT', async () => {
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(null);
    const media = fakeMedia();
    spyCallApi();
    await makeBot(media).handleUpdate(voiceUpdate());

    expect(media.transcribe).not.toHaveBeenCalled();
    expect(stepsRepo.insertStep).not.toHaveBeenCalled();
  });

  it('когда распознавание выключено у провайдера — просит написать текстом', async () => {
    const media = fakeMedia({ canTranscribe: false });
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(voiceUpdate());

    expect(media.transcribe).not.toHaveBeenCalled();
    const reply = callsOf(callApi, 'sendMessage').find(([, p]) =>
      String((p as { text?: string }).text).includes('Напишите действие текстом'),
    );
    expect(reply).toBeTruthy();
  });

  it('когда медиа-провайдера нет (media === null) — просит написать текстом', async () => {
    const callApi = spyCallApi();
    await makeBot(null).handleUpdate(voiceUpdate());

    const reply = callsOf(callApi, 'sendMessage').find(([, p]) =>
      String((p as { text?: string }).text).includes('Напишите действие текстом'),
    );
    expect(reply).toBeTruthy();
    expect(stepsRepo.insertStep).not.toHaveBeenCalled();
  });
});

describe('ошибка распознавания (#118)', () => {
  it('сообщает об ошибке и не выполняет ход', async () => {
    const media = fakeMedia({
      transcribe: vi.fn(async () => {
        throw new Error('STT упал');
      }),
    });
    const callApi = spyCallApi();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeBot(media).handleUpdate(voiceUpdate());

    expect(stepsRepo.insertStep).not.toHaveBeenCalled();
    const editText = callsOf(callApi, 'editMessageText').find(([, p]) =>
      String((p as { text?: string }).text).includes('Не удалось распознать голосовое'),
    );
    expect(editText).toBeTruthy();
  });
});
