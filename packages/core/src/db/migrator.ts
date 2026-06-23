import { getPool } from './pool.js';
import { runNeo4jRead, runNeo4jWrite, type Neo4jQueryRunner } from './neo4j.js';
import { postgresMigrations, neo4jMigrations } from './migrations/registry.js';

/**
 * Версионный раннер миграций (issue #336).
 *
 * Заменяет монолитный идемпотентный прогон `schema.sql` на forward-only набор
 * версионных миграций, применяемых ровно один раз. Применённые версии трекаются:
 *   - PostgreSQL — в таблице `schema_migrations`;
 *   - Neo4j      — в узлах `(:SchemaMigration)`.
 *
 * Раннер не привязан к приложению: его вызывает отдельный entrypoint
 * (`npm run migrate` / `node packages/core/dist/db/migrate.js`), а не старт бота.
 * Подробности — в docs/migrations-and-structure-refactor-plan.md.
 */

/** Минимальный интерфейс выполнения SQL: ему удовлетворяют и пул, и клиент `pg`. */
export type QueryRunner = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface PostgresMigration {
  /** Числовой префикс версии, уникальный и монотонный (`0001`, `0002`, …). */
  version: string;
  /** Человекочитаемое имя миграции. */
  name: string;
  /**
   * Выполнять ли миграцию в одной транзакции (по умолчанию `true`).
   * Baseline помечен `false`: `schema.sql` добавляет значения enum
   * (`ALTER TYPE … ADD VALUE`), что несовместимо с использованием значения в той
   * же транзакции.
   */
  transactional?: boolean;
  run(query: QueryRunner): Promise<void>;
}

export interface Neo4jMigration {
  version: string;
  name: string;
  run(tx: Neo4jQueryRunner): Promise<void>;
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
)`;

function sortByVersion<T extends { version: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Применяет все ещё не применённые PostgreSQL-миграции в порядке версий.
 * Возвращает список применённых на этом прогоне версий (пустой — если всё актуально).
 */
export async function runPostgresMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(SCHEMA_MIGRATIONS_DDL);
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => String(row.version)));

  const pending = sortByVersion(postgresMigrations).filter((m) => !applied.has(m.version));
  const done: string[] = [];

  for (const migration of pending) {
    if (migration.transactional === false) {
      // Без обрамляющей транзакции (см. комментарий к `transactional`).
      const query: QueryRunner = (text, params) => pool.query(text, params);
      await migration.run(query);
      await pool.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    } else {
      // Миграция и запись в трекер — атомарно, в одной транзакции.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const query: QueryRunner = (text, params) => client.query(text, params);
        await migration.run(query);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
    console.log(`✅ Postgres-миграция ${migration.version} (${migration.name}) применена`);
    done.push(migration.version);
  }

  return done;
}

/**
 * Применяет все ещё не применённые Neo4j-миграции в порядке версий.
 * Каждая выполняется в одной write-транзакции вместе с записью трекер-узла.
 */
export async function runNeo4jMigrations(): Promise<string[]> {
  await runNeo4jWrite(async (tx) => {
    await tx.run(
      `CREATE CONSTRAINT schema_migration_version IF NOT EXISTS
       FOR (m:SchemaMigration) REQUIRE m.version IS UNIQUE`,
    );
  });

  const applied = await runNeo4jRead(async (tx) => {
    const result = await tx.run('MATCH (m:SchemaMigration) RETURN m.version AS version');
    return new Set(result.records.map((record) => String(record.get('version'))));
  });

  const pending = sortByVersion(neo4jMigrations).filter((m) => !applied.has(m.version));
  const done: string[] = [];

  for (const migration of pending) {
    await runNeo4jWrite(async (tx) => {
      await migration.run(tx);
      await tx.run(
        `CREATE (m:SchemaMigration {version: $version, name: $name, appliedAt: datetime()})`,
        { version: migration.version, name: migration.name },
      );
    });
    console.log(`✅ Neo4j-миграция ${migration.version} (${migration.name}) применена`);
    done.push(migration.version);
  }

  return done;
}
