import { getPool } from '../pool.js';
import { DEFAULT_GROUP_ID } from './gameGroups.js';

export interface UserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  /** Получает LLM-логи после ходов и подсказок. */
  is_tester: boolean;
  /** Администратор службы поддержки (issue #57). */
  is_admin: boolean;
  /** Группы доступа к сценариям (issue #100). */
  groups: string[];
  /** Кеш доступных игроку game_id, собранный из его групп (issue #100). */
  game_ids: string[];
  /** Идентификатор текущей («активной») игровой сессии или null. */
  active_session_id: string | null;
  /** Текущее («активное») обращение поддержки у администратора или null. */
  active_support_ticket_id: string | null;
  created_at: Date;
}

/**
 * Возвращает существующего пользователя по telegram_id или создаёт нового.
 * Имя пользователя обновляется при каждом вызове.
 */
export async function upsertUser(telegramId: number, username?: string): Promise<UserRow> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `WITH default_access AS (
       SELECT COALESCE(
         (SELECT game_ids FROM game_groups WHERE group_id = $3),
         ARRAY[]::TEXT[]
       ) AS game_ids
     )
     INSERT INTO users (telegram_id, username, groups, game_ids)
     VALUES ($1, $2, ARRAY[$3]::TEXT[], (SELECT game_ids FROM default_access))
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = COALESCE(EXCLUDED.username, users.username)
     RETURNING *`,
    [telegramId, username ?? null, DEFAULT_GROUP_ID],
  );
  return rows[0];
}

/**
 * Устанавливает текущую («активную») игру пользователя.
 * Передайте null, чтобы сбросить указатель (например, при завершении игры).
 */
export async function setActiveSession(
  userId: string,
  sessionId: string | null,
): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE users SET active_session_id = $2 WHERE id = $1', [
    userId,
    sessionId,
  ]);
}

/** Возвращает пользователя по telegram_id или null. */
export async function getUserByTelegramId(telegramId: number): Promise<UserRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegramId],
  );
  return rows[0] ?? null;
}

/** Возвращает пользователя по внутреннему id или null. */
export async function getUserById(userId: string): Promise<UserRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] ?? null;
}

/** Возвращает общее число зарегистрированных пользователей (для пагинации). */
export async function countUsers(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM users',
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Возвращает страницу пользователей для админ-просмотра (issue #62).
 * Сортировка — по дате регистрации (свежие сверху); id добавлен для
 * детерминированного порядка при совпадении created_at.
 */
export async function listUsers(limit: number, offset: number): Promise<UserRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  return rows;
}

/** Возвращает всех администраторов службы поддержки (is_admin = TRUE). */
export async function listAdmins(): Promise<UserRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE is_admin = TRUE ORDER BY created_at ASC',
  );
  return rows;
}

/**
 * Выставляет флаг администратора пользователю с указанным telegram_id.
 * Создаёт пользователя, если его ещё нет (используется при бутстрапе админов).
 */
export async function setAdminByTelegramId(
  telegramId: number,
  isAdmin = true,
): Promise<UserRow> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `WITH default_access AS (
       SELECT COALESCE(
         (SELECT game_ids FROM game_groups WHERE group_id = $3),
         ARRAY[]::TEXT[]
       ) AS game_ids
     )
     INSERT INTO users (telegram_id, is_admin, groups, game_ids)
     VALUES ($1, $2, ARRAY[$3]::TEXT[], (SELECT game_ids FROM default_access))
     ON CONFLICT (telegram_id)
     DO UPDATE SET is_admin = EXCLUDED.is_admin
     RETURNING *`,
    [telegramId, isAdmin, DEFAULT_GROUP_ID],
  );
  return rows[0];
}

/**
 * Устанавливает текущее («активное») обращение поддержки администратора.
 * Передайте null, чтобы сбросить указатель.
 */
export async function setAdminActiveTicket(
  adminId: string,
  ticketId: string | null,
): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE users SET active_support_ticket_id = $2 WHERE id = $1', [
    adminId,
    ticketId,
  ]);
}
