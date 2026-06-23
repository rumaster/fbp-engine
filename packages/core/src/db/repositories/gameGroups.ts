import { getPool } from '../pool.js';
import type { UserRow } from './users.js';

export const DEFAULT_GROUP_ID = 'default';

const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;

export interface GameGroupRow {
  group_id: string;
  game_ids: string[];
  created_at: Date;
  updated_at: Date;
}

/** Проверяет формат group_id: короткий ASCII id без пробелов и разделителей callback_data. */
export function isValidGroupId(groupId: string): boolean {
  return GROUP_ID_RE.test(groupId);
}

/** Нормализует список game_id: trim, удаление пустых и дублей, стабильный порядок. */
export function normalizeGameIds(gameIds: readonly string[]): string[] {
  return [...new Set(gameIds.map((id) => id.trim()).filter(Boolean))].sort();
}

/** Разбирает ввод администратора вида `bomj, red_hood`. */
export function parseGameIdsInput(input: string): string[] {
  return normalizeGameIds(input.split(','));
}

/** Нормализует список group_id: trim, удаление пустых и дублей, стабильный порядок. */
export function normalizeGroupIds(groupIds: readonly string[]): string[] {
  return [...new Set(groupIds.map((id) => id.trim()).filter(Boolean))].sort();
}

/** Разбирает ввод администратора вида `default, kids`; "-" означает пустой список. */
export function parseGroupIdsInput(input: string): string[] {
  const value = input.trim();
  if (value === '-' || value === '—') return [];
  return normalizeGroupIds(value.split(','));
}

function assertValidGroupId(groupId: string): void {
  if (!isValidGroupId(groupId)) {
    throw new Error(`Недопустимый group_id: ${groupId}`);
  }
}

/** Возвращает все группы сценариев. */
export async function listGameGroups(): Promise<GameGroupRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<GameGroupRow>(
    'SELECT * FROM game_groups ORDER BY group_id ASC',
  );
  return rows;
}

/** Возвращает группу по id или null. */
export async function getGameGroup(groupId: string): Promise<GameGroupRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<GameGroupRow>(
    'SELECT * FROM game_groups WHERE group_id = $1',
    [groupId],
  );
  return rows[0] ?? null;
}

/** Возвращает группы, в которых доступен указанный сценарий. */
export async function listGameGroupsForGame(gameId: string): Promise<GameGroupRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<GameGroupRow>(
    'SELECT * FROM game_groups WHERE $1 = ANY(game_ids) ORDER BY group_id ASC',
    [gameId],
  );
  return rows;
}

/** Создаёт новую группу или заменяет список игр у существующей. */
export async function upsertGameGroup(
  groupId: string,
  gameIds: readonly string[],
): Promise<GameGroupRow> {
  assertValidGroupId(groupId);
  const pool = getPool();
  const normalized = normalizeGameIds(gameIds);
  const { rows } = await pool.query<GameGroupRow>(
    `INSERT INTO game_groups (group_id, game_ids)
     VALUES ($1, $2)
     ON CONFLICT (group_id)
     DO UPDATE SET game_ids = EXCLUDED.game_ids, updated_at = now()
     RETURNING *`,
    [groupId, normalized],
  );
  return rows[0];
}

/** Заменяет список игр группы. */
export async function setGameGroupGameIds(
  groupId: string,
  gameIds: readonly string[],
): Promise<GameGroupRow | null> {
  assertValidGroupId(groupId);
  const pool = getPool();
  const normalized = normalizeGameIds(gameIds);
  const { rows } = await pool.query<GameGroupRow>(
    `UPDATE game_groups
     SET game_ids = $2, updated_at = now()
     WHERE group_id = $1
     RETURNING *`,
    [groupId, normalized],
  );
  return rows[0] ?? null;
}

/**
 * Заменяет список групп, в которых доступен сценарий, и пересчитывает кеш
 * users.game_ids у игроков из затронутых групп.
 */
export async function setGameGroupsForGame(
  gameId: string,
  groupIds: readonly string[],
): Promise<GameGroupRow[]> {
  const normalizedGroupIds = normalizeGroupIds(groupIds);
  for (const groupId of normalizedGroupIds) {
    assertValidGroupId(groupId);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ group_id: string }>(
      'SELECT group_id FROM game_groups WHERE group_id = ANY($1::TEXT[])',
      [normalizedGroupIds],
    );
    const existingIds = new Set(existing.rows.map((row) => row.group_id));
    const missing = normalizedGroupIds.filter((groupId) => !existingIds.has(groupId));
    if (missing.length > 0) {
      throw new Error(`Неизвестные group_id: ${missing.join(', ')}`);
    }

    const { rows } = await client.query<GameGroupRow>(
      `WITH updated AS (
         UPDATE game_groups gg
         SET game_ids = CASE
             WHEN gg.group_id = ANY($2::TEXT[]) THEN ARRAY(
               SELECT DISTINCT gid.game_id
               FROM unnest(gg.game_ids || ARRAY[$1]::TEXT[]) AS gid(game_id)
               ORDER BY gid.game_id
             )
             ELSE array_remove(gg.game_ids, $1)
           END,
           updated_at = now()
         WHERE gg.group_id = ANY($2::TEXT[])
            OR $1 = ANY(gg.game_ids)
         RETURNING *
       )
       SELECT * FROM updated ORDER BY group_id ASC`,
      [gameId, normalizedGroupIds],
    );

    const changedGroupIds = rows.map((row) => row.group_id);
    if (changedGroupIds.length > 0) {
      await client.query(
        `UPDATE users u
         SET game_ids = COALESCE((
           SELECT array_agg(DISTINCT gid.game_id ORDER BY gid.game_id)
           FROM game_groups gg
           CROSS JOIN LATERAL unnest(gg.game_ids) AS gid(game_id)
           WHERE gg.group_id = ANY(u.groups)
         ), ARRAY[]::TEXT[])
         WHERE u.groups && $1::TEXT[]`,
        [changedGroupIds],
      );
    }

    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Пересчитывает кеш users.game_ids для одного пользователя по его группам. */
export async function refreshUserGameIds(userId: string): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ game_ids: string[] }>(
    `UPDATE users u
     SET game_ids = COALESCE((
       SELECT array_agg(DISTINCT gid.game_id ORDER BY gid.game_id)
       FROM game_groups gg
       CROSS JOIN LATERAL unnest(gg.game_ids) AS gid(game_id)
       WHERE gg.group_id = ANY(u.groups)
     ), ARRAY[]::TEXT[])
     WHERE u.id = $1
     RETURNING u.game_ids`,
    [userId],
  );
  return rows[0]?.game_ids ?? [];
}

/** Пересчитывает кеш users.game_ids у всех пользователей, состоящих в группе. */
export async function refreshGameIdsForGroup(groupId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users u
     SET game_ids = COALESCE((
       SELECT array_agg(DISTINCT gid.game_id ORDER BY gid.game_id)
       FROM game_groups gg
       CROSS JOIN LATERAL unnest(gg.game_ids) AS gid(game_id)
       WHERE gg.group_id = ANY(u.groups)
     ), ARRAY[]::TEXT[])
     WHERE $1 = ANY(u.groups)`,
    [groupId],
  );
}

/** Добавляет пользователю существующую группу и сразу обновляет кеш доступных игр. */
export async function addUserGroup(
  userId: string,
  groupId: string,
): Promise<UserRow | null> {
  assertValidGroupId(groupId);
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `WITH updated AS (
       UPDATE users
       SET groups = ARRAY(
         SELECT DISTINCT g.group_id
         FROM unnest(users.groups || ARRAY[$2]::TEXT[]) AS g(group_id)
         ORDER BY g.group_id
       )
       WHERE id = $1
         AND EXISTS (SELECT 1 FROM game_groups WHERE group_id = $2)
       RETURNING *
     )
     UPDATE users u
     SET game_ids = COALESCE((
       SELECT array_agg(DISTINCT gid.game_id ORDER BY gid.game_id)
       FROM game_groups gg
       CROSS JOIN LATERAL unnest(gg.game_ids) AS gid(game_id)
       WHERE gg.group_id = ANY(updated.groups)
     ), ARRAY[]::TEXT[])
     FROM updated
     WHERE u.id = updated.id
     RETURNING u.*`,
    [userId, groupId],
  );
  return rows[0] ?? null;
}
