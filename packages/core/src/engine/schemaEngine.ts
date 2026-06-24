import vm from 'node:vm';
import type { ILLMProvider } from '../llm/ILLMProvider.js';
import { generateTextWithLog, type LLMCallLogEntry } from '../llm/trace.js';
import type { ModelRouter } from '../llm/router.js';
import type { IEmbeddingProvider } from '../llm/embeddings.js';
import type { IMediaProvider } from '../media/IMediaProvider.js';
import type { GameManifest } from '../games/manifests.js';
import { SEASONS, TIMES_OF_DAY } from '../games/manifests.js';
import type { GameState, TurnHistoryEntry } from '../types.js';
import {
  buildGameExpertiseBlock,
  type GameExpertiseDoc,
} from './expertiseKeys.js';
import { retrieveGameExpertise, retrieveSupportExpertise } from './expertiseRetrieval.js';
import {
  buildMemoryBlock,
  runMemoryExtraction,
  selectMemoryCells,
  type ExtractedMemoryCell,
  type MemoryCell,
} from './memory.js';
import { formatWorldTimeLine } from '../games/manifests.js';
import {
  renderPromptTemplate,
  type PromptTemplateOverrides,
} from './promptTemplates.js';
import { extractJson } from './validation.js';
import {
  buildDefaultGraphRagBodyGraph,
  execInputPortIds,
  isExecPortId,
  isPortType,
  validateSchemaGraphContract,
  type EdgeDefinition,
  type NodeDefinition,
  type NodeType,
  type PortType,
  type SchemaGraph,
} from '@tg-games/schema-contract';
import {
  queryKnowledgeGraph,
  type GraphQueryConcept,
} from '../db/repositories/agenticGraphRag.js';

export type {
  EdgeDefinition,
  NodeDefinition,
  NodeType,
  PortType,
  SchemaGraph,
  SchemaType,
  SubSchemaClass,
} from '@tg-games/schema-contract';

/**
 * Одна реплика истории для узлов `support_history_read` / `game_history_read`
 * (issue #271). `role` — кто говорил: для поддержки `bot` | `operator` | `user`,
 * для игры `master` (гейммастер-нарратор) | `player`. Дополнительно зарезервирована
 * роль будущего агента-пересказчика «упаковщика» (см. docs/role-chronicler.md):
 * он будет сжимать старую часть истории, поэтому его реплики тоже появятся в этом
 * массиве. `message` — текст реплики/нарратива/действия.
 */
export interface SchemaHistoryMessage {
  role: string;
  message: string;
}

/**
 * Запись трассировки исполнения узла (issue #347). Полный отчёт по тесту схемы в
 * админке: по КАЖДОЙ ноде, через которую прошёл поток исполнения, и по каждой
 * pure-ноде (узел без exec-входа), к которой был запрос данных. Заполняется
 * движком в {@link SchemaExecutionContext.nodeTrace}, когда коллектор задан
 * (рантайм бота его не передаёт — трассировка нужна только для теста в редакторе).
 */
export interface SchemaNodeTraceEntry {
  /** Идентификатор узла в графе. */
  nodeId: string;
  /** Тип узла (`llm_request`, `manifest`, `transform`, …). */
  nodeType: NodeType;
  /**
   * Как узел был исполнен: `flow` — поток дошёл по exec-ребру; `data` — pure-узел
   * (без exec-входа) был подтянут как зависимость данных другого узла.
   */
  via: 'flow' | 'data';
  /** Длительность исполнения узла в миллисекундах. */
  durationMs: number;
  /** Имена выходных портов/полей узла. */
  outputKeys: string[];
  /** Снимок выходных данных узла (для показа в отчёте). */
  outputs: Record<string, unknown>;
  /**
   * Снимок входных данных узла — значения, пришедшие по data-портам от узлов-
   * источников (issue #406). Нужен в первую очередь для упавших узлов: когда узел
   * бросает ошибку, оператор видит в логе теста, с какими именно входами он
   * исполнялся, и может воспроизвести сбой. Заполняется по уже посчитанным выходам
   * источников, поэтому новых исполнений узлов не вызывает.
   */
  inputs: Record<string, unknown>;
  /** Slug схемы/суб-схемы, которой принадлежит узел (вложенность, issue #347). */
  schemaSlug: string;
  /** Глубина вложенности: 0 — корневой граф, 1+ — sub_schema/loop-тело. */
  depth: number;
  /** Узел завершился ошибкой — поток остановился на нём. */
  failed: boolean;
}

export interface SchemaExecutionContext {
  inputs: Record<string, unknown>;
  nodeOutputs: Map<string, Record<string, unknown>>;
  variables: Map<string, unknown>;
  llmLog: LLMCallLogEntry[];
  /**
   * Коллектор трассировки узлов (issue #347). Когда задан, движок добавляет в него
   * запись на каждое исполнение узла — и по потоку, и по pure-зависимостям данных.
   * Общий для вложенных контекстов (loop-тело, sub_schema) через spread `...ctx`,
   * поэтому отчёт охватывает и вложенные схемы. Не задаётся в боевом рантайме.
   */
  nodeTrace?: SchemaNodeTraceEntry[];
  /**
   * Глубина вложенности текущего графа для трассировки (issue #347). 0 — корневой
   * граф теста; loop-тело и sub_schema увеличивают её на 1. Внутреннее поле.
   */
  traceDepth?: number;
  provider: ILLMProvider;
  embeddingProvider?: IEmbeddingProvider;
  router?: ModelRouter;
  /**
   * Провайдер медиа для узла `media_generate` (issue #238). Когда задан и у него
   * включён {@link IMediaProvider.canDraw}, узел реально рисует иллюстрацию; иначе
   * возвращает только готовый промпт (обратная совместимость).
   */
  mediaProvider?: IMediaProvider;
  /** Модель/размер иллюстрации для конкретного пользователя (issue #238). */
  mediaImage?: { model?: string; size?: string };
  manifest: GameManifest;
  state: GameState;
  memoryCells?: MemoryCell[];
  /**
   * История переписки в службе поддержки для узла `support_history_read` (issue #271):
   * реплики обращения в хронологическом порядке. Заполняется рантаймом support-схемы
   * из сообщений тикета (sender → role). Если не задана, узел отдаёт пустой массив.
   */
  supportHistory?: SchemaHistoryMessage[];
  cacheKey?: string;
  maxRetries: number;
  /**
   * Резолвер вложенной схемы по slug для узла `sub_schema` (этап B, issue #245).
   * Рантайм передаёт обёртку над `getActiveSchema` (game → global fallback). Если
   * узел `sub_schema` ссылается на slug, а резолвер не задан или активной схемы нет,
   * узел бросает {@link SchemaNodeExecutionError}: legacy/«тихого» fallback нет —
   * нехватка данных в БД доставляется ошибкой (issue #238/#245).
   */
  resolveSubSchema?: (slug: string) => Promise<SchemaGraph | null>;
  /**
   * Домен вызывающей стороны для узла `knowledge_query` (issue #353): «support» или
   * «game». Суб-схема (класс common/game/support) не несёт `schemaType`, поэтому
   * сам по себе граф не говорит узлу, где искать экспертизу — в документах поддержки
   * (`game_id IS NULL`) или игры (`scope { gameId }`). Поле задаётся рантаймом
   * (support-рантайм — `support`) и тестом схемы (по выбранному контексту), а
   * вложенные суб-схемы наследуют его через spread `...ctx`. Для пайплайн-схемы поле
   * не влияет: её домен однозначно задан собственным `schemaType`.
   */
  expertiseDomain?: 'support' | 'game';
  /**
   * Тестовый/интеграционный hook для внутреннего `graph_query` (#386). В боевом
   * рантайме не задаётся: узел читает Neo4j через queryKnowledgeGraph.
   */
  graphQuery?: (
    keys: string[],
    options: { gameId: string; embeddingProvider?: IEmbeddingProvider; topK?: number },
  ) => Promise<GraphQueryConcept[]>;
  /** Внутренний флаг: `graph_query` разрешён только при исполнении bodyGraph `graph_rag`. */
  internalGraphQueryAllowed?: boolean;
}

export class SchemaNodeExecutionError extends Error {
  readonly nodeId: string;
  readonly lastRaw?: string;

  constructor(nodeId: string, message: string, lastRaw?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SchemaNodeExecutionError';
    this.nodeId = nodeId;
    this.lastRaw = lastRaw;
  }
}

/**
 * Детали ошибки исполнения для журнала схем (issue #255, этап F).
 *
 * Извлекает из ошибки узел, тип узла (по графу), текст и последний сырой ответ
 * LLM. Используется рантайм-обёртками всех типов, чтобы оператор видел причину
 * сбоя в админке без доступа к серверным логам.
 */
export function describeSchemaExecutionError(
  graph: SchemaGraph,
  err: unknown,
): { errorNodeId: string | null; errorNodeType: string | null; errorMessage: string; errorLastRaw: string | null } {
  const nodeId = err instanceof SchemaNodeExecutionError ? err.nodeId : null;
  const nodeType = nodeId ? graph.nodes.find((node) => node.id === nodeId)?.type ?? null : null;
  const lastRaw = err instanceof SchemaNodeExecutionError ? err.lastRaw ?? null : null;
  return {
    errorNodeId: nodeId,
    errorNodeType: nodeType,
    errorMessage: err instanceof Error ? err.message : String(err),
    errorLastRaw: lastRaw,
  };
}

/**
 * Ошибка отсутствия активной схемы для типа исполнения (issue #238).
 *
 * После удаления legacy-пайплайна schema engine — единственный путь исполнения.
 * Если в БД нет активной схемы нужного типа, исполнять нечем: вместо «тихого»
 * отката на старый код бросается эта ошибка. Вызывающий код доставляет её
 * пользователю (бот показывает сообщение и кнопку повтора) и фиксирует в логе
 * ошибок выполнения админки.
 */
export class MissingActiveSchemaError extends Error {
  /** Тип схемы (`action` / `hint` / `support` / `illustration`). */
  readonly schemaType: string;
  /** Игра, для которой искалась схема (если применимо). */
  readonly gameId?: string | null;

  constructor(schemaType: string, gameId?: string | null) {
    super(
      `Нет активной схемы «${schemaType}»` +
        (gameId ? ` для игры ${gameId}` : '') +
        '. Schema engine — единственный путь исполнения, legacy удалён (issue #238).',
    );
    this.name = 'MissingActiveSchemaError';
    this.schemaType = schemaType;
    this.gameId = gameId;
  }
}

interface LlmOutputConfig {
  name: string;
  jsonPath?: string;
  type?: PortType;
}

interface TransformOutputConfig {
  name: string;
  path?: string;
  type?: PortType;
}

type ResolveSourceOutputs = (nodeId: string) => Promise<Record<string, unknown> | null>;

const FORBIDDEN_EXPRESSION_TOKENS =
  /\b(?:process|globalThis|global|window|document|Function|eval|require|import|constructor|prototype|__proto__|this)\b/;

/**
 * Лимит времени исполнения пользовательских выражений `transform`/`exitExpression`
 * (этап B, issue #245). Бесконечный цикл (`while (true) {}`) прерывается движком V8
 * по таймауту vm, поэтому некорректный граф больше не вешает процесс.
 */
const SANDBOX_TIMEOUT_MS = 1000;

export async function executeSchema(
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
): Promise<Record<string, unknown>> {
  validateSchemaGraphContract(graph, { allowInternalGraphQuery: ctx.internalGraphQueryAllowed === true });

  for (const [name, value] of Object.entries(graph.variables ?? {})) {
    if (!ctx.variables.has(name)) ctx.variables.set(name, value);
  }

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const startNodes = graph.nodes.filter((node) => node.type === 'start');
  if (startNodes.length === 0) {
    throw new Error(`В схеме ${graph.slug} нет start-узла`);
  }

  const queue = startNodes.map((node) => node.id);
  const localOutputs = new Map<string, Record<string, unknown>>();
  const executing = new Set<string>();
  const arrivals = new Map<string, number>();
  let finalOutputs: Record<string, unknown> = {};

  const resolveSourceOutputs: ResolveSourceOutputs = async (nodeId) => {
    const outputs = localOutputs.get(nodeId);
    if (outputs) return outputs;
    const source = nodes.get(nodeId);
    if (!source) {
      throw new Error(`В схеме ${graph.slug} есть ссылка на неизвестный узел ${nodeId}`);
    }
    if (execInputPortIds(source).length > 0) return null;
    return executeNodeById(nodeId, 'data');
  };

  // Снимок входов узла для трассировки теста (issue #406). Берём только уже
  // посчитанные выходы узлов-источников из localOutputs — без вызова резолвера,
  // чтобы не исполнять новые узлы и не маскировать исходную ошибку. К моменту
  // записи трассировки (после исполнения узла) его data-источники уже посчитаны
  // самим узлом через resolveNodeInputs, поэтому снимок отражает реальные входы.
  const collectTraceInputs = (node: NodeDefinition): Record<string, unknown> => {
    const inputs: Record<string, unknown> = {};
    for (const edge of graph.edges) {
      if (edge.to !== node.id || isExecPortId(edge.fromPort)) continue;
      const sourceOutputs = localOutputs.get(edge.from);
      if (sourceOutputs && Object.prototype.hasOwnProperty.call(sourceOutputs, edge.fromPort)) {
        inputs[edge.toPort] = sourceOutputs[edge.fromPort];
      }
    }
    return inputs;
  };

  async function executeNodeById(
    nodeId: string,
    via: 'flow' | 'data',
  ): Promise<Record<string, unknown>> {
    const cached = localOutputs.get(nodeId);
    if (cached) return cached;
    const node = nodes.get(nodeId);
    if (!node) {
      throw new Error(`В схеме ${graph.slug} есть ссылка на неизвестный узел ${nodeId}`);
    }
    if (executing.has(nodeId)) {
      throw new SchemaNodeExecutionError(nodeId, `Data-зависимости схемы ${graph.slug} содержат цикл`);
    }

    executing.add(nodeId);
    // Трассировка узла (issue #347): засекаем время до и после, чтобы в отчёте
    // теста было видно длительность исполнения каждой ноды. Запись добавляем даже
    // при ошибке узла — оператор видит, где именно поток остановился.
    const startedAt = ctx.nodeTrace ? Date.now() : 0;
    try {
      const outputs = await executeNode(node, graph, ctx, resolveSourceOutputs);
      localOutputs.set(node.id, outputs);
      ctx.nodeOutputs.set(node.id, outputs);
      if (node.type === 'end') {
        finalOutputs = { ...finalOutputs, ...outputs };
      }
      ctx.nodeTrace?.push({
        nodeId: node.id,
        nodeType: node.type,
        via,
        durationMs: Date.now() - startedAt,
        outputKeys: Object.keys(outputs),
        outputs,
        inputs: ctx.nodeTrace ? collectTraceInputs(node) : {},
        schemaSlug: graph.slug,
        depth: ctx.traceDepth ?? 0,
        failed: false,
      });
      return outputs;
    } catch (err) {
      ctx.nodeTrace?.push({
        nodeId: node.id,
        nodeType: node.type,
        via,
        durationMs: Date.now() - startedAt,
        outputKeys: [],
        outputs: { error: err instanceof Error ? err.message : String(err) },
        inputs: ctx.nodeTrace ? collectTraceInputs(node) : {},
        schemaSlug: graph.slug,
        depth: ctx.traceDepth ?? 0,
        failed: true,
      });
      throw err;
    } finally {
      executing.delete(nodeId);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    const node = nodes.get(nodeId);
    if (!node) {
      throw new Error(`В схеме ${graph.slug} есть ссылка на неизвестный узел ${nodeId}`);
    }
    if (localOutputs.has(nodeId)) continue;

    if (node.type === 'merge') {
      const required = incomingExecEdges(graph, node.id).length;
      const arrived = arrivals.get(node.id) ?? 0;
      if (arrived < required) continue;
    }

    const outputs = await executeNodeById(nodeId, 'flow');

    for (const edge of outgoingExecEdges(graph, node, outputs)) {
      arrivals.set(edge.to, (arrivals.get(edge.to) ?? 0) + 1);
      queue.push(edge.to);
    }
  }

  return finalOutputs;
}

export function isSchemaGraph(value: unknown): value is SchemaGraph {
  if (!isRecord(value)) return false;
  // XOR-дискриминатор (issue #310): граф — пайплайн-схема (schemaType) либо
  // суб-схема (subSchemaClass). Достаточно, чтобы был задан ровно один признак.
  const kind =
    typeof value.schemaType === 'string' || typeof value.subSchemaClass === 'string';
  return (
    value.version === 1 &&
    kind &&
    typeof value.slug === 'string' &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    isRecord(value.variables)
  );
}

async function executeNode(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  try {
    switch (node.type) {
      case 'start':
        return { ...ctx.inputs, inputs: ctx.inputs };
      case 'end':
        return await resolveNodeInputs(node, graph, resolveSourceOutputs);
      case 'llm_request':
        return await executeLlmRequest(node, graph, ctx, resolveSourceOutputs);
      case 'knowledge_query':
        return await executeKnowledgeQuery(node, graph, ctx, resolveSourceOutputs);
      case 'graph_rag':
        return await executeGraphRag(node, graph, ctx, resolveSourceOutputs);
      case 'graph_query':
        return await executeGraphQuery(node, graph, ctx, resolveSourceOutputs);
      case 'game_memory_read':
        return executeGameMemoryRead(ctx);
      case 'game_memory_write':
        return await executeGameMemoryWrite(node, graph, ctx, resolveSourceOutputs);
      case 'manifest':
        return executeManifest(node, ctx);
      case 'game_state_read':
        return executeGameStateRead(node, ctx);
      case 'game_state_write':
        return await executeGameStateWrite(node, graph, ctx, resolveSourceOutputs);
      case 'support_history_read':
        return executeSupportHistoryRead(ctx);
      case 'game_history_read':
        return executeGameHistoryRead(ctx);
      case 'condition':
        return await executeCondition(node, graph, ctx, resolveSourceOutputs);
      case 'variable_read':
        return executeVariableRead(node, ctx);
      case 'variable_write':
        return await executeVariableWrite(node, graph, ctx, resolveSourceOutputs);
      case 'loop':
        return await executeLoop(node, graph, ctx, resolveSourceOutputs);
      case 'transform':
        return await executeTransform(node, graph, ctx, resolveSourceOutputs);
      case 'merge':
        return await resolveNodeInputs(node, graph, resolveSourceOutputs);
      case 'sub_schema':
        return await executeSubSchema(node, graph, ctx, resolveSourceOutputs);
      case 'media_generate':
        return await executeMediaGenerate(node, graph, ctx, resolveSourceOutputs);
      case 'log':
        return await executeLog(node, graph, ctx, resolveSourceOutputs);
      case 'constant':
        return executeConstant(node);
    }
  } catch (err) {
    if (err instanceof SchemaNodeExecutionError) throw err;
    throw new SchemaNodeExecutionError(node.id, err instanceof Error ? err.message : String(err));
  }
}

async function executeLlmRequest(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const values = buildTemplateValues(inputs, ctx);
  const systemInstruction = renderConfiguredTemplate(node.config.systemPrompt, values);
  const basePrompt = renderConfiguredTemplate(node.config.userPrompt ?? node.config.prompt, values);
  const retryPrompt = typeof node.config.retryPrompt === 'string' ? node.config.retryPrompt : '';
  const outputsConfig = parseLlmOutputs(node.config.outputs);
  const provider = await resolveProvider(ctx);
  const modelParams = isRecord(node.config.modelParams) ? node.config.modelParams : undefined;
  const jsonMode = node.config.jsonMode !== false;
  // Число попыток можно переопределить на самом узле (issue #248): поле
  // config.retries имеет приоритет над глобальным ctx.maxRetries; при отсутствии
  // или некорректном значении берётся глобальный лимит.
  const maxRetries = toPositiveInteger(node.config.retries, ctx.maxRetries);
  let lastError = '';
  let lastRaw: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const prompt =
      attempt === 1 || retryPrompt.length === 0
        ? basePrompt
        : renderPromptTemplate(retryPrompt, {
            ...values,
            base_prompt: basePrompt,
            error_text: lastError,
          });

    let raw: string;
    try {
      raw = await generateTextWithLog(
        provider,
        {
          prompt,
          systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
          jsonMode,
          cacheKey: ctx.cacheKey,
        },
        ctx.llmLog,
        {
          schemaSlug: graph.slug,
          nodeId: node.id,
          modelParams: { ...modelParams, nodeId: node.id },
        },
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    lastRaw = raw;

    try {
      const parsed = extractJson(raw);
      return {
        ...extractLlmOutputs(parsed, outputsConfig, node.id),
        raw,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new SchemaNodeExecutionError(
    node.id,
    `LLM-узел ${node.id} не вернул валидный JSON: ${lastError || 'нет деталей'}`,
    lastRaw,
  );
}

/**
 * Решает, искать ли узлу `knowledge_query` в документах поддержки (issue #353).
 *
 * Пайплайн-схема несёт собственный `schemaType` — он и определяет область поиска:
 * `support` → документы поддержки (`game_id IS NULL`), иначе — экспертиза игры.
 * Суб-схема (класс common/game/support) `schemaType` не несёт, поэтому область
 * берётся из домена вызывающей стороны `ctx.expertiseDomain`. Это чинит тест общей
 * суб-схемы в контексте поддержки, где раньше узел всегда уходил в экспертизу игры
 * и возвращал пустой результат.
 */
function isSupportExpertiseScope(graph: SchemaGraph, ctx: SchemaExecutionContext): boolean {
  if (typeof graph.schemaType === 'string') return graph.schemaType === 'support';
  return ctx.expertiseDomain === 'support';
}

async function executeKnowledgeQuery(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const keys = toStringArray(inputs.keys);
  // Семантические тэги (issue #321): если заданы, сужают область поиска до
  // документов с пересекающимся набором тэгов; пусто — фильтр не накладывается.
  const tags = toStringArray(inputs.tags);
  const topK = toPositiveInteger(ctx.inputs.expertiseTopK, 0);
  if (!ctx.embeddingProvider || topK <= 0 || keys.length === 0) {
    return { documents: [], expertise: '' };
  }

  const docs = isSupportExpertiseScope(graph, ctx)
    ? await retrieveSupportExpertise(ctx.embeddingProvider, keys, topK, tags)
    : await retrieveGameExpertise(ctx.embeddingProvider, keys, topK, ctx.manifest.id, tags);
  const expertiseDocs: GameExpertiseDoc[] = docs.map((doc) => ({
    title: doc.title,
    content: doc.content,
  }));
  return {
    documents: docs,
    expertise: buildGameExpertiseBlock(expertiseDocs),
  };
}

async function executeGraphRag(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const query = asString(inputs.query) ?? asString(ctx.inputs.query) ?? asString(ctx.inputs.action) ?? '';
  // options (issue #392): необязательный объект настроек узла, который пробрасывается
  // в граничный выход options тела для редактируемых сценариев.
  const options = isRecord(inputs.options) ? inputs.options : isRecord(ctx.inputs.options) ? ctx.inputs.options : undefined;
  const maxIterations = Math.min(toPositiveInteger(node.config.maxIterations, 3), 5);
  const body = isSchemaGraph(node.config.bodyGraph)
    ? node.config.bodyGraph
    : buildDefaultGraphRagBodyGraph(graph.slug, node.id);

  // questions — внутренний механизм повторных итераций (issue #392): публичного входа
  // у узла нет, поиск всегда стартует с пустого набора уточняющих вопросов.
  let questions: string[] = [];
  let answers = dedupeStringArray(toStringArray(ctx.inputs.answers));
  let result = '';

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // lastIteration (issue #392): на последней итерации тело принудительно прекращает
    // поиск концептов и формирует финальный ответ (см. has_missing_questions в теле).
    const lastIteration = iteration === maxIterations - 1;
    const iterationCtx: SchemaExecutionContext = {
      ...ctx,
      inputs: { ...ctx.inputs, query, questions, answers, options, lastIteration },
      variables: new Map(Object.entries(body.variables ?? {})),
      nodeOutputs: new Map(),
      traceDepth: (ctx.traceDepth ?? 0) + 1,
      internalGraphQueryAllowed: true,
    };

    const outputs = await executeSchema(body, iterationCtx);
    ctx.state = iterationCtx.state;

    const nextAnswers = dedupeStringArray(toStringArray(outputs.answers));
    if (nextAnswers.length > 0) answers = nextAnswers;

    const nextResult = asString(outputs.result);
    if (nextResult !== undefined) result = nextResult;

    const nextQuestions = dedupeStringArray(toStringArray(outputs.questions));
    // На последней итерации возвращаем result даже если критик ещё формулирует вопросы:
    // тело уже прервало поиск через lastIteration и выдало финальный ответ.
    if (lastIteration || nextQuestions.length === 0) return { result };
    questions = nextQuestions;
  }

  throw new SchemaNodeExecutionError(
    node.id,
    `graph_rag-узел ${node.id} достиг maxIterations без result`,
  );
}

async function executeGraphQuery(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  if (ctx.internalGraphQueryAllowed !== true) {
    throw new SchemaNodeExecutionError(node.id, 'graph_query доступен только внутри graph_rag');
  }

  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const keys = dedupeStringArray(toStringArray(inputs.keys));
  if (keys.length === 0) return { concepts: [] };

  const topK = toPositiveInteger(node.config.topK, 8);
  const options: { gameId: string; embeddingProvider?: IEmbeddingProvider; topK?: number } = {
    gameId: ctx.manifest.id,
    topK,
  };
  if (ctx.embeddingProvider) options.embeddingProvider = ctx.embeddingProvider;
  const concepts = ctx.graphQuery
    ? await ctx.graphQuery(keys, options)
    : await queryKnowledgeGraph({ ...options, keys });

  return { concepts };
}

function executeGameMemoryRead(ctx: SchemaExecutionContext): Record<string, unknown> {
  const topK = toPositiveInteger(ctx.inputs.memoryTopK, 0);
  if (topK <= 0) return { memory: '' };
  return {
    memory: buildMemoryBlock(selectMemoryCells(ctx.memoryCells ?? [], topK)),
  };
}

async function executeGameMemoryWrite(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  if (inputs.enabled === false) {
    ctx.variables.delete('memoryUpdate');
    return { added: [] };
  }
  const narrative = asString(inputs.narrative) ?? ctx.state.narrative;
  const action = asString(ctx.inputs.action) ?? '';
  const provider = await resolveProvider(ctx);
  const promptTemplates: PromptTemplateOverrides = {
    game_memory_system: asString(node.config.systemPrompt) ?? '',
    game_memory_prompt: asString(node.config.userPrompt ?? node.config.prompt) ?? '',
  };
  const extraction = await runMemoryExtraction(
    provider,
    ctx.manifest,
    ctx.state,
    action,
    narrative,
    ctx.memoryCells ?? [],
    ctx.maxRetries,
    promptTemplates,
  );
  ctx.llmLog.push(
    ...extraction.llmLog.map((entry) => ({
      ...entry,
      schemaSlug: graph.slug,
      nodeId: node.id,
      modelParams: { ...entry.modelParams, nodeId: node.id },
    })),
  );
  const memoryUpdate =
    extraction.added.length > 0
      ? ({ added: extraction.added } satisfies { added: ExtractedMemoryCell[] })
      : undefined;
  ctx.variables.set('memoryUpdate', memoryUpdate);
  return {
    added: extraction.added,
    ...(memoryUpdate ? { memoryUpdate } : {}),
  };
}

function executeManifest(node: NodeDefinition, ctx: SchemaExecutionContext): Record<string, unknown> {
  const fields = toStringArray(node.config.fields);
  if (fields.length === 0) return { manifest: ctx.manifest };
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    result[field] = readPath(ctx.manifest, field);
  }
  return result;
}

function executeGameStateRead(
  _node: NodeDefinition,
  ctx: SchemaExecutionContext,
): Record<string, unknown> {
  // game_state_read (issue #208): единственный выход state с полным объектом
  // состояния игры. Извлечение отдельных полей делается через transform.
  return { state: ctx.state };
}

// support_history_read (issue #271): отдаёт историю переписки тикета как массив
// реплик {role, message} в хронологическом порядке. Источник — ctx.supportHistory,
// который рантайм support-схемы заполняет из сообщений тикета (sender → role).
function executeSupportHistoryRead(ctx: SchemaExecutionContext): Record<string, unknown> {
  return { messages: ctx.supportHistory ?? [] };
}

// game_history_read (issue #271): отдаёт историю ходов игры как плоский массив
// реплик {role, message}. История ходов приходит во входе схемы `history`
// (TurnHistoryEntry[] = {turn, action, outcome}); каждый ход разворачивается в две
// реплики: действие игрока (player) и нарратив гейммастера (master). Пустые реплики
// пропускаются.
function executeGameHistoryRead(ctx: SchemaExecutionContext): Record<string, unknown> {
  const history = toHistory(ctx.inputs.history);
  const messages: SchemaHistoryMessage[] = [];
  for (const entry of history) {
    const action = entry.action.trim();
    const outcome = entry.outcome.trim();
    if (action) messages.push({ role: 'player', message: action });
    if (outcome) messages.push({ role: 'master', message: outcome });
  }
  return { messages };
}

async function executeGameStateWrite(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);

  // game_state_write (issue #208): берёт единственный вход state (объект) и мержит его
  // с текущим состоянием, не отдавая ничего наружу. Глубокий мерж позволяет частично
  // обновлять вложенные объекты.
  const update = toRecord(inputs.state);
  const merged = deepMergeState(ctx.state as unknown as Record<string, unknown>, update);
  ctx.state = merged as unknown as GameState;
  return {};
}

async function executeCondition(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const inputName = asString(node.config.input);
  const left =
    inputName !== undefined
      ? inputs[inputName] ?? ctx.inputs[inputName] ?? ctx.variables.get(inputName)
      : inputs.value ?? ctx.inputs.value;
  const operator = asString(node.config.operator) ?? 'truthy';
  const right = node.config.right ?? inputs.right;
  const condition = evaluateCondition(left, operator, right);
  return { condition };
}

function executeVariableRead(
  node: NodeDefinition,
  ctx: SchemaExecutionContext,
): Record<string, unknown> {
  // variable_read (issue #208): множество именованных выходов, имя порта = имени
  // переменной. На каждый порт отдаётся текущее значение одноимённой переменной.
  const result: Record<string, unknown> = {};
  for (const name of variablePortNames(node.config.outputs)) {
    result[name] = ctx.variables.get(name);
  }
  return result;
}

async function executeVariableWrite(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  // variable_write (issue #208): множество именованных входов, имя порта = имени
  // переменной. Значение каждого входа записывается в одноимённую переменную.
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const names = variablePortNames(node.config.inputs);
  for (const name of names) {
    const value = Object.prototype.hasOwnProperty.call(inputs, name)
      ? inputs[name]
      : names.length === 1
        ? node.config.value
        : undefined;
    ctx.variables.set(name, value);
  }
  return {};
}

// Имена именованных портов variable-блока (issue #208) из config.inputs/config.outputs.
// Пустая конфигурация даёт единственный порт value — так движок согласован с контрактом
// схемы (variablePortRows). Legacy config.name больше не поддерживается (issue #232).
function variablePortNames(value: unknown): string[] {
  const names: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item) && typeof item.name === 'string' && item.name.trim()) {
        const name = item.name.trim();
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  if (names.length > 0) return names;
  return ['value'];
}

async function executeLoop(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  // loop (issue #208, доработка — этап B issue #245): data-вход `value` пробрасывается
  // в тело каждой итерации, поэтому тело может опираться на входные данные узла, а не
  // только на общие переменные. Если на вход пришёл массив и включён config.iterateItems,
  // цикл идёт по элементам (на итерацию доступен loopItem), иначе крутится maxIterations раз.
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const maxIterations = toPositiveInteger(node.config.maxIterations, 1);
  const body = isSchemaGraph(node.config.bodyGraph) ? node.config.bodyGraph : null;
  const loopValue = inputs.value;
  const items =
    node.config.iterateItems === true && Array.isArray(loopValue) ? loopValue : null;
  const iterations = items ? Math.min(items.length, maxIterations) : maxIterations;
  // Стратегия агрегации: 'collect' собирает выход каждой итерации в массив, по
  // умолчанию 'last' — отдаём только последнюю (обратная совместимость).
  const aggregate = asString(node.config.aggregate) === 'collect' ? 'collect' : 'last';
  const results: unknown[] = [];
  let last: Record<string, unknown> = {};
  if (!body) return aggregate === 'collect' ? { value: results } : last;

  for (let i = 0; i < iterations; i += 1) {
    ctx.variables.set('loopIndex', i);
    const item = items ? items[i] : loopValue;
    if (items) ctx.variables.set('loopItem', item);
    // Тело исполняется в дочернем контексте: свои inputs (с loopIndex/loopItem) и
    // свежий nodeOutputs на итерацию, но общие variables/llmLog/state — чтобы запись
    // переменных и состояния в теле накапливалась между итерациями.
    const iterationCtx: SchemaExecutionContext = {
      ...ctx,
      inputs: { ...ctx.inputs, value: item, loopIndex: i, ...(items ? { loopItem: item } : {}) },
      nodeOutputs: new Map(),
      // Трассировка теста (issue #347): тело loop — на уровень глубже, nodeTrace общий.
      traceDepth: (ctx.traceDepth ?? 0) + 1,
    };
    last = await executeSchema(body, iterationCtx);
    // executeGameStateWrite переназначает ctx.state на новый объект — переносим его
    // обратно в родительский контекст, иначе правки состояния в теле потеряются.
    ctx.state = iterationCtx.state;
    results.push(last);
    const exitExpression = asString(node.config.exitExpression);
    if (exitExpression && Boolean(evaluateSafeExpression(exitExpression, {}, ctx))) break;
  }
  return aggregate === 'collect' ? { ...last, value: results } : last;
}

async function executeTransform(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  // transform (issue #204): несколько именованных входов произвольного типа (как у
  // llm_request). JS-код получает объект input с полями входов и возвращает result.
  // Выходы извлекаются по пути из { result }: выход по умолчанию имеет путь result.
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const code = asString(node.config.code);
  if (!code) {
    throw new SchemaNodeExecutionError(node.id, 'transform-узлу нужен config.code');
  }
  const result = evaluateTransformCode(code, inputs, ctx);

  const outputsConfig = parseTransformOutputs(node.config.outputs);
  if (outputsConfig.length === 0) {
    const outputName = asString(node.config.output) ?? 'result';
    if (!node.config.output && isRecord(result)) return result;
    return { [outputName]: result };
  }
  return extractTransformOutputs(result, outputsConfig, node.id);
}

async function executeSubSchema(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  // sub_schema (issue #208, доработка — этап B issue #245): вложенная схема задаётся
  // либо инлайн-графом (config.graph), либо ссылкой на сохранённую активную схему по
  // slug (config.schemaSlug) через ctx.resolveSubSchema. Если slug задан, а резолвера
  // нет или активной схемы не нашлось — бросаем ошибку: legacy/«тихого» fallback нет,
  // нехватка данных в БД доставляется пользователю (issue #238/#245).
  const subGraph = await resolveSubSchemaGraph(node, ctx);

  // Изоляция: вложенная схема получает только проброшенные data-входы как свои inputs
  // и собственные variables/nodeOutputs — переменные родителя в неё не протекают и
  // обратно не возвращаются. Общими остаются llmLog (учёт стоимости) и state (правки
  // игрового состояния), который переносим обратно после исполнения.
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const childCtx: SchemaExecutionContext = {
    ...ctx,
    inputs: { ...inputs },
    variables: new Map(),
    nodeOutputs: new Map(),
    // Трассировка теста (issue #347): узлы суб-схемы — на уровень глубже, nodeTrace общий.
    traceDepth: (ctx.traceDepth ?? 0) + 1,
  };
  const outputs = await executeSchema(subGraph, childCtx);
  ctx.state = childCtx.state;
  return outputs;
}

async function resolveSubSchemaGraph(
  node: NodeDefinition,
  ctx: SchemaExecutionContext,
): Promise<SchemaGraph> {
  if (isSchemaGraph(node.config.graph)) return node.config.graph;

  const slug = asString(node.config.schemaSlug);
  if (slug) {
    if (!ctx.resolveSubSchema) {
      throw new SchemaNodeExecutionError(
        node.id,
        `sub_schema-узел ссылается на схему «${slug}», но резолвер вложенных схем не задан`,
      );
    }
    const resolved = await ctx.resolveSubSchema(slug);
    if (!resolved) {
      throw new SchemaNodeExecutionError(
        node.id,
        `sub_schema-узел: активная схема «${slug}» не найдена в БД`,
      );
    }
    return resolved;
  }

  throw new SchemaNodeExecutionError(
    node.id,
    'sub_schema-узлу нужен config.graph или config.schemaSlug',
  );
}

async function executeMediaGenerate(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const values = buildTemplateValues(inputs, ctx);
  // media_generate (issue #225): настраиваемые входы (config.inputs) подставляются в шаблон
  // промпта иллюстрации. На выход image_url всегда отдаётся готовый к генерации промпт (строка) —
  // это сохраняет обратную совместимость и не раздувает аудит схемы бинарными данными.
  const prompt = renderConfiguredTemplate(node.config.prompt, values);

  // issue #238: при подключённом провайдере медиа узел действительно рисует иллюстрацию и
  // прокладывает бинарный результат через дополнительные выходы image/extension/mediaMeta.
  // Эти поля читает обёртка на стороне бота (src/media/illustrationSchema.ts) из ctx.nodeOutputs.
  const mediaProvider = ctx.mediaProvider;
  if (!mediaProvider || !mediaProvider.canDraw) {
    return { image_url: prompt };
  }
  try {
    const result = await mediaProvider.generateImage({ prompt, ...ctx.mediaImage });
    return {
      image_url: prompt,
      image: result.image,
      extension: result.extension,
      mediaMeta: result.meta,
    };
  } catch (err) {
    // Сохраняем исходную ошибку провайдера в cause, чтобы бот распознал MediaGenerationError
    // и показал кнопку повторной попытки с корректным отчётом тестировщику (issue #75).
    throw new SchemaNodeExecutionError(
      node.id,
      err instanceof Error ? err.message : String(err),
      undefined,
      err,
    );
  }
}

async function executeLog(
  node: NodeDefinition,
  graph: SchemaGraph,
  ctx: SchemaExecutionContext,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs = await resolveNodeInputs(node, graph, resolveSourceOutputs);
  const existing = ctx.variables.get('executionLog');
  const entries = Array.isArray(existing) ? [...existing] : [];
  entries.push({ nodeId: node.id, inputs, createdAt: new Date().toISOString() });
  ctx.variables.set('executionLog', entries);
  return inputs;
}

function executeConstant(node: NodeDefinition): Record<string, unknown> {
  // constant (issue #319): каждый порт config.outputs = { name, type, value }.
  // Возвращает объект { [name]: coercedValue } для всех портов.
  const outputs: Record<string, unknown> = {};
  const rows = Array.isArray(node.config.outputs) ? node.config.outputs : [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== 'string' || !row.name.trim()) continue;
    const name = row.name.trim();
    outputs[name] = coerceConstantValue(row.type as string, row.value);
  }
  return outputs;
}

function coerceConstantValue(type: string, value: unknown): unknown {
  if (type === 'number') return typeof value === 'number' ? value : Number(value);
  if (type === 'boolean') {
    // Значение хранится строкой 'true'/'false'; Boolean('false') === true, поэтому
    // сравниваем явно (issue #319).
    if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
    return Boolean(value);
  }
  if (type === 'string') return typeof value === 'string' ? value : String(value ?? '');
  if (type === 'object' || type === 'string_array' || type === 'object_array') {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return type === 'object' ? {} : []; }
    }
    return value ?? (type === 'object' ? {} : []);
  }
  return value;
}

function incomingExecEdges(graph: SchemaGraph, nodeId: string): EdgeDefinition[] {
  return graph.edges.filter((edge) => edge.to === nodeId && isExecPortId(edge.fromPort));
}

function outgoingExecEdges(
  graph: SchemaGraph,
  node: NodeDefinition,
  outputs: Record<string, unknown>,
): EdgeDefinition[] {
  const edges = graph.edges.filter((edge) => edge.from === node.id && isExecPortId(edge.fromPort));
  if (node.type !== 'condition') return edges.filter((edge) => edge.fromPort === 'exec' || edge.fromPort === 'done');
  const branch = outputs.condition === true ? 'true' : 'false';
  return edges.filter((edge) => edge.fromPort === branch);
}

async function resolveNodeInputs(
  node: NodeDefinition,
  graph: SchemaGraph,
  resolveSourceOutputs: ResolveSourceOutputs,
): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {};
  const incoming = graph.edges.filter((edge) => edge.to === node.id && !isExecPortId(edge.fromPort));
  for (const edge of incoming) {
    const sourceOutputs = await resolveSourceOutputs(edge.from);
    if (sourceOutputs && Object.prototype.hasOwnProperty.call(sourceOutputs, edge.fromPort)) {
      inputs[edge.toPort] = sourceOutputs[edge.fromPort];
    }
  }
  return inputs;
}

function buildTemplateValues(
  inputs: Record<string, unknown>,
  ctx: SchemaExecutionContext,
): Record<string, string | number | boolean | null | undefined> {
  const state = ctx.state;
  const builtIns: Record<string, unknown> = {
    action: ctx.inputs.action,
    history_block: formatHistoryBlock(toHistory(ctx.inputs.history)).join('\n'),
    game_name: ctx.manifest.name,
    game_description: ctx.manifest.description,
    world_rules: ctx.manifest.worldRules.map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
    limits_json: JSON.stringify(ctx.manifest.limits),
    seasons: SEASONS.join(', '),
    times_of_day: TIMES_OF_DAY.join(' -> '),
    state_json: JSON.stringify(state, null, 2),
    world_time_line: formatWorldTimeLine(state.world_time),
    location: state.location,
    last_narrative: state.narrative,
    state_summary: buildStateSummary(state),
    existing_memory: buildMemoryBlock(ctx.memoryCells ?? []),
    expertise: '',
    // graph_context: зарезервированный плейсхолдер графового ретрива. Дефолт '' —
    // как у expertise/memory: незаполненный {{graph_context}} не остаётся в промпте
    // дословно, пока схема не подключит явный источник этого контекста.
    graph_context: '',
    memory: '',
  };

  for (const [name, value] of ctx.variables.entries()) builtIns[name] = value;
  for (const [name, value] of Object.entries(ctx.inputs)) builtIns[name] = value;
  for (const [name, value] of Object.entries(inputs)) builtIns[name] = value;

  const result: Record<string, string | number | boolean | null | undefined> = {};
  for (const [name, value] of Object.entries(builtIns)) result[name] = toTemplateValue(value);
  return result;
}

function renderConfiguredTemplate(
  template: unknown,
  values: Record<string, string | number | boolean | null | undefined>,
): string {
  return typeof template === 'string' ? renderPromptTemplate(template, values) : '';
}

function parseLlmOutputs(value: unknown): LlmOutputConfig[] {
  if (!Array.isArray(value)) return [];
  const outputs: LlmOutputConfig[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = asString(item.name);
    if (!name) continue;
    const jsonPath = asString(item.jsonPath);
    const type = asPortType(item.type);
    outputs.push({ name, ...(jsonPath ? { jsonPath } : {}), ...(type ? { type } : {}) });
  }
  return outputs;
}

function extractLlmOutputs(
  parsed: unknown,
  outputsConfig: readonly LlmOutputConfig[],
  nodeId: string,
): Record<string, unknown> {
  if (outputsConfig.length === 0) {
    return isRecord(parsed) ? parsed : { value: parsed };
  }

  const result: Record<string, unknown> = {};
  for (const output of outputsConfig) {
    const path = output.jsonPath ?? output.name;
    const value = readPath(parsed, path);
    if (!isCompatiblePortValue(value, output.type ?? 'any')) {
      throw new SchemaNodeExecutionError(
        nodeId,
        `Выход ${output.name} (путь «${path}») не соответствует типу ${output.type ?? 'any'} (получено: ${describePortValueType(value)})`,
      );
    }
    result[output.name] = value;
  }
  return result;
}

function parseTransformOutputs(value: unknown): TransformOutputConfig[] {
  if (!Array.isArray(value)) return [];
  const outputs: TransformOutputConfig[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = asString(item.name);
    if (!name) continue;
    const path = asString(item.path);
    const type = asPortType(item.type);
    outputs.push({ name, ...(path ? { path } : {}), ...(type ? { type } : {}) });
  }
  return outputs;
}

function extractTransformOutputs(
  result: unknown,
  outputsConfig: readonly TransformOutputConfig[],
  nodeId: string,
): Record<string, unknown> {
  // Пути отсчитываются от объекта { result }: выход по умолчанию имеет путь result и
  // возвращает значение целиком, а вложенные поля доступны как result.field (issue #204).
  const source = { result };
  const outputs: Record<string, unknown> = {};
  for (const output of outputsConfig) {
    // Путь по умолчанию — result (весь возврат кода), а не имя выхода: для выхода без
    // явного пути читать source[output.name] бессмысленно (в { result } нет такого
    // ключа) и проверка типа ложно падала, даже если код вернул значение нужного типа
    // (issue #266). Вложенные поля по-прежнему задаются явным путём result.field.
    const path = output.path ?? 'result';
    const value = readPath(source, path);
    if (!isCompatiblePortValue(value, output.type ?? 'any')) {
      throw new SchemaNodeExecutionError(
        nodeId,
        `Выход ${output.name} (путь «${path}») не соответствует типу ${output.type ?? 'any'} (получено: ${describePortValueType(value)})`,
      );
    }
    outputs[output.name] = value;
  }
  return outputs;
}

function evaluateTransformCode(
  code: string,
  inputs: Record<string, unknown>,
  ctx: SchemaExecutionContext,
): unknown {
  // input — объект с полями входов узла; код заканчивается return result.
  return runInSandbox(`(() => {\n"use strict";\n${code}\n})()`, {
    input: inputs,
    variables: Object.fromEntries(ctx.variables.entries()) as Record<string, unknown>,
    state: ctx.state,
    manifest: ctx.manifest,
  });
}

async function resolveProvider(
  ctx: SchemaExecutionContext,
): Promise<ILLMProvider> {
  if (!ctx.router) return ctx.provider;
  const route = await ctx.router.resolve();
  return route.provider;
}

function asPortType(value: unknown): PortType | undefined {
  return isPortType(value) ? value : undefined;
}

function isCompatiblePortValue(value: unknown, type: PortType): boolean {
  if (type === 'any') return true;
  if (type === 'string' || type === 'expertise' || type === 'memory') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return isRecord(value);
  if (type === 'string_array') return Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (type === 'object_array') return Array.isArray(value) && value.every(isRecord);
  return true;
}

// Человекочитаемое описание фактического типа значения для сообщений об ошибке
// проверки типов выходов (issue #266): оператор видит, что именно пришло, а не только
// какой тип ожидался. undefined трактуем как «значение не найдено» — типичный признак
// неверного пути выхода.
function describePortValueType(value: unknown): string {
  if (value === undefined) return 'значение не найдено';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return 'string_array';
    if (value.every(isRecord)) return 'object_array';
    return 'array';
  }
  if (isRecord(value)) return 'object';
  return typeof value;
}

function evaluateCondition(left: unknown, operator: string, right: unknown): boolean {
  if (operator === 'exists') return left !== undefined && left !== null;
  if (operator === 'equals') return left === right;
  if (operator === 'not_equals') return left !== right;
  if (operator === 'gt') return Number(left) > Number(right);
  if (operator === 'gte') return Number(left) >= Number(right);
  if (operator === 'lt') return Number(left) < Number(right);
  if (operator === 'lte') return Number(left) <= Number(right);
  return Boolean(left);
}

function evaluateSafeExpression(
  expression: string,
  inputs: Record<string, unknown>,
  ctx: SchemaExecutionContext,
): unknown {
  return runInSandbox(`"use strict";\n(${expression})`, {
    inputs,
    variables: Object.fromEntries(ctx.variables.entries()) as Record<string, unknown>,
    state: ctx.state,
    manifest: ctx.manifest,
  });
}

/**
 * Исполняет пользовательский JS (`transform.code` / `loop.exitExpression`) в
 * изолированном контексте vm с таймаутом (этап B, issue #245).
 *
 * Защита эшелонирована: (1) {@link FORBIDDEN_EXPRESSION_TOKENS} отсекает доступ к
 * окружению и пути обхода (`constructor`, `globalThis`, `Function`, …);
 * (2) контекст vm не содержит Node-глобалей (`process`/`require`/`module` в нём
 * попросту нет); (3) таймаут {@link SANDBOX_TIMEOUT_MS} прерывает бесконечный цикл
 * силами V8, поэтому некорректный граф не вешает процесс.
 */
function runInSandbox(source: string, sandbox: Record<string, unknown>): unknown {
  if (FORBIDDEN_EXPRESSION_TOKENS.test(source)) {
    throw new Error('Выражение содержит запрещённый доступ к окружению');
  }
  const context = vm.createContext({ ...sandbox });
  const script = new vm.Script(source);
  try {
    return script.runInContext(context, { timeout: SANDBOX_TIMEOUT_MS });
  } catch (err) {
    // Таймаут vm бросается из C++ и не проходит instanceof Error, поэтому сверяемся
    // по тексту сообщения, а не по типу.
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) {
      throw new Error(`Выполнение выражения превысило лимит ${SANDBOX_TIMEOUT_MS} мс`);
    }
    throw err;
  }
}

function readPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  const parts = path.split('.');
  let current = source;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toTemplateValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value, null, 2);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// Рекурсивный мерж переданного состояния с текущим (issue #208): вложенные объекты
// сливаются по ключам, а массивы и примитивы заменяются переданными значениями.
function deepMergeState(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(update)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMergeState(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function dedupeStringArray(value: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function toPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function toHistory(value: unknown): TurnHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TurnHistoryEntry => {
    if (!isRecord(item)) return false;
    return (
      typeof item.turn === 'number' &&
      typeof item.action === 'string' &&
      typeof item.outcome === 'string'
    );
  });
}

function compactText(text: string, limit = 900): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function formatHistoryBlock(history: TurnHistoryEntry[]): string[] {
  const recent = history.slice(-12);
  if (recent.length === 0) return [];
  return [
    '',
    'Память предыдущих ходов (факты, которые персонаж уже пережил; учитывай их как накопленный опыт):',
    ...recent.map((entry) =>
      [
        `Ход ${entry.turn}. Действие: ${compactText(entry.action)}`,
        `Итог: ${compactText(entry.outcome)}`,
      ].join('\n'),
    ),
  ];
}

function buildStateSummary(state: GameState): string {
  const { character } = state;
  const skills = Object.keys(character.skills ?? {});
  const parts = [
    `HP ${character.hp}/${character.max_hp}`,
    `время мира ${formatWorldTimeLine(state.world_time)}`,
  ];
  if (character.inventory.length > 0) parts.push(`инвентарь: ${character.inventory.join(', ')}`);
  if (skills.length > 0) parts.push(`навыки: ${skills.join(', ')}`);
  return parts.join('; ');
}
