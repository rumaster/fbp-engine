import { Markup } from 'telegraf';
import type { TicketWithReadState } from '@tg-games/core/db/repositories/support.js';
import type { UserRow } from '@tg-games/core/db/repositories/users.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import type { GameGroupRow } from '@tg-games/core/db/repositories/gameGroups.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import type { GameTitleMap } from '@tg-games/core/db/repositories/gameManifests.js';
import { formatDateTime } from './format.js';

/**
 * Статус обращения с точки зрения конкретного администратора:
 * - `new`    — администратор ещё не открывал обращение (нет last_message_date);
 * - `unread` — есть новые сообщения клиента, которые администратор не видел;
 * - `read`   — новых сообщений нет.
 */
export type TopicStatus = 'new' | 'unread' | 'read';

/** Цветной символ статуса для кнопки обращения. */
export const TOPIC_STATUS_SYMBOL: Record<TopicStatus, string> = {
  new: '🔵',
  unread: '🔴',
  read: '⚪️',
};

/**
 * Определяет статус обращения для администратора.
 * Отсутствие отметки о прочтении (admin_last_read === null) приоритетнее,
 * чем флаг непрочитанных: «ещё не открывал» — отдельное состояние.
 */
export function topicStatus(
  ticket: Pick<TicketWithReadState, 'admin_last_read' | 'has_unread'>,
): TopicStatus {
  if (ticket.admin_last_read === null) return 'new';
  if (ticket.has_unread) return 'unread';
  return 'read';
}

/** Подпись клиента для кнопки: @username или telegram_id. */
function userLabel(ticket: Pick<TicketWithReadState, 'user_username' | 'user_telegram_id'>): string {
  return ticket.user_username ? `@${ticket.user_username}` : `id ${ticket.user_telegram_id}`;
}

/**
 * Текст кнопки обращения: цветной символ статуса + дата последнего сообщения +
 * номер обращения и клиент.
 */
export function topicButtonLabel(ticket: TicketWithReadState): string {
  const symbol = TOPIC_STATUS_SYMBOL[topicStatus(ticket)];
  return `${symbol} ${formatDateTime(ticket.last_message_at)} · #${ticket.number} · ${userLabel(ticket)}`;
}

/**
 * Inline-клавиатура со списком активных обращений.
 * callback_data: `topic:<ticketId>` — клик делает обращение текущим для админа.
 */
export function topicsKeyboard(tickets: TicketWithReadState[]) {
  return Markup.inlineKeyboard(
    tickets.map((t) => [Markup.button.callback(topicButtonLabel(t), `topic:${t.id}`)]),
  );
}

/** Клавиатура активного обращения: кнопка закрытия. */
export function ticketActionsKeyboard(ticketId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔒 Закрыть обращение', `close_ticket:${ticketId}`)],
  ]);
}

// ===== Просмотр данных по играм (issue #62) =====

/** Размер страницы списков пользователей и игр. */
export const PAGE_SIZE = 10;

/** callback_data «заглушки» (кнопка-индикатор страницы ничего не делает). */
export const NOOP_CALLBACK = 'noop';

/** Префиксы callback_data навигации по пользователям и играм. */
export const CB = {
  /** Страница списка пользователей: `users:<page>`. */
  usersPage: 'users',
  /** Страница списка игр пользователя: `usrg:<userId>:<page>`. */
  userGames: 'usrg',
  /** Карточка игры: `game:<sessionId>`. */
  game: 'game',
  /** Скачивание истории ходов игры: `usrh:<sessionId>`. */
  history: 'usrh',
  /** Список групп сценариев. */
  groupList: 'grplist',
  /** Карточка группы сценариев: `grp:<groupId>`. */
  groupView: 'grp',
  /** Создание группы сценариев. */
  groupCreate: 'grp:new',
  /** Редактирование игр группы: `grpedit:<groupId>`. */
  groupEdit: 'grpedit',
  /** Страница списка сценариев: `games:<page>`. */
  adminGamesPage: 'games',
  /** Карточка сценария: `admg:<gameId>`. */
  adminGame: 'admg',
  /** JSON-манифест сценария: `adgm:<gameId>`. */
  adminGameManifest: 'adgm',
  /** Редактирование JSON-манифеста сценария: `adgmedit:<gameId>`. */
  adminGameManifestEdit: 'adgmedit',
  /** Группы сценария: `adgg:<gameId>`. */
  adminGameGroups: 'adgg',
  /** Редактирование групп сценария: `adggedit:<gameId>`. */
  adminGameGroupsEdit: 'adggedit',
} as const;

/** Число страниц, необходимое для `total` элементов (минимум 1). */
export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Строка пагинации «◀️ n/m ▶️». `makeData(page)` формирует callback_data
 * перехода на страницу. Возвращает null, если страница всего одна. Стрелки
 * скрываются на границах, чтобы не было «мёртвых» кнопок (issue #62).
 */
export function paginationRow(
  makeData: (page: number) => string,
  page: number,
  pages: number,
) {
  if (pages <= 1) return null;
  const row = [];
  if (page > 0) row.push(Markup.button.callback('◀️', makeData(page - 1)));
  row.push(Markup.button.callback(`${page + 1}/${pages}`, NOOP_CALLBACK));
  if (page < pages - 1) row.push(Markup.button.callback('▶️', makeData(page + 1)));
  return row;
}

/** Подпись пользователя для кнопки: @username или «id <telegram_id>». */
export function userButtonLabel(user: Pick<UserRow, 'username' | 'telegram_id' | 'is_admin'>): string {
  const base = user.username ? `@${user.username}` : `id ${user.telegram_id}`;
  return user.is_admin ? `🛠 ${base}` : base;
}

/**
 * Inline-клавиатура страницы списка пользователей.
 * Каждый пользователь — отдельная кнопка `usrg:<userId>:0` (открывает его игры),
 * ниже — строка пагинации, если страниц больше одной.
 */
export function usersKeyboard(users: UserRow[], page: number, total: number) {
  const rows = users.map((u) => [
    Markup.button.callback(userButtonLabel(u), `${CB.userGames}:${u.id}:0`),
  ]);
  const nav = paginationRow((p) => `${CB.usersPage}:${p}`, page, pageCount(total));
  if (nav) rows.push(nav);
  return Markup.inlineKeyboard(rows);
}

/** Подпись игры для кнопки: маркер активности + дата начала + название. */
export function sessionButtonLabel(
  session: Pick<SessionRow, 'game_id' | 'is_active' | 'created_at'>,
  gameTitles: GameTitleMap = new Map(),
): string {
  const title = gameTitles.get(session.game_id) ?? session.game_id;
  const marker = session.is_active ? '🟢' : '⚪️';
  return `${marker} ${formatDateTime(session.created_at)} · ${title}`;
}

/**
 * Inline-клавиатура страницы списка игр пользователя.
 * Каждая игра — кнопка `game:<sessionId>`; ниже — пагинация (если нужна) и
 * кнопка возврата к списку пользователей.
 */
export function userSessionsKeyboard(
  sessions: SessionRow[],
  userId: string,
  page: number,
  total: number,
  gameTitles: GameTitleMap = new Map(),
) {
  const rows = sessions.map((s) => [
    Markup.button.callback(sessionButtonLabel(s, gameTitles), `${CB.game}:${s.id}`),
  ]);
  const nav = paginationRow((p) => `${CB.userGames}:${userId}:${p}`, page, pageCount(total));
  if (nav) rows.push(nav);
  rows.push([Markup.button.callback('⬅️ К пользователям', `${CB.usersPage}:0`)]);
  return Markup.inlineKeyboard(rows);
}

/** Клавиатура для пустого списка игр пользователя — только возврат к списку. */
export function emptyUserSessionsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ К пользователям', `${CB.usersPage}:0`)],
  ]);
}

/**
 * Клавиатура карточки игры: скачать историю ходов файлом и вернуться к списку
 * игр пользователя.
 */
export function gameDetailKeyboard(session: Pick<SessionRow, 'id' | 'user_id'>) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📥 Скачать историю ходов', `${CB.history}:${session.id}`)],
    [Markup.button.callback('⬅️ К играм', `${CB.userGames}:${session.user_id}:0`)],
  ]);
}

// ===== Группы сценариев (issue #100) =====

/** Подпись группы в списке: group_id и количество сценариев. */
export function groupButtonLabel(group: Pick<GameGroupRow, 'group_id' | 'game_ids'>): string {
  return `${group.group_id} · игр: ${group.game_ids.length}`;
}

/** Inline-список групп плюс кнопка создания. */
export function groupListKeyboard(groups: GameGroupRow[]) {
  return Markup.inlineKeyboard([
    ...groups.map((group) => [
      Markup.button.callback(groupButtonLabel(group), `${CB.groupView}:${group.group_id}`),
    ]),
    [Markup.button.callback('➕ Создать группу', CB.groupCreate)],
  ]);
}

/** Кнопки карточки группы: изменить игры и вернуться к списку. */
export function groupDetailKeyboard(groupId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить игры', `${CB.groupEdit}:${groupId}`)],
    [Markup.button.callback('⬅️ К группам', CB.groupList)],
  ]);
}

/** Кнопка возврата к списку групп для экранов ввода. */
export function groupBackKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ К группам', CB.groupList)]]);
}

// ===== Администрирование сценариев (/games, issue #109) =====

/** Подпись сценария в списке: название и game_id. */
export function adminGameButtonLabel(game: Pick<GameManifest, 'id' | 'name'>): string {
  return `${game.name} · ${game.id}`;
}

/** Inline-клавиатура страницы списка сценариев. */
export function adminGamesKeyboard(games: GameManifest[], page: number, total: number) {
  const rows = games.map((game) => [
    Markup.button.callback(adminGameButtonLabel(game), `${CB.adminGame}:${game.id}`),
  ]);
  const nav = paginationRow((p) => `${CB.adminGamesPage}:${p}`, page, pageCount(total));
  if (nav) rows.push(nav);
  return Markup.inlineKeyboard(rows);
}

/** Кнопки карточки сценария: манифест, группы и возврат к списку. */
export function adminGameDetailKeyboard(gameId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄 Манифест', `${CB.adminGameManifest}:${gameId}`)],
    [Markup.button.callback('👥 Группы', `${CB.adminGameGroups}:${gameId}`)],
    [Markup.button.callback('⬅️ К играм', `${CB.adminGamesPage}:0`)],
  ]);
}

/** Кнопки экрана JSON-манифеста. */
export function adminGameManifestKeyboard(gameId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить', `${CB.adminGameManifestEdit}:${gameId}`)],
    [Markup.button.callback('⬅️ К игре', `${CB.adminGame}:${gameId}`)],
  ]);
}

/** Кнопки экрана групп сценария. */
export function adminGameGroupsKeyboard(gameId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить группы', `${CB.adminGameGroupsEdit}:${gameId}`)],
    [Markup.button.callback('⬅️ К игре', `${CB.adminGame}:${gameId}`)],
  ]);
}

/** Кнопка возврата к карточке сценария для экранов ввода. */
export function adminGameBackKeyboard(gameId: string) {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ К игре', `${CB.adminGame}:${gameId}`)]]);
}
