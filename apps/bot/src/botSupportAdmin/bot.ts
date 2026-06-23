import { Input, Telegraf, type Context, type Telegram } from 'telegraf';
import { message } from 'telegraf/filters';
import type { AppConfig } from '@tg-games/core/config.js';
import type { UserRow } from '@tg-games/core/db/repositories/users.js';
import {
  countUsers,
  getUserById,
  getUserByTelegramId,
  listUsers,
  setAdminActiveTicket,
} from '@tg-games/core/db/repositories/users.js';
import {
  countUserSessions,
  getSessionByIdForAdmin,
  listUserSessionsPaged,
} from '@tg-games/core/db/repositories/sessions.js';
import {
  getGameGroup,
  isValidGroupId,
  listGameGroups,
  listGameGroupsForGame,
  parseGameIdsInput,
  parseGroupIdsInput,
  refreshGameIdsForGroup,
  setGameGroupGameIds,
  setGameGroupsForGame,
  upsertGameGroup,
} from '@tg-games/core/db/repositories/gameGroups.js';
import { listSteps } from '@tg-games/core/db/repositories/steps.js';
import {
  addSupportMessage,
  closeTicket,
  getAdminReadDate,
  getTicketById,
  getUnreadUserMessages,
  listActiveTicketsForAdmin,
  markTicketRead,
} from '@tg-games/core/db/repositories/support.js';
import { formatUserLabel, ticketClosedMessage } from '../botSupport/messages.js';
import { sendReplyToClient } from '../botSupport/bot.js';
import { formatHistory } from '../bot/format.js';
import {
  countGameManifests,
  getGameManifest,
  getGameManifestMap,
  getGameTitleMap,
  listGameManifestsPaged,
  updateGameManifest,
} from '@tg-games/core/db/repositories/gameManifests.js';
import { parseGameManifestInput } from '@tg-games/core/engine/validation.js';
import {
  PAGE_SIZE,
  adminGameBackKeyboard,
  adminGameDetailKeyboard,
  adminGameGroupsKeyboard,
  adminGameManifestKeyboard,
  adminGamesKeyboard,
  emptyUserSessionsKeyboard,
  gameDetailKeyboard,
  groupBackKeyboard,
  groupDetailKeyboard,
  groupListKeyboard,
  ticketActionsKeyboard,
  topicsKeyboard,
  userSessionsKeyboard,
  usersKeyboard,
  CB,
} from './menus.js';
import {
  ADMIN_START_TEXT,
  GAME_NOT_FOUND_TEXT,
  GROUP_ID_PROMPT,
  GROUP_NOT_FOUND_TEXT,
  NO_GAMES_TEXT,
  NO_ACTIVE_TICKET_TEXT,
  NO_TOPICS_TEXT,
  NO_USERS_TEXT,
  TICKET_UNAVAILABLE_TEXT,
  USER_NOT_FOUND_TEXT,
  formatAdminGameDetail,
  formatAdminGameGroups,
  formatGroupDetail,
  formatGameManifestJson,
  formatIncomingMessage,
  gameGroupsEditPrompt,
  gameDetailText,
  gameManifestEditPrompt,
  gamesListHeader,
  groupGamesPrompt,
  groupsListHeader,
  invalidGameIdsText,
  invalidGroupIdsText,
  replySentText,
  ticketClosedConfirmText,
  ticketOpenedHeader,
  userGamesHeader,
  usersListHeader,
} from './format.js';

/** Контекст бота администраторов: middleware гарантирует наличие `admin`. */
interface AdminContext extends Context {
  admin: UserRow;
}

type GroupInputState =
  | { mode: 'create_group_id' }
  | { mode: 'create_game_ids'; groupId: string }
  | { mode: 'edit_game_ids'; groupId: string };

type GameInputState =
  | { mode: 'edit_manifest'; gameId: string }
  | { mode: 'edit_game_groups'; gameId: string };

/** Зависимости бота администраторов поддержки. */
export interface AdminSupportDeps {
  /**
   * Клиент Telegram API клиентского бота — через него ответы администратора
   * доставляются клиенту, создавшему обращение.
   */
  clientNotifier: Pick<Telegram, 'sendMessage'>;
}

/**
 * Создаёт бот администраторов службы поддержки.
 *
 * Все обновления проходят через middleware проверки прав: если пользователя
 * с таким telegram_id нет или у него нет флага is_admin — обновление молча
 * игнорируется (issue #57).
 */
export function createAdminSupportBot(config: AppConfig, deps: AdminSupportDeps): Telegraf<AdminContext> {
  const bot = new Telegraf<AdminContext>(config.support.adminBotToken);
  const groupInputState = new Map<string, GroupInputState>();
  const gameInputState = new Map<string, GameInputState>();

  function clearInputState(adminId: string): void {
    groupInputState.delete(adminId);
    gameInputState.delete(adminId);
  }

  // ===== Проверка прав администратора =====
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    const user = await getUserByTelegramId(ctx.from.id);
    if (!user || !user.is_admin) {
      // Нет пользователя или не администратор — ничего не делаем.
      return;
    }
    ctx.admin = user;
    await next();
  });

  bot.start(async (ctx) => {
    await ctx.reply(ADMIN_START_TEXT);
  });

  // ===== Список активных обращений =====
  bot.command('topics', async (ctx) => {
    const tickets = await listActiveTicketsForAdmin(ctx.admin.id);
    if (tickets.length === 0) {
      await ctx.reply(NO_TOPICS_TEXT);
      return;
    }
    await ctx.reply('Активные обращения:', topicsKeyboard(tickets));
  });

  // ===== Открытие обращения =====
  // Делает обращение текущим для администратора, присылает непрочитанные
  // сообщения клиента и сдвигает отметку прочтения.
  bot.action(/^topic:(.+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery();

    const ticket = await getTicketById(ticketId);
    // Администратор работает только с переданными ему обращениями (issue #244).
    if (!ticket || ticket.status !== 'escalated') {
      await ctx.reply(TICKET_UNAVAILABLE_TEXT);
      return;
    }

    const client = await getUserById(ticket.user_id);
    const since = await getAdminReadDate(ctx.admin.id, ticketId);
    const unread = await getUnreadUserMessages(ticketId, since);

    await setAdminActiveTicket(ctx.admin.id, ticketId);

    const label = client
      ? formatUserLabel(client.username, client.telegram_id)
      : `обращение #${ticket.number}`;
    await ctx.reply(
      ticketOpenedHeader({
        ticketNumber: ticket.number,
        userLabel: label,
        unreadCount: unread.length,
      }),
    );
    for (const m of unread) {
      await ctx.reply(formatIncomingMessage(m));
    }

    // Сдвигаем отметку прочтения до последнего показанного сообщения,
    // а при отсутствии новых — на текущий момент (фиксируем факт открытия).
    const readUpTo = unread.length > 0 ? unread[unread.length - 1].created_at : new Date();
    await markTicketRead(ctx.admin.id, ticketId, readUpTo);

    // Кнопка закрытия обращения.
    await ctx.reply('Действия:', ticketActionsKeyboard(ticketId));
  });

  // ===== Закрытие обращения =====
  bot.action(/^close_ticket:(.+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery();

    const closed = await closeTicket(ticketId);
    if (!closed) {
      await ctx.reply(TICKET_UNAVAILABLE_TEXT);
      return;
    }

    // Сбрасываем активное обращение администратора, если оно совпадает с закрытым.
    if (ctx.admin.active_support_ticket_id === ticketId) {
      await setAdminActiveTicket(ctx.admin.id, null);
    }

    // Уведомляем клиента о закрытии.
    const client = await getUserById(closed.user_id);
    if (client) {
      try {
        await deps.clientNotifier.sendMessage(
          Number(client.telegram_id),
          ticketClosedMessage(closed.number),
        );
      } catch (err) {
        console.error(`Не удалось уведомить клиента ${client.telegram_id} о закрытии:`, err);
      }
    }

    await ctx.reply(ticketClosedConfirmText(closed.number));
  });

  // ===== Просмотр данных по играм (issue #62) =====

  /**
   * Рендерит страницу списка пользователей. При первом показе (команда /users)
   * отправляет новое сообщение, при пагинации — редактирует текущее, чтобы
   * список «перелистывался» в том же сообщении.
   */
  async function renderUsersPage(ctx: AdminContext, page: number, edit: boolean): Promise<void> {
    const total = await countUsers();
    if (total === 0) {
      if (edit) await ctx.editMessageText(NO_USERS_TEXT);
      else await ctx.reply(NO_USERS_TEXT);
      return;
    }
    const safePage = Math.min(Math.max(page, 0), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    const users = await listUsers(PAGE_SIZE, safePage * PAGE_SIZE);
    const text = usersListHeader(total);
    const keyboard = usersKeyboard(users, safePage, total);
    if (edit) await ctx.editMessageText(text, keyboard);
    else await ctx.reply(text, keyboard);
  }

  async function renderGroupsList(ctx: AdminContext, edit: boolean): Promise<void> {
    const groups = await listGameGroups();
    const text = groupsListHeader(groups.length);
    const keyboard = groupListKeyboard(groups);
    if (edit) await ctx.editMessageText(text, keyboard);
    else await ctx.reply(text, keyboard);
  }

  async function renderGroupDetail(
    ctx: AdminContext,
    groupId: string,
    edit: boolean,
  ): Promise<void> {
    const group = await getGameGroup(groupId);
    if (!group) {
      if (edit) await ctx.editMessageText(GROUP_NOT_FOUND_TEXT, groupBackKeyboard());
      else await ctx.reply(GROUP_NOT_FOUND_TEXT, groupBackKeyboard());
      return;
    }
    const gameTitles = await getGameTitleMap(group.game_ids);
    const text = formatGroupDetail(group, gameTitles);
    const keyboard = groupDetailKeyboard(group.group_id);
    if (edit) await ctx.editMessageText(text, keyboard);
    else await ctx.reply(text, keyboard);
  }

  async function renderAdminGamesPage(ctx: AdminContext, page: number, edit: boolean): Promise<void> {
    const total = await countGameManifests();
    if (total === 0) {
      if (edit) await ctx.editMessageText(NO_GAMES_TEXT);
      else await ctx.reply(NO_GAMES_TEXT);
      return;
    }
    const safePage = Math.min(Math.max(page, 0), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    const games = await listGameManifestsPaged(PAGE_SIZE, safePage * PAGE_SIZE);
    const text = gamesListHeader(total);
    const keyboard = adminGamesKeyboard(games, safePage, total);
    if (edit) await ctx.editMessageText(text, keyboard);
    else await ctx.reply(text, keyboard);
  }

  async function renderAdminGameDetail(
    ctx: AdminContext,
    gameId: string,
    edit: boolean,
  ): Promise<void> {
    const manifest = await getGameManifest(gameId);
    if (!manifest) {
      if (edit) await ctx.editMessageText(GAME_NOT_FOUND_TEXT);
      else await ctx.reply(GAME_NOT_FOUND_TEXT);
      return;
    }
    const groups = await listGameGroupsForGame(gameId);
    const text = formatAdminGameDetail(manifest, groups);
    const keyboard = adminGameDetailKeyboard(gameId);
    if (edit) await ctx.editMessageText(text, keyboard);
    else await ctx.reply(text, keyboard);
  }

  async function renderAdminGameManifest(ctx: AdminContext, gameId: string): Promise<void> {
    const manifest = await getGameManifest(gameId);
    if (!manifest) {
      await ctx.editMessageText(GAME_NOT_FOUND_TEXT);
      return;
    }
    await ctx.editMessageText(formatGameManifestJson(manifest), adminGameManifestKeyboard(gameId));
  }

  async function renderAdminGameGroups(ctx: AdminContext, gameId: string): Promise<void> {
    const manifest = await getGameManifest(gameId);
    if (!manifest) {
      await ctx.editMessageText(GAME_NOT_FOUND_TEXT);
      return;
    }
    const groups = await listGameGroupsForGame(gameId);
    await ctx.editMessageText(formatAdminGameGroups(manifest, groups), adminGameGroupsKeyboard(gameId));
  }

  // Команда /users — список пользователей с пагинацией.
  bot.command('users', async (ctx) => {
    clearInputState(ctx.admin.id);
    await renderUsersPage(ctx, 0, false);
  });

  // Команда /groups — справочник групп сценариев.
  bot.command('groups', async (ctx) => {
    clearInputState(ctx.admin.id);
    await renderGroupsList(ctx, false);
  });

  // Команда /games — справочник сценариев, манифесты и группы доступа.
  bot.command('games', async (ctx) => {
    clearInputState(ctx.admin.id);
    await renderAdminGamesPage(ctx, 0, false);
  });

  // Перелистывание списка пользователей.
  bot.action(/^users:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await renderUsersPage(ctx, Number(ctx.match[1]), true);
  });

  // Перелистывание списка сценариев.
  bot.action(/^games:(\d+)$/, async (ctx) => {
    clearInputState(ctx.admin.id);
    await ctx.answerCbQuery();
    await renderAdminGamesPage(ctx, Number(ctx.match[1]), true);
  });

  // Карточка сценария с группами доступа.
  bot.action(/^admg:([A-Za-z0-9_-]+)$/, async (ctx) => {
    clearInputState(ctx.admin.id);
    await ctx.answerCbQuery();
    await renderAdminGameDetail(ctx, ctx.match[1], true);
  });

  // JSON-манифест сценария.
  bot.action(/^adgm:([A-Za-z0-9_-]+)$/, async (ctx) => {
    clearInputState(ctx.admin.id);
    await ctx.answerCbQuery();
    await renderAdminGameManifest(ctx, ctx.match[1]);
  });

  // Включает режим ввода нового JSON-манифеста.
  bot.action(/^adgmedit:([A-Za-z0-9_-]+)$/, async (ctx) => {
    const gameId = ctx.match[1];
    const manifest = await getGameManifest(gameId);
    await ctx.answerCbQuery();
    if (!manifest) {
      await ctx.editMessageText(GAME_NOT_FOUND_TEXT);
      return;
    }
    groupInputState.delete(ctx.admin.id);
    gameInputState.set(ctx.admin.id, { mode: 'edit_manifest', gameId });
    await ctx.editMessageText(gameManifestEditPrompt(manifest), adminGameBackKeyboard(gameId));
  });

  // Группы, в которых доступен сценарий.
  bot.action(/^adgg:([A-Za-z0-9_-]+)$/, async (ctx) => {
    clearInputState(ctx.admin.id);
    await ctx.answerCbQuery();
    await renderAdminGameGroups(ctx, ctx.match[1]);
  });

  // Включает режим ввода списка групп для сценария.
  bot.action(/^adggedit:([A-Za-z0-9_-]+)$/, async (ctx) => {
    const gameId = ctx.match[1];
    const manifest = await getGameManifest(gameId);
    await ctx.answerCbQuery();
    if (!manifest) {
      await ctx.editMessageText(GAME_NOT_FOUND_TEXT);
      return;
    }
    const groups = await listGameGroupsForGame(gameId);
    groupInputState.delete(ctx.admin.id);
    gameInputState.set(ctx.admin.id, { mode: 'edit_game_groups', gameId });
    await ctx.editMessageText(gameGroupsEditPrompt(manifest, groups), adminGameBackKeyboard(gameId));
  });

  // Возврат к списку групп.
  bot.action(CB.groupList, async (ctx) => {
    clearInputState(ctx.admin.id);
    await ctx.answerCbQuery();
    await renderGroupsList(ctx, true);
  });

  // Создание группы: первый шаг — ввод group_id.
  bot.action(CB.groupCreate, async (ctx) => {
    gameInputState.delete(ctx.admin.id);
    groupInputState.set(ctx.admin.id, { mode: 'create_group_id' });
    await ctx.answerCbQuery();
    await ctx.editMessageText(GROUP_ID_PROMPT, groupBackKeyboard());
  });

  // Карточка группы с перечнем игр.
  bot.action(/^grp:([A-Za-z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await renderGroupDetail(ctx, ctx.match[1], true);
  });

  // Редактирование списка игр группы.
  bot.action(/^grpedit:([A-Za-z0-9_-]+)$/, async (ctx) => {
    const groupId = ctx.match[1];
    const group = await getGameGroup(groupId);
    await ctx.answerCbQuery();
    if (!group) {
      await ctx.editMessageText(GROUP_NOT_FOUND_TEXT, groupBackKeyboard());
      return;
    }
    gameInputState.delete(ctx.admin.id);
    groupInputState.set(ctx.admin.id, { mode: 'edit_game_ids', groupId });
    await ctx.editMessageText(groupGamesPrompt(group.group_id, group.game_ids), groupBackKeyboard());
  });

  // Клик по пользователю → список его игр (с пагинацией) в том же сообщении.
  bot.action(/^usrg:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.match[1];
    const page = Number(ctx.match[2]);

    const user = await getUserById(userId);
    if (!user) {
      await ctx.editMessageText(USER_NOT_FOUND_TEXT);
      return;
    }

    const total = await countUserSessions(userId);
    const label = formatUserLabel(user.username, user.telegram_id);
    if (total === 0) {
      await ctx.editMessageText(userGamesHeader(label, 0), emptyUserSessionsKeyboard());
      return;
    }

    const safePage = Math.min(Math.max(page, 0), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    const sessions = await listUserSessionsPaged(userId, PAGE_SIZE, safePage * PAGE_SIZE);
    const gameTitles = await getGameTitleMap(sessions.map((session) => session.game_id));
    await ctx.editMessageText(
      userGamesHeader(label, total),
      userSessionsKeyboard(sessions, userId, safePage, total, gameTitles),
    );
  });

  // Клик по игре → последний статус игры и кнопка скачивания истории ходов.
  bot.action(/^game:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = await getSessionByIdForAdmin(ctx.match[1]);
    if (!session) {
      await ctx.editMessageText(GAME_NOT_FOUND_TEXT);
      return;
    }
    const gameTitles = await getGameTitleMap([session.game_id]);
    await ctx.editMessageText(gameDetailText(session, gameTitles), gameDetailKeyboard(session));
  });

  // Скачивание истории ходов игры файлом (отдельным сообщением).
  bot.action(/^usrh:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = await getSessionByIdForAdmin(ctx.match[1]);
    if (!session) {
      await ctx.reply(GAME_NOT_FOUND_TEXT);
      return;
    }
    const steps = await listSteps(session.id);
    const filename = `${session.game_id}_${session.id}_history.txt`;
    const document = Input.fromBuffer(Buffer.from(formatHistory(steps), 'utf8'), filename);
    await ctx.replyWithDocument(document);
  });

  // Кнопка-индикатор страницы — ничего не делает, только гасит «часики».
  bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery();
  });

  async function handleGameInput(
    ctx: AdminContext,
    state: GameInputState,
    text: string,
  ): Promise<void> {
    if (state.mode === 'edit_manifest') {
      let manifest;
      try {
        manifest = parseGameManifestInput(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Невалидный JSON манифеста';
        await ctx.reply(`${message}. Отправьте JSON заново.`, adminGameBackKeyboard(state.gameId));
        return;
      }

      if (manifest.id !== state.gameId) {
        await ctx.reply(
          `id манифеста должен остаться ${state.gameId}. Отправьте JSON заново.`,
          adminGameBackKeyboard(state.gameId),
        );
        return;
      }

      const updated = await updateGameManifest(state.gameId, manifest);
      gameInputState.delete(ctx.admin.id);
      if (!updated) {
        await ctx.reply(GAME_NOT_FOUND_TEXT);
        return;
      }
      const groups = await listGameGroupsForGame(updated.id);
      await ctx.reply(formatAdminGameDetail(updated, groups), adminGameDetailKeyboard(updated.id));
      return;
    }

    const groupIds = parseGroupIdsInput(text);
    const invalid = groupIds.filter((groupId) => !isValidGroupId(groupId));
    if (invalid.length > 0) {
      await ctx.reply(invalidGroupIdsText(invalid), adminGameBackKeyboard(state.gameId));
      return;
    }

    try {
      await setGameGroupsForGame(state.gameId, groupIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось обновить группы';
      await ctx.reply(`${message}. Введите список заново.`, adminGameBackKeyboard(state.gameId));
      return;
    }

    const manifest = await getGameManifest(state.gameId);
    gameInputState.delete(ctx.admin.id);
    if (!manifest) {
      await ctx.reply(GAME_NOT_FOUND_TEXT);
      return;
    }
    const groups = await listGameGroupsForGame(state.gameId);
    await ctx.reply(formatAdminGameGroups(manifest, groups), adminGameGroupsKeyboard(state.gameId));
  }

  async function handleGroupInput(
    ctx: AdminContext,
    state: GroupInputState,
    text: string,
  ): Promise<void> {
    const value = text.trim();
    if (state.mode === 'create_group_id') {
      if (!isValidGroupId(value)) {
        await ctx.reply('Некорректный group_id. Используйте латиницу, цифры, "-" или "_".');
        return;
      }
      const existing = await getGameGroup(value);
      if (existing) {
        await ctx.reply('Такая группа уже существует. Введите другой group_id.');
        return;
      }
      groupInputState.set(ctx.admin.id, { mode: 'create_game_ids', groupId: value });
      await ctx.reply(groupGamesPrompt(value));
      return;
    }

    const gameIds = parseGameIdsInput(value);
    if (gameIds.length === 0) {
      await ctx.reply('Введите хотя бы один game_id.');
      return;
    }
    const manifests = await getGameManifestMap(gameIds);
    const invalid = gameIds.filter((gameId) => !manifests.has(gameId));
    if (invalid.length > 0) {
      await ctx.reply(invalidGameIdsText(invalid));
      return;
    }

    if (state.mode === 'create_game_ids') {
      const group = await upsertGameGroup(state.groupId, gameIds);
      await refreshGameIdsForGroup(state.groupId);
      groupInputState.delete(ctx.admin.id);
      const gameTitles = await getGameTitleMap(group.game_ids);
      await ctx.reply(formatGroupDetail(group, gameTitles), groupDetailKeyboard(group.group_id));
      return;
    }

    const group = await setGameGroupGameIds(state.groupId, gameIds);
    if (!group) {
      groupInputState.delete(ctx.admin.id);
      await ctx.reply(GROUP_NOT_FOUND_TEXT, groupBackKeyboard());
      return;
    }
    await refreshGameIdsForGroup(state.groupId);
    groupInputState.delete(ctx.admin.id);
    const gameTitles = await getGameTitleMap(group.game_ids);
    await ctx.reply(formatGroupDetail(group, gameTitles), groupDetailKeyboard(group.group_id));
  }

  // ===== Ответ администратора клиенту =====
  // Любое текстовое сообщение направляется в текущее обращение администратора,
  // сохраняется в БД и доставляется клиенту, создавшему обращение.
  bot.on(message('text'), async (ctx) => {
    const admin = ctx.admin;
    const text = ctx.message.text;

    const pendingGameInput = gameInputState.get(admin.id);
    if (pendingGameInput) {
      await handleGameInput(ctx, pendingGameInput, text);
      return;
    }

    const pendingGroupInput = groupInputState.get(admin.id);
    if (pendingGroupInput) {
      await handleGroupInput(ctx, pendingGroupInput, text);
      return;
    }

    if (!admin.active_support_ticket_id) {
      await ctx.reply(NO_ACTIVE_TICKET_TEXT);
      return;
    }

    const ticket = await getTicketById(admin.active_support_ticket_id);
    // Отвечать можно только в переданном оператору обращении (issue #244).
    if (!ticket || ticket.status !== 'escalated') {
      await setAdminActiveTicket(admin.id, null);
      await ctx.reply(TICKET_UNAVAILABLE_TEXT);
      return;
    }

    await addSupportMessage({
      ticketId: ticket.id,
      sender: 'admin',
      senderId: admin.id,
      text,
    });

    const client = await getUserById(ticket.user_id);
    if (client) {
      try {
        await sendReplyToClient(deps.clientNotifier, client.telegram_id, text);
      } catch (err) {
        console.error(`Не удалось доставить ответ клиенту ${client.telegram_id}:`, err);
        await ctx.reply('⚠️ Не удалось доставить ответ клиенту (возможно, он остановил бота).');
        return;
      }
    }

    await ctx.reply(replySentText(ticket.number));
  });

  return bot;
}
