import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PostgresMigration, Neo4jMigration } from '../migrator.js';
import { migratePromptTemplatesToSchemas } from './M001_prompt_templates_to_schemas.js';

/**
 * Реестр версионных миграций (issue #336).
 *
 * Forward-only список применяется ровно один раз и трекается раннером в
 * `schema_migrations` (Postgres) и `(:SchemaMigration)` (Neo4j). Подробности —
 * в docs/migrations-and-structure-refactor-plan.md.
 *
 * **Соглашение по версионированию.** Префикс `NNNN_`, монотонно растёт, новые
 * миграции дописываются в конец. Уже зарелизенные миграции редактировать
 * запрещено — правьте схему новой миграцией.
 *
 * **Baseline (0001).** Чтобы версионирование не сломалось на уже существующих
 * базах, нулевая миграция — это текущий монолитный `schema.sql` с пометкой
 * `transactional: false`: ему нужен отдельный шаг `ENSURE_ESCALATED_STATUS_SQL`
 * (см. ниже) и в той же транзакции нельзя использовать только что добавленное
 * значение enum. После записи baseline в трекер дальнейшие миграции применяются
 * по обычной forward-only схеме.
 *
 * **Структура каталога (issue #336, О4).** Сырые версионные миграции лежат рядом
 * по типу хранилища: `migrations/postgres/*.sql` и `migrations/cypher/*.cypher`
 * (см. README в этих каталогах). Data-миграции, которым нужен доступ к
 * репозиториям ядра, остаются TypeScript-модулями в `migrations/`
 * (например, `M001_prompt_templates_to_schemas.ts`).
 */

/**
 * Идемпотентно добавляет значение enum статусов обращений `escalated` (issue
 * #244) ОТДЕЛЬНОЙ транзакцией. PostgreSQL запрещает использовать только что
 * добавленное значение enum в той же транзакции, поэтому фиксируем его до
 * основного скрипта baseline.
 */
const ENSURE_ESCALATED_STATUS_SQL = `
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_ticket_status')
       AND NOT EXISTS (
           SELECT 1 FROM pg_enum
           WHERE enumtypid = 'support_ticket_status'::regtype
             AND enumlabel = 'escalated'
       ) THEN
        ALTER TYPE support_ticket_status ADD VALUE 'escalated';
    END IF;
END$$;`;

/** Полный текст baseline-схемы — читается из `schema.sql` рядом с этим файлом. */
function readBaselineSchema(): string {
  const schemaPath = fileURLToPath(new URL('../schema.sql', import.meta.url));
  return readFileSync(schemaPath, 'utf8');
}

/** Читает текст версионной Cypher-миграции из `migrations/cypher/` (issue #336, О4). */
function readCypherMigration(file: string): string {
  const path = fileURLToPath(new URL(`./cypher/${file}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

/**
 * Разбивает .cypher-файл на отдельные операторы: Neo4j `tx.run()` выполняет ровно
 * один statement за вызов. Сначала отбрасываем строки-комментарии (`//`), затем
 * режем по `;` и убираем пустые фрагменты.
 */
function splitCypherStatements(text: string): string[] {
  const withoutComments = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export const postgresMigrations: readonly PostgresMigration[] = [
  {
    version: '0001',
    name: 'baseline_schema',
    // schema.sql содержит ALTER TYPE … ADD VALUE и идемпотентные DDL —
    // в одной транзакции их не запустить, см. комментарий выше.
    transactional: false,
    async run(query) {
      await query(ENSURE_ESCALATED_STATUS_SQL);
      await query(readBaselineSchema());
    },
  },
  {
    version: '0002',
    name: 'prompt_templates_to_schemas',
    // Использует getPool() внутри — оставляем без явной транзакции.
    transactional: false,
    async run() {
      await migratePromptTemplatesToSchemas();
    },
  },
];

export const neo4jMigrations: readonly Neo4jMigration[] = [
  {
    version: '0001',
    name: 'baseline_constraints_and_indexes',
    // Текст вынесен в `migrations/cypher/0001_baseline_constraints_and_indexes.cypher`
    // (issue #336, О4); операторы выполняем по одному.
    async run(tx) {
      const cypher = readCypherMigration('0001_baseline_constraints_and_indexes.cypher');
      for (const statement of splitCypherStatements(cypher)) {
        await tx.run(statement);
      }
    },
  },
];
