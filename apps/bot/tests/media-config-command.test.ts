import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { IMediaProvider } from '@tg-games/core/media/IMediaProvider.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as userMediaConfigRepo from '@tg-games/core/db/repositories/userMediaConfig.js';

vi.mock('@tg-games/core/db/repositories/users.js', () => ({
  getUserByTelegramId: vi.fn(),
  setActiveSession: vi.fn(),
  upsertUser: vi.fn(),
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

const config: AppConfig = {
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
};

const player = {
  id: 'user-1',
  telegram_id: '123',
  username: 'alice',
  active_session_id: null,
  active_support_ticket_id: null,
  is_tester: false,
  is_admin: false,
  created_at: new Date('2026-05-27T10:00:00Z'),
};

function fakeMedia(overrides: Partial<IMediaProvider> = {}): IMediaProvider {
  return {
    name: 'Fake',
    canSpeak: true,
    canDraw: true,
    generateSpeech: vi.fn(),
    generateImage: vi.fn(),
    ...overrides,
  };
}

function makeBot(media: IMediaProvider | null = fakeMedia()) {
  const provider: ILLMProvider = {
    name: 'mock',
    generateText: vi.fn(),
    generateTextResult: vi.fn(),
  };
  const bot = createBot(config, provider, media);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' } as any;
  return bot;
}

function commandUpdate(text = '/config') {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    },
  } as any;
}

function callbackUpdate(data: string) {
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
        text: 'Настройки медиа',
      },
    },
  } as any;
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
function payloadOf(spy: CallApiSpy, method: string) {
  return spy.mock.calls.find(([m]) => m === method)?.[1] as any;
}

describe('/config: настройки медиа пользователя (#81)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('показывает текущие env-настройки и выбор раздела', async () => {
    const callApi = spyCallApi();
    await makeBot().handleUpdate(commandUpdate());

    const payload = payloadOf(callApi, 'sendMessage');
    expect(payload.text).toContain('Настройки медиа');
    expect(payload.text).toContain('Озвучка: gpt-4o-mini-tts / alloy');
    expect(payload.text).toContain('Иллюстрации: gpt-image-1 / 1024x1024');
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data);
    expect(callbacks).toEqual(['cfg:subject:tts', 'cfg:subject:image']);
  });

  it('после выбора модели озвучки сохраняет её и предлагает выбрать голос', async () => {
    vi.mocked(userMediaConfigRepo.setUserTtsModel).mockResolvedValue({
      user_id: player.id,
      tts_model: 'tts-1-hd',
      tts_voice: null,
      image_model: null,
      image_size: null,
      updated_at: new Date('2026-05-27T10:03:00Z'),
    });
    const callApi = spyCallApi();
    await makeBot().handleUpdate(callbackUpdate('cfg:tts:model:tts-1-hd'));

    expect(userMediaConfigRepo.setUserTtsModel).toHaveBeenCalledWith(player.id, 'tts-1-hd');
    const payload = payloadOf(callApi, 'editMessageText');
    expect(payload.text).toContain('Модель: tts-1-hd');
    expect(payload.text).toContain('Выберите голос');
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data);
    expect(callbacks).toContain('cfg:tts:voice:nova');
  });

  it('после выбора голоса сохраняет его и возвращает обновлённую сводку', async () => {
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue({
      user_id: player.id,
      tts_model: 'tts-1-hd',
      tts_voice: null,
      image_model: null,
      image_size: null,
      updated_at: new Date('2026-05-27T10:03:00Z'),
    });
    vi.mocked(userMediaConfigRepo.setUserTtsVoice).mockResolvedValue({
      user_id: player.id,
      tts_model: 'tts-1-hd',
      tts_voice: 'nova',
      image_model: null,
      image_size: null,
      updated_at: new Date('2026-05-27T10:04:00Z'),
    });
    const callApi = spyCallApi();
    await makeBot().handleUpdate(callbackUpdate('cfg:tts:voice:nova'));

    expect(userMediaConfigRepo.setUserTtsVoice).toHaveBeenCalledWith(player.id, 'nova');
    const payload = payloadOf(callApi, 'editMessageText');
    expect(payload.text).toContain('Озвучка обновлена');
    expect(payload.text).toContain('Озвучка: tts-1-hd / nova');
  });

  it('после выбора модели иллюстраций сохраняет её и предлагает выбрать размер', async () => {
    vi.mocked(userMediaConfigRepo.setUserImageModel).mockResolvedValue({
      user_id: player.id,
      tts_model: null,
      tts_voice: null,
      image_model: 'dall-e-3',
      image_size: null,
      updated_at: new Date('2026-05-27T10:05:00Z'),
    });
    const callApi = spyCallApi();
    await makeBot().handleUpdate(callbackUpdate('cfg:image:model:dall-e-3'));

    expect(userMediaConfigRepo.setUserImageModel).toHaveBeenCalledWith(player.id, 'dall-e-3');
    const payload = payloadOf(callApi, 'editMessageText');
    expect(payload.text).toContain('Модель: dall-e-3');
    expect(payload.text).toContain('Выберите размер');
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data);
    expect(callbacks).toContain('cfg:image:size:1792x1024');
  });

  it('после выбора размера сохраняет его и возвращает обновлённую сводку', async () => {
    vi.mocked(userMediaConfigRepo.getUserMediaConfig).mockResolvedValue({
      user_id: player.id,
      tts_model: null,
      tts_voice: null,
      image_model: 'dall-e-3',
      image_size: null,
      updated_at: new Date('2026-05-27T10:05:00Z'),
    });
    vi.mocked(userMediaConfigRepo.setUserImageSize).mockResolvedValue({
      user_id: player.id,
      tts_model: null,
      tts_voice: null,
      image_model: 'dall-e-3',
      image_size: '1792x1024',
      updated_at: new Date('2026-05-27T10:06:00Z'),
    });
    const callApi = spyCallApi();
    await makeBot().handleUpdate(callbackUpdate('cfg:image:size:1792x1024'));

    expect(userMediaConfigRepo.setUserImageSize).toHaveBeenCalledWith(player.id, '1792x1024');
    const payload = payloadOf(callApi, 'editMessageText');
    expect(payload.text).toContain('Иллюстрации обновлены');
    expect(payload.text).toContain('Иллюстрации: dall-e-3 / 1792x1024');
  });
});
