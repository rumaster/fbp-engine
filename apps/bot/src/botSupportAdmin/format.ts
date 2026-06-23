/**
 * Чистые построители текстов бота администраторов поддержки.
 * Вынесены отдельно от обработчиков, чтобы покрывать их юнит-тестами.
 */
import type { SupportMessageRow } from '@tg-games/core/db/repositories/support.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import type { GameGroupRow } from '@tg-games/core/db/repositories/gameGroups.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import type { GameTitleMap } from '@tg-games/core/db/repositories/gameManifests.js';
import { formatStatus } from '../bot/format.js';

/**
 * Форматирование даты/времени для администратора.
 * Фиксированная зона Europe/Moscow делает вывод детерминированным независимо
 * от часового пояса сервера (важно и для тестов).
 */
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});

/** Возвращает дату/время в формате «ДД.ММ, ЧЧ:ММ» (МСК). */
export function formatDateTime(date: Date): string {
  return DATE_TIME_FORMAT.format(date);
}

/** Приветствие бота администраторов. */
export const ADMIN_START_TEXT = [
  '🛠 Бот службы поддержки (администрирование).',
  '',
  '/topics — список активных обращений.',
  '/users — список пользователей и их игр.',
  '/games — сценарии, манифесты и группы.',
  '/groups — группы доступных сценариев.',
  'Выберите обращение, чтобы прочитать новые сообщения и отвечать клиенту прямо здесь.',
].join('\n');

/** Сообщение, когда активных обращений нет. */
export const NO_TOPICS_TEXT = '✅ Активных обращений нет.';

/** Подсказка администратору выбрать обращение, прежде чем отвечать. */
export const NO_ACTIVE_TICKET_TEXT =
  'Сейчас не выбрано ни одного обращения. Откройте список командой /topics и выберите обращение.';

/**
 * Текст-заголовок при открытии обращения администратором.
 * Показывает номер обращения и клиента; ниже отдельными сообщениями идут
 * непрочитанные сообщения клиента.
 */
export function ticketOpenedHeader(input: {
  ticketNumber: string | number;
  userLabel: string;
  unreadCount: number;
}): string {
  const { ticketNumber, userLabel, unreadCount } = input;
  if (unreadCount === 0) {
    return [
      `📂 Обращение #${ticketNumber} от ${userLabel}.`,
      'Новых сообщений нет. Можете написать ответ — он уйдёт клиенту.',
    ].join('\n');
  }
  const plural = unreadCount === 1 ? 'новое сообщение' : 'новых сообщений';
  return [
    `📂 Обращение #${ticketNumber} от ${userLabel}. ${unreadCount} ${plural}:`,
  ].join('\n');
}

/** Форматирует одно входящее сообщение клиента для администратора. */
export function formatIncomingMessage(message: Pick<SupportMessageRow, 'text' | 'created_at'>): string {
  return `🗨 ${formatDateTime(message.created_at)}\n${message.text}`;
}

/** Подтверждение администратору, что ответ доставлен клиенту. */
export function replySentText(ticketNumber: string | number): string {
  return `✅ Ответ отправлен клиенту (обращение #${ticketNumber}).`;
}

/** Подтверждение администратору о закрытии обращения. */
export function ticketClosedConfirmText(ticketNumber: string | number): string {
  return `🔒 Обращение #${ticketNumber} закрыто. Клиент получил уведомление.`;
}

/** Сообщение администратору, если его активное обращение уже закрыто/не найдено. */
export const TICKET_UNAVAILABLE_TEXT =
  'Выбранное обращение недоступно. Откройте список командой /topics и выберите другое.';

// ===== Просмотр данных по играм (issue #62) =====

/** Сообщение, когда зарегистрированных пользователей нет. */
export const NO_USERS_TEXT = 'Пользователей пока нет.';

/** Сообщение, если выбранный пользователь не найден. */
export const USER_NOT_FOUND_TEXT = 'Пользователь не найден.';

/** Сообщение, если выбранная игра не найдена. */
export const GAME_NOT_FOUND_TEXT = 'Игра не найдена.';

/** Заголовок страницы списка пользователей. */
export function usersListHeader(total: number): string {
  return `👥 Пользователи (всего: ${total}). Выберите пользователя, чтобы посмотреть его игры:`;
}

/** Заголовок страницы списка игр пользователя. */
export function userGamesHeader(userLabel: string, total: number): string {
  if (total === 0) {
    return `🎮 У пользователя ${userLabel} нет игр.`;
  }
  return `🎮 Игры пользователя ${userLabel} (всего: ${total}):`;
}

/**
 * Карточка игры для администратора: заголовок с метаданными сессии плюс
 * последний статус игры (переиспользует formatStatus игрового бота).
 */
export function gameDetailText(session: SessionRow, gameTitles: GameTitleMap = new Map()): string {
  const title = gameTitles.get(session.game_id) ?? session.game_id;
  const header = [
    `🎮 Игра: ${title}`,
    `🆔 Сессия: ${session.id}`,
    `📅 Начата: ${formatDateTime(session.created_at)}`,
    `Состояние: ${session.is_active ? 'активна' : 'завершена'}`,
    '',
  ].join('\n');
  return header + formatStatus(session.current_state, session);
}

// ===== Группы сценариев (issue #100) =====

export const GROUP_NOT_FOUND_TEXT = 'Группа не найдена.';

export const GROUP_ID_PROMPT = [
  'Создание группы сценариев.',
  '',
  'Введите group_id: латиница, цифры, "-" или "_".',
].join('\n');

export function groupGamesPrompt(groupId: string, gameIds: string[] = []): string {
  const games = gameIds.length === 0 ? 'нет доступных сценариев' : gameIds.join(', ');
  return [
    `Группа: ${groupId}`,
    `Игры: ${games}`,
    '',
    'Введите список game_id через запятую.',
  ].join('\n');
}

export function groupsListHeader(total: number): string {
  return `🎮 Группы сценариев (всего: ${total}). Выберите группу:`;
}

export function formatGroupDetail(
  group: GameGroupRow,
  gameTitles: GameTitleMap = new Map(),
): string {
  const games =
    group.game_ids.length === 0
      ? ['нет доступных сценариев']
      : group.game_ids.map((gameId) => {
          const title = gameTitles.get(gameId) ?? gameId;
          return `- ${title} (${gameId})`;
        });
  return [
    `🎮 Группа: ${group.group_id}`,
    '',
    'Доступные сценарии:',
    ...games,
  ].join('\n');
}

export function invalidGameIdsText(gameIds: string[]): string {
  return `Неизвестные game_id: ${gameIds.join(', ')}. Введите список заново.`;
}

// ===== Администрирование сценариев (/games, issue #109) =====

const TELEGRAM_TEXT_LIMIT = 4096;

/** Сообщение, когда манифестов сценариев нет. */
export const NO_GAMES_TEXT = 'Сценариев пока нет.';

/** Заголовок страницы списка сценариев. */
export function gamesListHeader(total: number): string {
  return `🎮 Игры (всего: ${total}). Выберите сценарий:`;
}

function formatGroupIds(groups: Pick<GameGroupRow, 'group_id'>[]): string[] {
  if (groups.length === 0) return ['нет групп'];
  return groups.map((group) => `- ${group.group_id}`);
}

/** Карточка сценария: id, название и группы, где он доступен. */
export function formatAdminGameDetail(
  manifest: Pick<GameManifest, 'id' | 'name'>,
  groups: Pick<GameGroupRow, 'group_id'>[],
): string {
  return [
    `🎮 Игра: ${manifest.name}`,
    `🆔 id: ${manifest.id}`,
    '',
    'Группы:',
    ...formatGroupIds(groups),
  ].join('\n');
}

/** Экран групп сценария. */
export function formatAdminGameGroups(
  manifest: Pick<GameManifest, 'id' | 'name'>,
  groups: Pick<GameGroupRow, 'group_id'>[],
): string {
  return [
    `👥 Группы игры: ${manifest.name}`,
    `🆔 id: ${manifest.id}`,
    '',
    'Сценарий доступен в группах:',
    ...formatGroupIds(groups),
  ].join('\n');
}

/**
 * JSON-манифест для Telegram-сообщения.
 *
 * У Telegram есть жёсткий лимит длины сообщения. Для коротких манифестов
 * показываем отформатированный JSON, для больших — компактный JSON или
 * безопасно обрезанный фрагмент с явной пометкой.
 */
export function formatGameManifestJson(manifest: GameManifest): string {
  const header = [`📄 Манифест: ${manifest.name}`, `🆔 id: ${manifest.id}`, ''].join('\n');
  const variants = [
    JSON.stringify(manifest, null, 2),
    JSON.stringify(manifest),
  ];
  for (const json of variants) {
    const text = `${header}${json}`;
    if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  }

  const compact = variants[1];
  const note = '\n\n... JSON не помещается в одно сообщение Telegram. Отправьте полный JSON при изменении.';
  const maxJsonLength = TELEGRAM_TEXT_LIMIT - header.length - note.length;
  return `${header}${compact.slice(0, Math.max(0, maxJsonLength))}${note}`;
}

export function gameManifestEditPrompt(manifest: Pick<GameManifest, 'id' | 'name'>): string {
  return [
    `Изменение манифеста: ${manifest.name}`,
    `id должен остаться ${manifest.id}.`,
    '',
    'Отправьте новый JSON манифеста одним сообщением.',
  ].join('\n');
}

export function gameGroupsEditPrompt(
  manifest: Pick<GameManifest, 'id' | 'name'>,
  groups: Pick<GameGroupRow, 'group_id'>[],
): string {
  return [
    `Изменение групп игры: ${manifest.name}`,
    `id: ${manifest.id}`,
    '',
    'Сейчас:',
    ...formatGroupIds(groups),
    '',
    'Введите group_id через запятую. Чтобы убрать игру из всех групп, отправьте "-".',
  ].join('\n');
}

export function invalidGroupIdsText(groupIds: string[]): string {
  return `Некорректные group_id: ${groupIds.join(', ')}. Используйте латиницу, цифры, "-" или "_".`;
}
