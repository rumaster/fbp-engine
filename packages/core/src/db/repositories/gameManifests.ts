import type { GameManifest } from '../../games/manifests.js';
import { getPool } from '../pool.js';

export type GameTitleMap = ReadonlyMap<string, string>;

interface GameManifestRow {
  game_id: string;
  manifest: GameManifest;
}

function uniqueGameIds(gameIds: readonly string[]): string[] {
  return [...new Set(gameIds.map((id) => id.trim()).filter(Boolean))];
}

/** Возвращает манифест сценария из БД или null. */
export async function getGameManifest(gameId: string): Promise<GameManifest | null> {
  const pool = getPool();
  const { rows } = await pool.query<GameManifestRow>(
    'SELECT game_id, manifest FROM game_manifests WHERE game_id = $1',
    [gameId],
  );
  return rows[0]?.manifest ?? null;
}

/** Возвращает общее число манифестов сценариев. */
export async function countGameManifests(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM game_manifests',
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Возвращает манифесты сценариев из БД.
 *
 * Если передан список id, результат всё равно сортируется по порядку из БД,
 * чтобы пользовательские меню не зависели от порядка кеша users.game_ids.
 */
export async function listGameManifests(
  gameIds?: readonly string[],
): Promise<GameManifest[]> {
  const pool = getPool();
  if (gameIds !== undefined) {
    const ids = uniqueGameIds(gameIds);
    if (ids.length === 0) return [];
    const { rows } = await pool.query<GameManifestRow>(
      `SELECT game_id, manifest
       FROM game_manifests
       WHERE game_id = ANY($1::TEXT[])
       ORDER BY sort_order ASC, game_id ASC`,
      [ids],
    );
    return rows.map((row) => row.manifest);
  }

  const { rows } = await pool.query<GameManifestRow>(
    `SELECT game_id, manifest
     FROM game_manifests
     ORDER BY sort_order ASC, game_id ASC`,
  );
  return rows.map((row) => row.manifest);
}

/** Возвращает страницу манифестов сценариев для админского списка. */
export async function listGameManifestsPaged(
  limit: number,
  offset: number,
): Promise<GameManifest[]> {
  const pool = getPool();
  const { rows } = await pool.query<GameManifestRow>(
    `SELECT game_id, manifest
     FROM game_manifests
     ORDER BY sort_order ASC, game_id ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map((row) => row.manifest);
}

/** Заменяет JSON-манифест сценария, сохраняя его game_id. */
export async function updateGameManifest(
  gameId: string,
  manifest: GameManifest,
): Promise<GameManifest | null> {
  if (manifest.id !== gameId) {
    throw new Error(`id манифеста должен остаться ${gameId}`);
  }

  const pool = getPool();
  const { rows } = await pool.query<GameManifestRow>(
    `UPDATE game_manifests
     SET manifest = $2::jsonb,
         updated_at = now()
     WHERE game_id = $1
     RETURNING game_id, manifest`,
    [gameId, manifest],
  );
  return rows[0]?.manifest ?? null;
}

/** Возвращает карту манифестов по game_id для валидации и подписей. */
export async function getGameManifestMap(
  gameIds: readonly string[],
): Promise<Map<string, GameManifest>> {
  const manifests = await listGameManifests(gameIds);
  return new Map(manifests.map((manifest) => [manifest.id, manifest]));
}

/** Возвращает карту `game_id -> название сценария`. */
export async function getGameTitleMap(gameIds: readonly string[]): Promise<Map<string, string>> {
  const manifests = await listGameManifests(gameIds);
  return new Map(manifests.map((manifest) => [manifest.id, manifest.name]));
}
