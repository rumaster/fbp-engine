import pg from 'pg';
import { loadDbConfig } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Возвращает singleton-пул подключений к PostgreSQL.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    // Миграциям нужен только конфиг БД, поэтому грузим его отдельно от полного
    // конфига приложения, который требует TELEGRAM_BOT_TOKEN (issue #408).
    const db = loadDbConfig();
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
