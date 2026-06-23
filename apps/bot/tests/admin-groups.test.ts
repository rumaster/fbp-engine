import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@tg-games/core/config.js';
import type { UserRow } from '@tg-games/core/db/repositories/users.js';
import {
  CB,
  groupDetailKeyboard,
  groupListKeyboard,
} from '../src/botSupportAdmin/menus.js';
import {
  formatGroupDetail,
  groupsListHeader,
} from '../src/botSupportAdmin/format.js';
import { createAdminSupportBot } from '../src/botSupportAdmin/bot.js';
import { DEFAULT_GROUP_ID, type GameGroupRow } from '@tg-games/core/db/repositories/gameGroups.js';
import { testGameTitleMap } from './fixtures/gameManifests.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as groupsRepo from '@tg-games/core/db/repositories/gameGroups.js';

vi.mock('@tg-games/core/db/repositories/users.js', () => ({
  getUserByTelegramId: vi.fn(),
  getUserById: vi.fn(),
  countUsers: vi.fn(),
  listUsers: vi.fn(),
  setAdminActiveTicket: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/sessions.js', () => ({
  countUserSessions: vi.fn(),
  getSessionByIdForAdmin: vi.fn(),
  listUserSessionsPaged: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/steps.js', () => ({
  listSteps: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/support.js', () => ({
  addSupportMessage: vi.fn(),
  getAdminReadDate: vi.fn(),
  getTicketById: vi.fn(),
  getUnreadUserMessages: vi.fn(),
  listActiveTicketsForAdmin: vi.fn(),
  markTicketRead: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/gameGroups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tg-games/core/db/repositories/gameGroups.js')>();
  return {
    ...actual,
    listGameGroups: vi.fn(),
    getGameGroup: vi.fn(),
    upsertGameGroup: vi.fn(),
    setGameGroupGameIds: vi.fn(),
    refreshGameIdsForGroup: vi.fn(),
  };
});

const config = {
  telegramBotToken: '000:test',
  llm: { provider: 'GOOGLE', apiKey: 'k', modelName: 'm', temperature: 0.5, maxRetries: 3 },
  db: { host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' },
  millicentsPerStar: 200,
  support: {
    clientBotToken: '111:client',
    adminBotToken: '222:admin',
    botUsername: 'bot',
    adminIds: [],
    llmConsultation: true,
  },
  media: {
    provider: 'GOOGLE',
    apiKey: '',
    tts: { enabled: false, model: 'tts', voice: 'voice' },
    image: { enabled: false, model: 'image', size: '1024x1024' },
  },
} as unknown as AppConfig;

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'admin-1',
    telegram_id: '999',
    username: 'root',
    is_tester: false,
    is_admin: true,
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
    group_id: DEFAULT_GROUP_ID,
    game_ids: ['bomj'],
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function commandUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 5,
      date: 0,
      chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false, first_name: 'Root', username: 'root' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  } as any;
}

function textUpdate(text: string) {
  return {
    update_id: 3,
    message: {
      message_id: 6,
      date: 0,
      chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false, first_name: 'Root', username: 'root' },
      text,
    },
  } as any;
}

function callbackUpdate(data: string) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1',
      from: { id: 999, is_bot: false, first_name: 'Root', username: 'root' },
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 999, type: 'private' },
        text: 'placeholder',
      },
      chat_instance: 'ci',
      data,
    },
  } as any;
}

function buildBot() {
  const clientNotifier = { sendMessage: vi.fn() };
  const bot = createAdminSupportBot(config, { clientNotifier });
  bot.botInfo = { id: 222, is_bot: true, first_name: 'Admin', username: 'admin_bot' } as any;
  return bot;
}

function inlineKeyboard(markup: { reply_markup?: { inline_keyboard?: unknown[][] } }) {
  return markup.reply_markup?.inline_keyboard ?? [];
}

describe('админские группы сценариев (#100)', () => {
  let callApi: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.getUserByTelegramId).mockResolvedValue(makeUser());
    callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('строит список групп с кнопкой создания', () => {
    const kb = inlineKeyboard(groupListKeyboard([makeGroup()]));
    expect(kb[0][0]).toMatchObject({ callback_data: `${CB.groupView}:${DEFAULT_GROUP_ID}` });
    expect(JSON.stringify(kb)).toContain(CB.groupCreate);
    expect(groupsListHeader(1)).toContain('1');
  });

  it('карточка группы показывает игры и кнопку редактирования', () => {
    const gameIds = ['bomj', 'red_hood'];
    const text = formatGroupDetail(makeGroup({ game_ids: gameIds }), testGameTitleMap(gameIds));
    expect(text).toContain('Выживание бомжа');
    expect(text).toContain('Приключения Красной Шапочки');
    const kb = inlineKeyboard(groupDetailKeyboard(DEFAULT_GROUP_ID));
    expect(kb[0][0]).toMatchObject({ callback_data: `${CB.groupEdit}:${DEFAULT_GROUP_ID}` });
  });

  it('/groups присылает inline-список групп', async () => {
    vi.mocked(groupsRepo.listGameGroups).mockResolvedValue([makeGroup()]);

    await buildBot().handleUpdate(commandUpdate('/groups'));

    const send = callApi.mock.calls.find(([method]) => method === 'sendMessage');
    const payload = send?.[1] as { text: string; reply_markup?: { inline_keyboard?: any[][] } };
    expect(payload.text).toContain('Группы');
    expect(JSON.stringify(payload.reply_markup?.inline_keyboard ?? [])).toContain(
      `${CB.groupView}:${DEFAULT_GROUP_ID}`,
    );
  });

  it('создаёт группу через последовательный ввод group_id и game_ids', async () => {
    vi.mocked(groupsRepo.listGameGroups).mockResolvedValue([makeGroup()]);
    vi.mocked(groupsRepo.getGameGroup).mockResolvedValueOnce(null);
    vi.mocked(groupsRepo.upsertGameGroup).mockResolvedValue(
      makeGroup({ group_id: 'kids', game_ids: ['red_hood'] }),
    );

    const bot = buildBot();
    await bot.handleUpdate(callbackUpdate(CB.groupCreate));
    await bot.handleUpdate(textUpdate('kids'));
    await bot.handleUpdate(textUpdate('red_hood'));

    expect(groupsRepo.upsertGameGroup).toHaveBeenCalledWith('kids', ['red_hood']);
    expect(groupsRepo.refreshGameIdsForGroup).toHaveBeenCalledWith('kids');
    const sendTexts = callApi.mock.calls
      .filter(([method]) => method === 'sendMessage')
      .map(([, body]) => String((body as { text?: string }).text ?? ''));
    expect(sendTexts.some((text) => text.includes('kids'))).toBe(true);
  });

  it('редактирует game_ids группы и пересчитывает кеш игроков этой группы', async () => {
    vi.mocked(groupsRepo.getGameGroup).mockResolvedValueOnce(makeGroup());
    vi.mocked(groupsRepo.setGameGroupGameIds).mockResolvedValue(
      makeGroup({ game_ids: ['bomj', 'red_hood'] }),
    );

    const bot = buildBot();
    await bot.handleUpdate(callbackUpdate(`${CB.groupEdit}:${DEFAULT_GROUP_ID}`));
    await bot.handleUpdate(textUpdate('red_hood, bomj'));

    const edit = callApi.mock.calls.find(([method]) => method === 'editMessageText');
    const payload = edit?.[1] as { text?: string };
    expect(payload.text).toContain('Игры: bomj');
    expect(groupsRepo.setGameGroupGameIds).toHaveBeenCalledWith(
      DEFAULT_GROUP_ID,
      ['bomj', 'red_hood'],
    );
    expect(groupsRepo.refreshGameIdsForGroup).toHaveBeenCalledWith(DEFAULT_GROUP_ID);
  });
});
