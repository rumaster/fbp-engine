import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@tg-games/core/config.js';
import type { UserRow } from '@tg-games/core/db/repositories/users.js';
import type { GameGroupRow } from '@tg-games/core/db/repositories/gameGroups.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import { createAdminSupportBot } from '../src/botSupportAdmin/bot.js';
import {
  CB,
  adminGameDetailKeyboard,
  adminGameGroupsKeyboard,
  adminGamesKeyboard,
} from '../src/botSupportAdmin/menus.js';
import {
  formatAdminGameDetail,
  formatGameManifestJson,
  gamesListHeader,
} from '../src/botSupportAdmin/format.js';
import { DEFAULT_GROUP_ID } from '@tg-games/core/db/repositories/gameGroups.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as groupsRepo from '@tg-games/core/db/repositories/gameGroups.js';
import * as manifestsRepo from '@tg-games/core/db/repositories/gameManifests.js';

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
    listGameGroupsForGame: vi.fn(),
    setGameGroupsForGame: vi.fn(),
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

describe('админские игры (/games, issue #109)', () => {
  let callApi: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.getUserByTelegramId).mockResolvedValue(makeUser());
    vi.mocked(manifestsRepo.countGameManifests).mockResolvedValue(3);
    vi.mocked(manifestsRepo.listGameManifestsPaged).mockResolvedValue([
      GAMES.bomj,
      GAMES.red_hood,
    ]);
    vi.mocked(manifestsRepo.getGameManifest).mockResolvedValue(GAMES.bomj);
    vi.mocked(groupsRepo.listGameGroupsForGame).mockResolvedValue([makeGroup()]);
    vi.mocked(groupsRepo.setGameGroupsForGame).mockResolvedValue([
      makeGroup(),
      makeGroup({ group_id: 'kids', game_ids: ['bomj', 'red_hood'] }),
    ]);
    callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('строит список игр с inline-кнопками и пагинацией', () => {
    const kb = inlineKeyboard(adminGamesKeyboard([GAMES.bomj, GAMES.red_hood], 0, 12));

    expect(kb[0][0]).toMatchObject({ callback_data: `${CB.adminGame}:bomj` });
    expect(kb[1][0]).toMatchObject({ callback_data: `${CB.adminGame}:red_hood` });
    expect(JSON.stringify(kb)).toContain(`${CB.adminGamesPage}:1`);
    expect(gamesListHeader(12)).toContain('12');
  });

  it('карточка игры показывает id, название, группы и кнопки манифеста/групп', () => {
    const groups = [makeGroup(), makeGroup({ group_id: 'kids' })];
    const text = formatAdminGameDetail(GAMES.bomj, groups);
    const kb = inlineKeyboard(adminGameDetailKeyboard('bomj'));

    expect(text).toContain('bomj');
    expect(text).toContain('Выживание бомжа');
    expect(text).toContain(DEFAULT_GROUP_ID);
    expect(text).toContain('kids');
    expect(JSON.stringify(kb)).toContain(`${CB.adminGameManifest}:bomj`);
    expect(JSON.stringify(kb)).toContain(`${CB.adminGameGroups}:bomj`);
  });

  it('/games присылает первую страницу игр', async () => {
    await buildBot().handleUpdate(commandUpdate('/games'));

    const send = callApi.mock.calls.find(([method]) => method === 'sendMessage');
    const payload = send?.[1] as { text: string; reply_markup?: { inline_keyboard?: any[][] } };
    expect(payload.text).toContain('Игры');
    expect(payload.reply_markup?.inline_keyboard?.[0][0]).toMatchObject({
      callback_data: `${CB.adminGame}:bomj`,
    });
    expect(manifestsRepo.listGameManifestsPaged).toHaveBeenCalledWith(10, 0);
  });

  it('клик по игре редактирует сообщение на карточку игры', async () => {
    await buildBot().handleUpdate(callbackUpdate(`${CB.adminGame}:bomj`));

    const edit = callApi.mock.calls.find(([method]) => method === 'editMessageText');
    const payload = edit?.[1] as { text: string; reply_markup?: { inline_keyboard?: any[][] } };
    expect(payload.text).toContain('Выживание бомжа');
    expect(payload.text).toContain(DEFAULT_GROUP_ID);
    expect(JSON.stringify(payload.reply_markup?.inline_keyboard ?? [])).toContain(
      `${CB.adminGameManifest}:bomj`,
    );
  });

  it('клик по манифесту показывает JSON и кнопку изменения', async () => {
    await buildBot().handleUpdate(callbackUpdate(`${CB.adminGameManifest}:bomj`));

    const edit = callApi.mock.calls.find(([method]) => method === 'editMessageText');
    const payload = edit?.[1] as { text: string; reply_markup?: { inline_keyboard?: any[][] } };
    expect(payload.text).toContain('"id": "bomj"');
    expect(formatGameManifestJson(GAMES.bomj)).toContain('"name": "Выживание бомжа"');
    expect(JSON.stringify(payload.reply_markup?.inline_keyboard ?? [])).toContain(
      `${CB.adminGameManifestEdit}:bomj`,
    );
  });

  it('редактирует манифест после ввода валидного JSON с тем же id', async () => {
    const updated: GameManifest = { ...GAMES.bomj, name: 'Новое название' };
    vi.mocked(manifestsRepo.updateGameManifest).mockResolvedValue(updated);

    const bot = buildBot();
    await bot.handleUpdate(callbackUpdate(`${CB.adminGameManifestEdit}:bomj`));
    await bot.handleUpdate(textUpdate(JSON.stringify(updated)));

    expect(manifestsRepo.updateGameManifest).toHaveBeenCalledWith('bomj', updated);
    const sentTexts = callApi.mock.calls
      .filter(([method]) => method === 'sendMessage')
      .map(([, body]) => String((body as { text?: string }).text ?? ''));
    expect(sentTexts.some((text) => text.includes('Новое название'))).toBe(true);
  });

  it('отклоняет манифест с id другой игры', async () => {
    const invalid = { ...GAMES.bomj, id: 'red_hood' };

    const bot = buildBot();
    await bot.handleUpdate(callbackUpdate(`${CB.adminGameManifestEdit}:bomj`));
    await bot.handleUpdate(textUpdate(JSON.stringify(invalid)));

    expect(manifestsRepo.updateGameManifest).not.toHaveBeenCalled();
    const sentTexts = callApi.mock.calls
      .filter(([method]) => method === 'sendMessage')
      .map(([, body]) => String((body as { text?: string }).text ?? ''));
    expect(sentTexts.some((text) => text.includes('id манифеста должен остаться bomj'))).toBe(
      true,
    );
  });

  it('показывает группы игры и обновляет их через ввод списка group_id', async () => {
    const bot = buildBot();
    await bot.handleUpdate(callbackUpdate(`${CB.adminGameGroups}:bomj`));
    await bot.handleUpdate(callbackUpdate(`${CB.adminGameGroupsEdit}:bomj`));
    await bot.handleUpdate(textUpdate(`${DEFAULT_GROUP_ID}, kids`));

    expect(groupsRepo.setGameGroupsForGame).toHaveBeenCalledWith('bomj', [
      DEFAULT_GROUP_ID,
      'kids',
    ]);
    const firstEdit = callApi.mock.calls.find(([method]) => method === 'editMessageText');
    const editPayload = firstEdit?.[1] as { text: string; reply_markup?: { inline_keyboard?: any[][] } };
    expect(editPayload.text).toContain(DEFAULT_GROUP_ID);
    expect(JSON.stringify(inlineKeyboard(adminGameGroupsKeyboard('bomj')))).toContain(
      `${CB.adminGameGroupsEdit}:bomj`,
    );
  });
});
