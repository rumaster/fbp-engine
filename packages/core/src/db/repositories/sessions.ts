import { getPool } from '../pool.js';
import type { GameState } from '../../types.js';
import type { TokenUsage } from '../../llm/pricing.js';

export interface SessionRow {
  id: string;
  game_id: string;
  user_id: string;
  is_active: boolean;
  is_processing: boolean;
  current_state: GameState;
  /** Бюджет сессии в миллицентах (пополняется при покупке звезды). */
  allocated_millicents: number;
  /** Суммарно израсходованные токены за всю сессию. */
  used_credits: number;
  /** Суммарный расход токенов по категориям за всю сессию (JSONB). */
  token_usage: TokenUsage;
  /** Оценка суммарной стоимости сессии в тысячных долях цента (миллицентах). */
  cost_millicents: number;
  created_at: Date;
}

/**
 * Создаёт новую игровую сессию и делает её текущей («активной») для игрока.
 *
 * Предыдущие игры НЕ завершаются (is_active у них сохраняется) — игрок может
 * вернуться к ним через «Мои игры». Меняется лишь указатель текущей игры
 * (users.active_session_id). Всё выполняется в одной транзакции.
 */
export async function createSession(
  userId: string,
  gameId: string,
  initialState: GameState,
  allocatedMillicents = 0,
): Promise<SessionRow> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<SessionRow>(
      `INSERT INTO game_sessions (game_id, user_id, is_active, current_state, allocated_millicents)
       VALUES ($1, $2, TRUE, $3, $4)
       RETURNING *`,
      [gameId, userId, JSON.stringify(initialState), allocatedMillicents],
    );
    await client.query('UPDATE users SET active_session_id = $2 WHERE id = $1', [
      userId,
      rows[0].id,
    ]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Возвращает текущую («активную») сессию игрока — ту, на которую указывает
 * users.active_session_id, — или null, если игрок не выбрал игру.
 */
export async function getActiveSession(userId: string): Promise<SessionRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<SessionRow>(
    `SELECT s.* FROM game_sessions s
     JOIN users u ON u.active_session_id = s.id
     WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Возвращает сессию по id, проверяя принадлежность пользователю, или null. */
export async function getSessionById(
  sessionId: string,
  userId: string,
): Promise<SessionRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<SessionRow>(
    'SELECT * FROM game_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  return rows[0] ?? null;
}

/** Возвращает все сессии пользователя (история «Мои игры»). */
export async function listUserSessions(userId: string): Promise<SessionRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SessionRow>(
    'SELECT * FROM game_sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows;
}

/**
 * Возвращает страницу сессий пользователя для админ-просмотра (issue #62).
 * Сортировка совпадает с listUserSessions — свежие игры сверху.
 */
export async function listUserSessionsPaged(
  userId: string,
  limit: number,
  offset: number,
): Promise<SessionRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SessionRow>(
    'SELECT * FROM game_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [userId, limit, offset],
  );
  return rows;
}

/**
 * Возвращает сессию по id без проверки владельца — для админ-просмотра (issue #62).
 * Обычный игровой бот использует getSessionById, который дополнительно сверяет
 * user_id; администратору же нужно видеть чужие игры.
 */
export async function getSessionByIdForAdmin(sessionId: string): Promise<SessionRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<SessionRow>(
    'SELECT * FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  return rows[0] ?? null;
}

/** Возвращает количество сессий пользователя (для проверки триала). */
export async function countUserSessions(userId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM game_sessions WHERE user_id = $1',
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Обновляет текущее состояние сессии. */
export async function updateSessionState(
  sessionId: string,
  state: GameState,
): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE game_sessions SET current_state = $2 WHERE id = $1', [
    sessionId,
    JSON.stringify(state),
  ]);
}

/**
 * Атомарно захватывает блокировку обработки хода: устанавливает is_processing = TRUE
 * только если флаг ещё не установлен. Возвращает true при успехе, false если
 * сессия уже обрабатывается (двойной клик).
 */
export async function acquireProcessingLock(sessionId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE game_sessions SET is_processing = TRUE
     WHERE id = $1 AND is_processing = FALSE`,
    [sessionId],
  );
  return (rowCount ?? 0) > 0;
}

/** Снимает блокировку обработки хода. */
export async function releaseProcessingLock(sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE game_sessions SET is_processing = FALSE WHERE id = $1', [
    sessionId,
  ]);
}

/**
 * Атомарно увеличивает used_credits сессии на указанное число токенов.
 * Используется после каждого хода/подсказки.
 */
export async function addUsedCredits(sessionId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  const pool = getPool();
  await pool.query(
    'UPDATE game_sessions SET used_credits = used_credits + $2 WHERE id = $1',
    [sessionId, credits],
  );
}

/**
 * Пополняет бюджет сессии (в миллицентах) — например, при покупке дополнительной звезды.
 */
export async function addAllocatedMillicents(sessionId: string, millicents: number): Promise<void> {
  if (millicents <= 0) return;
  const pool = getPool();
  await pool.query(
    'UPDATE game_sessions SET allocated_millicents = allocated_millicents + $2 WHERE id = $1',
    [sessionId, millicents],
  );
}

/**
 * Атомарно добавляет детализацию токенов и стоимость к накопительным счётчикам сессии.
 * Обновляет JSONB-поле token_usage и целочисленное cost_millicents одним запросом.
 */
export async function addTokenUsageAndCost(
  sessionId: string,
  usage: TokenUsage,
  costMillicents: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE game_sessions
     SET token_usage = jsonb_build_object(
           'inputTokens',        (token_usage->>'inputTokens')::int + $2,
           'outputTokens',       (token_usage->>'outputTokens')::int + $3,
           'cacheReadTokens',    (token_usage->>'cacheReadTokens')::int + $4,
           'cacheCreationTokens',(token_usage->>'cacheCreationTokens')::int + $5
         ),
         cost_millicents = cost_millicents + $6
     WHERE id = $1`,
    [
      sessionId,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      costMillicents,
    ],
  );
}

/**
 * Завершает сессию (например, при game over): помечает её как неактивную
 * и сбрасывает указатель текущей игры у всех игроков, на неё ссылавшихся.
 * Завершённая игра остаётся в истории «Мои игры».
 */
export async function finishSession(sessionId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE game_sessions SET is_active = FALSE WHERE id = $1', [
      sessionId,
    ]);
    await client.query('UPDATE users SET active_session_id = NULL WHERE active_session_id = $1', [
      sessionId,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
