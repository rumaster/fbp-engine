import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@tg-games/core/config.js';
import type { UserRow } from '@tg-games/core/db/repositories/users.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES, testGameTitleMap } from './fixtures/gameManifests.js';
import {
  CB,
  PAGE_SIZE,
  pageCount,
  paginationRow,
  sessionButtonLabel,
  userButtonLabel,
  userSessionsKeyboard,
  usersKeyboard,
} from '../src/botSupportAdmin/menus.js';
import {
  GAME_NOT_FOUND_TEXT,
  NO_USERS_TEXT,
  gameDetailText,
  userGamesHeader,
  usersListHeader,
} from '../src/botSupportAdmin/format.js';

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

import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import { createAdminSupportBot } from '../src/botSupportAdmin/bot.js';

/** Достаёт inline_keyboard из результата Markup-хелпера. */
function inlineKeyboard(markup: { reply_markup?: { inline_keyboard?: unknown[][] } }) {
  return markup.reply_markup?.inline_keyboard ?? [];
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    telegram_id: '111',
    username: 'vasya',
    is_tester: false,
    is_admin: false,
    active_session_id: null,
    active_support_ticket_id: null,
    created_at: new Date('2026-05-27T10:00:00Z'),
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    game_id: 'bomj',
    user_id: 'user-1',
    is_active: false,
    is_processing: false,
    current_state: { ...buildInitialState(GAMES.bomj), turn_count: 3 },
    allocated_millicents: 200,
    used_credits: 0,
    token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cost_millicents: 42,
    created_at: new Date('2026-05-27T10:01:00Z'),
    ...overrides,
  };
}

// ===== Чистые юнит-тесты построителей (issue #62) =====

describe('пагинация списков (#62)', () => {
  it('pageCount округляет вверх и возвращает минимум 1', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(10)).toBe(1);
    expect(pageCount(11)).toBe(2);
    expect(pageCount(25)).toBe(3);
  });

  it('paginationRow возвращает null для единственной страницы', () => {
    expect(paginationRow((p) => `users:${p}`, 0, 1)).toBeNull();
  });

  it('на первой странице показывает только «вперёд» и индикатор', () => {
    const row = paginationRow((p) => `users:${p}`, 0, 3)!;
    expect(row).toHaveLength(2);
    expect(row[0]).toMatchObject({ text: '1/3' });
    expect(row[1]).toMatchObject({ text: '▶️', callback_data: 'users:1' });
  });

  it('на средней странице показывает «назад», индикатор и «вперёд»', () => {
    const row = paginationRow((p) => `users:${p}`, 1, 3)!;
    expect(row).toHaveLength(3);
    expect(row[0]).toMatchObject({ text: '◀️', callback_data: 'users:0' });
    expect(row[1]).toMatchObject({ text: '2/3' });
    expect(row[2]).toMatchObject({ text: '▶️', callback_data: 'users:2' });
  });

  it('на последней странице показывает только «назад» и индикатор', () => {
    const row = paginationRow((p) => `users:${p}`, 2, 3)!;
    expect(row).toHaveLength(2);
    expect(row[0]).toMatchObject({ text: '◀️', callback_data: 'users:1' });
    expect(row[1]).toMatchObject({ text: '3/3' });
  });
});

describe('userButtonLabel / usersKeyboard (#62)', () => {
  it('показывает @username, а без него — telegram_id', () => {
    expect(userButtonLabel({ username: 'vasya', telegram_id: '111', is_admin: false })).toBe(
      '@vasya',
    );
    expect(userButtonLabel({ username: null, telegram_id: '111', is_admin: false })).toBe('id 111');
  });

  it('помечает администратора маркером', () => {
    expect(userButtonLabel({ username: 'root', telegram_id: '1', is_admin: true })).toContain('🛠');
  });

  it('строит по кнопке на пользователя с callback usrg:<id>:0', () => {
    const kb = inlineKeyboard(
      usersKeyboard([makeUser({ id: 'a' }), makeUser({ id: 'b' })], 0, 2),
    );
    expect(kb).toHaveLength(2);
    expect(kb[0][0]).toMatchObject({ callback_data: `${CB.userGames}:a:0` });
    expect(kb[1][0]).toMatchObject({ callback_data: `${CB.userGames}:b:0` });
  });

  it('добавляет строку пагинации при количестве пользователей больше страницы', () => {
    const users = Array.from({ length: PAGE_SIZE }, (_, i) => makeUser({ id: `u${i}` }));
    const kb = inlineKeyboard(usersKeyboard(users, 0, 25));
    // PAGE_SIZE кнопок пользователей + строка навигации.
    expect(kb).toHaveLength(PAGE_SIZE + 1);
    const nav = kb[PAGE_SIZE] as Array<{ callback_data: string }>;
    expect(nav.some((b) => b.callback_data === 'users:1')).toBe(true);
  });
});

describe('sessionButtonLabel / userSessionsKeyboard (#62)', () => {
  it('подпись игры содержит маркер активности, дату и название сценария', () => {
    const gameTitles = testGameTitleMap(['bomj']);
    const active = sessionButtonLabel(
      makeSession({ is_active: true, created_at: new Date('2026-05-27T10:00:00Z') }),
      gameTitles,
    );
    expect(active).toContain('🟢');
    expect(active).toContain('Выживание бомжа');
    const finished = sessionButtonLabel(makeSession({ is_active: false }), gameTitles);
    expect(finished).toContain('⚪️');
  });

  it('каждая игра — кнопка game:<sessionId>, плюс возврат к пользователям', () => {
    const kb = inlineKeyboard(
      userSessionsKeyboard(
        [makeSession({ id: 's1' }), makeSession({ id: 's2' })],
        'user-1',
        0,
        2,
        testGameTitleMap(['bomj']),
      ),
    );
    expect(kb[0][0]).toMatchObject({ callback_data: `${CB.game}:s1` });
    expect(kb[1][0]).toMatchObject({ callback_data: `${CB.game}:s2` });
    // Последняя строка — возврат к списку пользователей.
    const back = kb[kb.length - 1][0] as { callback_data: string };
    expect(back.callback_data).toBe(`${CB.usersPage}:0`);
  });

  it('пагинация игр использует callback usrg:<userId>:<page>', () => {
    const sessions = Array.from({ length: PAGE_SIZE }, (_, i) => makeSession({ id: `s${i}` }));
    const kb = inlineKeyboard(
      userSessionsKeyboard(sessions, 'user-9', 0, 25, testGameTitleMap(['bomj'])),
    );
    const nav = kb.find((row) =>
      (row as Array<{ callback_data: string }>).some((b) => b.callback_data === 'usrg:user-9:1'),
    );
    expect(nav).toBeDefined();
  });
});

describe('тексты просмотра игр (#62)', () => {
  it('заголовок списка пользователей содержит общее число', () => {
    expect(usersListHeader(42)).toContain('42');
  });

  it('заголовок игр различает наличие и отсутствие игр', () => {
    expect(userGamesHeader('@vasya', 0).toLowerCase()).toContain('нет игр');
    expect(userGamesHeader('@vasya', 3)).toContain('3');
  });

  it('карточка игры содержит название, статус сессии и последний статус игры', () => {
    const text = gameDetailText(makeSession(), testGameTitleMap(['bomj']));
    expect(text).toContain('Выживание бомжа');
    expect(text).toContain('завершена');
    expect(text).toContain('Локация');
    expect(text).toContain('Кредиты');
  });
});

// ===== Интеграционные тесты обработчиков бота (issue #62) =====

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
  },
} as unknown as AppConfig;

const admin = makeUser({ id: 'admin-1', telegram_id: '999', username: 'root', is_admin: true });

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

describe('обработчики /users (#62)', () => {
  let callApi: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.getUserByTelegramId).mockResolvedValue(admin);
    callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('/users присылает список пользователей с inline-кнопками', async () => {
    vi.mocked(usersRepo.countUsers).mockResolvedValue(2);
    vi.mocked(usersRepo.listUsers).mockResolvedValue([
      makeUser({ id: 'u1', username: 'alice' }),
      makeUser({ id: 'u2', username: 'bob' }),
    ]);

    await buildBot().handleUpdate(commandUpdate('/users'));

    const send = callApi.mock.calls.find(([m]) => m === 'sendMessage');
    expect(send).toBeDefined();
    const payload = send![1] as { text: string; reply_markup?: { inline_keyboard: any[][] } };
    expect(payload.text).toContain('Пользователи');
    const kb = payload.reply_markup?.inline_keyboard ?? [];
    expect(kb[0][0]).toMatchObject({ callback_data: 'usrg:u1:0' });
    expect(usersRepo.listUsers).toHaveBeenCalledWith(PAGE_SIZE, 0);
  });

  it('/users без пользователей отвечает текстом-заглушкой', async () => {
    vi.mocked(usersRepo.countUsers).mockResolvedValue(0);

    await buildBot().handleUpdate(commandUpdate('/users'));

    const send = callApi.mock.calls.find(([m]) => m === 'sendMessage');
    expect((send![1] as { text: string }).text).toBe(NO_USERS_TEXT);
  });

  it('клик по пользователю редактирует сообщение со списком его игр', async () => {
    vi.mocked(usersRepo.getUserById).mockResolvedValue(makeUser({ id: 'u1', username: 'alice' }));
    vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(1);
    vi.mocked(sessionsRepo.listUserSessionsPaged).mockResolvedValue([makeSession({ id: 's1' })]);

    await buildBot().handleUpdate(callbackUpdate('usrg:u1:0'));

    const edit = callApi.mock.calls.find(([m]) => m === 'editMessageText');
    expect(edit).toBeDefined();
    const payload = edit![1] as { text: string; reply_markup?: { inline_keyboard: any[][] } };
    expect(payload.text).toContain('@alice');
    const kb = payload.reply_markup?.inline_keyboard ?? [];
    expect(kb[0][0]).toMatchObject({ callback_data: 'game:s1' });
    expect(sessionsRepo.listUserSessionsPaged).toHaveBeenCalledWith('u1', PAGE_SIZE, 0);
  });

  it('клик по игре показывает статус и кнопку скачивания истории', async () => {
    vi.mocked(sessionsRepo.getSessionByIdForAdmin).mockResolvedValue(makeSession({ id: 's1' }));

    await buildBot().handleUpdate(callbackUpdate('game:s1'));

    const edit = callApi.mock.calls.find(([m]) => m === 'editMessageText');
    const payload = edit![1] as { text: string; reply_markup?: { inline_keyboard: any[][] } };
    expect(payload.text).toContain('Локация');
    const kb = payload.reply_markup?.inline_keyboard ?? [];
    expect(kb[0][0]).toMatchObject({ callback_data: 'usrh:s1' });
  });

  it('клик по кнопке скачивания присылает файл истории ходов', async () => {
    vi.mocked(sessionsRepo.getSessionByIdForAdmin).mockResolvedValue(
      makeSession({ id: 's1', game_id: 'bomj' }),
    );
    const steps: StepRow[] = [
      {
        id: 'st1',
        session_id: 's1',
        action_text: 'осмотреться',
        llm_raw_response: null,
        changes_summary: 'Вы нашли монету ₽',
        step_credits: 0,
        token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        cost_millicents: 0,
        created_at: new Date('2026-05-27T10:02:00Z'),
      },
    ];
    vi.mocked(stepsRepo.listSteps).mockResolvedValue(steps);

    await buildBot().handleUpdate(callbackUpdate('usrh:s1'));

    const doc = callApi.mock.calls.find(([m]) => m === 'sendDocument');
    expect(doc).toBeDefined();
    const payload = doc![1] as { document: { source: Buffer; filename?: string } };
    expect(payload.document.filename).toBe('bomj_s1_history.txt');
    expect(payload.document.source.toString('utf8')).toContain('Вы нашли монету ₽');
  });

  it('клик по отсутствующей игре сообщает об ошибке', async () => {
    vi.mocked(sessionsRepo.getSessionByIdForAdmin).mockResolvedValue(null);

    await buildBot().handleUpdate(callbackUpdate('game:nope'));

    const edit = callApi.mock.calls.find(([m]) => m === 'editMessageText');
    expect((edit![1] as { text: string }).text).toBe(GAME_NOT_FOUND_TEXT);
  });

  it('не-администратор игнорируется (middleware не пускает дальше)', async () => {
    vi.mocked(usersRepo.getUserByTelegramId).mockResolvedValue(makeUser({ is_admin: false }));
    vi.mocked(usersRepo.countUsers).mockResolvedValue(5);

    await buildBot().handleUpdate(commandUpdate('/users'));

    expect(usersRepo.countUsers).not.toHaveBeenCalled();
    expect(callApi.mock.calls.find(([m]) => m === 'sendMessage')).toBeUndefined();
  });
});
