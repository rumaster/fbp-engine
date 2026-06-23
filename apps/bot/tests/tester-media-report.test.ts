/**
 * Тесты отчёта тестировщику по медиа (issue #75).
 *
 * Требования issue:
 *  - когда тестировщику отправляется озвучка или иллюстрация, СЛЕДОМ приходит
 *    сообщение-отчёт;
 *  - если вызов API упал, отчёт всё равно приходит и содержит текст ошибки;
 *  - отчёт включает информацию о запросе, ответе, ошибке и расходе токенов.
 *
 * Проверяем как чистое форматирование (formatMediaTesterReport, утилиты trace),
 * так и интеграцию в обработчике медиа-колбэка бота.
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { formatMediaTesterReport } from '../src/bot/testerLog.js';
import { clipForReport, mediaErrorMessage, normalizeUsage } from '@tg-games/core/media/trace.js';
import { MediaGenerationError } from '@tg-games/core/media/IMediaProvider.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { IMediaProvider } from '@tg-games/core/media/IMediaProvider.js';
import type { StepRow, StepWithOwner } from '@tg-games/core/db/repositories/steps.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import { mockActiveSchemasByType } from './fixtures/schemas.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as userMediaConfigRepo from '@tg-games/core/db/repositories/userMediaConfig.js';

// issue #238: бот исполняет ходы/иллюстрации только через активные схемы —
// мокируем репозиторий схем (action повторяет прежний 5-фазный пайплайн).
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
  userMediaConfigValues: vi.fn((row) =>
    row
      ? {
          ttsModel: row.tts_model,
          ttsVoice: row.tts_voice,
          imageModel: row.image_model,
          imageSize: row.image_size,
        }
      : null,
  ),
}));

// ───────────────────────── Чистые юнит-тесты форматирования ──────────────────

describe('formatMediaTesterReport (#75)', () => {
  it('успешный отчёт содержит запрос, ответ, «нет» ошибки и токены', () => {
    const text = formatMediaTesterReport({
      kind: 'tts',
      request: 'Провайдер: Google (озвучка)\nМодель: tts',
      response: 'Аудио wav, 1024 байт.',
      usage: {
        promptTokens: 14,
        completionTokens: 5,
        totalTokens: 19,
        cacheReadTokens: 4,
        cacheCreationTokens: 2,
      },
    });
    expect(text).toContain('Озвучка сцены');
    expect(text).toContain('Запрос:');
    expect(text).toContain('Модель: tts');
    expect(text).toContain('Ответ:');
    expect(text).toContain('Аудио wav, 1024 байт.');
    expect(text).toContain('Ошибка:');
    expect(text).toContain('нет');
    expect(text).toContain('Затраты:');
    expect(text).toContain('inputTokens: 10');
    expect(text).toContain('outputTokens: 5');
    expect(text).toContain('cacheReadTokens: 4');
    expect(text).toContain('cacheCreationTokens: 2');
    expect(text).toContain('cost_millicents:');
    expect(text).not.toContain('19 (запрос: 14, ответ: 5)');
  });

  it('отчёт об ошибке содержит текст ошибки и прочерк вместо ответа', () => {
    const text = formatMediaTesterReport({
      kind: 'draw',
      request: 'Провайдер: OpenAI (иллюстрация)',
      error: 'rate limit',
    });
    expect(text).toContain('Иллюстрация сцены');
    expect(text).toContain('Ответ:\n—');
    expect(text).toContain('Ошибка:\nrate limit');
    expect(text).toContain('Затраты:\nнеизвестно');
  });
});

describe('утилиты media/trace (#75)', () => {
  it('clipForReport обрезает длинный текст и помечает исходную длину', () => {
    expect(clipForReport('коротко')).toBe('коротко');
    const long = 'x'.repeat(1000);
    const clipped = clipForReport(long, 100);
    expect(clipped.startsWith('x'.repeat(100))).toBe(true);
    expect(clipped).toContain('всего 1000 симв.');
  });

  it('mediaErrorMessage достаёт message из Error и строку из прочего', () => {
    expect(mediaErrorMessage(new Error('бум'))).toBe('бум');
    expect(mediaErrorMessage('просто строка')).toBe('просто строка');
  });

  it('normalizeUsage понимает имена полей Gemini и OpenAI', () => {
    expect(normalizeUsage({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 })).toEqual(
      { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    );
    expect(normalizeUsage({ input_tokens: 4, output_tokens: 6, total_tokens: 10 })).toEqual({
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
    });
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({})).toBeUndefined();
  });
});

// ───────────────────────── Интеграция с обработчиком бота ────────────────────

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
  },
} as AppConfig;

const SCENE_TEXT = 'Вы нашли монету';

function makePlayer(isTester: boolean) {
  return {
    id: 'user-1',
    telegram_id: '123',
    username: 'alice',
    active_session_id: 'sess-1',
    is_tester: isTester,
    created_at: new Date('2026-05-27T10:00:00Z'),
  };
}

const session: SessionRow = {
  id: 'sess-1',
  game_id: 'bomj',
  user_id: 'user-1',
  is_active: true,
  is_processing: false,
  current_state: { ...buildInitialState(GAMES.bomj), turn_count: 2 },
  allocated_millicents: 200,
  used_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-05-27T10:01:00Z'),
};

const step: StepRow = {
  id: 'step-42',
  session_id: session.id,
  action_text: 'осмотреться',
  llm_raw_response: null,
  changes_summary: SCENE_TEXT,
  step_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-05-27T10:02:00Z'),
};

function ownedStep(userId = 'user-1'): StepWithOwner {
  return { ...step, user_id: userId };
}

function fakeMedia(over: Partial<IMediaProvider> = {}): IMediaProvider {
  return {
    name: 'Fake',
    canSpeak: true,
    canDraw: true,
    generateSpeech: vi.fn(async () => ({
      audio: Buffer.from('voice-bytes'),
      extension: 'ogg',
      voiceNote: true,
      meta: {
        request: 'Провайдер: Fake (озвучка)\nМодель: tts-1',
        response: 'Аудио ogg, 11 байт.',
        usage: {
          promptTokens: 16,
          completionTokens: 0,
          totalTokens: 18,
          cacheReadTokens: 4,
          cacheCreationTokens: 2,
        },
      },
    })),
    generateImage: vi.fn(async () => ({
      image: Buffer.from('img-bytes'),
      extension: 'png',
      meta: {
        request: 'Провайдер: Fake (иллюстрация)\nМодель: img-1',
        response: 'Изображение png, 9 байт.',
        usage: {
          promptTokens: 40,
          completionTokens: 70,
          totalTokens: 112,
          cacheReadTokens: 10,
          cacheCreationTokens: 2,
        },
      },
    })),
    ...over,
  };
}

function callbackUpdate(data: string) {
  const rows = [
    [{ text: '🔊 Озвучить', callback_data: 'tts:step-42' }],
    [{ text: '🎨 Нарисовать иллюстрацию', callback_data: 'draw:step-42' }],
  ];
  return {
    update_id: 2,
    callback_query: {
      id: 'cbq-1',
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 555,
        date: 0,
        chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
        from: { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' },
        text: SCENE_TEXT,
        reply_markup: { inline_keyboard: rows },
      },
    },
  } as any;
}

function makeBot(media: IMediaProvider | null) {
  const provider: ILLMProvider = {
    name: 'mock',
    generateText: vi.fn(),
    generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
      text: JSON.stringify({ narrative: SCENE_TEXT, updated_state: session.current_state }),
      usage: { promptTokens: 80, completionTokens: 19, totalTokens: 99 },
    })),
  };
  const bot = createBot(config, provider, media);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' } as any;
  return bot;
}

function spyCallApi() {
  return vi
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === 'sendMessage') return { message_id: 777, chat: { id: 123 } };
      return {};
    });
}

type CallApiSpy = ReturnType<typeof spyCallApi>;
function callsOf(spy: CallApiSpy, method: string) {
  return spy.mock.calls.filter(([m]) => m === method);
}
/** Текст файла-отчёта, если он был отправлен тестировщику. */
function reportDocument(spy: CallApiSpy): { text: string; filename?: string } | undefined {
  const call = callsOf(spy, 'sendDocument').find(([, p]) => {
    const payload = p as { document?: { source?: Buffer; filename?: string } };
    return payload.document?.filename?.endsWith('_media_report.txt');
  });
  if (!call) return undefined;

  const payload = call[1] as { document: { source: Buffer; filename?: string } };
  return {
    text: payload.document.source.toString('utf8'),
    filename: payload.document.filename,
  };
}

describe('отчёт тестировщику после медиа (#75)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(stepsRepo.getStepWithOwner).mockResolvedValue(ownedStep());
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('после озвучки тестировщику приходит отчёт с запросом, ответом и токенами', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(makePlayer(true));
    const callApi = spyCallApi();
    await makeBot(fakeMedia()).handleUpdate(callbackUpdate('tts:step-42'));

    expect(callsOf(callApi, 'sendVoice')).toHaveLength(1);
    const report = reportDocument(callApi);
    expect(report).toBeTruthy();
    expect(report?.filename).toBe('step-42_tts_media_report.txt');
    expect(report?.text).toContain('Озвучка сцены');
    expect(report?.text).toContain('Провайдер: Fake (озвучка)');
    expect(report?.text).toContain('Аудио ogg, 11 байт.');
    expect(report?.text).toContain('нет'); // ошибки нет
    expect(report?.text).toContain('inputTokens: 12');
    expect(report?.text).toContain('outputTokens: 0');
    expect(report?.text).toContain('cacheReadTokens: 4');
    expect(report?.text).toContain('cacheCreationTokens: 2');
    expect(report?.text).toContain('cost_millicents:');
    expect(report?.text).not.toContain('18 (запрос: 16, ответ: 0)');
  });

  it('после иллюстрации тестировщику приходит отчёт', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(makePlayer(true));
    const callApi = spyCallApi();
    await makeBot(fakeMedia()).handleUpdate(callbackUpdate('draw:step-42'));

    expect(callsOf(callApi, 'sendPhoto')).toHaveLength(1);
    const report = reportDocument(callApi);
    expect(report?.filename).toBe('step-42_draw_media_report.txt');
    expect(report?.text).toContain('Иллюстрация сцены');
    expect(report?.text).toContain('Провайдер: Fake (иллюстрация)');
    expect(report?.text).toContain('inputTokens: 30');
    expect(report?.text).toContain('outputTokens: 70');
    expect(report?.text).toContain('cacheReadTokens: 10');
    expect(report?.text).toContain('cacheCreationTokens: 2');
    expect(report?.text).toContain('cost_millicents:');
    expect(report?.text).not.toContain('112 (запрос: 40, ответ: 70)');
  });

  it('обычному игроку (не тестировщику) отчёт НЕ приходит', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(makePlayer(false));
    const callApi = spyCallApi();
    await makeBot(fakeMedia()).handleUpdate(callbackUpdate('tts:step-42'));

    expect(callsOf(callApi, 'sendVoice')).toHaveLength(1);
    expect(reportDocument(callApi)).toBeUndefined();
  });

  it('при ошибке API тестировщик получает отчёт с описанием ошибки и запросом', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(makePlayer(true));
    const media = fakeMedia({
      generateSpeech: vi.fn(async () => {
        throw new MediaGenerationError('429 Too Many Requests', 'Провайдер: Fake (озвучка)\nМодель: tts-1');
      }),
    });
    const callApi = spyCallApi();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
    const report = reportDocument(callApi);
    expect(report).toBeTruthy();
    expect(report?.text).toContain('Провайдер: Fake (озвучка)');
    expect(report?.text).toContain('429 Too Many Requests');
    // и progress-сообщение заменилось человекочитаемой ошибкой
    const userErr = callsOf(callApi, 'editMessageText').find(([, p]) =>
      String((p as { text?: string }).text).includes('Не удалось озвучить'),
    );
    expect(userErr).toBeTruthy();
  });

  it('при ошибке без MediaGenerationError отчёт использует запасное описание запроса', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(makePlayer(true));
    const media = fakeMedia({
      generateImage: vi.fn(async () => {
        throw new Error('сеть упала');
      }),
    });
    const callApi = spyCallApi();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeBot(media).handleUpdate(callbackUpdate('draw:step-42'));

    const report = reportDocument(callApi);
    expect(report?.text).toContain('Провайдер: Fake (иллюстрация)');
    expect(report?.text).toContain('сеть упала');
  });
});
