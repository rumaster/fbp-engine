import pg from 'pg';
import { loadConfig } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Возвращает singleton-пул подключений к PostgreSQL.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const { db } = loadConfig();
    pool = new Pool({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    });
  }
  return pool;
}

/** Закрывает пул подключений (graceful shutdown / тесты). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
