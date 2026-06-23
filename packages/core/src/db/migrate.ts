import { fileURLToPath } from 'node:url';
import { closePool } from './pool.js';
import { runPostgresMigrations, runNeo4jMigrations } from './migrator.js';

/**
 * Применяет все ожидающие миграции PostgreSQL и Neo4j (issue #336).
 *
 * Тонкая обёртка над `migrator.ts`: реализация — версионная forward-only,
 * первая миграция (`0001_baseline_schema`) разворачивает текущий `schema.sql`.
 * Экспортируется как стабильная точка входа для `npm run migrate` и для
 * совместимости с прежним API; новый код должен напрямую вызывать
 * `runPostgresMigrations` / `runNeo4jMigrations`.
 */
export async function migrate(): Promise<void> {
  const pgApplied = await runPostgresMigrations();
  const neoApplied = await runNeo4jMigrations();
  if (pgApplied.length === 0 && neoApplied.length === 0) {
    console.log('✅ Схема БД актуальна, новых миграций нет');
  } else {
    console.log(
      `✅ Схема БД применена (postgres: ${pgApplied.length || 0}, neo4j: ${neoApplied.length || 0})`,
    );
  }
}

// Запуск как самостоятельного скрипта: `npm run migrate`.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('❌ Ошибка миграции:', err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
