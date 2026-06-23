/**
 * Интеграционные тесты медиа-кнопок сцены (issue #71).
 *
 * Проверяем два требования issue:
 *  1. В сообщении-результате действия появляются inline-кнопки «Озвучить» и
 *     «Нарисовать иллюстрацию» (когда медиа-провайдер их поддерживает).
 *  2. При клике по кнопке ИМЕННО ЭТА кнопка исчезает из сообщения, а игроку
 *     приходит НОВОЕ сообщение с озвучкой или иллюстрацией.
 *
 * Дополнительно: проверка владельца сцены, недоступность медиа и восстановление
 * кнопки при ошибке генерации.
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { MEDIA_IN_PROGRESS_TEXT } from '../src/bot/progress.js';
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

const player = {
  id: 'user-1',
  telegram_id: '123',
  username: 'alice',
  active_session_id: 'sess-1',
  is_tester: false,
  created_at: new Date('2026-05-27T10:00:00Z'),
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
  created_at: new Date('2026-05-27T10:01:00Z'),
};

const SCENE_TEXT = 'Вы нашли монету';

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

/** Шаг с владельцем (для проверки прав в медиа-колбэке). */
function ownedStep(userId = player.id): StepWithOwner {
  return { ...step, user_id: userId };
}

/** Фейковый медиа-провайдер со шпионами на генерацию. */
function fakeMedia(over: Partial<IMediaProvider> = {}): IMediaProvider {
  return {
    name: 'Fake',
    canSpeak: true,
    canDraw: true,
    generateSpeech: vi.fn(async () => ({
      audio: Buffer.from('voice-bytes'),
      extension: 'ogg',
      voiceNote: true,
    })),
    generateImage: vi.fn(async () => ({ image: Buffer.from('img-bytes'), extension: 'png' })),
    ...over,
  };
}

/** Update с произвольным игровым действием (как ввод текста). */
function textUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      text,
    },
  } as any;
}

/** Двухкнопочная клавиатура сцены под сообщением-результатом. */
function sceneButtons(stepId = 'step-42') {
  return [
    [{ text: '🔊 Озвучить', callback_data: `tts:${stepId}` }],
    [{ text: '🎨 Нарисовать иллюстрацию', callback_data: `draw:${stepId}` }],
  ];
}

/** Update клика по inline-кнопке сцены. */
function callbackUpdate(data: string, rows: unknown[][] = sceneButtons()) {
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
  // LLM-провайдер нужен только для части с обработкой действия.
  const provider: ILLMProvider = {
    name: 'mock',
    generateText: vi.fn(),
    generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
      // issue #238: один совмещённый ответ удовлетворяет все типизированные узлы
      // action-схемы (narrative/inventory/characteristics/world_flags/updated_state).
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

/** Перехватывает callApi и возвращает шпион + хелперы поиска вызовов. */
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
function payloadOf(spy: CallApiSpy, method: string) {
  return callsOf(spy, method)[0]?.[1] as any;
}

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
  vi.mocked(stepsRepo.getStepWithOwner).mockResolvedValue(ownedStep());
  vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('кнопки сцены в результате действия (#71)', () => {
  it('прикрепляет обе кнопки «Озвучить»/«Нарисовать иллюстрацию» к результату', async () => {
    const callApi = spyCallApi();
    await makeBot(fakeMedia()).handleUpdate(textUpdate('осмотреться'));

    const editPayload = payloadOf(callApi, 'editMessageText');
    const kb = editPayload?.reply_markup?.inline_keyboard ?? [];
    const flat = kb.flat() as { callback_data: string }[];
    expect(flat.map((b) => b.callback_data)).toEqual(['tts:step-42', 'draw:step-42']);
  });

  it('не прикрепляет кнопки, когда медиа недоступно (media === null)', async () => {
    const callApi = spyCallApi();
    await makeBot(null).handleUpdate(textUpdate('осмотреться'));

    const editPayload = payloadOf(callApi, 'editMessageText');
    expect(editPayload?.reply_markup).toBeUndefined();
  });

  it('показывает только «Озвучить», если рисование выключено', async () => {
    const callApi = spyCallApi();
    await makeBot(fakeMedia({ canDraw: false })).handleUpdate(textUpdate('осмотреться'));

    const kb = payloadOf(callApi, 'editMessageText')?.reply_markup?.inline_keyboard ?? [];
    const flat = kb.flat() as { callback_data: string }[];
    expect(flat.map((b) => b.callback_data)).toEqual(['tts:step-42']);
  });
});

describe('клик по «Озвучить» (tts) (#71)', () => {
  it('сразу сообщает, что генерация медиа началась', async () => {
    const media = fakeMedia();
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    const sendMessageCalls = callsOf(callApi, 'sendMessage');
    const progressPayload = sendMessageCalls[0]?.[1] as { text?: string } | undefined;
    expect(progressPayload?.text).toBe(MEDIA_IN_PROGRESS_TEXT);

    const progressCallIndex = callApi.mock.calls.findIndex(([method, payload]) =>
      method === 'sendMessage' && (payload as { text?: string }).text === MEDIA_IN_PROGRESS_TEXT,
    );
    const voiceCallIndex = callApi.mock.calls.findIndex(([method]) => method === 'sendVoice');
    expect(progressCallIndex).toBeGreaterThanOrEqual(0);
    expect(voiceCallIndex).toBeGreaterThan(progressCallIndex);
  });

  it('убирает только кнопку tts и присылает голосовое сообщение', async () => {
    const media = fakeMedia();
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    // 1. Убрана ИМЕННО кнопка tts, кнопка draw осталась.
    const editKb = payloadOf(callApi, 'editMessageReplyMarkup')?.reply_markup?.inline_keyboard ?? [];
    const flat = editKb.flat() as { callback_data: string }[];
    expect(flat.map((b) => b.callback_data)).toEqual(['draw:step-42']);

    // 2. Озвучка сгенерирована по тексту сцены и прислана как голосовое (sendVoice).
    expect(media.generateSpeech).toHaveBeenCalledWith({
      text: SCENE_TEXT,
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
    });
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(1);
    expect(callsOf(callApi, 'sendAudio')).toHaveLength(0);
    expect(callsOf(callApi, 'sendPhoto')).toHaveLength(0);
  });

  it('передаёт в провайдер пользовательские модель и голос из БД (#81)', async () => {
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue({
      user_id: player.id,
      tts_model: 'tts-1-hd',
      tts_voice: 'nova',
      image_model: null,
      image_size: null,
      updated_at: new Date('2026-05-27T10:03:00Z'),
    });
    const media = fakeMedia();
    spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    expect(media.generateSpeech).toHaveBeenCalledWith({
      text: SCENE_TEXT,
      model: 'tts-1-hd',
      voice: 'nova',
    });
  });

  it('добавляет токены и стоимость озвучки в игровую сессию (#84)', async () => {
    const media = fakeMedia({
      generateSpeech: vi.fn(async () => ({
        audio: Buffer.from('voice-bytes'),
        extension: 'ogg',
        voiceNote: true,
        meta: {
          request: 'Провайдер: Fake (озвучка)',
          response: 'Аудио ogg, 11 байт.',
          usage: { promptTokens: 12, completionTokens: 20, totalTokens: 32 },
        },
      })),
    });
    spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    expect(sessionsRepo.addUsedCredits).toHaveBeenCalledWith(session.id, 32);
    expect(sessionsRepo.addTokenUsageAndCost).toHaveBeenCalledWith(
      session.id,
      { inputTokens: 12, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      25,
    );
  });

  it('шлёт аудиофайлом (sendAudio), когда формат не голосовой (WAV)', async () => {
    const media = fakeMedia({
      generateSpeech: vi.fn(async () => ({
        audio: Buffer.from('wav-bytes'),
        extension: 'wav',
        voiceNote: false,
      })),
    });
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    expect(callsOf(callApi, 'sendAudio')).toHaveLength(1);
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
  });
});

describe('клик по «Нарисовать иллюстрацию» (draw) (#71)', () => {
  it('убирает только кнопку draw и присылает фото', async () => {
    const media = fakeMedia();
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('draw:step-42'));

    // Убрана ИМЕННО кнопка draw, кнопка tts осталась.
    const editKb = payloadOf(callApi, 'editMessageReplyMarkup')?.reply_markup?.inline_keyboard ?? [];
    const flat = editKb.flat() as { callback_data: string }[];
    expect(flat.map((b) => b.callback_data)).toEqual(['tts:step-42']);

    // Картинка сгенерирована по промпту со сценой и прислана фото (sendPhoto).
    expect(media.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(SCENE_TEXT),
        model: 'gpt-image-1',
        size: '1024x1024',
      }),
    );
    expect(callsOf(callApi, 'sendPhoto')).toHaveLength(1);
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
  });

  it('передаёт в провайдер пользовательские модель и размер иллюстрации из БД (#81)', async () => {
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue({
      user_id: player.id,
      tts_model: null,
      tts_voice: null,
      image_model: 'dall-e-3',
      image_size: '1792x1024',
      updated_at: new Date('2026-05-27T10:03:00Z'),
    });
    const media = fakeMedia();
    spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('draw:step-42'));

    expect(media.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'dall-e-3',
        size: '1792x1024',
      }),
    );
  });

  it('добавляет токены и стоимость иллюстрации по пользовательской модели в игровую сессию (#84)', async () => {
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue({
      user_id: player.id,
      tts_model: null,
      tts_voice: null,
      image_model: 'gpt-image-1-mini',
      image_size: '1024x1024',
      updated_at: new Date('2026-05-27T10:03:00Z'),
    });
    const media = fakeMedia({
      generateImage: vi.fn(async () => ({
        image: Buffer.from('img-bytes'),
        extension: 'png',
        meta: {
          request: 'Провайдер: Fake (иллюстрация)',
          response: 'Изображение png, 9 байт.',
          usage: { promptTokens: 30, completionTokens: 70, totalTokens: 100 },
        },
      })),
    });
    spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('draw:step-42'));

    expect(media.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-1-mini',
        size: '1024x1024',
      }),
    );
    expect(sessionsRepo.addUsedCredits).toHaveBeenCalledWith(session.id, 100);
    expect(sessionsRepo.addTokenUsageAndCost).toHaveBeenCalledWith(
      session.id,
      { inputTokens: 30, outputTokens: 70, cacheReadTokens: 0, cacheCreationTokens: 0 },
      62,
    );
  });
});

describe('права и недоступность медиа (#71)', () => {
  it('не озвучивает чужую сцену (другой владелец шага)', async () => {
    vi.mocked(stepsRepo.getStepWithOwner).mockResolvedValue(ownedStep('someone-else'));
    const media = fakeMedia();
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    const answer = payloadOf(callApi, 'answerCallbackQuery');
    expect(String(answer?.text)).toContain('другого игрока');
    expect(media.generateSpeech).not.toHaveBeenCalled();
    expect(callsOf(callApi, 'editMessageReplyMarkup')).toHaveLength(0);
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
  });

  it('сообщает о недоступности, если озвучка выключена у провайдера', async () => {
    const media = fakeMedia({ canSpeak: false });
    const callApi = spyCallApi();
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    const answer = payloadOf(callApi, 'answerCallbackQuery');
    expect(String(answer?.text)).toContain('недоступна');
    expect(media.generateSpeech).not.toHaveBeenCalled();
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
  });

  it('медиа-колбэк без провайдера (media === null) лишь отвечает на callback', async () => {
    const callApi = spyCallApi();
    await makeBot(null).handleUpdate(callbackUpdate('tts:step-42'));

    expect(callsOf(callApi, 'answerCallbackQuery')).toHaveLength(1);
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
    expect(callsOf(callApi, 'editMessageReplyMarkup')).toHaveLength(0);
  });
});

describe('иллюстрация без активной схемы (#238, этап C)', () => {
  it('доставляет ошибку игроку и не дёргает медиа-провайдер, когда illustration-схемы нет', async () => {
    // issue #238: иллюстрация рисуется ТОЛЬКО через активную схему. Legacy-путь
    // удалён, поэтому при отсутствии схемы generateIllustrationViaSchema бросает
    // MissingActiveSchemaError — бот обязан доставить ошибку игроку, а не зависнуть.
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(null);
    const media = fakeMedia();
    const callApi = spyCallApi();
    // Гасим ожидаемый console.error из обработчика ошибки.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeBot(media).handleUpdate(callbackUpdate('draw:step-42'));

    // Провайдер медиа не вызывался: ошибка случилась до генерации изображения.
    expect(media.generateImage).not.toHaveBeenCalled();
    expect(callsOf(callApi, 'sendPhoto')).toHaveLength(0);

    // Прогресс-сообщение заменено человекочитаемой ошибкой иллюстрации.
    const errEdit = callsOf(callApi, 'editMessageText').find(([, p]) =>
      String((p as { text?: string }).text).includes('Не удалось нарисовать иллюстрацию'),
    );
    expect(errEdit).toBeTruthy();

    // Кнопка draw восстановлена, чтобы игрок мог повторить попытку.
    const editCalls = callsOf(callApi, 'editMessageReplyMarkup');
    const restoredKb = (editCalls.at(-1)?.[1] as any)?.reply_markup?.inline_keyboard ?? [];
    const flat = restoredKb.flat() as { callback_data: string }[];
    expect(flat.map((b) => b.callback_data)).toContain('draw:step-42');
  });
});

describe('восстановление кнопки при ошибке генерации (#71)', () => {
  it('возвращает кнопку tts обратно и сообщает об ошибке', async () => {
    const media = fakeMedia({
      generateSpeech: vi.fn(async () => {
        throw new Error('генерация упала');
      }),
    });
    const callApi = spyCallApi();
    // Гасим ожидаемый console.error из обработчика ошибки.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeBot(media).handleUpdate(callbackUpdate('tts:step-42'));

    const editCalls = callsOf(callApi, 'editMessageReplyMarkup');
    // Первый вызов убрал tts, второй — восстановил полную клавиатуру.
    expect(editCalls.length).toBe(2);
    const restoredKb =
      (editCalls[1]?.[1] as any)?.reply_markup?.inline_keyboard ?? [];
    const flat = restoredKb.flat() as { callback_data: string }[];
    expect(flat.map((b) => b.callback_data)).toEqual(['tts:step-42', 'draw:step-42']);

    // Progress-сообщение заменено человекочитаемой ошибкой, голосового нет.
    const errEdit = callsOf(callApi, 'editMessageText').find(([, p]) =>
      String((p as { text?: string }).text).includes('Не удалось озвучить'),
    );
    expect(errEdit).toBeTruthy();
    expect(callsOf(callApi, 'sendVoice')).toHaveLength(0);
  });
});
