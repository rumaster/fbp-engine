import { isSubSchemaUsableIn } from '@tg-games/schema-contract';
import type {
  SchemaGraph,
  SchemaType,
  SubSchemaClass,
} from '../../engine/schemaEngine.js';
import { getPool } from '../pool.js';

// «Вид» вызывающего графа для проверки совместимости при резолве суб-схемы
// (issue #310): тип пайплайн-схемы либо класс суб-схемы. См. isSubSchemaUsableIn.
export type SchemaCallerKind = SchemaType | SubSchemaClass;

export interface SchemaRecord {
  id: string;
  schemaSlug: string;
  // Ровно одно из двух (issue #310): schemaType — пайплайн, schemaClass — суб-схема.
  schemaType: SchemaType | null;
  schemaClass: SubSchemaClass | null;
  gameId: string | null;
  graphJson: SchemaGraph;
  isActive: boolean;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SchemaHistoryRecord {
  id: string;
  schemaSlug: string;
  schemaType: SchemaType | null;
  schemaClass: SubSchemaClass | null;
  gameId: string | null;
  graphJson: SchemaGraph;
  isActive: boolean;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  versionCreatedAt: Date;
  archivedAt: Date;
}

interface SchemaRow {
  id: string;
  schema_slug: string;
  schema_type: SchemaType | null;
  schema_class: SubSchemaClass | null;
  game_id: string | null;
  graph_json: SchemaGraph;
  is_active: boolean;
  description: string;
  created_at: Date;
  updated_at: Date;
}

interface SchemaHistoryRow {
  id: string;
  schema_slug: string;
  schema_type: SchemaType | null;
  schema_class: SubSchemaClass | null;
  game_id: string | null;
  graph_json: SchemaGraph;
  is_active: boolean;
  description: string;
  created_at: Date;
  updated_at: Date;
  version_created_at: Date;
  archived_at: Date;
}

/** Статус исполнения схемы для журнала (issue #255, этап F). */
export type SchemaExecutionStatus = 'ok' | 'error';

export interface SchemaExecutionLogInput {
  schemaSlug: string;
  /** Тип схемы (`action` / `hint` / `support` / `illustration`) для фильтра журнала. */
  schemaType?: SchemaType | null;
  /** Класс суб-схемы, если корнем исполнения была суб-схема (issue #310). */
  schemaClass?: SubSchemaClass | null;
  gameId?: string | null;
  sessionId?: string | null;
  /** Итог исполнения: `ok` либо `error` (этап F). По умолчанию — `ok`. */
  status?: SchemaExecutionStatus;
  inputsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  llmLog: unknown[];
  durationMs: number;
  /** Узел, на котором упало исполнение (для деталей ошибки в админке). */
  errorNodeId?: string | null;
  /** Тип упавшего узла. */
  errorNodeType?: string | null;
  /** Текст ошибки. */
  errorMessage?: string | null;
  /** Последний сырой ответ LLM перед ошибкой (если есть). */
  errorLastRaw?: string | null;
}

function mapSchemaRow(row: SchemaRow): SchemaRecord {
  return {
    id: row.id,
    schemaSlug: row.schema_slug,
    schemaType: row.schema_type,
    schemaClass: row.schema_class,
    gameId: row.game_id,
    graphJson: row.graph_json,
    isActive: row.is_active,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHistoryRow(row: SchemaHistoryRow): SchemaHistoryRecord {
  return {
    id: row.id,
    schemaSlug: row.schema_slug,
    schemaType: row.schema_type,
    schemaClass: row.schema_class,
    gameId: row.game_id,
    graphJson: row.graph_json,
    isActive: row.is_active,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versionCreatedAt: row.version_created_at,
    archivedAt: row.archived_at,
  };
}

/** Возвращает активную схему: сначала для конкретной игры, затем глобальный fallback. */
export async function getActiveSchema(
  slug: string,
  gameId?: string | null,
): Promise<SchemaRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<SchemaRow>(
    `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at
     FROM schemas
     WHERE schema_slug = $1
       AND is_active = TRUE
       AND (game_id IS NULL OR game_id = $2)
     ORDER BY CASE WHEN game_id = $2 THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`,
    [slug, gameId ?? null],
  );
  return rows[0] ? mapSchemaRow(rows[0]) : null;
}

/**
 * Резолвер вложенной схемы по slug для узла `sub_schema` (этап B, issue #245;
 * совместимость класса — issue #310).
 *
 * Возвращает граф активной схемы (game → global fallback) или `null`, если активной
 * схемы с таким slug нет. Движок при `null` бросает ошибку — нехватка данных в БД
 * доставляется пользователю, legacy/«тихого» fallback нет (issue #238/#245).
 *
 * Если задан `callerKind` (вид вызывающего графа), резолвер дополнительно проверяет
 * совместимость класса найденной суб-схемы: общая (`common`) доступна отовсюду,
 * игровая/поддержки — только из своего домена (см. {@link isSubSchemaUsableIn}).
 * Несовместимая суб-схема трактуется как ненайденная (`null` → ошибка движка).
 */
export function makeSubSchemaResolver(
  gameId?: string | null,
  callerKind?: SchemaCallerKind | null,
): (slug: string) => Promise<SchemaGraph | null> {
  return async (slug) => {
    const record = await getActiveSchema(slug, gameId ?? undefined);
    if (!record) return null;
    // Проверка совместимости только для суб-схем (у пайплайн-схем schemaClass = null).
    if (record.schemaClass && callerKind && !isSubSchemaUsableIn(record.schemaClass, callerKind)) {
      return null;
    }
    return record.graphJson;
  };
}

/**
 * Сохраняет новую активную версию схемы, архивируя прежнюю активную версию этой
 * области. Вид графа задаётся `kind`: ровно одно из `schemaType` (пайплайн) или
 * `schemaClass` (суб-схема, issue #310) — в БД пишутся обе колонки с XOR-инвариантом.
 */
export async function saveSchema(
  slug: string,
  kind: { schemaType?: SchemaType | null; schemaClass?: SubSchemaClass | null },
  graphJson: SchemaGraph,
  description = '',
  gameId?: string | null,
): Promise<SchemaRecord> {
  const schemaType = kind.schemaType ?? null;
  const schemaClass = kind.schemaClass ?? null;
  if ((schemaType === null) === (schemaClass === null)) {
    throw new Error('saveSchema: требуется ровно одно из schemaType / schemaClass (issue #310)');
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO schema_history (
         schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
         created_at, updated_at, version_created_at
       )
       SELECT schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
              created_at, updated_at, updated_at
       FROM schemas
       WHERE schema_slug = $1
         AND game_id IS NOT DISTINCT FROM $2
         AND is_active = TRUE`,
      [slug, gameId ?? null],
    );
    await client.query(
      `UPDATE schemas
       SET is_active = FALSE,
           updated_at = now()
       WHERE schema_slug = $1
         AND game_id IS NOT DISTINCT FROM $2
         AND is_active = TRUE`,
      [slug, gameId ?? null],
    );
    const { rows } = await client.query<SchemaRow>(
      `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
       VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)
       RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
      [slug, schemaType, schemaClass, gameId ?? null, JSON.stringify(graphJson), description],
    );
    await client.query('COMMIT');
    return mapSchemaRow(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Возвращает список активных и архивируемых записей из таблицы schemas. */
export async function listSchemas(): Promise<SchemaRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<SchemaRow>(
    `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at
     FROM schemas
     ORDER BY schema_slug ASC, game_id ASC NULLS FIRST, updated_at DESC`,
  );
  return rows.map(mapSchemaRow);
}

/** Возвращает список архивных версий схемы по slug. */
export async function getSchemaHistory(slug: string): Promise<SchemaHistoryRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<SchemaHistoryRow>(
    `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
            created_at, updated_at, version_created_at, archived_at
     FROM schema_history
     WHERE schema_slug = $1
     ORDER BY archived_at DESC, id DESC`,
    [slug],
  );
  return rows.map(mapHistoryRow);
}

/** Возвращает конкретную архивную версию схемы. */
export async function getSchemaHistoryEntry(
  slug: string,
  historyId: string,
): Promise<SchemaHistoryRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<SchemaHistoryRow>(
    `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
            created_at, updated_at, version_created_at, archived_at
     FROM schema_history
     WHERE schema_slug = $1 AND id = $2`,
    [slug, historyId],
  );
  return rows[0] ? mapHistoryRow(rows[0]) : null;
}

/** Пишет журнал исполнения схемы. Ошибку отдаёт вызывающему коду для явного решения. */
export async function logSchemaExecution(input: SchemaExecutionLogInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO schema_execution_log (
       schema_slug, schema_type, schema_class, game_id, session_id, status,
       inputs_json, outputs_json, llm_log, duration_ms,
       error_node_id, error_node_type, error_message, error_last_raw
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)`,
    [
      input.schemaSlug,
      input.schemaType ?? null,
      input.schemaClass ?? null,
      input.gameId ?? null,
      input.sessionId ?? null,
      input.status ?? 'ok',
      JSON.stringify(input.inputsJson),
      JSON.stringify(input.outputsJson),
      JSON.stringify(input.llmLog),
      input.durationMs,
      input.errorNodeId ?? null,
      input.errorNodeType ?? null,
      input.errorMessage ?? null,
      input.errorLastRaw ?? null,
    ],
  );
}

/**
 * Фиксирует отсутствие активной схемы (issue #255, этап F).
 *
 * После удаления legacy `MissingActiveSchemaError` доставляется пользователю, а
 * не маскируется откатом. Чтобы оператор видел такие случаи в журнале админки,
 * рантайм пишет запись со `status='error'`. Пишется лучшим усилием — ошибка
 * записи не должна ломать доставку основной ошибки пользователю.
 */
export async function logMissingActiveSchema(input: {
  schemaType: SchemaType;
  gameId?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  try {
    await logSchemaExecution({
      // Активной схемы нет, поэтому в качестве slug используем сам тип —
      // запись в журнале служит метке «нет активной схемы данного типа».
      schemaSlug: input.schemaType,
      schemaType: input.schemaType,
      gameId: input.gameId ?? null,
      sessionId: input.sessionId ?? null,
      status: 'error',
      inputsJson: {},
      outputsJson: {},
      llmLog: [],
      durationMs: 0,
      errorMessage:
        `Нет активной схемы «${input.schemaType}»` +
        (input.gameId ? ` для игры ${input.gameId}` : '') +
        '. Schema engine — единственный путь исполнения (issue #238).',
    });
  } catch (err) {
    console.warn(
      `[schema-engine] не удалось записать журнал отсутствия схемы ${input.schemaType}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
