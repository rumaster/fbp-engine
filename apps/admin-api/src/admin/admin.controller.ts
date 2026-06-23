import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parsePageQuery, optionalString, parseBooleanFlag } from '../common/http';
import { parseInput } from '../common/validation';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import {
  AdminDataService,
  type ExpertiseImportItem,
  type GameManifestImportItem,
  type SchemaImportItem,
  type OntologyImportPayload,
} from './admin-data.service';

const jsonObjectSchema = z.record(z.string(), z.unknown());

const gameGroupsSchema = z.object({
  groupIds: z.array(z.string()).default([]),
});

const gameCreateSchema = z.object({
  manifest: jsonObjectSchema,
  groupIds: z.array(z.string()).optional(),
});

const gameManifestImportRecordSchema = z.object({
  gameId: z.string().trim().min(1).optional(),
  game_id: z.string().trim().min(1).optional(),
  manifest: jsonObjectSchema,
  sortOrder: z.number().int().optional(),
  sort_order: z.number().int().optional(),
});

const gameManifestImportItemSchema = z.union([gameManifestImportRecordSchema, jsonObjectSchema]);

const gameManifestImportSchema = z.union([
  z.object({ items: z.array(gameManifestImportItemSchema).default([]) }),
  z.object({ manifests: z.array(gameManifestImportItemSchema).default([]) }),
  z.array(gameManifestImportItemSchema),
]);

const groupBodySchema = z.object({
  gameIds: z.array(z.string()).default([]),
});

const groupCreateSchema = z.object({
  groupId: z.string().trim().min(1),
  gameIds: z.array(z.string()).default([]),
});

const schemaBodySchema = z
  .object({
    schemaType: z.string().optional(),
    schema_type: z.string().optional(),
    // Класс суб-схемы (issue #310). Граф задаёт ровно одно из schemaType/subSchemaClass.
    subSchemaClass: z.string().optional(),
    schema_class: z.string().optional(),
    graphJson: jsonObjectSchema.optional(),
    graph_json: jsonObjectSchema.optional(),
    description: z.string().optional(),
    gameId: z.string().trim().nullable().optional(),
    game_id: z.string().trim().nullable().optional(),
  })
  .transform(({ schema_type, schemaType, schema_class, subSchemaClass, graph_json, graphJson, game_id, gameId, ...rest }) => ({
    ...rest,
    schemaType: schemaType ?? schema_type,
    schemaClass: subSchemaClass ?? schema_class,
    graphJson: graphJson ?? graph_json ?? {},
    gameId: gameId ?? game_id ?? null,
  }));

const schemaImportItemSchema = z
  .object({
    schemaSlug: z.string().optional(),
    schema_slug: z.string().optional(),
    schemaType: z.string().optional(),
    schema_type: z.string().optional(),
    subSchemaClass: z.string().optional(),
    schema_class: z.string().optional(),
    graphJson: jsonObjectSchema.optional(),
    graph_json: jsonObjectSchema.optional(),
    description: z.string().optional(),
    gameId: z.string().trim().nullable().optional(),
    game_id: z.string().trim().nullable().optional(),
  })
  .transform(({ schema_slug, schemaSlug, schema_type, schemaType, schema_class, subSchemaClass, graph_json, graphJson, game_id, gameId, ...rest }) => ({
    ...rest,
    schemaSlug: schemaSlug ?? schema_slug ?? '',
    schemaType: schemaType ?? schema_type,
    schemaClass: subSchemaClass ?? schema_class,
    graphJson: graphJson ?? graph_json ?? {},
    gameId: gameId ?? game_id ?? null,
  }));

const schemaImportSchema = z.union([
  z.object({ items: z.array(schemaImportItemSchema).default([]) }),
  z.object({ schemas: z.array(schemaImportItemSchema).default([]) }),
  z.array(schemaImportItemSchema),
]);

const schemaTestSchema = z
  .object({
    inputs: jsonObjectSchema.default({}),
    gameId: z.string().trim().optional(),
    game_id: z.string().trim().optional(),
    // Контекст выполнения суб-схемы при тестировании (issue #351): домен вызывающей
    // стороны. Опционален и применяется только к суб-схемам — для пайплайн-схем
    // домен задаётся самим типом схемы.
    context: z.enum(['support', 'game']).optional(),
  })
  .transform(({ game_id, gameId, ...rest }) => ({
    ...rest,
    gameId: gameId ?? game_id,
  }));

const modelDefaultsSchema = z.object({
  llmModelName: z.string().trim().min(1),
  embeddingModel: z.string().trim().min(1),
});

const azureModelCreateSchema = z.object({
  alias: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

const azureModelUpdateSchema = z.object({
  model: z.string().trim().min(1),
});

const expertiseBodySchema = z
  .object({
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
    embeddingSources: z.array(z.string()).default([]),
    // Семантические тэги документа (issue #321).
    tags: z.array(z.string()).default([]),
    // Привязка к игре (issue #154). null/пусто — документ службы поддержки.
    gameId: z.string().trim().nullable().optional(),
    game_id: z.string().trim().nullable().optional(),
  })
  .transform(({ game_id, gameId, ...rest }) => ({
    ...rest,
    gameId: gameId ?? game_id ?? null,
  }));

const expertiseImportItemSchema = z
  .object({
    title: z.string().optional(),
    content: z.string().optional(),
    embeddingSources: z.array(z.string()).optional(),
    embedding_sources: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    gameId: z.string().trim().nullable().optional(),
    game_id: z.string().trim().nullable().optional(),
  })
  .transform(({ embedding_sources, embeddingSources, game_id, gameId, ...rest }) => ({
    ...rest,
    embeddingSources: embeddingSources ?? embedding_sources ?? [],
    gameId: gameId ?? game_id ?? null,
  }));

const expertiseImportSchema = z.union([
  z.object({ items: z.array(expertiseImportItemSchema).default([]) }),
  z.object({ documents: z.array(expertiseImportItemSchema).default([]) }),
  z.array(expertiseImportItemSchema),
]);

// Issue #164 — проверка поиска: произвольный ключ, опциональный предел выдачи и
// область поиска (служба поддержки либо конкретная игра).
const expertiseSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    gameId: z.string().trim().optional(),
    support: z.boolean().optional(),
  })
  .transform(({ gameId, ...rest }) => ({
    ...rest,
    gameId: gameId && gameId.length > 0 ? gameId : undefined,
  }));

// ── Онтология (issue #323) ───────────────────────────────────────────────
// Граф знаний игры: концепты (вершины) и связи (рёбра). Привязка к игре
// обязательна — граф всегда принадлежит конкретной игре.

const ontologyConceptCreateSchema = z.object({
  gameId: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  synonyms: z.array(z.string()).default([]),
  fact: z.string().default(''),
  weight: z.coerce.number().positive().optional(),
});

const ontologyConceptUpdateSchema = ontologyConceptCreateSchema.omit({ gameId: true });

const ontologyRelationCreateSchema = z.object({
  gameId: z.string().trim().min(1),
  fromSlug: z.string().trim().min(1),
  toSlug: z.string().trim().min(1),
  relation: z.string().trim().min(1),
  weight: z.coerce.number().positive().optional(),
  condition: z.record(z.string(), z.unknown()).nullable().optional(),
  note: z.string().default(''),
});

const ontologyRelationUpdateSchema = ontologyRelationCreateSchema.omit({ gameId: true });

const ontologyImportSchema = z.object({
  gameId: z.string().trim().min(1),
  concepts: z
    .array(
      z.object({
        slug: z.string(),
        kind: z.string(),
        title: z.string(),
        synonyms: z.array(z.string()).optional(),
        fact: z.string().optional(),
        weight: z.coerce.number().optional(),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        fromSlug: z.string().optional(),
        from_slug: z.string().optional(),
        toSlug: z.string().optional(),
        to_slug: z.string().optional(),
        relation: z.string(),
        weight: z.coerce.number().optional(),
        condition: z.record(z.string(), z.unknown()).nullable().optional(),
        note: z.string().optional(),
      }),
    )
    .default([]),
});

type RawGameManifestImportItem = z.infer<typeof gameManifestImportItemSchema>;
type RawGameManifestImportPayload = z.infer<typeof gameManifestImportSchema>;
type RawSchemaImportPayload = z.infer<typeof schemaImportSchema>;
type RawExpertiseImportPayload = z.infer<typeof expertiseImportSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Разбирает порог сходства из query-строки (0..1), игнорируя пустое/некорректное. */
function parseSimilarity(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(1, Math.max(0, parsed));
}

function normalizeGameManifestImportPayload(payload: RawGameManifestImportPayload): GameManifestImportItem[] {
  const items = Array.isArray(payload) ? payload : 'items' in payload ? payload.items : payload.manifests;
  return items.map((item) => {
    const record = item as Record<string, unknown>;
    if (isRecord(record.manifest)) {
      return {
        gameId: optionalString(record.gameId) ?? optionalString(record.game_id),
        manifest: record.manifest,
        sortOrder: optionalNumber(record.sortOrder) ?? optionalNumber(record.sort_order),
      };
    }
    return { manifest: item as RawGameManifestImportItem };
  });
}

function normalizeSchemaImportPayload(payload: RawSchemaImportPayload): SchemaImportItem[] {
  const items = Array.isArray(payload) ? payload : 'items' in payload ? payload.items : payload.schemas;
  return items.map((item) => ({
    schemaSlug: item.schemaSlug,
    schemaType: item.schemaType,
    schemaClass: item.schemaClass,
    graphJson: item.graphJson,
    description: typeof item.description === 'string' ? item.description : undefined,
    gameId: item.gameId,
  }));
}

function normalizeExpertiseImportPayload(payload: RawExpertiseImportPayload): ExpertiseImportItem[] {
  const items = Array.isArray(payload) ? payload : 'items' in payload ? payload.items : payload.documents;
  return items.map((item) => ({
    title: typeof item.title === 'string' ? item.title : '',
    content: typeof item.content === 'string' ? item.content : '',
    embeddingSources: item.embeddingSources,
    tags: Array.isArray(item.tags) ? item.tags : [],
    gameId: item.gameId,
  }));
}

type RawOntologyImportPayload = z.infer<typeof ontologyImportSchema>;

// Нормализация импорта онтологии: принимаем экспортный формат (camelCase),
// но терпим и snake_case (from_slug/to_slug), чтобы можно было загрузить файл,
// собранный руками или выгруженный из БД.
function normalizeOntologyImportPayload(payload: RawOntologyImportPayload): OntologyImportPayload {
  return {
    gameId: payload.gameId,
    concepts: payload.concepts.map((c) => ({
      slug: c.slug,
      kind: c.kind,
      title: c.title,
      synonyms: c.synonyms,
      fact: c.fact,
      weight: c.weight,
    })),
    relations: payload.relations.map((r) => ({
      fromSlug: r.fromSlug ?? r.from_slug ?? '',
      toSlug: r.toSlug ?? r.to_slug ?? '',
      relation: r.relation,
      weight: r.weight,
      condition: r.condition ?? null,
      note: r.note,
    })),
  };
}

@Controller()
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(private readonly data: AdminDataService) {}

  @Get('users')
  listUsers(
    @Query('search') search: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listUsers({
      search: optionalString(search),
      ...parsePageQuery(limit, offset),
    });
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.data.getUser(id);
  }

  @Get('sessions')
  listSessions(
    @Query('userId') userId: string | undefined,
    @Query('telegramId') telegramId: string | undefined,
    @Query('gameId') gameId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listSessions({
      userId: optionalString(userId),
      telegramId: optionalString(telegramId),
      gameId: optionalString(gameId),
      status: optionalString(status),
      ...parsePageQuery(limit, offset),
    });
  }

  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    return this.data.getSession(id);
  }

  @Get('games')
  listGames(
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listGames(parsePageQuery(limit, offset));
  }

  @Get('games/export')
  exportGameManifests() {
    return this.data.exportGameManifests();
  }

  @Post('games')
  createGame(@Body() body: unknown) {
    return this.data.createGame(parseInput(gameCreateSchema, body));
  }

  @Post('games/import')
  importGameManifests(@Body() body: unknown) {
    const payload = parseInput(gameManifestImportSchema, body);
    return this.data.importGameManifests(normalizeGameManifestImportPayload(payload));
  }

  @Get('games/:id')
  getGame(@Param('id') id: string) {
    return this.data.getGame(id);
  }

  @Patch('games/:id/manifest')
  updateGameManifest(@Param('id') id: string, @Body() body: unknown) {
    return this.data.updateGameManifest(id, parseInput(jsonObjectSchema, body));
  }

  @Get('games/:id/manifest-history')
  listGameManifestHistory(@Param('id') id: string) {
    return this.data.listGameManifestHistory(id);
  }

  @Get('games/:id/manifest-history/:historyId')
  getGameManifestHistoryEntry(@Param('id') id: string, @Param('historyId') historyId: string) {
    return this.data.getGameManifestHistoryEntry(id, historyId);
  }

  @Patch('games/:id/groups')
  updateGameGroups(@Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(gameGroupsSchema, body);
    return this.data.updateGameGroups(id, input.groupIds);
  }

  @Get('groups')
  listGroups() {
    return this.data.listGroups();
  }

  @Post('groups')
  createGroup(@Body() body: unknown) {
    const input = parseInput(groupCreateSchema, body);
    return this.data.upsertGroup(input.groupId, input.gameIds);
  }

  @Get('groups/:id')
  getGroup(@Param('id') id: string) {
    return this.data.getGroup(id);
  }

  @Patch('groups/:id')
  updateGroup(@Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(groupBodySchema, body);
    return this.data.updateGroupGames(id, input.gameIds);
  }

  @Get('schemas')
  listSchemas() {
    return this.data.listSchemas();
  }

  @Get('schemas/export')
  exportSchemas() {
    return this.data.exportSchemas();
  }

  @Post('schemas/import')
  importSchemas(@Body() body: unknown) {
    const payload = parseInput(schemaImportSchema, body);
    return this.data.importSchemas(normalizeSchemaImportPayload(payload));
  }

  @Get('schemas/:slug')
  getSchema(@Param('slug') slug: string, @Query('gameId') gameId: string | undefined) {
    return this.data.getSchema(slug, optionalString(gameId));
  }

  @Patch('schemas/:slug')
  updateSchema(@Param('slug') slug: string, @Body() body: unknown) {
    const input = parseInput(schemaBodySchema, body);
    return this.data.updateSchema({
      slug,
      schemaType: input.schemaType,
      schemaClass: input.schemaClass,
      graphJson: input.graphJson,
      description: input.description,
      gameId: input.gameId,
    });
  }

  @Get('schemas/:slug/history')
  listSchemaHistory(@Param('slug') slug: string, @Query('gameId') gameId: string | undefined) {
    return this.data.listSchemaHistory(slug, optionalString(gameId));
  }

  @Get('schemas/:slug/history/:historyId')
  getSchemaHistoryEntry(@Param('slug') slug: string, @Param('historyId') historyId: string) {
    return this.data.getSchemaHistoryEntry(slug, historyId);
  }

  @Post('schemas/:slug/restore/:historyId')
  @HttpCode(200)
  restoreSchemaHistoryEntry(@Param('slug') slug: string, @Param('historyId') historyId: string) {
    return this.data.restoreSchemaHistoryEntry(slug, historyId);
  }

  @Delete('schemas/:slug/history/:historyId')
  @HttpCode(204)
  deleteSchemaHistoryEntry(@Param('slug') slug: string, @Param('historyId') historyId: string) {
    return this.data.deleteSchemaHistoryEntry(slug, historyId);
  }

  @Post('schemas/:slug/test')
  @HttpCode(200)
  testSchema(@Param('slug') slug: string, @Body() body: unknown) {
    const input = parseInput(schemaTestSchema, body);
    return this.data.testSchema(slug, input);
  }

  // ── Черновики схем (issue #286) ──────────────────────────────────────────

  @Get('schemas/:slug/draft')
  getSchemaDraft(@Param('slug') slug: string, @Query('gameId') gameId: string | undefined) {
    return this.data.getSchemaDraft(slug, optionalString(gameId));
  }

  @Patch('schemas/:slug/draft')
  saveSchemaDraft(@Param('slug') slug: string, @Body() body: unknown) {
    const input = parseInput(schemaBodySchema, body);
    return this.data.saveSchemaDraft({
      slug,
      graphJson: input.graphJson,
      gameId: input.gameId,
    });
  }

  @Post('schemas/:slug/promote')
  @HttpCode(200)
  promoteSchemaDraft(@Param('slug') slug: string, @Query('gameId') gameId: string | undefined) {
    return this.data.promoteSchemaDraft(slug, optionalString(gameId));
  }

  @Delete('schemas/:slug/draft')
  @HttpCode(200)
  resetSchemaDraft(@Param('slug') slug: string, @Query('gameId') gameId: string | undefined) {
    return this.data.resetSchemaDraft(slug, optionalString(gameId));
  }

  @Get('azure-models')
  listAzureModels() {
    return this.data.listAzureModels();
  }

  @Post('azure-models')
  createAzureModel(@Body() body: unknown) {
    const input = parseInput(azureModelCreateSchema, body);
    return this.data.createAzureModel(input.alias, input.model);
  }

  @Patch('azure-models/:alias')
  updateAzureModel(@Param('alias') alias: string, @Body() body: unknown) {
    const input = parseInput(azureModelUpdateSchema, body);
    return this.data.updateAzureModel(alias, input.model);
  }

  @Delete('azure-models/:alias')
  deleteAzureModel(@Param('alias') alias: string) {
    return this.data.deleteAzureModel(alias);
  }

  @Get('llm-requests')
  listLlmRequests(
    @Query('userId') userId: string | undefined,
    @Query('telegramId') telegramId: string | undefined,
    @Query('sessionId') sessionId: string | undefined,
    @Query('requestKind') requestKind: string | undefined,
    @Query('hasError') hasError: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listLlmRequests({
      userId: optionalString(userId),
      telegramId: optionalString(telegramId),
      sessionId: optionalString(sessionId),
      requestKind: optionalString(requestKind),
      hasError: parseBooleanFlag(hasError),
      ...parsePageQuery(limit, offset),
    });
  }

  @Get('llm-requests/:id')
  getLlmRequest(@Param('id') id: string) {
    return this.data.getLlmRequest(id);
  }

  // ── Журнал исполнения схем (issue #255, этап F) ──────────────────────────

  @Get('schema-executions')
  listSchemaExecutions(
    @Query('schemaType') schemaType: string | undefined,
    @Query('gameId') gameId: string | undefined,
    @Query('schemaSlug') schemaSlug: string | undefined,
    @Query('status') status: string | undefined,
    @Query('sessionId') sessionId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listSchemaExecutions({
      schemaType: optionalString(schemaType),
      gameId: optionalString(gameId),
      schemaSlug: optionalString(schemaSlug),
      status: optionalString(status),
      sessionId: optionalString(sessionId),
      ...parsePageQuery(limit, offset),
    });
  }

  // Статический маршрут объявлен до `:id`, иначе Nest примет «error-summary» за id.
  @Get('schema-executions/error-summary')
  schemaExecutionsErrorSummary(@Query('sinceMinutes') sinceMinutes: string | undefined) {
    const parsed = sinceMinutes ? Number(sinceMinutes) : undefined;
    return this.data.countRecentSchemaErrors({
      ...(parsed !== undefined && Number.isFinite(parsed) ? { sinceMinutes: parsed } : {}),
    });
  }

  @Get('schema-executions/:id')
  getSchemaExecution(@Param('id') id: string) {
    return this.data.getSchemaExecution(id);
  }

  @Get('model-defaults')
  getModelDefaults() {
    return this.data.getModelDefaults();
  }

  @Patch('model-defaults')
  updateModelDefaults(@Body() body: unknown) {
    return this.data.updateModelDefaults(parseInput(modelDefaultsSchema, body));
  }

  @Get('expertise')
  listExpertiseDocuments() {
    return this.data.listExpertiseDocuments();
  }

  @Get('expertise/export')
  exportExpertiseDocuments() {
    return this.data.exportExpertiseDocuments();
  }

  @Get('expertise/queries')
  listExpertiseSearchQueries(
    @Query('gameId') gameId: string | undefined,
    @Query('support') support: string | undefined,
    @Query('before') before: string | undefined,
    @Query('phrase') phrase: string | undefined,
    @Query('minSimilarity') minSimilarity: string | undefined,
    @Query('maxSimilarity') maxSimilarity: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listExpertiseSearchQueries({
      gameId: optionalString(gameId),
      support: parseBooleanFlag(support) === true ? true : undefined,
      before: optionalString(before),
      phrase: optionalString(phrase),
      minSimilarity: parseSimilarity(minSimilarity),
      maxSimilarity: parseSimilarity(maxSimilarity),
      ...parsePageQuery(limit, offset),
    });
  }

  @Post('expertise/import')
  importExpertiseDocuments(@Body() body: unknown) {
    const payload = parseInput(expertiseImportSchema, body);
    return this.data.importExpertiseDocuments(normalizeExpertiseImportPayload(payload));
  }

  // Issue #164 — проверка работы поисковых запросов к базе знаний: вернуть, какие
  // ключи документов находит произвольный поисковый запрос и насколько близко.
  @Post('expertise/search')
  @HttpCode(200)
  searchExpertiseSources(@Body() body: unknown) {
    const input = parseInput(expertiseSearchSchema, body);
    return this.data.searchExpertiseSources(input);
  }

  @Post('expertise')
  createExpertiseDocument(@Body() body: unknown) {
    const input = parseInput(expertiseBodySchema, body);
    return this.data.createExpertiseDocument(input);
  }

  @Get('expertise/:id')
  getExpertiseDocument(@Param('id') id: string) {
    return this.data.getExpertiseDocument(id);
  }

  @Patch('expertise/:id')
  updateExpertiseDocument(@Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(expertiseBodySchema, body);
    return this.data.updateExpertiseDocument(id, input);
  }

  @Delete('expertise/:id')
  deleteExpertiseDocument(@Param('id') id: string) {
    return this.data.deleteExpertiseDocument(id);
  }

  // ── Онтология (issue #323) ─────────────────────────────────────────────
  // Статические сегменты (export/import/concepts/relations) объявлены до
  // параметрических маршрутов, чтобы Nest не перехватил их как :id.

  @Get('ontology')
  getOntology(@Query('gameId') gameId: string | undefined) {
    return this.data.getGameOntology(gameId ?? '');
  }

  @Get('ontology/export')
  exportOntology(@Query('gameId') gameId: string | undefined) {
    return this.data.exportGameOntology(gameId ?? '');
  }

  @Get('ontology/communities')
  getOntologyCommunities(@Query('gameId') gameId: string | undefined) {
    return this.data.getGameCommunities(gameId ?? '');
  }

  @Post('ontology/import')
  importOntology(@Body() body: unknown) {
    const payload = parseInput(ontologyImportSchema, body);
    return this.data.importGameOntology(normalizeOntologyImportPayload(payload));
  }

  @Post('ontology/concepts')
  createOntologyConcept(@Body() body: unknown) {
    const input = parseInput(ontologyConceptCreateSchema, body);
    const { gameId, ...concept } = input;
    return this.data.createOntologyConcept(gameId, concept);
  }

  @Patch('ontology/concepts/:id')
  updateOntologyConcept(@Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(ontologyConceptUpdateSchema, body);
    return this.data.updateOntologyConcept(id, input);
  }

  @Delete('ontology/concepts/:id')
  deleteOntologyConcept(@Param('id') id: string) {
    return this.data.deleteOntologyConcept(id);
  }

  @Post('ontology/concepts/:id/verify')
  verifyOntologyConcept(@Param('id') id: string) {
    return this.data.verifyOntologyConcept(id);
  }

  @Post('ontology/relations')
  createOntologyRelation(@Body() body: unknown) {
    const input = parseInput(ontologyRelationCreateSchema, body);
    const { gameId, ...relation } = input;
    return this.data.createOntologyRelation(gameId, relation);
  }

  @Patch('ontology/relations/:id')
  updateOntologyRelation(@Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(ontologyRelationUpdateSchema, body);
    return this.data.updateOntologyRelation(id, input);
  }

  @Delete('ontology/relations/:id')
  deleteOntologyRelation(@Param('id') id: string) {
    return this.data.deleteOntologyRelation(id);
  }

  @Post('ontology/relations/:id/verify')
  verifyOntologyRelation(@Param('id') id: string) {
    return this.data.verifyOntologyRelation(id);
  }

  @Get('topics')
  listTopics(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    return this.data.listTopics({
      status: optionalString(status),
      ...parsePageQuery(limit, offset),
    });
  }

  @Get('topics/:id')
  getTopic(@Param('id') id: string) {
    return this.data.getTopic(id);
  }

  @Post('topics/:id/close')
  closeTopic(@Param('id') id: string) {
    return this.data.closeTopic(id);
  }
}
