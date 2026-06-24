import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService, type DatabaseClient } from '../database/database.service';
import { Neo4jOntologyConflictError, Neo4jService } from '../database/neo4j.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { graphPaletteKind, isSubSchemaGraph, isSubSchemaUsableIn } from '@tg-games/schema-contract';
import {
  assertOptionalGameId,
  assertSchemaSlug,
  isAdminSchemaType,
  isAdminSubSchemaClass,
  normalizeSchemaGraph,
  resolveNodeBodyGraph,
  SUB_SCHEMA_CLASSES,
  type AdminSchemaGraph,
  type AdminNodeType,
  type AdminSchemaType,
  type AdminSubSchemaClass,
  type SchemaTestLogEntry,
  type SchemaTestNodeTraceEntry,
  type SchemaTestRunInput,
  type SchemaTestRunResult,
} from './schema-graph';

type JsonObject = Record<string, unknown>;

export interface GameManifestImportItem {
  gameId?: string;
  manifest: JsonObject;
  sortOrder?: number;
}

export interface SchemaImportItem {
  schemaSlug: string;
  schemaType?: string;
  schemaClass?: string;
  graphJson: JsonObject;
  description?: string;
  gameId?: string | null;
}

export interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
}

export interface ExpertiseImportItem {
  title: string;
  content: string;
  embeddingSources: string[];
  tags?: string[];
  gameId?: string | null;
}

// ── Онтология (issue #323) ───────────────────────────────────────────────
// Граф знаний игры: концепты (вершины) и типизированные связи (рёбра). В отличие
// от экспертизы привязка к игре обязательна — граф всегда принадлежит игре.

/** Поля концепта онтологии для create/update. */
export interface OntologyConceptInput {
  slug: string;
  kind: string;
  title: string;
  synonyms?: string[];
  fact?: string;
  weight?: number;
}

/** Поля связи онтологии для create/update. */
export interface OntologyRelationInput {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight?: number;
  condition?: Record<string, unknown> | null;
  note?: string;
}

/** Элемент импорта графа онтологии (концепты + связи одной игры). */
export interface OntologyImportPayload {
  gameId: string;
  concepts: OntologyConceptInput[];
  relations: OntologyRelationInput[];
}

interface NormalizedGameManifestImportItem {
  gameId: string;
  manifest: JsonObject;
  sortOrder?: number;
}

interface CountRow {
  total: number;
}

interface GameIdRow {
  game_id: string;
}

interface GroupIdRow {
  group_id: string;
}

interface GameManifestExportRow {
  game_id: string;
  manifest: JsonObject;
  sort_order: number;
  updated_at: string | Date;
}

interface SchemaRow {
  id: string;
  schema_slug: string;
  schema_type: AdminSchemaType | null;
  schema_class: AdminSubSchemaClass | null;
  game_id: string | null;
  graph_json: AdminSchemaGraph;
  draft_graph_json: AdminSchemaGraph | null;
  is_active: boolean;
  description: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SchemaHistoryRow {
  id: string;
  schema_slug: string;
  schema_type: AdminSchemaType | null;
  schema_class: AdminSubSchemaClass | null;
  game_id: string | null;
  graph_json: AdminSchemaGraph;
  is_active: boolean;
  description: string;
  created_at: string | Date;
  updated_at: string | Date;
  version_created_at: string | Date;
  archived_at: string | Date;
}

/**
 * Вид строки схемы (issue #310): для пайплайн-схемы — это `schema_type`
 * (`action`/`hint`/…), для суб-схемы — `schema_class` (`game`/`support`/`common`).
 * XOR-инвариант гарантирует, что заполнено ровно одно из полей.
 */
function schemaRowKind(row: {
  schema_type?: AdminSchemaType | null;
  schema_class?: AdminSubSchemaClass | null;
}): string | undefined {
  return row.schema_class ?? row.schema_type ?? undefined;
}

interface SchemaSlugRow {
  schema_slug: string;
}

interface SchemaGameManifestRow {
  game_id: string;
  manifest: JsonObject;
}


interface SchemaTurnHistoryEntry {
  turn: number;
  action: string;
  outcome: string;
}

interface SchemaMemoryCell {
  id: string;
  sessionId: string;
  stepId: string | null;
  content: string;
  category: string;
  importance: number;
  turnCreated: number;
  createdAt: Date;
}

interface SchemaHistoryMessage {
  role: string;
  message: string;
}

interface SchemaTestContextData {
  gameId: string | null;
  manifest: JsonObject;
  state: JsonObject;
  history: SchemaTurnHistoryEntry[];
  memoryCells: SchemaMemoryCell[];
  supportHistory: SchemaHistoryMessage[];
}

interface ExpertiseExportRow {
  id: string;
  title: string;
  content: string;
  embedding_sources: string[] | null;
  tags: string[] | null;
  game_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ExpertiseSearchQueryRow {
  id: string;
  game_id: string | null;
  query_text: string;
  best_similarity: number | null;
  result_count: number;
  retrieved_documents: unknown;
  created_at: string | Date;
  query_distance: number | null;
  game_name: string | null;
}

// Issue #164 — одно найденное совпадение по фразе-источнику (поисковому ключу)
// для вкладки «Проверка поиска». В отличие от обычного поиска не схлопывается до
// одной строки на документ: каждый ключ возвращается со своим расстоянием.
interface ExpertiseSourceMatchRow {
  document_id: string;
  document_title: string;
  game_id: string | null;
  source: string;
  distance: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,50}$/;

const MODEL_PROVIDERS = ['OPENAI', 'GOOGLE', 'OPENROUTER', 'AZURE'] as const;
const LLM_MODEL_DEFAULT_KEY = 'llm_model_name';
const EMBEDDING_MODEL_DEFAULT_KEY = 'embedding_model';
type LLMProviderName = (typeof MODEL_PROVIDERS)[number];
type ModelDefaultSource = 'database' | 'env';

interface RuntimeLLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface RuntimeLlmLogEntry {
  schemaSlug?: string;
  nodeId?: string;
  request: string;
  response: string;
  error?: string;
  usage?: RuntimeLLMUsage;
  modelParams?: Record<string, unknown>;
  retrievedDocuments?: unknown[];
}

interface RuntimeLLMProvider {
  readonly name: string;
  generateText(options: unknown): Promise<string>;
  generateTextResult?(options: unknown): Promise<{ text: string; usage?: RuntimeLLMUsage }>;
}

interface RuntimeEmbeddingProvider {
  readonly model: string;
  embed(inputs: string[]): Promise<{ embeddings: number[][]; usage?: unknown }>;
}

interface RuntimeModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface RuntimeRoutedModel {
  provider: RuntimeLLMProvider;
  providerName: LLMProviderName;
  model: string;
  pricing: RuntimeModelPricing | null;
}

interface RuntimeSchemaTestProvider {
  provider: RuntimeLLMProvider;
}

interface RuntimeModelRouter {
  resolve(): Promise<RuntimeRoutedModel>;
}

interface RuntimeNodeTraceEntry {
  nodeId: string;
  nodeType: string;
  via: 'flow' | 'data';
  durationMs: number;
  outputKeys: string[];
  outputs: Record<string, unknown>;
  // Снимок входов узла (issue #406): значения, пришедшие по data-портам. Нужен для
  // упавших узлов — оператор видит в логе теста входы и может воспроизвести сбой.
  inputs: Record<string, unknown>;
  schemaSlug: string;
  depth: number;
  failed: boolean;
}

interface RuntimeSchemaExecutionContext {
  inputs: Record<string, unknown>;
  nodeOutputs: Map<string, Record<string, unknown>>;
  variables: Map<string, unknown>;
  llmLog: RuntimeLlmLogEntry[];
  // Коллектор трассировки узлов для отчёта теста (issue #347): движок наполняет его
  // записью на каждое исполнение узла — и по потоку, и по pure-зависимостям данных.
  nodeTrace?: RuntimeNodeTraceEntry[];
  provider: RuntimeLLMProvider;
  embeddingProvider?: RuntimeEmbeddingProvider;
  router?: RuntimeModelRouter;
  manifest: JsonObject;
  state: JsonObject;
  memoryCells?: SchemaMemoryCell[];
  cacheKey?: string;
  maxRetries: number;
  // Домен экспертизы узла knowledge_query (issue #353): суб-схема не несёт schemaType,
  // поэтому область поиска (документы поддержки или игры) задаётся явно по домену
  // вызывающей стороны. Для пайплайн-схемы поле не влияет — её домен задан schemaType.
  expertiseDomain?: 'support' | 'game';
  // Резолвер вложенной схемы по slug для узла sub_schema (этап B, issue #245). В
  // test-run он повторяет боевой путь: ищет активную схему в БД, иначе null → ошибка.
  resolveSubSchema?: (slug: string) => Promise<AdminSchemaGraph | null>;
}

interface SchemaEngineModule {
  executeSchema(graph: AdminSchemaGraph, ctx: RuntimeSchemaExecutionContext): Promise<Record<string, unknown>>;
}

interface RuntimeFactoryModule {
  buildLLMProvider(config: unknown, providerName: LLMProviderName, modelName: string): RuntimeLLMProvider | null;
}

interface RuntimePricingModule {
  findModelPricing(modelName: string): RuntimeModelPricing | null;
}

interface TsxEsmApiModule {
  tsImport<T>(specifier: string, options: { parentURL: string; tsconfig?: string }): Promise<T>;
}

interface AzureModelRuntimeRow {
  model: string;
}

interface ModelDefaultRow {
  key: string;
  value: string;
  updated_at: string | Date;
}

interface ModelDefaultsInput {
  llmModelName: string;
  embeddingModel: string;
}

interface ResolvedModelDefaults {
  llmModelName: string;
  llmModelSource: ModelDefaultSource;
  llmUpdatedAt: string | Date | null;
  embeddingModel: string;
  embeddingModelSource: ModelDefaultSource;
  embeddingUpdatedAt: string | Date | null;
}

function assertCatalogId(id: string, label: string): void {
  if (!ID_RE.test(id)) {
    throw new BadRequestException(`${label} должен содержать латиницу, цифры, "-" или "_"`);
  }
}

function normalizeIds(ids: readonly string[] = []): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function exportDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function emptyImportSummary(total: number): ImportSummary {
  return { total, created: 0, updated: 0, unchanged: 0 };
}

function addImportAction(summary: ImportSummary, action: 'created' | 'updated' | 'unchanged'): void {
  summary[action] += 1;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Нормализация входа онтологии (issue #323) ────────────────────────────

/** Тримминг строкового массива с удалением пустых и дублей (порядок сохраняется). */
function normalizeStringList(values: readonly string[] = []): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** Приводит вес к конечному положительному числу (по умолчанию 1). */
function normalizeWeight(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/** Проверяет и нормализует концепт онтологии (slug/kind/title обязательны). */
function normalizeOntologyConcept(input: OntologyConceptInput): {
  slug: string;
  kind: string;
  title: string;
  synonyms: string[];
  fact: string;
  weight: number;
} {
  const slug = input.slug?.trim() ?? '';
  const kind = input.kind?.trim() ?? '';
  const title = input.title?.trim() ?? '';
  if (!slug) throw new BadRequestException('Slug концепта не может быть пустым');
  if (!kind) throw new BadRequestException('Тип (kind) концепта не может быть пустым');
  if (!title) throw new BadRequestException('Заголовок концепта не может быть пустым');
  return {
    slug,
    kind,
    title,
    synonyms: normalizeStringList(input.synonyms),
    fact: input.fact?.trim() ?? '',
    weight: normalizeWeight(input.weight),
  };
}

/** Проверяет и нормализует связь онтологии (концы и тип обязательны). */
function normalizeOntologyRelation(input: OntologyRelationInput): {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight: number;
  condition: Record<string, unknown> | null;
  note: string;
} {
  const fromSlug = input.fromSlug?.trim() ?? '';
  const toSlug = input.toSlug?.trim() ?? '';
  const relation = input.relation?.trim() ?? '';
  if (!fromSlug) throw new BadRequestException('Не указан концепт-источник связи');
  if (!toSlug) throw new BadRequestException('Не указан концепт-приёмник связи');
  if (!relation) throw new BadRequestException('Не указан тип связи');
  const condition =
    isJsonObject(input.condition) && Object.keys(input.condition).length > 0
      ? input.condition
      : null;
  return {
    fromSlug,
    toSlug,
    relation,
    weight: normalizeWeight(input.weight),
    condition,
    note: input.note?.trim() ?? '',
  };
}

/** Превращает конфликт уникальности хранилища в понятную 400-ошибку. */
function mapOntologyConflict(err: unknown, message: string): unknown {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    return new BadRequestException(message);
  }
  if (err instanceof Neo4jOntologyConflictError) {
    return new BadRequestException(message);
  }
  return err;
}

@Injectable()
export class AdminDataService {
  constructor(
    private readonly database: DatabaseService,
    private readonly embeddings: EmbeddingService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly neo4j?: Neo4jService,
  ) {}

  private ontologyStore(): Neo4jService {
    if (!this.neo4j) throw new Error('Neo4jService не подключён к AdminDataService');
    return this.neo4j;
  }

  async listUsers(input: { search?: string; limit: number; offset: number }) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.search) {
      params.push(likePattern(input.search));
      where.push(`(u.username ILIKE $${params.length} ESCAPE '\\' OR u.telegram_id::text ILIKE $${params.length} ESCAPE '\\')`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
      params,
    );
    params.push(input.limit, input.offset);
    const rows = await this.database.query(
      `SELECT
         u.id,
         u.telegram_id::text AS telegram_id,
         u.username,
         u.is_tester,
         u.is_admin,
         u.groups,
         u.game_ids,
         u.active_session_id,
         u.active_support_ticket_id,
         u.created_at,
         COUNT(s.id)::int AS session_count
       FROM users u
       LEFT JOIN game_sessions s ON s.user_id = u.id
       ${whereSql}
       GROUP BY u.id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: total.rows[0]?.total ?? 0, items: rows.rows };
  }

  async getUser(userId: string) {
    const { rows } = await this.database.query(
      `SELECT
         u.id,
         u.telegram_id::text AS telegram_id,
         u.username,
         u.is_tester,
         u.is_admin,
         u.groups,
         u.game_ids,
         u.active_session_id,
         u.active_support_ticket_id,
         u.created_at,
         COUNT(s.id)::int AS session_count
       FROM users u
       LEFT JOIN game_sessions s ON s.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [userId],
    );
    if (!rows[0]) throw new NotFoundException('Пользователь не найден');
    return rows[0];
  }

  async listSessions(input: {
    userId?: string;
    telegramId?: string;
    gameId?: string;
    status?: string;
    limit: number;
    offset: number;
  }) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (input.userId) where.push(`s.user_id = ${add(input.userId)}`);
    if (input.telegramId) where.push(`u.telegram_id::text ILIKE ${add(likePattern(input.telegramId))} ESCAPE '\\'`);
    if (input.gameId) where.push(`s.game_id = ${add(input.gameId)}`);
    if (input.status === 'active') where.push('s.is_active = TRUE');
    if (input.status === 'finished') where.push('s.is_active = FALSE');
    if (input.status === 'processing') where.push('s.is_processing = TRUE');
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total
       FROM game_sessions s
       JOIN users u ON u.id = s.user_id
       ${whereSql}`,
      params,
    );
    params.push(input.limit, input.offset);
    const rows = await this.database.query(
      `SELECT
         s.id,
         s.game_id,
         s.user_id,
         s.is_active,
         s.is_processing,
         s.current_state,
         s.allocated_millicents::text AS allocated_millicents,
         s.cost_millicents::text AS cost_millicents,
         (s.allocated_millicents - s.cost_millicents)::text AS balance_millicents,
         s.used_credits,
         s.token_usage,
         s.created_at,
         u.telegram_id::text AS user_telegram_id,
         u.username AS user_username,
         gm.manifest->>'name' AS game_name
       FROM game_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN game_manifests gm ON gm.game_id = s.game_id
       ${whereSql}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: total.rows[0]?.total ?? 0, items: rows.rows };
  }

  async getSession(sessionId: string) {
    const session = await this.database.query(
      `SELECT
         s.id,
         s.game_id,
         s.user_id,
         s.is_active,
         s.is_processing,
         s.current_state,
         s.allocated_millicents::text AS allocated_millicents,
         s.cost_millicents::text AS cost_millicents,
         (s.allocated_millicents - s.cost_millicents)::text AS balance_millicents,
         s.used_credits,
         s.token_usage,
         s.created_at,
         u.telegram_id::text AS user_telegram_id,
         u.username AS user_username,
         gm.manifest->>'name' AS game_name
       FROM game_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN game_manifests gm ON gm.game_id = s.game_id
       WHERE s.id = $1`,
      [sessionId],
    );
    if (!session.rows[0]) throw new NotFoundException('Сессия не найдена');
    const steps = await this.database.query(
      `SELECT
         id,
         session_id,
         action_text,
         llm_raw_response,
         changes_summary,
         cost_millicents::text AS cost_millicents,
         step_credits,
         token_usage,
         created_at
       FROM game_steps
       WHERE session_id = $1
       ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
    return { ...session.rows[0], steps: steps.rows };
  }

  async listGames(input: { limit: number; offset: number }) {
    const total = await this.database.query<CountRow>('SELECT COUNT(*)::int AS total FROM game_manifests');
    const rows = await this.database.query(
      `SELECT
         game_id,
         manifest->>'name' AS name,
         manifest->>'description' AS description,
         sort_order,
         created_at,
         updated_at
       FROM game_manifests
       ORDER BY sort_order ASC, game_id ASC
       LIMIT $1 OFFSET $2`,
      [input.limit, input.offset],
    );
    return { total: total.rows[0]?.total ?? 0, items: rows.rows };
  }

  async getGame(gameId: string) {
    const game = await this.database.query(
      `SELECT game_id, manifest, sort_order, created_at, updated_at
       FROM game_manifests
       WHERE game_id = $1`,
      [gameId],
    );
    if (!game.rows[0]) throw new NotFoundException('Игра не найдена');
    const groups = await this.database.query(
      'SELECT group_id, game_ids, created_at, updated_at FROM game_groups WHERE $1 = ANY(game_ids) ORDER BY group_id ASC',
      [gameId],
    );
    const sessions = await this.database.query<CountRow>(
      'SELECT COUNT(*)::int AS total FROM game_sessions WHERE game_id = $1',
      [gameId],
    );
    return {
      ...game.rows[0],
      groups: groups.rows,
      session_count: sessions.rows[0]?.total ?? 0,
    };
  }

  async exportGameManifests() {
    const { rows } = await this.database.query<GameManifestExportRow>(
      `SELECT game_id, manifest, sort_order, updated_at
       FROM game_manifests
       ORDER BY sort_order ASC, game_id ASC`,
    );
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: rows.map((row) => ({
        gameId: row.game_id,
        manifest: row.manifest,
        sortOrder: row.sort_order,
        updatedAt: exportDate(row.updated_at),
      })),
    };
  }

  async importGameManifests(items: readonly GameManifestImportItem[]): Promise<ImportSummary> {
    const normalized = this.normalizeGameManifestImportItems(items);
    return this.database.transaction(async (client) => {
      const summary = emptyImportSummary(normalized.length);
      for (const item of normalized) {
        addImportAction(summary, await this.upsertImportedGameManifest(client, item));
      }
      return summary;
    });
  }

  async createGame(input: { manifest: JsonObject; groupIds?: string[] }) {
    const gameId = typeof input.manifest.id === 'string' ? input.manifest.id : '';
    assertCatalogId(gameId, 'game_id');
    const groupIds = input.groupIds === undefined ? undefined : await this.requireExistingGroupIds(input.groupIds);
    await this.database.query(
      `INSERT INTO game_manifests (game_id, manifest, sort_order)
       VALUES (
         $1,
         $2::jsonb,
         COALESCE((SELECT MAX(sort_order) + 1 FROM game_manifests), 1)
      )`,
      [gameId, JSON.stringify(input.manifest)],
    );
    if (groupIds !== undefined) {
      await this.updateGameGroups(gameId, groupIds);
    }
    return this.getGame(gameId);
  }

  async updateGameManifest(gameId: string, manifest: JsonObject) {
    if (manifest.id !== gameId) {
      throw new BadRequestException(`id манифеста должен остаться ${gameId}`);
    }
    // Архивируем прежнюю версию, только если манифест действительно меняется,
    // чтобы повторное сохранение без правок не плодило одинаковые записи.
    await this.database.query(
      `INSERT INTO game_manifest_history (game_id, manifest, version_created_at)
       SELECT game_id, manifest, updated_at
       FROM game_manifests
       WHERE game_id = $1 AND manifest IS DISTINCT FROM $2::jsonb`,
      [gameId, JSON.stringify(manifest)],
    );
    const { rows } = await this.database.query(
      `UPDATE game_manifests
       SET manifest = $2::jsonb,
           updated_at = now()
       WHERE game_id = $1
       RETURNING game_id, manifest, sort_order, created_at, updated_at`,
      [gameId, JSON.stringify(manifest)],
    );
    if (!rows[0]) throw new NotFoundException('Игра не найдена');
    return rows[0];
  }

  async listGameManifestHistory(gameId: string) {
    await this.ensureGameExists(gameId);
    const { rows } = await this.database.query(
      `SELECT id, version_created_at, archived_at
       FROM game_manifest_history
       WHERE game_id = $1
       ORDER BY archived_at DESC, id DESC`,
      [gameId],
    );
    return { items: rows };
  }

  async getGameManifestHistoryEntry(gameId: string, historyId: string) {
    const { rows } = await this.database.query(
      `SELECT id, game_id, manifest, version_created_at, archived_at
       FROM game_manifest_history
       WHERE game_id = $1 AND id = $2`,
      [gameId, historyId],
    );
    if (!rows[0]) throw new NotFoundException('Версия манифеста не найдена');
    return rows[0];
  }

  async updateGameGroups(gameId: string, groupIds: readonly string[]) {
    assertCatalogId(gameId, 'game_id');
    const normalized = await this.requireExistingGroupIds(groupIds);
    await this.ensureGameExists(gameId);

    await this.database.query(
      `UPDATE game_groups gg
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
          OR $1 = ANY(gg.game_ids)`,
      [gameId, normalized],
    );
    await this.refreshAllUserGameIds();
    return this.getGame(gameId);
  }

  async listGroups() {
    const rows = await this.database.query(
      `SELECT
         gg.group_id,
         gg.game_ids,
         gg.created_at,
         gg.updated_at,
         COUNT(u.id)::int AS user_count
       FROM game_groups gg
       LEFT JOIN users u ON gg.group_id = ANY(u.groups)
       GROUP BY gg.group_id
       ORDER BY gg.group_id ASC`,
    );
    return { items: rows.rows };
  }

  async getGroup(groupId: string) {
    const group = await this.database.query(
      'SELECT group_id, game_ids, created_at, updated_at FROM game_groups WHERE group_id = $1',
      [groupId],
    );
    if (!group.rows[0]) throw new NotFoundException('Группа не найдена');
    const games = await this.database.query(
      `SELECT game_id, manifest->>'name' AS name
       FROM game_manifests
       WHERE game_id = ANY($1::TEXT[])
       ORDER BY sort_order ASC, game_id ASC`,
      [group.rows[0].game_ids],
    );
    const users = await this.database.query(
      `SELECT id, telegram_id::text AS telegram_id, username, created_at
       FROM users
       WHERE $1 = ANY(groups)
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [groupId],
    );
    const userCount = await this.database.query<CountRow>(
      'SELECT COUNT(*)::int AS total FROM users WHERE $1 = ANY(groups)',
      [groupId],
    );
    return {
      ...group.rows[0],
      games: games.rows,
      users: users.rows,
      user_count: userCount.rows[0]?.total ?? 0,
    };
  }

  async upsertGroup(groupId: string, gameIds: readonly string[]) {
    assertCatalogId(groupId, 'group_id');
    const normalized = await this.requireExistingGameIds(gameIds);
    const { rows } = await this.database.query(
      `INSERT INTO game_groups (group_id, game_ids)
       VALUES ($1, $2)
       ON CONFLICT (group_id)
       DO UPDATE SET game_ids = EXCLUDED.game_ids, updated_at = now()
       RETURNING group_id, game_ids, created_at, updated_at`,
      [groupId, normalized],
    );
    await this.refreshAllUserGameIds();
    return rows[0];
  }

  async updateGroupGames(groupId: string, gameIds: readonly string[]) {
    assertCatalogId(groupId, 'group_id');
    const normalized = await this.requireExistingGameIds(gameIds);
    const { rows } = await this.database.query(
      `UPDATE game_groups
       SET game_ids = $2, updated_at = now()
       WHERE group_id = $1
       RETURNING group_id, game_ids, created_at, updated_at`,
      [groupId, normalized],
    );
    if (!rows[0]) throw new NotFoundException('Группа не найдена');
    await this.refreshAllUserGameIds();
    return rows[0];
  }

  // ── JSON-схемы Schema Engine (issue #173) ────────────────────────────────

  async listSchemas() {
    const { rows } = await this.database.query<SchemaRow>(
      `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, draft_graph_json, is_active, description, created_at, updated_at
       FROM schemas
       WHERE is_active = TRUE
       ORDER BY schema_type ASC, schema_slug ASC, game_id ASC NULLS FIRST`,
    );
    return {
      items: rows.map((row) => this.formatSchemaRow(row, false)),
    };
  }

  async getSchema(slug: string, gameId?: string | null) {
    assertSchemaSlug(slug);
    assertOptionalGameId(gameId);
    const row = await this.findActiveSchema(slug, gameId ?? null);
    if (!row) throw new NotFoundException('Схема не найдена');
    return this.formatSchemaRow(row, true);
  }

  async updateSchema(input: {
    slug: string;
    schemaType?: string;
    schemaClass?: string;
    graphJson: JsonObject;
    description?: string;
    gameId?: string | null;
  }) {
    const data = await this.normalizeSchemaInput(input);
    return this.database.transaction(async (client) => {
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
        [data.slug, data.gameId],
      );
      await client.query(
        `UPDATE schemas
            SET is_active = FALSE,
                updated_at = now()
          WHERE schema_slug = $1
            AND game_id IS NOT DISTINCT FROM $2
            AND is_active = TRUE`,
        [data.slug, data.gameId],
      );
      const { rows } = await client.query<SchemaRow>(
        `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
         VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)
         RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
        [data.slug, data.schemaType, data.schemaClass, data.gameId, JSON.stringify(data.graphJson), data.description],
      );
      return this.formatSchemaRow(rows[0], true);
    });
  }

  // ── Черновики схем (issue #286) ───────────────────────────────────────────
  // draft_graph_json — незафиксированная версия графа, хранится в той же строке
  // активной схемы. NULL означает, что черновик совпадает с рабочей версией.
  // GET draft: возвращает черновик если он есть, иначе — рабочую версию.
  // PATCH draft: сохраняет черновик без создания истории.
  // POST promote: копирует черновик в рабочую версию (создаёт запись истории).

  async getSchemaDraft(slug: string, gameId?: string | null) {
    assertSchemaSlug(slug);
    assertOptionalGameId(gameId);
    const row = await this.findActiveSchema(slug, gameId ?? null);
    if (!row) throw new NotFoundException('Схема не найдена');
    const draftRow = row as SchemaRow & { draft_graph_json?: AdminSchemaGraph | null };
    const graphJson = draftRow.draft_graph_json ?? row.graph_json;
    const hasDraft = draftRow.draft_graph_json !== null && draftRow.draft_graph_json !== undefined;
    return {
      ...this.formatSchemaRow(row, false),
      graph_json: graphJson,
      has_draft: hasDraft,
    };
  }

  async saveSchemaDraft(input: {
    slug: string;
    graphJson: JsonObject;
    gameId?: string | null;
  }) {
    assertSchemaSlug(input.slug);
    assertOptionalGameId(input.gameId);
    const gameId = input.gameId ?? null;
    const row = await this.findActiveSchema(input.slug, gameId);
    if (!row) throw new NotFoundException('Схема не найдена');
    const graphJson = normalizeSchemaGraph(input.graphJson, input.slug, schemaRowKind(row));
    if (gameId !== null && row.game_id !== gameId) {
      // Игра наследует базовую схему и ещё не имеет собственной строки (issue #234):
      // материализуем игровую строку, чтобы черновик хранился отдельно от базы и
      // не терялся при переходах (требование #4). Рабочая версия = базовый граф,
      // draft = текущие правки редактора.
      const { rows: created } = await this.database.query<SchemaRow>(
        `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, draft_graph_json, is_active, description)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, TRUE, $7)
         RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
        [input.slug, row.schema_type, row.schema_class, gameId, JSON.stringify(row.graph_json), JSON.stringify(graphJson), row.description ?? null],
      );
      return {
        ...this.formatSchemaRow(created[0], false),
        graph_json: graphJson,
        has_draft: true,
      };
    }
    const { rows } = await this.database.query<SchemaRow>(
      `UPDATE schemas
          SET draft_graph_json = $3::jsonb,
              updated_at = now()
        WHERE schema_slug = $1
          AND game_id IS NOT DISTINCT FROM $2
          AND is_active = TRUE
        RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
      [input.slug, gameId, JSON.stringify(graphJson)],
    );
    if (!rows[0]) throw new NotFoundException('Схема не найдена');
    return {
      ...this.formatSchemaRow(rows[0], false),
      graph_json: graphJson,
      has_draft: true,
    };
  }

  async promoteSchemaDraft(slug: string, gameId?: string | null) {
    assertSchemaSlug(slug);
    assertOptionalGameId(gameId);
    const resolvedGameId = gameId ?? null;
    return this.database.transaction(async (client) => {
      const { rows: activeRows } = await client.query<SchemaRow & { draft_graph_json?: AdminSchemaGraph | null }>(
        `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at, draft_graph_json
           FROM schemas
          WHERE schema_slug = $1
            AND game_id IS NOT DISTINCT FROM $2
            AND is_active = TRUE`,
        [slug, resolvedGameId],
      );
      const active = activeRows[0];
      if (!active) {
        // Нет собственной строки — игра наследует базовую схему (issue #234).
        // Сохранение должно создать игровую схему-форк из базовой рабочей версии.
        if (resolvedGameId !== null) {
          const { rows: baseRows } = await client.query<SchemaRow>(
            `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at
               FROM schemas
              WHERE schema_slug = $1
                AND game_id IS NULL
                AND is_active = TRUE
              LIMIT 1`,
            [slug],
          );
          const base = baseRows[0];
          if (base) {
            const { rows: created } = await client.query<SchemaRow>(
              `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
               VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)
               RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
              [slug, base.schema_type, base.schema_class, resolvedGameId, JSON.stringify(base.graph_json), base.description ?? null],
            );
            return {
              ...this.formatSchemaRow(created[0], true),
              has_draft: false,
            };
          }
        }
        throw new NotFoundException('Схема не найдена');
      }
      if (!active.draft_graph_json) {
        return {
          ...this.formatSchemaRow(active, true),
          has_draft: false,
        };
      }
      const draftGraph = active.draft_graph_json;
      // Архивируем текущую рабочую версию в историю перед заменой.
      await client.query(
        `INSERT INTO schema_history (
           schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
           created_at, updated_at, version_created_at
         )
         SELECT schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
                created_at, updated_at, updated_at
           FROM schemas
          WHERE id = $1`,
        [active.id],
      );
      const { rows } = await client.query<SchemaRow>(
        `UPDATE schemas
            SET graph_json = draft_graph_json,
                draft_graph_json = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
        [active.id],
      );
      return {
        ...this.formatSchemaRow(rows[0], true),
        has_draft: false,
        promoted_graph: draftGraph,
      };
    });
  }

  // Сбрасывает черновик до рабочей версии (кнопка «Обновить», issue #286):
  // обнуляет draft_graph_json, после чего черновик снова совпадает с рабочей
  // версией. Незафиксированные правки черновика теряются. Возвращает рабочий
  // граф, чтобы редактор сразу показал актуальную версию.
  async resetSchemaDraft(slug: string, gameId?: string | null) {
    assertSchemaSlug(slug);
    assertOptionalGameId(gameId);
    const resolvedGameId = gameId ?? null;
    const { rows } = await this.database.query<SchemaRow>(
      `UPDATE schemas
          SET draft_graph_json = NULL,
              updated_at = now()
        WHERE schema_slug = $1
          AND game_id IS NOT DISTINCT FROM $2
          AND is_active = TRUE
        RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
      [slug, resolvedGameId],
    );
    if (rows[0]) {
      return {
        ...this.formatSchemaRow(rows[0], false),
        graph_json: rows[0].graph_json,
        has_draft: false,
      };
    }
    // Нет собственной строки — игра наследует базовую схему (issue #234): черновика
    // нет, сбрасывать нечего. Возвращаем рабочую (базовую) версию, чтобы редактор
    // показал актуальный граф без ошибки.
    const fallback = await this.findActiveSchema(slug, resolvedGameId);
    if (!fallback) throw new NotFoundException('Схема не найдена');
    return {
      ...this.formatSchemaRow(fallback, false),
      graph_json: fallback.graph_json,
      has_draft: false,
    };
  }

  async listSchemaHistory(slug: string, gameId?: string | null) {
    assertSchemaSlug(slug);
    assertOptionalGameId(gameId);
    await this.ensureSchemaExists(slug, gameId);
    const params: unknown[] = [slug];
    const gameFilter =
      gameId === undefined
        ? ''
        : `AND game_id IS NOT DISTINCT FROM $${params.push(gameId)}::text`;
    const { rows } = await this.database.query<SchemaHistoryRow>(
      `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
              created_at, updated_at, version_created_at, archived_at
         FROM schema_history
        WHERE schema_slug = $1
          ${gameFilter}
        ORDER BY archived_at DESC, id DESC`,
      params,
    );
    return {
      items: rows.map((row) => this.formatSchemaHistoryRow(row, false)),
    };
  }

  async getSchemaHistoryEntry(slug: string, historyId: string) {
    assertSchemaSlug(slug);
    const { rows } = await this.database.query<SchemaHistoryRow>(
      `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
              created_at, updated_at, version_created_at, archived_at
         FROM schema_history
        WHERE schema_slug = $1 AND id = $2`,
      [slug, historyId],
    );
    if (!rows[0]) throw new NotFoundException('Версия схемы не найдена');
    return this.formatSchemaHistoryRow(rows[0], true);
  }

  async deleteSchemaHistoryEntry(slug: string, historyId: string): Promise<void> {
    assertSchemaSlug(slug);
    const { rowCount } = await this.database.query(
      `DELETE FROM schema_history WHERE schema_slug = $1 AND id = $2`,
      [slug, historyId],
    );
    if (!rowCount) throw new NotFoundException('Версия схемы не найдена');
  }

  async restoreSchemaHistoryEntry(slug: string, historyId: string) {
    assertSchemaSlug(slug);
    return this.database.transaction(async (client) => {
      const history = await client.query<SchemaHistoryRow>(
        `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
                created_at, updated_at, version_created_at, archived_at
           FROM schema_history
          WHERE schema_slug = $1 AND id = $2`,
        [slug, historyId],
      );
      const source = history.rows[0];
      if (!source) throw new NotFoundException('Версия схемы не найдена');
      const graph = normalizeSchemaGraph(source.graph_json, source.schema_slug, schemaRowKind(source));

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
        [source.schema_slug, source.game_id],
      );
      await client.query(
        `UPDATE schemas
            SET is_active = FALSE,
                updated_at = now()
          WHERE schema_slug = $1
            AND game_id IS NOT DISTINCT FROM $2
            AND is_active = TRUE`,
        [source.schema_slug, source.game_id],
      );
      const { rows } = await client.query<SchemaRow>(
        `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
         VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)
         RETURNING id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at`,
        [source.schema_slug, source.schema_type, source.schema_class, source.game_id, JSON.stringify(graph), source.description],
      );
      return this.formatSchemaRow(rows[0], true);
    });
  }

  async exportSchemas() {
    const { rows } = await this.database.query<SchemaRow>(
      `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at
       FROM schemas
       WHERE is_active = TRUE
       ORDER BY schema_type ASC, schema_slug ASC, game_id ASC NULLS FIRST`,
    );
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: rows.map((row) => ({
        schemaSlug: row.schema_slug,
        schemaType: row.schema_type,
        schemaClass: row.schema_class,
        gameId: row.game_id,
        graphJson: row.graph_json,
        description: row.description,
        updatedAt: exportDate(row.updated_at),
      })),
    };
  }

  async importSchemas(items: readonly SchemaImportItem[]): Promise<ImportSummary> {
    const normalized = await this.normalizeSchemaImportItems(items);
    return this.database.transaction(async (client) => {
      const summary = emptyImportSummary(normalized.length);
      for (const item of normalized) {
        addImportAction(summary, await this.upsertImportedSchema(client, item));
      }
      return summary;
    });
  }

  async testSchema(slug: string, input: SchemaTestRunInput): Promise<SchemaTestRunResult> {
    assertSchemaSlug(slug);
    assertOptionalGameId(input.gameId);
    const context = await this.buildSchemaTestContext(input);
    const row = await this.findActiveSchema(slug, context.gameId);
    if (!row) throw new NotFoundException('Схема не найдена');
    // Тест выполняется на черновике (issue #286): если черновик есть — используем его,
    // иначе — рабочую версию.
    const schemaGraphJson = row.draft_graph_json ?? row.graph_json;
    // Изолированный тест тела узла (issue #390): если задан путь к узлу loop/graph_rag,
    // прогоняем не всю схему, а bodyGraph самого вложенного узла. Тогда `inputs` —
    // это значения входов тестируемого узла (они подаются телу как его входы и могут
    // не совпадать с портами внутреннего start тела).
    const bodyTest =
      input.nodePath && input.nodePath.length > 0
        ? resolveNodeBodyGraph(schemaGraphJson, input.nodePath)
        : null;
    const graphJson = bodyTest ? bodyTest.graph : schemaGraphJson;
    const startedAt = Date.now();
    const llmLog: RuntimeLlmLogEntry[] = [];
    // Полный отчёт по узлам теста (issue #347): движок наполняет массив записью на
    // каждое исполнение узла — и по потоку, и по pure-зависимостям данных. Доступен
    // и при ошибке: показывает, где именно поток остановился.
    const nodeTrace: RuntimeNodeTraceEntry[] = [];
    // Контекст выполнения суб-схемы (issue #351): для суб-схемы домен вызывающей
    // стороны можно задать явно (support/game) — иначе callerKind берётся из самого
    // графа. Для пайплайн-схем контекст игнорируется: их домен задан типом схемы.
    const callerKind =
      input.context && isSubSchemaGraph(graphJson) ? input.context : graphPaletteKind(graphJson);
    const executionInputs = this.buildSchemaExecutionInputs(
      input.inputs,
      context,
      callerKind,
    );
    let router: RuntimeModelRouter | undefined;

    try {
      const engine = await loadSchemaEngineModule();
      const providerConfig = await this.createSchemaTestProvider(graphJson, input.inputs);
      router = await this.createSchemaTestRouter(providerConfig.provider);
      const embeddingProvider = await this.createSchemaTestEmbeddingProvider();
      const outputs = await engine.executeSchema(graphJson, {
        inputs: executionInputs,
        nodeOutputs: new Map(),
        // Переменные берём из исполняемого графа (issue #355): при тесте черновика
        // это graphJson (черновик), иначе — рабочая версия. Раньше здесь жёстко
        // стояла row.graph_json, из-за чего тест черновика прогонялся с переменными
        // рабочей версии — то есть по факту тестировалась рабочая, а не черновик.
        variables: new Map(Object.entries(graphJson.variables ?? {})),
        llmLog,
        nodeTrace,
        provider: providerConfig.provider,
        ...(embeddingProvider ? { embeddingProvider } : {}),
        router,
        manifest: context.manifest,
        state: context.state,
        memoryCells: context.memoryCells,
        ...(context.supportHistory.length > 0 ? { supportHistory: context.supportHistory } : {}),
        maxRetries: this.schemaMaxRetries(input.inputs),
        // Домен экспертизы узла knowledge_query (issue #353): суб-схема не несёт
        // schemaType, поэтому область поиска (документы поддержки или игры) задаём
        // явно по домену вызывающей стороны. Так общая суб-схема, тестируемая в
        // контексте поддержки, ищет в документах СП, а не в пустой экспертизе игры.
        expertiseDomain: callerKind === 'support' ? 'support' : 'game',
        // Изолированный тест тела graph_rag (issue #390): тело содержит служебные
        // graph_query-узлы, которые в обычном рантайме разрешены только внутри
        // graph_rag. Прогоняя тело напрямую, выставляем тот же флаг, иначе узел сразу
        // бросает «graph_query доступен только внутри graph_rag».
        ...(bodyTest?.nodeType === 'graph_rag' ? { internalGraphQueryAllowed: true } : {}),
        resolveSubSchema: async (subSlug: string) => {
          const subRow = await this.findActiveSchema(subSlug, context.gameId);
          if (!subRow) return null;
          // Суб-схему можно вызвать только из совместимого домена (issue #310):
          // common — отовсюду, game/support — только из своего домена. Пайплайн-
          // схему (без класса) по ссылке суб-схемы не подключаем.
          if (!subRow.schema_class || !isSubSchemaUsableIn(subRow.schema_class, callerKind)) {
            return null;
          }
          // Тест прогоняет черновик и для вложенных суб-схем (issue #343): если у
          // суб-схемы есть незафиксированный черновик — используем его, иначе
          // рабочую версию. Это согласуется с верхним уровнем теста (см. выше).
          return subRow.draft_graph_json ?? subRow.graph_json;
        },
      });
      const durationMs = Date.now() - startedAt;
      const formattedLog = formatSchemaTestLog(llmLog);
      const costMillicents = await this.calcSchemaTestCost(llmLog, router);
      await this.logSchemaTestExecution(row, context, executionInputs, outputs, llmLog, durationMs);
      await this.logSchemaTestLlmRequests(row, llmLog, router);
      return {
        outputs,
        llmLog: formattedLog,
        nodeTrace: formatSchemaTestNodeTrace(nodeTrace),
        durationMs,
        costMillicents,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const summary = this.schemaTestErrorSummary(graphJson, err);
      await this.logSchemaTestExecution(
        row,
        context,
        executionInputs,
        summary,
        llmLog,
        durationMs,
        summary,
      );
      if (router) await this.logSchemaTestLlmRequests(row, llmLog, router);
      // Отчёт по узлам прикладываем и к ошибке (issue #347): движок наполнял nodeTrace
      // по ходу исполнения, поэтому в нём видно, какие ноды успели отработать и на
      // какой именно остановился поток (последняя запись — упавший узел).
      throw new BadRequestException({
        ...summary,
        nodeTrace: formatSchemaTestNodeTrace(nodeTrace),
      });
    }
  }

  async listTopics(input: { status?: string; limit: number; offset: number }) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.status === 'open' || input.status === 'closed' || input.status === 'auto_closed') {
      params.push(input.status);
      where.push(`t.status = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total FROM support_tickets t ${whereSql}`,
      params,
    );
    params.push(input.limit, input.offset);
    const rows = await this.database.query(
      `SELECT
         t.id,
         t.number::text AS number,
         t.user_id,
         t.status,
         t.last_message_at,
         t.escalated_at,
         t.created_at,
         u.telegram_id::text AS user_telegram_id,
         u.username AS user_username,
         COUNT(m.id)::int AS message_count,
         (
           SELECT sm.text
           FROM support_messages sm
           WHERE sm.ticket_id = t.id
           ORDER BY sm.created_at DESC
           LIMIT 1
         ) AS last_message_text
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN support_messages m ON m.ticket_id = t.id
       ${whereSql}
       GROUP BY t.id, u.id
       ORDER BY t.last_message_at DESC, t.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: total.rows[0]?.total ?? 0, items: rows.rows };
  }

  async getTopic(ticketId: string) {
    const ticket = await this.database.query(
      `SELECT
         t.id,
         t.number::text AS number,
         t.user_id,
         t.status,
         t.last_message_at,
         t.escalated_at,
         t.created_at,
         u.telegram_id::text AS user_telegram_id,
         u.username AS user_username
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId],
    );
    if (!ticket.rows[0]) throw new NotFoundException('Обращение не найдено');
    const messages = await this.database.query(
      `SELECT id, ticket_id, sender, sender_id, text, created_at
       FROM support_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC, id ASC`,
      [ticketId],
    );
    return { ...ticket.rows[0], messages: messages.rows };
  }

  /**
   * Закрывает обращение через веб-админку (issue #149).
   * Возвращает обновлённую запись или бросает NotFoundException.
   */
  async closeTopic(ticketId: string) {
    const { rows } = await this.database.query(
      `UPDATE support_tickets SET status = 'closed'
       WHERE id = $1 AND status = 'open'
       RETURNING id, number::text AS number, user_id, status, last_message_at, escalated_at, created_at`,
      [ticketId],
    );
    if (!rows[0]) throw new NotFoundException('Обращение не найдено или уже закрыто');
    return rows[0];
  }

  // ── Глобальные модели по умолчанию (issue #345) ──────────────────────────

  async getModelDefaults() {
    const llmEnvModel = this.defaultModelName();
    const embeddingEnvModel = this.defaultEmbeddingModelName();
    const defaults = await this.readModelDefaults({
      llmModelName: llmEnvModel,
      embeddingModel: embeddingEnvModel,
    });
    return {
      llm: {
        provider: this.defaultProviderName(),
        model: defaults.llmModelName,
        envModel: llmEnvModel,
        source: defaults.llmModelSource,
        updatedAt: defaults.llmUpdatedAt,
      },
      embedding: {
        provider: this.defaultEmbeddingProviderName(),
        model: defaults.embeddingModel,
        envModel: embeddingEnvModel,
        source: defaults.embeddingModelSource,
        updatedAt: defaults.embeddingUpdatedAt,
      },
    };
  }

  async updateModelDefaults(input: ModelDefaultsInput) {
    const llmModelName = input.llmModelName.trim();
    const embeddingModel = input.embeddingModel.trim();
    if (!llmModelName) throw new BadRequestException('Не задана LLM-модель');
    if (!embeddingModel) throw new BadRequestException('Не задана embedding-модель');
    await this.database.query(
      `INSERT INTO model_defaults (key, value)
       VALUES
         ('llm_model_name', $1),
         ('embedding_model', $2)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value,
                     updated_at = now()`,
      [llmModelName, embeddingModel],
    );
    return this.getModelDefaults();
  }

  async listLlmRequests(input: {
    userId?: string;
    telegramId?: string;
    sessionId?: string;
    schemaSlug?: string;
    nodeId?: string;
    hasError?: boolean;
    limit: number;
    offset: number;
  }) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (input.userId) where.push(`l.user_id = ${add(input.userId)}`);
    if (input.telegramId) where.push(`u.telegram_id::text ILIKE ${add(likePattern(input.telegramId))} ESCAPE '\\'`);
    if (input.sessionId) where.push(`l.session_id = ${add(input.sessionId)}`);
    if (input.schemaSlug) where.push(`l.schema_slug = ${add(input.schemaSlug)}`);
    if (input.nodeId) where.push(`l.node_id = ${add(input.nodeId)}`);
    if (input.hasError === true) where.push('l.error_text IS NOT NULL');
    if (input.hasError === false) where.push('l.error_text IS NULL');
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total
       FROM llm_request_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${whereSql}`,
      params,
    );
    params.push(input.limit, input.offset);
    const rows = await this.database.query(
      `SELECT
         l.id,
         l.user_id,
         l.session_id,
         l.step_id,
         l.support_ticket_id,
         l.schema_slug,
         l.node_id,
         l.provider,
         l.model,
         (l.error_text IS NOT NULL) AS has_error,
         l.cost_millicents::text AS cost_millicents,
         l.token_usage,
         l.created_at,
         u.telegram_id::text AS user_telegram_id,
         u.username AS user_username
       FROM llm_request_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${whereSql}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: total.rows[0]?.total ?? 0, items: rows.rows };
  }

  async listAzureModels() {
    const rows = await this.database.query(
      `SELECT alias, model, created_at, updated_at
       FROM azure_models
       ORDER BY alias ASC`,
    );
    return { items: rows.rows };
  }

  async createAzureModel(alias: string, model: string) {
    const trimmedAlias = alias.trim();
    const trimmedModel = model.trim();
    if (!trimmedAlias) throw new BadRequestException('alias не может быть пустым');
    if (!trimmedModel) throw new BadRequestException('model не может быть пустым');
    const existing = await this.database.query(
      'SELECT alias FROM azure_models WHERE alias = $1',
      [trimmedAlias],
    );
    if (existing.rows[0]) {
      throw new BadRequestException(`Алиас ${trimmedAlias} уже существует`);
    }
    const { rows } = await this.database.query(
      `INSERT INTO azure_models (alias, model)
       VALUES ($1, $2)
       RETURNING alias, model, created_at, updated_at`,
      [trimmedAlias, trimmedModel],
    );
    return rows[0];
  }

  async updateAzureModel(alias: string, model: string) {
    const trimmedModel = model.trim();
    if (!trimmedModel) throw new BadRequestException('model не может быть пустым');
    const { rows } = await this.database.query(
      `UPDATE azure_models
       SET model = $2, updated_at = now()
       WHERE alias = $1
       RETURNING alias, model, created_at, updated_at`,
      [alias, trimmedModel],
    );
    if (!rows[0]) throw new NotFoundException('Алиас Azure не найден');
    return rows[0];
  }

  async deleteAzureModel(alias: string) {
    const { rows } = await this.database.query(
      'DELETE FROM azure_models WHERE alias = $1 RETURNING alias',
      [alias],
    );
    if (!rows[0]) throw new NotFoundException('Алиас Azure не найден');
    return { alias: rows[0].alias };
  }

  // ───────────────────────── Экспертиза (issue #147) ─────────────────────────

  /** Список документов экспертизы с числом фраз/эмбеддингов (для админки). */
  async listExpertiseDocuments() {
    const { rows } = await this.database.query(
      `SELECT d.id,
              d.title,
              d.content,
              d.embedding_sources,
              d.tags,
              d.game_id,
              COUNT(e.id)::int AS embedding_count,
              d.created_at,
              d.updated_at
         FROM expertise_documents d
         LEFT JOIN expertise_document_embeddings e ON e.document_id = d.id
        GROUP BY d.id
        ORDER BY d.created_at DESC`,
    );
    return { items: rows };
  }

  /** Возвращает документ экспертизы по id. */
  async getExpertiseDocument(id: string) {
    const { rows } = await this.database.query(
      `SELECT id, title, content, embedding_sources, tags, game_id, created_at, updated_at
         FROM expertise_documents
        WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Документ экспертизы не найден');
    return rows[0];
  }

  /** Создаёт документ экспертизы и генерирует эмбеддинги поисковых фраз. */
  async createExpertiseDocument(input: {
    title: string;
    content: string;
    embeddingSources: string[];
    tags?: string[];
    gameId?: string | null;
  }) {
    const data = await this.normalizeExpertiseInput(input);
    const embeddings = await this.embeddings.embed(data.embeddingSources);
    return this.database.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO expertise_documents (title, content, embedding_sources, tags, game_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, title, content, embedding_sources, tags, game_id, created_at, updated_at`,
        [data.title, data.content, data.embeddingSources, data.tags, data.gameId],
      );
      const doc = rows[0] as { id: string };
      await this.writeExpertiseEmbeddings(client, doc.id, data.embeddingSources, embeddings);
      return rows[0];
    });
  }

  /** Обновляет документ экспертизы и пересоздаёт эмбеддинги поисковых фраз. */
  async updateExpertiseDocument(
    id: string,
    input: {
      title: string;
      content: string;
      embeddingSources: string[];
      tags?: string[];
      gameId?: string | null;
    },
  ) {
    const data = await this.normalizeExpertiseInput(input);
    const embeddings = await this.embeddings.embed(data.embeddingSources);
    return this.database.transaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE expertise_documents
            SET title = $2, content = $3, embedding_sources = $4, tags = $5, game_id = $6, updated_at = now()
          WHERE id = $1
          RETURNING id, title, content, embedding_sources, tags, game_id, created_at, updated_at`,
        [id, data.title, data.content, data.embeddingSources, data.tags, data.gameId],
      );
      if (!rows[0]) throw new NotFoundException('Документ экспертизы не найден');
      await client.query('DELETE FROM expertise_document_embeddings WHERE document_id = $1', [id]);
      await this.writeExpertiseEmbeddings(client, id, data.embeddingSources, embeddings);
      return rows[0];
    });
  }

  // ── Выгрузка/загрузка документов экспертизы (issue #156) ─────────────────

  /** Полная выгрузка документов экспертизы в JSON-конверте. */
  async exportExpertiseDocuments() {
    const { rows } = await this.database.query<ExpertiseExportRow>(
      `SELECT id, title, content, embedding_sources, tags, game_id, created_at, updated_at
         FROM expertise_documents
        ORDER BY created_at ASC, id ASC`,
    );
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: rows.map((row) => ({
        title: row.title,
        content: row.content,
        embeddingSources: row.embedding_sources ?? [],
        tags: row.tags ?? [],
        gameId: row.game_id,
        updatedAt: exportDate(row.updated_at),
      })),
    };
  }

  /**
   * Загрузка документов экспертизы из JSON. Документы сопоставляются по паре
   * (title, game_id): найденный обновляется, отсутствующий создаётся. Эмбеддинги
   * поисковых фраз пересчитываются для созданных и изменённых документов.
   */
  async importExpertiseDocuments(items: readonly ExpertiseImportItem[]): Promise<ImportSummary> {
    const normalized: Array<{
      title: string;
      content: string;
      embeddingSources: string[];
      tags: string[];
      gameId: string | null;
    }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      const data = await this.normalizeExpertiseInput(item);
      const key = JSON.stringify([data.gameId ?? null, data.title]);
      if (seen.has(key)) {
        throw new BadRequestException(
          `Дублирующая пара (заголовок, игра) в файле импорта: «${data.title}»`,
        );
      }
      seen.add(key);
      normalized.push(data);
    }

    const summary = emptyImportSummary(normalized.length);
    for (const item of normalized) {
      const embeddings = await this.embeddings.embed(item.embeddingSources);
      const action = await this.database.transaction(async (client) => {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM expertise_documents
            WHERE title = $1 AND game_id IS NOT DISTINCT FROM $2`,
          [item.title, item.gameId],
        );
        if (existing.rows[0]) {
          const id = existing.rows[0].id;
          await client.query(
            `UPDATE expertise_documents
                SET content = $2, embedding_sources = $3, tags = $4, updated_at = now()
              WHERE id = $1`,
            [id, item.content, item.embeddingSources, item.tags],
          );
          await client.query('DELETE FROM expertise_document_embeddings WHERE document_id = $1', [id]);
          await this.writeExpertiseEmbeddings(client, id, item.embeddingSources, embeddings);
          return 'updated' as const;
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO expertise_documents (title, content, embedding_sources, tags, game_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [item.title, item.content, item.embeddingSources, item.tags, item.gameId],
        );
        await this.writeExpertiseEmbeddings(client, inserted.rows[0].id, item.embeddingSources, embeddings);
        return 'created' as const;
      });
      addImportAction(summary, action);
    }
    return summary;
  }

  // ── Аналитика поисковых запросов экспертизы (issue #156) ─────────────────

  /**
   * Журнал поисковых запросов экспертизы с фильтрами:
   * - `gameId` — область (игра либо служба поддержки при `support`);
   * - `before` — запросы строго раньше указанного момента;
   * - `phrase` — семантический поиск ближайших запросов (эмбеддинг фразы и
   *   сортировка по косинусной близости `embedding <=> $vec`);
   * - `minSimilarity`/`maxSimilarity` — отбор по качеству лучшего совпадения
   *   (например, только удачные запросы или, наоборот, ничего не нашедшие).
   * Без фразы сортировка — по убыванию лучшего совпадения, затем по дате.
   */
  async listExpertiseSearchQueries(input: {
    gameId?: string;
    support?: boolean;
    before?: string;
    phrase?: string;
    minSimilarity?: number;
    maxSimilarity?: number;
    limit: number;
    offset: number;
  }) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (input.support) {
      where.push('q.game_id IS NULL');
    } else if (input.gameId) {
      where.push(`q.game_id = ${add(input.gameId)}`);
    }
    if (input.before) {
      where.push(`q.created_at < ${add(input.before)}`);
    }
    if (input.minSimilarity !== undefined) {
      where.push(`COALESCE(q.best_similarity, 0) >= ${add(input.minSimilarity)}`);
    }
    if (input.maxSimilarity !== undefined) {
      where.push(`COALESCE(q.best_similarity, 0) <= ${add(input.maxSimilarity)}`);
    }

    // Семантический поиск: считаем эмбеддинг фразы и упорядочиваем по близости.
    const phrase = input.phrase?.trim();
    let distanceSelect = 'NULL::double precision AS query_distance';
    let orderSql = 'ORDER BY q.best_similarity DESC NULLS LAST, q.created_at DESC';
    if (phrase) {
      const [vector] = await this.embeddings.embed([phrase]);
      if (Array.isArray(vector) && vector.length > 0) {
        const vecParam = add(`[${vector.join(',')}]`);
        distanceSelect = `(q.embedding <=> ${vecParam}::vector) AS query_distance`;
        orderSql = `ORDER BY q.embedding <=> ${vecParam}::vector ASC, q.created_at DESC`;
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total FROM expertise_search_queries q ${whereSql}`,
      params,
    );
    params.push(input.limit, input.offset);
    const { rows } = await this.database.query<ExpertiseSearchQueryRow>(
      `SELECT
         q.id,
         q.game_id,
         q.query_text,
         q.best_similarity,
         q.result_count,
         q.retrieved_documents,
         q.created_at,
         ${distanceSelect},
         gm.manifest->>'name' AS game_name
       FROM expertise_search_queries q
       LEFT JOIN game_manifests gm ON gm.game_id = q.game_id
       ${whereSql}
       ${orderSql}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      total: total.rows[0]?.total ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        gameId: row.game_id,
        gameName: row.game_name,
        queryText: row.query_text,
        bestSimilarity: row.best_similarity,
        resultCount: row.result_count,
        retrievedDocuments: row.retrieved_documents ?? [],
        querySimilarity:
          row.query_distance === null || row.query_distance === undefined
            ? null
            : 1 - Number(row.query_distance),
        createdAt: exportDate(row.created_at),
      })),
    };
  }

  // ── Проверка поисковых запросов к базе знаний (issue #164) ───────────────

  /**
   * Вкладка «Проверка поиска»: эмбеддит произвольный поисковый ключ и возвращает,
   * какие фразы-источники (поисковые ключи) документов экспертизы он находит и
   * насколько близко (косинусная близость pgvector `<=>`). В отличие от
   * `searchExpertiseDocuments` НЕ схлопывает результат до одной строки на
   * документ — администратор видит каждый ключ отдельно, чтобы подбирать
   * корректные ключи документов.
   *
   * Область поиска: `support` — документы службы поддержки (`game_id IS NULL`),
   * `gameId` — документы конкретной игры, иначе — все документы. Возвращает
   * признак доступности эмбеддингов, чтобы UI пояснил пустой результат при
   * незаданном провайдере эмбеддингов.
   */
  async searchExpertiseSources(input: {
    query: string;
    limit: number;
    gameId?: string;
    support?: boolean;
  }) {
    const query = input.query.trim();
    const embeddingsAvailable = this.embeddings.isEnabled();
    if (!query || !embeddingsAvailable) {
      return { query, embeddingsAvailable, matches: [] };
    }
    const [vector] = await this.embeddings.embed([query]);
    if (!Array.isArray(vector) || vector.length === 0) {
      return { query, embeddingsAvailable, matches: [] };
    }
    const params: unknown[] = [`[${vector.join(',')}]`];
    const where: string[] = [];
    if (input.support) {
      where.push('d.game_id IS NULL');
    } else if (input.gameId) {
      params.push(input.gameId);
      where.push(`d.game_id = $${params.length}`);
    }
    params.push(input.limit);
    const limitParam = `$${params.length}`;
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.database.query<ExpertiseSourceMatchRow>(
      `SELECT d.id      AS document_id,
              d.title   AS document_title,
              d.game_id AS game_id,
              e.source  AS source,
              e.embedding <=> $1::vector AS distance
         FROM expertise_document_embeddings e
         JOIN expertise_documents d ON d.id = e.document_id
         ${whereSql}
        ORDER BY distance ASC
        LIMIT ${limitParam}`,
      params,
    );
    return {
      query,
      embeddingsAvailable,
      matches: rows.map((row) => {
        const distance = Number(row.distance);
        return {
          documentId: row.document_id,
          documentTitle: row.document_title,
          gameId: row.game_id,
          source: row.source,
          distance,
          similarity: 1 - distance,
        };
      }),
    };
  }

  /** Удаляет документ экспертизы (эмбеддинги уходят каскадом). */
  async deleteExpertiseDocument(id: string) {
    const { rows } = await this.database.query(
      'DELETE FROM expertise_documents WHERE id = $1 RETURNING id',
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Документ экспертизы не найден');
    return { id: rows[0].id };
  }

  /** Проверяет и нормализует вход документа экспертизы. */
  private async normalizeExpertiseInput(input: {
    title: string;
    content: string;
    embeddingSources: string[];
    tags?: string[];
    gameId?: string | null;
  }): Promise<{
    title: string;
    content: string;
    embeddingSources: string[];
    tags: string[];
    gameId: string | null;
  }> {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) throw new BadRequestException('Заголовок документа не может быть пустым');
    if (!content) throw new BadRequestException('Контент документа не может быть пустым');
    const embeddingSources = Array.from(
      new Set(input.embeddingSources.map((s) => s.trim()).filter((s) => s.length > 0)),
    );
    // Тэги (issue #321): тримминг, удаление пустых и дублей (порядок сохраняется).
    const tags = Array.from(
      new Set((input.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0)),
    );
    if (embeddingSources.length > 0 && !this.embeddings.isEnabled()) {
      throw new BadRequestException(
        'Поисковые фразы заданы, но не настроен провайдер эмбеддингов',
      );
    }
    // Привязка к игре (issue #154): пусто/null — документ службы поддержки;
    // иначе game_id должен существовать в каталоге игр.
    const rawGameId = typeof input.gameId === 'string' ? input.gameId.trim() : '';
    let gameId: string | null = null;
    if (rawGameId) {
      const { rows } = await this.database.query(
        'SELECT 1 FROM game_manifests WHERE game_id = $1',
        [rawGameId],
      );
      if (!rows[0]) throw new BadRequestException(`Игра «${rawGameId}» не найдена`);
      gameId = rawGameId;
    }
    return { title, content, embeddingSources, tags, gameId };
  }

  /** Вставляет эмбеддинги фраз (по одной строке на фразу) в рамках транзакции. */
  private async writeExpertiseEmbeddings(
    client: DatabaseClient,
    documentId: string,
    sources: string[],
    embeddings: number[][],
  ): Promise<void> {
    for (let i = 0; i < sources.length; i += 1) {
      const vector = embeddings[i];
      if (!Array.isArray(vector) || vector.length === 0) continue;
      await client.query(
        `INSERT INTO expertise_document_embeddings (document_id, source, embedding)
         VALUES ($1, $2, $3::vector)`,
        [documentId, sources[i], `[${vector.join(',')}]`],
      );
    }
  }

  // ───────────────────────── Онтология (issue #323) ─────────────────────────
  // Альтернатива Vector RAG: знания мира — типизированный граф концептов и связей.
  // Привязка к игре обязательна, потому что граф всегда принадлежит игре.

  /**
   * Граф онтологии игры целиком (концепты + связи) для админки. Поля origin и
   * source_document_id (issue #328, Graph RAG) позволяют админке отличать ручную
   * разметку ('authored', #323) от автоизвлечённой ('extracted') и предлагать
   * верификацию последней.
   */
  async getGameOntology(gameId: string) {
    await this.assertGameExists(gameId);
    const graph = await this.ontologyStore().getGameOntology(gameId);
    return { gameId, concepts: graph.concepts, relations: graph.relations };
  }

  /**
   * Сообщества графа игры со сводками (issue #328, Graph RAG). Сообщества —
   * производная графа (кластеры концептов с LLM-сводкой), питают обзорный
   * Graph RAG-запрос. Только чтение: набор перестраивается offline-индексацией
   * бота, не правится поштучно в админке.
   */
  async getGameCommunities(gameId: string) {
    await this.assertGameExists(gameId);
    const communities = await this.ontologyStore().getGameCommunities(gameId);
    return { gameId, communities };
  }

  /**
   * Верификация автором извлечённого концепта (issue #328, борьба с шумом
   * автоизвлечения): помечает строку как подтверждённую (origin 'extracted' →
   * 'authored'), чтобы будущие переиндексации её не перетирали. 404, если
   * концепта нет; 409-подобная ошибка не нужна — повтор на уже authored просто
   * ничего не меняет, поэтому возвращаем актуальную строку.
   */
  async verifyOntologyConcept(id: string) {
    const row = await this.ontologyStore().verifyOntologyConcept(id);
    if (!row) throw new NotFoundException('Концепт онтологии не найден');
    return row;
  }

  /** Верификация автором извлечённой связи (extracted → authored, issue #328). */
  async verifyOntologyRelation(id: string) {
    const row = await this.ontologyStore().verifyOntologyRelation(id);
    if (!row) throw new NotFoundException('Связь онтологии не найдена');
    return row;
  }

  /** Создаёт концепт онтологии игры. */
  async createOntologyConcept(gameId: string, input: OntologyConceptInput) {
    await this.assertGameExists(gameId);
    const data = normalizeOntologyConcept(input);
    try {
      return await this.ontologyStore().createOntologyConcept(gameId, data);
    } catch (err) {
      throw mapOntologyConflict(err, `Концепт «${data.slug}» уже существует в этой игре`);
    }
  }

  /** Обновляет концепт онтологии игры (game_id не меняется). */
  async updateOntologyConcept(id: string, input: OntologyConceptInput) {
    const data = normalizeOntologyConcept(input);
    try {
      const row = await this.ontologyStore().updateOntologyConcept(id, data);
      if (!row) throw new NotFoundException('Концепт онтологии не найден');
      return row;
    } catch (err) {
      throw mapOntologyConflict(err, `Концепт «${data.slug}» уже существует в этой игре`);
    }
  }

  /** Удаляет концепт онтологии игры. */
  async deleteOntologyConcept(id: string) {
    const deleted = await this.ontologyStore().deleteOntologyConcept(id);
    if (!deleted) throw new NotFoundException('Концепт онтологии не найден');
    return { id: deleted };
  }

  /** Создаёт связь онтологии игры. */
  async createOntologyRelation(gameId: string, input: OntologyRelationInput) {
    await this.assertGameExists(gameId);
    const data = normalizeOntologyRelation(input);
    try {
      return await this.ontologyStore().createOntologyRelation(gameId, data);
    } catch (err) {
      throw mapOntologyConflict(err, 'Такая связь между концептами уже существует');
    }
  }

  /** Обновляет связь онтологии игры. */
  async updateOntologyRelation(id: string, input: OntologyRelationInput) {
    const data = normalizeOntologyRelation(input);
    try {
      const row = await this.ontologyStore().updateOntologyRelation(id, data);
      if (!row) throw new NotFoundException('Связь онтологии не найдена');
      return row;
    } catch (err) {
      throw mapOntologyConflict(err, 'Такая связь между концептами уже существует');
    }
  }

  /** Удаляет связь онтологии игры. */
  async deleteOntologyRelation(id: string) {
    const deleted = await this.ontologyStore().deleteOntologyRelation(id);
    if (!deleted) throw new NotFoundException('Связь онтологии не найдена');
    return { id: deleted };
  }

  /** Полная выгрузка графа онтологии игры в JSON-конверте. */
  async exportGameOntology(gameId: string) {
    await this.assertGameExists(gameId);
    const graph = await this.ontologyStore().exportGameOntology(gameId);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      gameId,
      concepts: graph.concepts.map((row) => ({
        slug: String(row.slug ?? ''),
        kind: String(row.kind ?? ''),
        title: String(row.title ?? ''),
        synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
        fact: String(row.fact ?? ''),
        weight: Number(row.weight ?? 1),
      })),
      relations: graph.relations.map((row) => ({
        fromSlug: String(row.from_slug ?? ''),
        toSlug: String(row.to_slug ?? ''),
        relation: String(row.relation ?? ''),
        weight: Number(row.weight ?? 1),
        condition: (row.condition as Record<string, unknown> | null | undefined) ?? null,
        note: String(row.note ?? ''),
      })),
    };
  }

  /**
   * Загрузка графа онтологии из JSON для одной игры. Концепты сопоставляются по
   * (game_id, slug), связи — по (game_id, from_slug, to_slug, relation): найденные
   * обновляются, отсутствующие создаются. Всё в одной Neo4j-транзакции.
   */
  async importGameOntology(payload: OntologyImportPayload): Promise<ImportSummary> {
    await this.assertGameExists(payload.gameId);
    const concepts = payload.concepts.map((c) => normalizeOntologyConcept(c));
    const relations = payload.relations.map((r) => normalizeOntologyRelation(r));
    const summary = emptyImportSummary(concepts.length + relations.length);
    const imported = await this.ontologyStore().importGameOntology({
      gameId: payload.gameId,
      concepts,
      relations,
    });
    summary.created = imported.created;
    summary.updated = imported.updated;
    return summary;
  }

  /** Проверяет, что игра существует в каталоге (иначе 400). */
  private async assertGameExists(gameId: string): Promise<void> {
    const raw = typeof gameId === 'string' ? gameId.trim() : '';
    if (!raw) throw new BadRequestException('Не указана игра онтологии');
    const { rows } = await this.database.query('SELECT 1 FROM game_manifests WHERE game_id = $1', [
      raw,
    ]);
    if (!rows[0]) throw new BadRequestException(`Игра «${raw}» не найдена`);
  }

  async getLlmRequest(requestId: string) {
    const { rows } = await this.database.query(
      `SELECT
         l.id,
         l.user_id,
         l.session_id,
         l.step_id,
         l.support_ticket_id,
         l.schema_slug,
         l.node_id,
         l.provider,
         l.model,
         l.model_params,
         l.request_text,
         l.response_text,
         l.error_text,
         (l.error_text IS NOT NULL) AS has_error,
         l.cost_millicents::text AS cost_millicents,
         l.token_usage,
         l.retrieved_documents,
         l.created_at,
         u.telegram_id::text AS user_telegram_id,
         u.username AS user_username
       FROM llm_request_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.id = $1`,
      [requestId],
    );
    if (!rows[0]) throw new NotFoundException('Запрос LLM не найден');
    return rows[0];
  }

  // ── Журнал исполнения схем (issue #255, этап F) ──────────────────────────
  // Просмотр и фильтрация записей schema_execution_log: оператор видит причину
  // сбоя (узел, тип, сообщение, сырой ответ) без доступа к серверным логам.

  /**
   * Список записей журнала исполнения схем с фильтрами и пагинацией.
   *
   * Поддерживает фильтры по типу схемы, игре, slug, статусу (`ok`/`error`) и
   * сессии. Для списка крупные поля (inputs/outputs/llm_log) не отдаём —
   * только сводку и признак наличия ошибки.
   */
  async listSchemaExecutions(input: {
    schemaType?: string;
    gameId?: string;
    schemaSlug?: string;
    status?: string;
    sessionId?: string;
    limit: number;
    offset: number;
  }) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (input.schemaType) {
      if (!isAdminSchemaType(input.schemaType)) {
        throw new BadRequestException('schemaType должен быть одним из: action, hint, illustration, support');
      }
      where.push(`e.schema_type = ${add(input.schemaType)}`);
    }
    if (input.gameId) where.push(`e.game_id = ${add(input.gameId)}`);
    if (input.schemaSlug) where.push(`e.schema_slug = ${add(input.schemaSlug)}`);
    if (input.status === 'ok' || input.status === 'error') {
      where.push(`e.status = ${add(input.status)}`);
    }
    if (input.sessionId) where.push(`e.session_id = ${add(input.sessionId)}`);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total FROM schema_execution_log e ${whereSql}`,
      params,
    );
    params.push(input.limit, input.offset);
    const rows = await this.database.query(
      `SELECT
         e.id,
         e.schema_slug,
         e.schema_type,
         e.game_id,
         e.session_id,
         e.status,
         (e.status = 'error') AS has_error,
         e.error_node_id,
         e.error_node_type,
         e.error_message,
         e.duration_ms,
         e.created_at
       FROM schema_execution_log e
       ${whereSql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: total.rows[0]?.total ?? 0, items: rows.rows };
  }

  /** Полная запись журнала исполнения схемы (с входами, выходами и LLM-логом). */
  async getSchemaExecution(id: string) {
    const { rows } = await this.database.query(
      `SELECT
         e.id,
         e.schema_slug,
         e.schema_type,
         e.game_id,
         e.session_id,
         e.status,
         (e.status = 'error') AS has_error,
         e.error_node_id,
         e.error_node_type,
         e.error_message,
         e.error_last_raw,
         e.inputs_json,
         e.outputs_json,
         e.llm_log,
         e.duration_ms,
         e.created_at
       FROM schema_execution_log e
       WHERE e.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Запись журнала исполнения не найдена');
    return rows[0];
  }

  /**
   * Сводка свежих ошибок исполнения схем для подсветки/счётчика в навигации.
   *
   * Возвращает число ошибок за окно (по умолчанию 24 часа) и общее число
   * ошибок. Оператор видит бейдж, если рантайм недавно не нашёл активной схемы
   * или узел упал (issue #255, этап F).
   */
  async countRecentSchemaErrors(input?: { sinceMinutes?: number }) {
    const sinceMinutes =
      input?.sinceMinutes && input.sinceMinutes > 0 ? Math.floor(input.sinceMinutes) : 24 * 60;
    const { rows } = await this.database.query<{ recent: number; total: number }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE status = 'error' AND created_at >= now() - ($1 || ' minutes')::interval
         )::int AS recent,
         COUNT(*) FILTER (WHERE status = 'error')::int AS total
       FROM schema_execution_log`,
      [String(sinceMinutes)],
    );
    return {
      sinceMinutes,
      recent: rows[0]?.recent ?? 0,
      total: rows[0]?.total ?? 0,
    };
  }

  private async normalizeSchemaInput(input: {
    slug: string;
    schemaType?: string;
    schemaClass?: string;
    graphJson: JsonObject;
    description?: string;
    gameId?: string | null;
  }): Promise<{
    slug: string;
    schemaType: AdminSchemaType | null;
    schemaClass: AdminSubSchemaClass | null;
    graphJson: AdminSchemaGraph;
    description: string;
    gameId: string | null;
  }> {
    const slug = input.slug.trim();
    assertSchemaSlug(slug);
    // Вид схемы (issue #310): ровно одно из schemaType (пайплайн-схема) или
    // schemaClass (суб-схема). Если поле пришло в запросе — используем как
    // ожидаемый вид для сверки с графом; иначе вид берём из самого графа.
    const hasType = input.schemaType !== undefined && input.schemaType !== null;
    const hasClass = input.schemaClass !== undefined && input.schemaClass !== null;
    if (hasType && hasClass) {
      throw new BadRequestException('Укажите ровно одно из schemaType (пайплайн-схема) или schemaClass (суб-схема)');
    }
    if (hasType && !isAdminSchemaType(input.schemaType)) {
      throw new BadRequestException(`schemaType должен быть одним из: action, hint, illustration, support`);
    }
    if (hasClass && !isAdminSubSchemaClass(input.schemaClass)) {
      throw new BadRequestException(`schemaClass должен быть одним из: ${SUB_SCHEMA_CLASSES.join(', ')}`);
    }
    const expectedKind = hasType ? input.schemaType : hasClass ? input.schemaClass : undefined;
    const graphJson = normalizeSchemaGraph(input.graphJson, slug, expectedKind);
    const gameId = input.gameId === undefined ? graphJson.gameId ?? null : input.gameId;
    assertOptionalGameId(gameId);
    if (graphJson.gameId !== undefined && gameId !== graphJson.gameId) {
      throw new BadRequestException(`graphJson.gameId должен совпадать с gameId ${gameId ?? 'null'}`);
    }
    if (gameId) await this.ensureGameExists(gameId);
    return {
      slug,
      schemaType: graphJson.schemaType ?? null,
      schemaClass: graphJson.subSchemaClass ?? null,
      graphJson,
      description: input.description?.trim() ?? '',
      gameId: gameId ?? null,
    };
  }

  private async normalizeSchemaImportItems(items: readonly SchemaImportItem[]): Promise<Array<{
    slug: string;
    schemaType: AdminSchemaType | null;
    schemaClass: AdminSubSchemaClass | null;
    graphJson: AdminSchemaGraph;
    description: string;
    gameId: string | null;
  }>> {
    const seen = new Set<string>();
    const normalized = [];
    for (const item of items) {
      const data = await this.normalizeSchemaInput({
        slug: item.schemaSlug,
        schemaType: item.schemaType,
        schemaClass: item.schemaClass,
        graphJson: item.graphJson,
        description: item.description,
        gameId: item.gameId,
      });
      const key = `${data.slug}\0${data.gameId ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException(`Дублирующая схема в файле импорта: ${data.slug}`);
      }
      seen.add(key);
      normalized.push(data);
    }
    return normalized;
  }

  private async upsertImportedSchema(
    client: DatabaseClient,
    item: {
      slug: string;
      schemaType: AdminSchemaType | null;
      schemaClass: AdminSubSchemaClass | null;
      graphJson: AdminSchemaGraph;
      description: string;
      gameId: string | null;
    },
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const graphJson = JSON.stringify(item.graphJson);
    const existing = await client.query<SchemaRow>(
      `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description, created_at, updated_at
         FROM schemas
        WHERE schema_slug = $1
          AND game_id IS NOT DISTINCT FROM $2
          AND is_active = TRUE
        LIMIT 1`,
      [item.slug, item.gameId],
    );
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
         VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)`,
        [item.slug, item.schemaType, item.schemaClass, item.gameId, graphJson, item.description],
      );
      return 'created';
    }

    const unchanged = await client.query<SchemaSlugRow>(
      `SELECT schema_slug
         FROM schemas
        WHERE id = $1
          AND schema_type IS NOT DISTINCT FROM $2
          AND schema_class IS NOT DISTINCT FROM $3
          AND graph_json = $4::jsonb
          AND description = $5`,
      [existing.rows[0].id, item.schemaType, item.schemaClass, graphJson, item.description],
    );
    if (unchanged.rows[0]) return 'unchanged';

    await client.query(
      `INSERT INTO schema_history (
         schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
         created_at, updated_at, version_created_at
       )
       SELECT schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description,
              created_at, updated_at, updated_at
         FROM schemas
        WHERE id = $1`,
      [existing.rows[0].id],
    );
    await client.query(
      `UPDATE schemas
          SET is_active = FALSE,
              updated_at = now()
        WHERE id = $1`,
      [existing.rows[0].id],
    );
    await client.query(
      `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
       VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)`,
      [item.slug, item.schemaType, item.schemaClass, item.gameId, graphJson, item.description],
    );
    return 'updated';
  }

  private async findActiveSchema(slug: string, gameId: string | null): Promise<SchemaRow | null> {
    const { rows } = await this.database.query<SchemaRow>(
      `SELECT id, schema_slug, schema_type, schema_class, game_id, graph_json, draft_graph_json, is_active, description, created_at, updated_at
         FROM schemas
        WHERE schema_slug = $1
          AND is_active = TRUE
          AND (game_id IS NULL OR game_id = $2)
        ORDER BY CASE WHEN game_id = $2 THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1`,
      [slug, gameId],
    );
    return rows[0] ?? null;
  }

  private async ensureSchemaExists(slug: string, gameId?: string | null): Promise<void> {
    const params: unknown[] = [slug];
    const gameFilter =
      gameId === undefined
        ? ''
        : `AND game_id IS NOT DISTINCT FROM $${params.push(gameId)}::text`;
    const active = await this.database.query<SchemaSlugRow>(
      `SELECT schema_slug
         FROM schemas
        WHERE schema_slug = $1
          ${gameFilter}
        LIMIT 1`,
      params,
    );
    if (active.rows[0]) return;
    const history = await this.database.query<SchemaSlugRow>(
      `SELECT schema_slug
         FROM schema_history
        WHERE schema_slug = $1
          ${gameFilter}
        LIMIT 1`,
      params,
    );
    if (!history.rows[0]) throw new NotFoundException('Схема не найдена');
  }

  private async buildSchemaTestContext(input: SchemaTestRunInput): Promise<SchemaTestContextData> {
    const gameId = input.gameId ?? null;
    const manifest = gameId ? await this.loadGameManifest(gameId) : this.defaultTestManifest('test');
    const state = isJsonObject(input.inputs.state) ? input.inputs.state : this.defaultTestState();
    return {
      gameId,
      manifest,
      state,
      history: normalizeTestHistory(input.inputs.history),
      memoryCells: normalizeTestMemoryCells(input.inputs.memoryCells ?? input.inputs.memory_cells),
      supportHistory: normalizeTestSupportHistory(input.inputs.supportHistory),
    };
  }

  private buildSchemaExecutionInputs(
    inputs: Record<string, unknown>,
    context: SchemaTestContextData,
    kind: string | undefined,
  ): Record<string, unknown> {
    const defaultExpertiseTopK = kind === 'support'
      ? this.configNumber('SUPPORT_EXPERTISE_TOP_K', 3)
      : this.configNumber('GAME_EXPERTISE_TOP_K', 2);
    const expertiseTopK = nonNegativeInteger(
      inputs.expertiseTopK,
      defaultExpertiseTopK,
    );
    const memoryTopK = nonNegativeInteger(
      inputs.memoryTopK,
      this.configNumber('GAME_MEMORY_TOP_K', 12),
    );
    return {
      ...inputs,
      history: context.history,
      memoryCells: context.memoryCells,
      expertiseTopK,
      memoryTopK,
      expertise_enabled: expertiseTopK > 0 && Boolean(this.embeddings?.isEnabled()),
      memory_enabled: memoryTopK > 0,
    };
  }

  private async createSchemaTestProvider(
    graph: AdminSchemaGraph,
    inputs: Record<string, unknown>,
  ): Promise<RuntimeSchemaTestProvider> {
    const mockResponses = mockLlmResponses(inputs);
    if (mockResponses.length > 0) {
      return {
        provider: createMockLLMProvider(mockResponses, normalizeMockUsage(inputs.mockUsage)),
      };
    }
    if (!graphNeedsLlmProvider(graph)) return { provider: createNoopLLMProvider() };
    const provider = await this.buildConfiguredProvider(
      this.defaultProviderName(),
      await this.effectiveDefaultModelName(),
    );
    if (provider) return { provider };
    throw new BadRequestException('Не задан API-ключ LLM-провайдера для test-run');
  }

  private async createSchemaTestEmbeddingProvider(): Promise<RuntimeEmbeddingProvider | undefined> {
    if (!this.embeddings?.isEnabled()) return undefined;
    const model = await this.effectiveEmbeddingModelName();
    return {
      model,
      embed: async (inputs: string[]) => ({ embeddings: await this.embeddings.embed(inputs) }),
    };
  }

  private async createSchemaTestRouter(
    baseProvider: RuntimeLLMProvider,
  ): Promise<RuntimeModelRouter> {
    const fallbackProviderName = this.defaultProviderName();
    const fallbackModel = await this.effectiveDefaultModelName();
    const fallbackPricing = await this.resolveModelPricing(fallbackProviderName, fallbackModel);
    const route: RuntimeRoutedModel = {
      provider: baseProvider,
      providerName: fallbackProviderName,
      model: fallbackModel,
      pricing: fallbackPricing,
    };

    return {
      resolve: async () => route,
    };
  }

  private async buildConfiguredProvider(
    providerName: LLMProviderName,
    modelName: string,
  ): Promise<RuntimeLLMProvider | null> {
    const factory = await loadLLMFactoryModule();
    return factory.buildLLMProvider(
      this.buildRuntimeConfig(modelName, await this.effectiveEmbeddingModelName()),
      providerName,
      modelName,
    );
  }

  private buildRuntimeConfig(llmModelName: string, embeddingModel: string): unknown {
    const provider = this.defaultProviderName();
    const providerKeys: Record<LLMProviderName, string> = {
      OPENAI: this.configValue('OPENAI_API_KEY', ''),
      GOOGLE: this.configValue('GOOGLE_API_KEY', ''),
      OPENROUTER: this.configValue('OPENROUTER_API_KEY', ''),
      AZURE: this.configValue('AZURE_OPENAI_API_KEY', ''),
    };
    const azureEndpoint = this.configValue('AZURE_OPENAI_ENDPOINT', '');
    const embeddingProvider = this.configValue('EMBEDDING_PROVIDER', 'OPENAI').toUpperCase();
    const embeddingDeployment = this.configValue('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', '');
    return {
      llm: {
        provider,
        apiKey: providerKeys[provider],
        modelName: llmModelName,
        temperature: this.configNumber('LLM_TEMPERATURE', 0.7),
        maxRetries: this.configNumber('LLM_MAX_RETRIES', 2),
        providerKeys,
        ...(azureEndpoint
          ? {
              azure: {
                endpoint: azureEndpoint,
                apiVersion: this.configValue('AZURE_OPENAI_API_VERSION', '2024-10-21'),
                models: {},
              },
            }
          : {}),
      },
      embedding: {
        provider: embeddingProvider,
        apiKey: this.configValue(
          embeddingProvider === 'AZURE'
            ? 'AZURE_OPENAI_API_KEY'
            : 'OPENAI_API_KEY',
          '',
        ),
        model: embeddingModel,
        ...(azureEndpoint && embeddingDeployment
          ? {
              azure: {
                endpoint: azureEndpoint,
                apiVersion: this.configValue('AZURE_OPENAI_API_VERSION', '2024-10-21'),
                deploymentName: embeddingDeployment,
              },
            }
          : {}),
      },
    };
  }

  private async resolveModelPricing(
    providerName: LLMProviderName,
    modelName: string,
  ): Promise<RuntimeModelPricing | null> {
    const pricing = await loadPricingModule();
    const pricedModel = providerName === 'AZURE' ? await this.resolveAzureModelName(modelName) : modelName;
    return pricing.findModelPricing(pricedModel);
  }

  private async resolveAzureModelName(modelName: string): Promise<string> {
    const { rows } = await this.database.query<AzureModelRuntimeRow>(
      'SELECT model FROM azure_models WHERE alias = $1',
      [modelName],
    );
    return rows[0]?.model ?? modelName;
  }

  private defaultProviderName(): LLMProviderName {
    const configured = this.configValue('LLM_PROVIDER', 'GOOGLE').toUpperCase();
    return isLLMProviderName(configured) ? configured : 'GOOGLE';
  }

  private defaultModelName(): string {
    return this.configValue('LLM_MODEL_NAME', 'gemini-1.5-flash');
  }

  private defaultEmbeddingProviderName(): string {
    return this.configValue('EMBEDDING_PROVIDER', 'OPENAI').toUpperCase();
  }

  private defaultEmbeddingModelName(): string {
    return this.configValue('EMBEDDING_MODEL', 'text-embedding-3-small');
  }

  private async effectiveDefaultModelName(): Promise<string> {
    const defaults = await this.readModelDefaults({
      llmModelName: this.defaultModelName(),
      embeddingModel: this.defaultEmbeddingModelName(),
    });
    return defaults.llmModelName;
  }

  private async effectiveEmbeddingModelName(): Promise<string> {
    const defaults = await this.readModelDefaults({
      llmModelName: this.defaultModelName(),
      embeddingModel: this.defaultEmbeddingModelName(),
    });
    return defaults.embeddingModel;
  }

  private async readModelDefaults(fallbacks: {
    llmModelName: string;
    embeddingModel: string;
  }): Promise<ResolvedModelDefaults> {
    const { rows } = await this.database.query<ModelDefaultRow>(
      `SELECT key, value, updated_at
         FROM model_defaults
        WHERE key = ANY($1::text[])`,
      [[LLM_MODEL_DEFAULT_KEY, EMBEDDING_MODEL_DEFAULT_KEY]],
    );
    const byKey = new Map<string, ModelDefaultRow>();
    for (const row of rows) {
      const value = row.value.trim();
      if (value) byKey.set(row.key, { ...row, value });
    }
    const llm = byKey.get(LLM_MODEL_DEFAULT_KEY);
    const embedding = byKey.get(EMBEDDING_MODEL_DEFAULT_KEY);
    return {
      llmModelName: llm?.value ?? fallbacks.llmModelName,
      llmModelSource: llm ? 'database' : 'env',
      llmUpdatedAt: llm?.updated_at ?? null,
      embeddingModel: embedding?.value ?? fallbacks.embeddingModel,
      embeddingModelSource: embedding ? 'database' : 'env',
      embeddingUpdatedAt: embedding?.updated_at ?? null,
    };
  }

  private schemaMaxRetries(inputs: Record<string, unknown>): number {
    return positiveInteger(inputs.maxRetries, this.configNumber('LLM_MAX_RETRIES', 2));
  }

  private async calcSchemaTestCost(
    llmLog: readonly RuntimeLlmLogEntry[],
    router: RuntimeModelRouter,
  ): Promise<number> {
    let total = 0;
    const route = await router.resolve();
    if (!route.pricing) return 0;
    for (const entry of llmLog) {
      const usage = usageToTokenUsage(entry.usage);
      if (isEmptyTokenUsage(usage)) continue;
      total += calcCostMillicents(usage, route.pricing);
    }
    return total;
  }

  private async logSchemaTestExecution(
    row: SchemaRow,
    context: SchemaTestContextData,
    inputs: Record<string, unknown>,
    outputs: Record<string, unknown>,
    llmLog: readonly RuntimeLlmLogEntry[],
    durationMs: number,
    error?: { nodeId?: string; nodeType?: AdminNodeType; message: string; lastRaw?: string },
  ): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO schema_execution_log (
           schema_slug, schema_type, schema_class, game_id, session_id, status,
           inputs_json, outputs_json, llm_log, duration_ms,
           error_node_id, error_node_type, error_message, error_last_raw
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)`,
        [
          row.schema_slug,
          row.schema_type,
          row.schema_class,
          context.gameId,
          null,
          error ? 'error' : 'ok',
          JSON.stringify(inputs),
          JSON.stringify(outputs),
          JSON.stringify(llmLog),
          durationMs,
          error?.nodeId ?? null,
          error?.nodeType ?? null,
          error?.message ?? null,
          error?.lastRaw ?? null,
        ],
      );
    } catch (err) {
      console.error('[admin-schema-test] не удалось записать schema_execution_log:', err);
    }
  }

  /**
   * Сохраняет каждый LLM-запрос тестового прогона схемы в общий аудит
   * llm_request_logs (issue #403, R3). Логируется КАЖДЫЙ вызов — и из игрового
   * хода, и из теста схемы — с указанием слага схемы и узла-источника. Сессии у
   * теста нет (user_id/session_id = NULL), поэтому записи отличимы по schema_slug.
   * Best-effort: ошибка аудита не должна ломать тест.
   */
  private async logSchemaTestLlmRequests(
    row: SchemaRow,
    llmLog: readonly RuntimeLlmLogEntry[],
    router: RuntimeModelRouter,
  ): Promise<void> {
    if (llmLog.length === 0) return;
    try {
      const route = await router.resolve();
      for (const entry of llmLog) {
        const usage = usageToTokenUsage(entry.usage);
        const cost = route.pricing ? calcCostMillicents(usage, route.pricing) : 0;
        const nodeId =
          entry.nodeId ??
          (typeof entry.modelParams?.nodeId === 'string' ? entry.modelParams.nodeId : null);
        const schemaSlug = entry.schemaSlug ?? row.schema_slug ?? null;
        await this.database.query(
          `INSERT INTO llm_request_logs (
             user_id, session_id, step_id, support_ticket_id, schema_slug, node_id,
             provider, model, model_params, request_text, response_text, error_text,
             token_usage, cost_millicents, retrieved_documents
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15::jsonb)`,
          [
            null,
            null,
            null,
            null,
            schemaSlug,
            nodeId,
            route.provider.name,
            route.model,
            JSON.stringify(entry.modelParams ?? {}),
            entry.request,
            entry.error ? null : entry.response,
            entry.error ?? null,
            JSON.stringify(usage),
            cost,
            entry.retrievedDocuments ? JSON.stringify(entry.retrievedDocuments) : null,
          ],
        );
      }
    } catch (err) {
      console.error('[admin-schema-test] не удалось записать llm_request_logs:', err);
    }
  }

  private schemaTestErrorSummary(
    graph: AdminSchemaGraph,
    err: unknown,
  ): { nodeId?: string; nodeType?: AdminNodeType; message: string; lastRaw?: string } {
    const nodeId = schemaNodeErrorId(err);
    const node = nodeId ? graph.nodes.find((candidate) => candidate.id === nodeId) : undefined;
    const lastRaw = schemaNodeErrorLastRaw(err);
    return {
      ...(nodeId ? { nodeId } : {}),
      ...(node ? { nodeType: node.type } : {}),
      message: errorMessage(err),
      ...(lastRaw ? { lastRaw } : {}),
    };
  }

  private configValue(name: string, fallback: string): string {
    return (this.config?.get<string>(name) ?? process.env[name] ?? fallback).trim();
  }

  private configNumber(name: string, fallback: number): number {
    const raw = Number(this.configValue(name, String(fallback)));
    return Number.isFinite(raw) ? raw : fallback;
  }

  private async loadGameManifest(gameId: string): Promise<JsonObject> {
    const { rows } = await this.database.query<SchemaGameManifestRow>(
      'SELECT game_id, manifest FROM game_manifests WHERE game_id = $1',
      [gameId],
    );
    if (!rows[0]) throw new BadRequestException(`Игра «${gameId}» не найдена`);
    return rows[0].manifest;
  }

  private defaultTestManifest(gameId: string): JsonObject {
    return {
      id: gameId,
      name: 'Тестовая схема',
      description: '',
      priceStars: 1,
      limits: { maxHp: 100, maxInventoryItems: 10 },
      worldRules: [],
      startTime: { season: 'лето', date: '1 июня', time: '12:00', time_of_day: 'день' },
      characterPresets: [],
      locationPresets: [],
    };
  }

  private defaultTestState(): JsonObject {
    return {
      location: 'Тестовая локация',
      narrative: '',
      character: { hp: 100, max_hp: 100, skills: {}, inventory: [] },
      world_flags: {},
      world_time: { season: 'лето', date: '1 июня', time: '12:00', time_of_day: 'день' },
      turn_count: 0,
    };
  }

  private formatSchemaRow(row: SchemaRow, includeGraph: boolean): JsonObject {
    return {
      id: row.id,
      schema_slug: row.schema_slug,
      schema_type: row.schema_type,
      schema_class: row.schema_class,
      game_id: row.game_id,
      is_active: row.is_active,
      description: row.description,
      has_draft: row.draft_graph_json !== null && row.draft_graph_json !== undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(includeGraph ? { graph_json: row.graph_json } : {}),
    };
  }

  private formatSchemaHistoryRow(row: SchemaHistoryRow, includeGraph: boolean): JsonObject {
    return {
      id: row.id,
      schema_slug: row.schema_slug,
      schema_type: row.schema_type,
      schema_class: row.schema_class,
      game_id: row.game_id,
      is_active: row.is_active,
      description: row.description,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version_created_at: row.version_created_at,
      archived_at: row.archived_at,
      ...(includeGraph ? { graph_json: row.graph_json } : {}),
    };
  }

  private normalizeGameManifestImportItems(items: readonly GameManifestImportItem[]): NormalizedGameManifestImportItem[] {
    const seen = new Set<string>();
    return items.map((item) => {
      const rawManifestId = typeof item.manifest.id === 'string' ? item.manifest.id : '';
      const manifestId = rawManifestId.trim();
      const gameId = (item.gameId ?? manifestId).trim();
      assertCatalogId(gameId, 'game_id');
      if (rawManifestId !== gameId) {
        throw new BadRequestException(`id манифеста должен совпадать с game_id ${gameId}`);
      }
      if (seen.has(gameId)) {
        throw new BadRequestException(`Дублирующий game_id в файле импорта: ${gameId}`);
      }
      seen.add(gameId);
      if (item.sortOrder !== undefined && !Number.isSafeInteger(item.sortOrder)) {
        throw new BadRequestException(`sortOrder для ${gameId} должен быть целым числом`);
      }
      return { gameId, manifest: item.manifest, sortOrder: item.sortOrder };
    });
  }

  private async upsertImportedGameManifest(
    client: DatabaseClient,
    item: NormalizedGameManifestImportItem,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const manifestJson = JSON.stringify(item.manifest);
    const sortOrder = item.sortOrder ?? null;
    const insert = await client.query<GameIdRow>(
      `INSERT INTO game_manifests (game_id, manifest, sort_order)
       VALUES (
         $1,
         $2::jsonb,
         COALESCE($3::int, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM game_manifests))
       )
       ON CONFLICT (game_id) DO NOTHING
       RETURNING game_id`,
      [item.gameId, manifestJson, sortOrder],
    );
    if (insert.rows[0]) return 'created';

    await client.query(
      `INSERT INTO game_manifest_history (game_id, manifest, version_created_at)
       SELECT game_id, manifest, updated_at
       FROM game_manifests
       WHERE game_id = $1 AND manifest IS DISTINCT FROM $2::jsonb`,
      [item.gameId, manifestJson],
    );
    const update = await client.query<GameIdRow>(
      `UPDATE game_manifests
       SET manifest = $2::jsonb,
           sort_order = COALESCE($3::int, sort_order),
           updated_at = now()
       WHERE game_id = $1
         AND (manifest IS DISTINCT FROM $2::jsonb
              OR ($3::int IS NOT NULL AND sort_order IS DISTINCT FROM $3::int))
       RETURNING game_id`,
      [item.gameId, manifestJson, sortOrder],
    );
    return update.rows[0] ? 'updated' : 'unchanged';
  }

  private async requireExistingGameIds(gameIds: readonly string[]): Promise<string[]> {
    const normalized = normalizeIds(gameIds);
    normalized.forEach((gameId) => assertCatalogId(gameId, 'game_id'));
    if (normalized.length === 0) return [];
    const existing = await this.database.query<GameIdRow>(
      'SELECT game_id FROM game_manifests WHERE game_id = ANY($1::TEXT[])',
      [normalized],
    );
    const existingIds = new Set(existing.rows.map((row) => row.game_id));
    const missing = normalized.filter((gameId) => !existingIds.has(gameId));
    if (missing.length > 0) {
      throw new BadRequestException(`Неизвестные game_id: ${missing.join(', ')}`);
    }
    return normalized;
  }

  private async ensureGameExists(gameId: string): Promise<void> {
    const { rows } = await this.database.query<GameIdRow>(
      'SELECT game_id FROM game_manifests WHERE game_id = $1',
      [gameId],
    );
    if (!rows[0]) throw new NotFoundException('Игра не найдена');
  }

  private async requireExistingGroupIds(groupIds: readonly string[]): Promise<string[]> {
    const normalized = normalizeIds(groupIds);
    normalized.forEach((groupId) => assertCatalogId(groupId, 'group_id'));
    if (normalized.length === 0) return [];
    const existing = await this.database.query<GroupIdRow>(
      'SELECT group_id FROM game_groups WHERE group_id = ANY($1::TEXT[])',
      [normalized],
    );
    const existingIds = new Set(existing.rows.map((row) => row.group_id));
    const missing = normalized.filter((groupId) => !existingIds.has(groupId));
    if (missing.length > 0) {
      throw new BadRequestException(`Неизвестные group_id: ${missing.join(', ')}`);
    }
    return normalized;
  }

  private async refreshAllUserGameIds(): Promise<void> {
    await this.database.query(
      `UPDATE users u
       SET game_ids = COALESCE((
         SELECT array_agg(DISTINCT gid.game_id ORDER BY gid.game_id)
         FROM game_groups gg
         CROSS JOIN LATERAL unnest(gg.game_ids) AS gid(game_id)
         WHERE gg.group_id = ANY(u.groups)
       ), ARRAY[]::TEXT[])`,
    );
  }
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const runtimeModuleCache = new Map<string, Promise<unknown>>();
let tsxEsmApiCache: Promise<TsxEsmApiModule> | undefined;

// Ядро вынесено в workspace-пакет packages/core (issue #269). Админ-API
// подгружает его рантайм-модули из файловой системы (а не как пакет-зависимость),
// поэтому пути считаются относительно корня монорепо.
function loadSchemaEngineModule(): Promise<SchemaEngineModule> {
  return loadRuntimeModule<SchemaEngineModule>(
    'packages/core/dist/engine/schemaEngine.js',
    'packages/core/src/engine/schemaEngine.ts',
  );
}

function loadLLMFactoryModule(): Promise<RuntimeFactoryModule> {
  return loadRuntimeModule<RuntimeFactoryModule>(
    'packages/core/dist/llm/factory.js',
    'packages/core/src/llm/factory.ts',
  );
}

function loadPricingModule(): Promise<RuntimePricingModule> {
  return loadRuntimeModule<RuntimePricingModule>(
    'packages/core/dist/llm/pricing.js',
    'packages/core/src/llm/pricing.ts',
  );
}

function loadRuntimeModule<T>(distRelative: string, srcRelative: string): Promise<T> {
  const modulePath = resolveRuntimeModulePath(distRelative, srcRelative);
  const specifier = pathToFileURL(modulePath).href;
  let cached = runtimeModuleCache.get(specifier);
  if (!cached) {
    cached = importRuntimeModule<T>(modulePath, specifier, srcRelative);
    runtimeModuleCache.set(specifier, cached);
  }
  return cached as Promise<T>;
}

async function importRuntimeModule<T>(modulePath: string, specifier: string, srcRelative: string): Promise<T> {
  if (!modulePath.endsWith('.ts')) {
    return import(/* @vite-ignore */ specifier) as Promise<T>;
  }

  const tsx = await loadTsxEsmApi();
  const root = findRepositoryRoot(srcRelative);
  const tsconfig = path.join(root, 'packages/core/tsconfig.json');
  return tsx.tsImport<T>(specifier, {
    parentURL: pathToFileURL(__filename).href,
    ...(existsSync(tsconfig) ? { tsconfig } : {}),
  });
}

async function loadTsxEsmApi(): Promise<TsxEsmApiModule> {
  if (!tsxEsmApiCache) {
    tsxEsmApiCache = import('tsx/esm/api') as Promise<TsxEsmApiModule>;
  }
  return tsxEsmApiCache;
}

function resolveRuntimeModulePath(distRelative: string, srcRelative: string): string {
  const root = findRepositoryRoot(srcRelative);
  const distPath = path.join(root, distRelative);
  const srcPath = path.join(root, srcRelative);
  if (preferSourceRuntime() && existsSync(srcPath)) return srcPath;
  if (existsSync(distPath)) return distPath;
  if (existsSync(srcPath)) return srcPath;
  throw new Error(`Не найден runtime-модуль схемы: ${distRelative} / ${srcRelative}`);
}

function findRepositoryRoot(srcRelative: string): string {
  const starts = [process.cwd(), __dirname, path.resolve(process.cwd(), '..')];
  for (const start of starts) {
    let current = path.resolve(start);
    while (true) {
      if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, srcRelative))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return process.cwd();
}

function preferSourceRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('vitest'));
}

function formatSchemaTestLog(llmLog: readonly RuntimeLlmLogEntry[]): SchemaTestLogEntry[] {
  return llmLog.map((entry) => {
    const nodeId =
      entry.nodeId ??
      (typeof entry.modelParams?.nodeId === 'string' ? entry.modelParams.nodeId : '');
    return {
      nodeId,
      schemaSlug: entry.schemaSlug,
      requestText: entry.request,
      responseText: entry.response,
      errorText: entry.error,
      request: entry.request,
      response: entry.response,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.usage ? { usage: { ...entry.usage } } : {}),
      ...(entry.modelParams ? { modelParams: { ...entry.modelParams } } : {}),
      ...(entry.retrievedDocuments ? { retrievedDocuments: entry.retrievedDocuments } : {}),
    };
  });
}

// Лимит на сериализованный снимок выходов узла в отчёте (issue #347): длинные
// нарративы/RAG-выдачи режем, чтобы ответ теста не раздувался. Полный текст
// LLM-узлов остаётся доступен в LLM-логе ниже по той же ноде.
const NODE_TRACE_OUTPUT_LIMIT = 2000;

function truncateTraceValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > NODE_TRACE_OUTPUT_LIMIT
      ? `${value.slice(0, NODE_TRACE_OUTPUT_LIMIT)}… (+${value.length - NODE_TRACE_OUTPUT_LIMIT} симв.)`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncateTraceValue);
  if (isJsonObject(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) result[key] = truncateTraceValue(item);
    return result;
  }
  return value;
}

function formatSchemaTestNodeTrace(
  trace: readonly RuntimeNodeTraceEntry[],
): SchemaTestNodeTraceEntry[] {
  return trace.map((entry, index) => ({
    order: index + 1,
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    via: entry.via,
    durationMs: entry.durationMs,
    outputKeys: entry.outputKeys,
    outputs: truncateTraceValue(entry.outputs) as Record<string, unknown>,
    inputs: truncateTraceValue(entry.inputs ?? {}) as Record<string, unknown>,
    schemaSlug: entry.schemaSlug,
    depth: entry.depth,
    failed: entry.failed,
  }));
}

function normalizeTestHistory(value: unknown): SchemaTurnHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return { turn: index + 1, action: item, outcome: '' };
    }
    const record = isJsonObject(item) ? item : {};
    return {
      turn: positiveInteger(record.turn, index + 1),
      action: stringValue(record.action ?? record.action_text),
      outcome: stringValue(record.outcome ?? record.changes_summary ?? record.llm_raw_response),
    };
  });
}

function normalizeTestSupportHistory(value: unknown): SchemaHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).map((item) => ({
    role: stringValue(item.role),
    message: stringValue(item.message),
  }));
}

function normalizeTestMemoryCells(value: unknown): SchemaMemoryCell[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).map((item, index) => ({
    id: stringValue(item.id) || `memory-${index + 1}`,
    sessionId: stringValue(item.sessionId ?? item.session_id),
    stepId: nullableString(item.stepId ?? item.step_id),
    content: stringValue(item.content),
    category: stringValue(item.category),
    importance: positiveInteger(item.importance, 1),
    turnCreated: nonNegativeInteger(item.turnCreated ?? item.turn_created, 0),
    createdAt: dateValue(item.createdAt ?? item.created_at),
  }));
}

function mockLlmResponses(inputs: Record<string, unknown>): unknown[] {
  const value = inputs.mockResponses ?? inputs.__mockLlmResponses;
  return Array.isArray(value) ? value : [];
}

function createMockLLMProvider(responses: readonly unknown[], usage?: RuntimeLLMUsage): RuntimeLLMProvider {
  let index = 0;
  const next = (): string => {
    const fallback = responses[responses.length - 1] ?? {};
    const value = index < responses.length ? responses[index] : fallback;
    index += 1;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return {
    name: 'AdminSchemaMockProvider',
    generateText: async () => next(),
    generateTextResult: async () => ({ text: next(), ...(usage ? { usage } : {}) }),
  };
}

function createNoopLLMProvider(): RuntimeLLMProvider {
  return {
    name: 'AdminSchemaNoopProvider',
    generateText: async () => {
      throw new Error('LLM-провайдер не настроен для test-run');
    },
    generateTextResult: async () => {
      throw new Error('LLM-провайдер не настроен для test-run');
    },
  };
}

function normalizeMockUsage(value: unknown): RuntimeLLMUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const usage: RuntimeLLMUsage = {};
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function graphNeedsLlmProvider(graph: AdminSchemaGraph): boolean {
  return graph.nodes.some((node) => {
    if (node.type === 'llm_request' || node.type === 'game_memory_write') return true;
    const nested = node.config.graph ?? node.config.bodyGraph;
    return isSchemaGraphShape(nested) ? graphNeedsLlmProvider(nested) : false;
  });
}

function isSchemaGraphShape(value: unknown): value is AdminSchemaGraph {
  return (
    isJsonObject(value) &&
    value.version === 1 &&
    // Граф задаёт ровно одно из schemaType (пайплайн) или subSchemaClass (суб-схема).
    (typeof value.schemaType === 'string' || typeof value.subSchemaClass === 'string') &&
    typeof value.slug === 'string' &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    isJsonObject(value.variables)
  );
}

function schemaNodeErrorId(err: unknown): string | undefined {
  return isJsonObject(err) && typeof err.nodeId === 'string' ? err.nodeId : undefined;
}

function schemaNodeErrorLastRaw(err: unknown): string | undefined {
  return isJsonObject(err) && typeof err.lastRaw === 'string' ? err.lastRaw : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof BadRequestException) {
    const response = err.getResponse();
    if (typeof response === 'string') return response;
    if (isJsonObject(response)) {
      const message = response.message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.map(String).join('; ');
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function isLLMProviderName(value: unknown): value is LLMProviderName {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function dateValue(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function usageToTokenUsage(usage: RuntimeLLMUsage | undefined): TokenUsage {
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.promptTokens ?? 0) - cacheReadTokens),
    outputTokens: usage?.completionTokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
  };
}

function isEmptyTokenUsage(usage: TokenUsage): boolean {
  return usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cacheReadTokens === 0 && usage.cacheCreationTokens === 0;
}

function calcCostMillicents(usage: TokenUsage, pricing: RuntimeModelPricing): number {
  const costUsd =
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheCreationTokens * pricing.cacheCreation) /
    1_000_000;
  return Math.max(0, Math.ceil(costUsd * 100_000));
}
