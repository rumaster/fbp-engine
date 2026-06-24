import { BadRequestException } from '@nestjs/common';
import {
  NODE_TYPES,
  PORT_TYPES,
  SCHEMA_TYPES,
  SUB_SCHEMA_CLASSES,
  SchemaContractError,
  isNodeType,
  isSchemaType,
  isSubSchemaClass,
  validateSchemaGraphContract,
  type EdgeDefinition as AdminEdgeDefinition,
  type NodeDefinition as AdminNodeDefinition,
  type NodeType as AdminNodeType,
  type PortType as AdminPortType,
  type SchemaGraph as AdminSchemaGraph,
  type SchemaType as AdminSchemaType,
  type SubSchemaClass as AdminSubSchemaClass,
} from '@tg-games/schema-contract';

export { NODE_TYPES, PORT_TYPES, SCHEMA_TYPES, SUB_SCHEMA_CLASSES };
export type {
  AdminEdgeDefinition,
  AdminNodeDefinition,
  AdminNodeType,
  AdminPortType,
  AdminSchemaGraph,
  AdminSchemaType,
  AdminSubSchemaClass,
};

export interface SchemaTestRunInput {
  inputs: Record<string, unknown>;
  gameId?: string;
  // Контекст выполнения суб-схемы при тестировании (issue #351): домен вызывающей
  // стороны — «поддержка» или «игра». Для общей (common) суб-схемы оператор выбирает
  // его явно, для игровой/поддержки он задан классом. Подменяет callerKind, по
  // которому резолвятся вложенные суб-схемы и подбираются дефолты экспертизы.
  context?: 'support' | 'game';
  // Путь к телу узла для изолированного теста (issue #390): список id узлов
  // loop/graph_rag от корня графа к вложенному. Если задан — тест прогоняет не всю
  // схему, а bodyGraph указанного узла, а `inputs` подаются ему как входы (значения
  // входов самого узла), а не как выходы внутреннего start тела.
  nodePath?: string[];
}

export interface SchemaTestLogEntry {
  nodeId: string;
  schemaSlug?: string;
  requestText?: string;
  responseText?: string;
  errorText?: string;
  request?: string;
  response?: string;
  error?: string;
  usage?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  retrievedDocuments?: unknown[];
}

/**
 * Запись отчёта по узлу теста схемы (issue #347). Полный лог исполнения: по КАЖДОЙ
 * ноде, через которую прошёл поток, и по каждой pure-ноде, к которой был запрос
 * данных. Формируется из трассировки движка для показа в редакторе.
 */
export interface SchemaTestNodeTraceEntry {
  /** Порядковый номер исполнения (1-based) — для устойчивого ключа в UI. */
  order: number;
  /** Идентификатор узла. */
  nodeId: string;
  /** Тип узла (`llm_request`, `manifest`, …). */
  nodeType: string;
  /** Как узел исполнен: `flow` — по потоку, `data` — pure-зависимость данных. */
  via: 'flow' | 'data';
  /** Длительность исполнения узла в миллисекундах. */
  durationMs: number;
  /** Имена выходных полей узла. */
  outputKeys: string[];
  /** Снимок выходных данных узла (усечён для больших значений). */
  outputs: Record<string, unknown>;
  /**
   * Снимок входных данных узла (усечён для больших значений, issue #406). Для
   * упавшего узла показывает, с какими входами он исполнялся, — чтобы оператор
   * мог воспроизвести сбой по логу теста.
   */
  inputs: Record<string, unknown>;
  /** Slug схемы/суб-схемы, которой принадлежит узел. */
  schemaSlug: string;
  /** Глубина вложенности: 0 — корневой граф, 1+ — sub_schema/loop-тело. */
  depth: number;
  /** Узел завершился ошибкой (поток остановился на нём). */
  failed: boolean;
}

export interface SchemaTestRunResult {
  outputs: Record<string, unknown>;
  llmLog: SchemaTestLogEntry[];
  /** Полный отчёт по исполненным узлам теста схемы (issue #347). */
  nodeTrace: SchemaTestNodeTraceEntry[];
  durationMs: number;
  costMillicents: number;
}

const SCHEMA_SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/;
const GAME_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;
const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export function assertSchemaSlug(slug: string): void {
  if (!SCHEMA_SLUG_RE.test(slug)) {
    throw new BadRequestException('schemaSlug должен содержать латиницу, цифры, "-" или "_" и быть не длиннее 100 символов');
  }
}

export function assertOptionalGameId(gameId: string | null | undefined): void {
  if (gameId !== null && gameId !== undefined && !GAME_ID_RE.test(gameId)) {
    throw new BadRequestException('gameId должен содержать латиницу, цифры, "-" или "_" и быть не длиннее 50 символов');
  }
}

export function isAdminSchemaType(value: unknown): value is AdminSchemaType {
  return isSchemaType(value);
}

export function isAdminSubSchemaClass(value: unknown): value is AdminSubSchemaClass {
  return isSubSchemaClass(value);
}

/**
 * Нормализует и валидирует граф схемы (issue #310). Граф задаёт ровно одно из:
 * `schemaType` (пайплайн-схема) или `subSchemaClass` (суб-схема) — XOR-инвариант.
 * `expectedKind` (если задан) — это значение вида (`action`/`game`/…), с которым
 * должен совпасть вид графа: используется при пересохранении на основе строки БД.
 */
export function normalizeSchemaGraph(
  value: unknown,
  expectedSlug?: string,
  expectedKind?: string,
): AdminSchemaGraph {
  if (!isRecord(value)) {
    throw new BadRequestException('graphJson должен быть объектом');
  }
  if (value.version !== 1) {
    throw new BadRequestException('graphJson.version должен быть равен 1');
  }
  const slug = requireString(value.slug, 'graphJson.slug');
  assertSchemaSlug(slug);
  if (expectedSlug !== undefined && slug !== expectedSlug) {
    throw new BadRequestException(`graphJson.slug должен совпадать с ${expectedSlug}`);
  }

  const hasType = value.schemaType !== undefined && value.schemaType !== null;
  const hasClass = value.subSchemaClass !== undefined && value.subSchemaClass !== null;
  if (hasType === hasClass) {
    throw new BadRequestException(
      'graphJson должен задавать ровно одно из schemaType (пайплайн-схема) или subSchemaClass (суб-схема)',
    );
  }
  let schemaType: AdminSchemaType | undefined;
  let subSchemaClass: AdminSubSchemaClass | undefined;
  if (hasType) {
    if (!isAdminSchemaType(value.schemaType)) {
      throw new BadRequestException(`graphJson.schemaType должен быть одним из: ${SCHEMA_TYPES.join(', ')}`);
    }
    schemaType = value.schemaType;
  } else {
    if (!isAdminSubSchemaClass(value.subSchemaClass)) {
      throw new BadRequestException(`graphJson.subSchemaClass должен быть одним из: ${SUB_SCHEMA_CLASSES.join(', ')}`);
    }
    subSchemaClass = value.subSchemaClass;
  }
  const kindValue = schemaType ?? subSchemaClass;
  if (expectedKind !== undefined && kindValue !== expectedKind) {
    throw new BadRequestException(`graphJson: вид схемы должен совпадать с ${expectedKind}`);
  }

  const gameId = typeof value.gameId === 'string' && value.gameId.trim() ? value.gameId.trim() : undefined;
  assertOptionalGameId(gameId);
  const nodes = normalizeNodes(value.nodes);
  const edges = normalizeEdges(value.edges);
  const variables = isRecord(value.variables) ? value.variables : {};

  const graph: AdminSchemaGraph = {
    version: 1,
    ...(schemaType ? { schemaType } : {}),
    ...(subSchemaClass ? { subSchemaClass } : {}),
    slug,
    ...(gameId ? { gameId } : {}),
    nodes,
    edges,
    variables,
  };
  validateSchemaGraph(graph);
  return graph;
}

function normalizeNodes(value: unknown): AdminNodeDefinition[] {
  if (!Array.isArray(value)) throw new BadRequestException('graphJson.nodes должен быть массивом');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new BadRequestException(`graphJson.nodes[${index}] должен быть объектом`);
    const id = requireString(item.id, `graphJson.nodes[${index}].id`);
    if (!NODE_ID_RE.test(id)) {
      throw new BadRequestException(`Некорректный id узла: ${id}`);
    }
    if (!isNodeType(item.type)) {
      throw new BadRequestException(`Неизвестный тип узла ${String(item.type)} у ${id}`);
    }
    const position = normalizePosition(item.position, id);
    const config = isRecord(item.config) ? item.config : {};
    const label = typeof item.label === 'string' ? item.label : undefined;
    return { id, type: item.type, position, config, ...(label ? { label } : {}) };
  });
}

function normalizePosition(value: unknown, nodeId: string): { x: number; y: number } {
  if (!isRecord(value)) return { x: 0, y: 0 };
  const x = typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : 0;
  const y = typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BadRequestException(`position узла ${nodeId} должен содержать конечные x/y`);
  }
  return { x, y };
}

function normalizeEdges(value: unknown): AdminEdgeDefinition[] {
  if (!Array.isArray(value)) throw new BadRequestException('graphJson.edges должен быть массивом');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new BadRequestException(`graphJson.edges[${index}] должен быть объектом`);
    return {
      id: requireString(item.id, `graphJson.edges[${index}].id`),
      from: requireString(item.from, `graphJson.edges[${index}].from`),
      fromPort: requireString(item.fromPort, `graphJson.edges[${index}].fromPort`),
      to: requireString(item.to, `graphJson.edges[${index}].to`),
      toPort: requireString(item.toPort, `graphJson.edges[${index}].toPort`),
    };
  });
}

function validateSchemaGraph(graph: AdminSchemaGraph): void {
  try {
    validateSchemaGraphContract(graph);
  } catch (err) {
    if (err instanceof SchemaContractError) throw schemaContractBadRequest(err);
    throw err;
  }
}

function schemaContractBadRequest(err: SchemaContractError): BadRequestException {
  const exception = new BadRequestException({
    code: err.code,
    message: err.message,
    details: err.details,
  });
  exception.message = err.message;
  return exception;
}

/**
 * Спускается по пути из id узлов loop/graph_rag к телу самого вложенного узла
 * (issue #390). Возвращает bodyGraph, который и прогоняется изолированно: входы
 * тестируемого узла подаются телу как его входы. Тело хранится в config.bodyGraph
 * как сырой граф (он не проходит контракт-валидацию, т.к. graph_rag-тело содержит
 * служебные graph_query-узлы), поэтому проверяем только базовую форму графа.
 */
export interface ResolvedNodeBody {
  /** Тело самого вложенного узла пути — граф, который прогоняется изолированно. */
  graph: AdminSchemaGraph;
  /** Тип самого вложенного узла (loop/graph_rag) — от него зависят разрешения движка. */
  nodeType: 'loop' | 'graph_rag';
}

export function resolveNodeBodyGraph(
  graph: AdminSchemaGraph,
  nodePath: readonly string[],
): ResolvedNodeBody {
  let current: AdminSchemaGraph = graph;
  let nodeType: 'loop' | 'graph_rag' = 'loop';
  const visited: string[] = [];
  for (const nodeId of nodePath) {
    if (!NODE_ID_RE.test(nodeId)) {
      throw new BadRequestException(`Некорректный id узла в nodePath: ${nodeId}`);
    }
    const node = current.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new BadRequestException(`Узел ${nodeId} не найден на пути ${visited.join(' / ') || 'корня графа'}`);
    }
    if (node.type !== 'loop' && node.type !== 'graph_rag') {
      throw new BadRequestException(`Узел ${nodeId} типа ${node.type} не имеет тела для изолированного теста`);
    }
    const body = (node.config as Record<string, unknown>).bodyGraph;
    if (!isBodyGraphLike(body)) {
      throw new BadRequestException(`У узла ${nodeId} нет сохранённого тела (bodyGraph)`);
    }
    current = body;
    nodeType = node.type;
    visited.push(nodeId);
  }
  return { graph: current, nodeType };
}

function isBodyGraphLike(value: unknown): value is AdminSchemaGraph {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${label} должен быть непустой строкой`);
  }
  return value.trim();
}
