import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDbConfig, loadNeo4jConfig, loadConfig, resetConfigCache } from '@tg-games/core/config.js';

/**
 * Регрессионный тест: миграциям не нужен TELEGRAM_BOT_TOKEN (issue #408).
 *
 * Раньше `getPool()`/драйвер Neo4j звали полный `loadConfig()`, который требует
 * `TELEGRAM_BOT_TOKEN`, поэтому контейнер миграций падал с
 * «Не задана обязательная переменная окружения: TELEGRAM_BOT_TOKEN», хотя токен
 * бота миграциям не нужен. Конфиги БД и Neo4j вынесены в отдельные загрузчики,
 * которые не зависят от токена.
 */
describe('конфиг миграций не требует TELEGRAM_BOT_TOKEN (issue #408)', () => {
  const ENV = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    delete process.env.DB_NAME;
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_DATABASE;
  });

  afterEach(() => {
    process.env = { ...ENV };
    resetConfigCache();
  });

  it('loadDbConfig() работает без TELEGRAM_BOT_TOKEN и отдаёт дефолты', () => {
    expect(() => loadDbConfig()).not.toThrow();
    expect(loadDbConfig()).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'postgres_password',
      database: 'tg_rpg_db',
    });
  });

  it('loadDbConfig() читает переменные окружения БД', () => {
    process.env.DB_HOST = 'pg';
    process.env.DB_PORT = '6432';
    process.env.DB_USER = 'migrator';
    process.env.DB_PASSWORD = 'secret';
    process.env.DB_NAME = 'app_db';
    expect(loadDbConfig()).toEqual({
      host: 'pg',
      port: 6432,
      user: 'migrator',
      password: 'secret',
      database: 'app_db',
    });
  });

  it('loadNeo4jConfig() работает без TELEGRAM_BOT_TOKEN и отдаёт дефолты', () => {
    expect(() => loadNeo4jConfig()).not.toThrow();
    expect(loadNeo4jConfig()).toEqual({
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'neo4j_password',
      database: 'neo4j',
    });
  });

  it('полный loadConfig() по-прежнему требует TELEGRAM_BOT_TOKEN', () => {
    expect(() => loadConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
