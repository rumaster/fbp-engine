import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { BTN } from '../src/bot/menus.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { UserRow } from '@tg-games/core/db/repositories/users.js';
import { DEFAULT_GROUP_ID, type GameGroupRow } from '@tg-games/core/db/repositories/gameGroups.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as groupsRepo from '@tg-games/core/db/repositories/gameGroups.js';

vi.mock('@tg-games/core/db/repositories/users.js', () => ({
  getUserByTelegramId: vi.fn(),
  setActiveSession: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/gameGroups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tg-games/core/db/repositories/gameGroups.js')>();
  return {
    ...actual,
    addUserGroup: vi.fn(),
    getGameGroup: vi.fn(),
  };
});

vi.mock('@tg-games/core/db/repositories/sessions.js', () => ({
  acquireProcessingLock: vi.fn().mockResolvedValue(true),
  addAllocatedMillicents: vi.fn().mockResolvedValue(undefined),
  addUsedCredits: vi.fn().mockResolvedValue(undefined),
  addTokenUsageAndCost: vi.fn().mockResolvedValue(undefined),
  countUserSessions: vi.fn(),
  createSession: vi.fn(),
  finishSession: vi.fn(),
  getActiveSession: vi.fn(),
  getSessionById: vi.fn(),
  listUserSessions: vi.fn(),
  releaseProcessingLock: vi.fn().mockResolvedValue(undefined),
  updateSessionState: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/steps.js', () => ({
  getStepWithOwner: vi.fn(),
  insertStep: vi.fn(),
  listSteps: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/payments.js', () => ({
  createPayment: vi.fn(),
  markPaymentPaid: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/llmLogs.js', () => ({
  buildLlmRequestLogInputs: vi.fn(() => []),
  insertLlmRequestLogsSafely: vi.fn(),
}));

const config: AppConfig = {
  telegramBotToken: '000:test',
  llm: {
    provider: 'GOOGLE',
    apiKey: 'key',
    modelName: 'model',
    temperature: 0.5,
    maxRetries: 3,
  },
  db: {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres_password',
    database: 'tg_rpg_db',
  },
  millicentsPerStar: 2000,
  support: {
    clientBotToken: '',
    adminBotToken: '',
    botUsername: '',
    adminIds: [],
    llmConsultation: true,
  },
  media: {
    provider: 'GOOGLE',
    apiKey: '',
    tts: { enabled: false, model: 'tts', voice: 'voice' },
    image: { enabled: false, model: 'image', size: '1024x1024' },
  },
};

const provider: ILLMProvider = {
  name: 'mock',
  generateText: vi.fn(),
};

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    telegram_id: '42',
    username: 'bob',
    is_tester: false,
    is_admin: false,
    groups: [DEFAULT_GROUP_ID],
    game_ids: ['bomj'],
    active_session_id: null,
    active_support_ticket_id: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeGroup(overrides: Partial<GameGroupRow> = {}): GameGroupRow {
  return {
    group_id: 'kids',
    game_ids: ['red_hood'],
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function textUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 5,
      date: 0,
      chat: { id: 42, type: 'private', first_name: 'Bob' },
      from: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      text,
    },
  } as any;
}

function commandUpdate(text: string) {
  return {
    ...textUpdate(text),
    message: {
      ...textUpdate(text).message,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s+/)[0].length }],
    },
  } as any;
}

function callbackUpdate(data: string) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cq1',
      from: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 5,
        date: 0,
        chat: { id: 42, type: 'private', first_name: 'Bob' },
        text: 'список игр',
      },
    },
  } as any;
}

function createMockBot() {
  const bot = createBot(config, provider);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return bot;
}

describe('группы игрока (#100)', () => {
  let callApi: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(makeUser());
    callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('показывает в списке новой игры только сценарии из кеша user.game_ids', async () => {
    await createMockBot().handleUpdate(textUpdate(BTN.newGame));

    const send = callApi.mock.calls.find(([method]) => method === 'sendMessage');
    const payload = send?.[1] as { reply_markup?: { inline_keyboard?: any[][] } };
    const buttons = JSON.stringify(payload.reply_markup?.inline_keyboard ?? []);
    expect(buttons).toContain('game:bomj');
    expect(buttons).not.toContain('game:red_hood');
    expect(buttons).not.toContain('game:private_detective');
  });

  it('не открывает сценарий вне доступных игроку game_ids по callback', async () => {
    await createMockBot().handleUpdate(callbackUpdate('game:red_hood'));

    const sendMessages = callApi.mock.calls.filter(([method]) => method === 'sendMessage');
    expect(JSON.stringify(sendMessages.map(([, body]) => body))).toContain('Сценарий недоступен');
  });

  it('/mygroups возвращает группы игрока', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(
      makeUser({ groups: [DEFAULT_GROUP_ID, 'kids'], game_ids: ['bomj', 'red_hood'] }),
    );

    await createMockBot().handleUpdate(commandUpdate('/mygroups'));

    const send = callApi.mock.calls.find(([method]) => method === 'sendMessage');
    const text = String((send?.[1] as { text?: string })?.text ?? '');
    expect(text).toContain(DEFAULT_GROUP_ID);
    expect(text).toContain('kids');
  });

  it('/group добавляет существующую группу и обновляет ответ по новому списку групп', async () => {
    vi.mocked(groupsRepo.getGameGroup).mockResolvedValue(makeGroup({ group_id: 'kids' }));
    vi.mocked(groupsRepo.addUserGroup).mockResolvedValue(
      makeUser({ groups: [DEFAULT_GROUP_ID, 'kids'], game_ids: ['bomj', 'red_hood'] }),
    );

    await createMockBot().handleUpdate(commandUpdate('/group kids'));

    expect(groupsRepo.addUserGroup).toHaveBeenCalledWith('user-1', 'kids');
    const send = callApi.mock.calls.find(([method]) => method === 'sendMessage');
    const text = String((send?.[1] as { text?: string })?.text ?? '');
    expect(text).toContain('kids');
    expect(text).toContain(GAMES.red_hood.name);
  });
});
