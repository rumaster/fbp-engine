import {
  BASE_NODE_PALETTE,
  CONSTANT_PORT_TYPES,
  NODE_TYPE_LABELS,
  PORT_TYPES,
  SCHEMA_TABS,
  SUB_SCHEMA_CLASSES,
  SUB_SCHEMA_CLASS_LABELS,
  SchemaContractError,
  arePortTypesCompatible,
  buildDefaultGraphRagBodyGraph,
  boundaryEndPorts,
  boundaryStartPorts,
  getNodePaletteForSchema,
  getNodePortDefinitions,
  graphPaletteKind,
  isBoundaryPortType,
  isExecPortId,
  isNodeType,
  isPortType,
  isSchemaType,
  isSubSchemaClass,
  isSubSchemaGraph,
  isSubSchemaUsableIn,
  isNodeTypeAllowedInSchema,
  portColor,
  schemaTypeLabel,
  subSchemaClassLabel,
  subSchemaNodePorts,
  validateSchemaGraphContract,
  type BoundaryPortType,
  type EdgeDefinition,
  type NodeDefinition,
  type NodeType,
  type PortDefinition,
  type PortType,
  type SchemaBoundaryPort,
  type SchemaGraph,
  type SchemaPaletteKind,
  type SchemaType,
  type SubSchemaClass,
} from '@tg-games/schema-contract';

export {
  BASE_NODE_PALETTE,
  CONSTANT_PORT_TYPES,
  NODE_TYPE_LABELS,
  PORT_TYPES,
  SCHEMA_TABS,
  SUB_SCHEMA_CLASSES,
  SUB_SCHEMA_CLASS_LABELS,
  arePortTypesCompatible,
  buildDefaultGraphRagBodyGraph,
  boundaryEndPorts,
  boundaryStartPorts,
  getNodePaletteForSchema,
  graphPaletteKind,
  isBoundaryPortType,
  isExecPortId,
  isNodeType,
  isNodeTypeAllowedInSchema,
  isPortType,
  isSchemaType,
  isSubSchemaClass,
  isSubSchemaGraph,
  isSubSchemaUsableIn,
  portColor,
  schemaTypeLabel,
  subSchemaClassLabel,
  subSchemaNodePorts,
};

export const NODE_PALETTE = BASE_NODE_PALETTE;

export type {
  BoundaryPortType,
  EdgeDefinition,
  NodeDefinition,
  NodeType,
  PortDefinition,
  PortType,
  SchemaBoundaryPort,
  SchemaGraph,
  SchemaPaletteKind,
  SchemaType,
  SubSchemaClass,
};

/**
 * Подпись вида графа (issue #310): для пайплайн-схемы — метка типа, для суб-схемы —
 * метка класса. Используется в палитре узлов и шапке редактора, где «вид» может быть
 * как `SchemaType`, так и `SubSchemaClass`.
 */
export function paletteKindLabel(kind: SchemaPaletteKind): string {
  return isSubSchemaClass(kind) ? subSchemaClassLabel(kind) : schemaTypeLabel(kind);
}

/** Подпись вида конкретного графа (пайплайн-тип или класс суб-схемы). */
export function graphKindLabel(graph: SchemaGraph): string {
  const kind = graphPaletteKind(graph);
  return kind ? paletteKindLabel(kind) : '—';
}

export interface GraphConnection {
  source: string | null;
  sourceHandle: string | null;
  target: string | null;
  targetHandle: string | null;
}

export interface ConnectionValidation {
  valid: boolean;
  message?: string;
}

export function getNodePorts(node: NodeDefinition, graph?: SchemaGraph): {
  inputs: PortDefinition[];
  outputs: PortDefinition[];
} {
  return getNodePortDefinitions(node, graph);
}

/** Запись палитры узлов с признаком доступности в активной схеме (issue #248). */
export interface NodePaletteEntry {
  type: NodeType;
  label: string;
  available: boolean;
  /** Почему узел недоступен — для подсказки на неактивной кнопке. */
  reason?: string;
}

/**
 * Полная палитра узлов для схемы с пометкой доступности (issue #248, этап D).
 * В отличие от getNodePaletteForSchema, который скрывает запрещённые узлы, здесь
 * возвращаются все базовые узлы — недоступные помечаются available=false и reason,
 * чтобы редактор показывал их выключенными с подсказкой, а не прятал.
 */
export function nodePaletteAvailability(kind: SchemaPaletteKind | undefined): NodePaletteEntry[] {
  const kindLabel = kind ? paletteKindLabel(kind) : '—';
  return BASE_NODE_PALETTE.map((type) => {
    const available = isNodeTypeAllowedInSchema(kind, type);
    const label = NODE_TYPE_LABELS[type];
    return available
      ? { type, label, available }
      : {
          type,
          label,
          available,
          reason: `Узел «${label}» недоступен для схемы «${kindLabel}»`,
        };
  });
}

/**
 * Категория узла для визуального оформления заголовка (issue #248, этап D, ТЗ §5):
 * узлы одной категории получают единый цвет шапки, а граничные start/end —
 * ромбовидную форму. Чисто презентационное деление, на исполнение не влияет.
 */
export type NodeCategory = 'boundary' | 'generation' | 'control' | 'data' | 'utility';

export function nodeCategory(type: NodeType): NodeCategory {
  if (type === 'start' || type === 'end') return 'boundary';
  if (type === 'llm_request' || type === 'knowledge_query' || type === 'graph_rag' || type === 'media_generate') return 'generation';
  if (type === 'condition' || type === 'loop' || type === 'merge') return 'control';
  if (type === 'sub_schema' || type === 'log') return 'utility';
  if (type === 'constant') return 'data';
  return 'data';
}

/** Режим выхода из loop в редакторе (issue #248): по счётчику или по выражению. */
export type LoopMode = 'count' | 'expression';

/**
 * Определяет режим loop по его конфигурации: если задано exitExpression — режим
 * «по выражению», иначе «по счётчику». Движок учитывает оба поля одновременно
 * (выражение прерывает цикл досрочно), поэтому это чисто UI-различение того, какое
 * поле считать основным.
 */
export function loopModeFromConfig(config: Record<string, unknown>): LoopMode {
  const expression = typeof config.exitExpression === 'string' ? config.exitExpression.trim() : '';
  return expression.length > 0 ? 'expression' : 'count';
}

/** Описание одного типизированного поля ввода для тест-модалки (issue #248). */
export interface TestInputField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'json';
  placeholder?: string;
}

const HISTORY_PLACEHOLDER = JSON.stringify(
  [{ turn: 1, action: 'Осмотреться', outcome: 'Ты видишь тёмный коридор.' }],
  null,
  2,
);

const SUPPORT_HISTORY_PLACEHOLDER = JSON.stringify(
  [
    { role: 'user', message: 'Не получается начать игру' },
    { role: 'bot', message: 'Уточните, пожалуйста, на каком шаге возникает проблема.' },
  ],
  null,
  2,
);

/**
 * Типизированные поля ввода тест-модалки по типу схемы (issue #248, этап D): вместо
 * сырого «Inputs JSON» администратор заполняет понятные поля специфичные для схемы.
 */
export function testInputFields(schemaType: SchemaPaletteKind): TestInputField[] {
  if (schemaType === 'action') {
    return [
      { key: 'action', label: 'Действие игрока', kind: 'text', placeholder: 'Осмотреться' },
      { key: 'history', label: 'История ходов (JSON)', kind: 'json', placeholder: HISTORY_PLACEHOLDER },
    ];
  }
  if (schemaType === 'hint') {
    return [
      { key: 'history', label: 'История ходов (JSON)', kind: 'json', placeholder: HISTORY_PLACEHOLDER },
    ];
  }
  if (schemaType === 'illustration') {
    return [
      { key: 'narrative', label: 'Нарратив сцены', kind: 'textarea', placeholder: 'Игрок стоит у входа в убежище.' },
    ];
  }
  if (schemaType === 'support') {
    return [
      { key: 'user_query', label: 'Запрос пользователя', kind: 'textarea', placeholder: 'Не получается начать игру' },
      {
        key: 'supportHistory',
        label: 'История переписки (JSON)',
        kind: 'json',
        placeholder: SUPPORT_HISTORY_PLACEHOLDER,
      },
    ];
  }
  return [];
}

/**
 * Собирает объект inputs для теста из значений типизированных полей, дополняя их
 * служебными полями по умолчанию (mockResponses/history), которые нужны движку, но
 * не редактируются простыми полями (issue #248).
 */
export function buildTestInputs(
  schemaType: SchemaPaletteKind,
  values: Record<string, string>,
): Record<string, unknown> {
  const base = defaultTestInputValues(schemaType);
  const result: Record<string, unknown> = { ...base };
  for (const field of testInputFields(schemaType)) {
    const value = values[field.key];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (field.kind === 'json') {
      try {
        result[field.key] = JSON.parse(value) as unknown;
      } catch {
        // невалидный JSON — оставляем дефолт
      }
    } else {
      result[field.key] = value;
    }
  }
  return result;
}

/** Значения inputs по умолчанию для теста схемы (issue #248). */
export function defaultTestInputValues(schemaType: SchemaPaletteKind): Record<string, unknown> {
  if (schemaType === 'action') return { action: 'Осмотреться', history: [], mockResponses: [] };
  if (schemaType === 'hint') {
    return { history: [], mockResponses: [{ hints: ['Осмотреться', 'Проверить инвентарь'] }] };
  }
  if (schemaType === 'illustration') return { narrative: 'Игрок стоит у входа в убежище.' };
  if (schemaType === 'support') {
    return {
      user_query: 'Не получается начать игру',
      supportHistory: [],
      expertiseTopK: 3,
      mockResponses: [{ reply: 'Проверю проблему.', summary: 'Пользователь не может начать игру' }],
    };
  }
  // Суб-схема (issue #310): входы — настраиваемые граничные порты, фиксированных
  // дефолтов нет; значения задаются по составу start-узла (см.
  // defaultSubSchemaTestInputValues / subSchemaTestInputFields, issue #343).
  return {};
}

/**
 * Типизированные поля ввода теста для суб-схемы (issue #343): строятся по составу
 * start-узла — каждый граничный вход суб-схемы даёт отдельное поле. Строки
 * вводятся как текст, числа/булевы — как текст с приведением типа при сборке,
 * сложные типы (объекты, массивы, expertise/memory, any) — как JSON.
 */
export function subSchemaTestInputFields(graph: SchemaGraph): TestInputField[] {
  return boundaryStartPorts(graph).map((port) => ({
    key: port.id,
    label: `${port.label} · ${port.type}`,
    kind: boundaryPortFieldKind(port.type),
    placeholder: boundaryPortPlaceholder(port.type),
  }));
}

/**
 * Начальные значения inputs теста суб-схемы (issue #343): по одному ключу на
 * каждый граничный вход start-узла с дефолтом, подходящим под тип порта. Это даёт
 * движку валидную форму входов даже без ручного заполнения полей.
 */
export function defaultSubSchemaTestInputValues(graph: SchemaGraph): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const port of boundaryStartPorts(graph)) {
    result[port.id] = defaultBoundaryPortValue(port.type);
  }
  return result;
}

/**
 * Собирает объект inputs теста суб-схемы из значений типизированных полей
 * (issue #343): ключи — id граничных входов start-узла, значения приводятся к типу
 * порта. Пустое поле заменяется дефолтом по типу.
 */
export function buildSubSchemaTestInputs(
  graph: SchemaGraph,
  values: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const port of boundaryStartPorts(graph)) {
    const raw = values[port.id];
    if (typeof raw !== 'string' || raw.length === 0) {
      result[port.id] = defaultBoundaryPortValue(port.type);
      continue;
    }
    result[port.id] = coerceBoundaryPortValue(port.type, raw);
  }
  return result;
}

/**
 * Входные data-порты узла с телом (loop / graph_rag), по которым строится форма
 * изолированного теста тела узла (issue #390). Из набора входов узла исключаются
 * exec-порты — они задают поток управления, а не данные.
 */
function nodeBodyDataInputs(node: NodeDefinition, graph?: SchemaGraph): PortDefinition[] {
  return getNodePorts(node, graph).inputs.filter((port) => port.type !== 'exec');
}

/**
 * Типизированные поля ввода для изолированного теста тела узла (issue #390):
 * строятся по входным data-портам самого тестируемого узла (например, `value`
 * у loop или `query`/`questions` у graph_rag), а не по граничным портам start-узла
 * его тела — они могут не совпадать с входами узла.
 */
export function nodeBodyTestInputFields(node: NodeDefinition, graph?: SchemaGraph): TestInputField[] {
  return nodeBodyDataInputs(node, graph).map((port) => ({
    key: port.id,
    label: `${port.label} · ${port.type}`,
    kind: boundaryPortFieldKind(port.type),
    placeholder: boundaryPortPlaceholder(port.type),
  }));
}

/**
 * Начальные значения inputs изолированного теста тела узла (issue #390): по одному
 * ключу на каждый входной data-порт тестируемого узла с дефолтом под тип порта.
 */
export function defaultNodeBodyTestInputValues(
  node: NodeDefinition,
  graph?: SchemaGraph,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const port of nodeBodyDataInputs(node, graph)) {
    result[port.id] = defaultBoundaryPortValue(port.type);
  }
  return result;
}

/**
 * Собирает объект inputs изолированного теста тела узла из значений полей формы
 * (issue #390): ключи — id входных data-портов тестируемого узла, значения
 * приводятся к типу порта. Пустое поле заменяется дефолтом по типу.
 */
export function buildNodeBodyTestInputs(
  node: NodeDefinition,
  graph: SchemaGraph | undefined,
  values: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const port of nodeBodyDataInputs(node, graph)) {
    const raw = values[port.id];
    if (typeof raw !== 'string' || raw.length === 0) {
      result[port.id] = defaultBoundaryPortValue(port.type);
      continue;
    }
    result[port.id] = coerceBoundaryPortValue(port.type, raw);
  }
  return result;
}

/** Вид поля редактора для типа граничного порта суб-схемы (issue #343). */
function boundaryPortFieldKind(type: PortType): TestInputField['kind'] {
  if (type === 'string') return 'text';
  if (type === 'number' || type === 'boolean') return 'text';
  return 'json';
}

/** Подсказка-плейсхолдер для типа граничного порта суб-схемы (issue #343). */
function boundaryPortPlaceholder(type: PortType): string {
  switch (type) {
    case 'string':
      return 'Текст';
    case 'number':
      return '0';
    case 'boolean':
      return 'true / false';
    case 'string_array':
      return '["элемент 1", "элемент 2"]';
    case 'object':
      return '{ "ключ": "значение" }';
    case 'object_array':
      return '[{ "ключ": "значение" }]';
    default:
      return 'JSON-значение';
  }
}

/** Дефолтное значение для типа граничного порта суб-схемы (issue #343). */
function defaultBoundaryPortValue(type: PortType): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string_array':
    case 'object_array':
    case 'expertise':
    case 'memory':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/** Приводит сырое строковое значение поля к типу граничного порта (issue #343). */
function coerceBoundaryPortValue(type: PortType, raw: string): unknown {
  if (type === 'string') return raw;
  if (type === 'number') {
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  if (type === 'boolean') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'да') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'нет') return false;
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Невалидный JSON — отдаём дефолт по типу, чтобы не сломать форму входов.
    return defaultBoundaryPortValue(type);
  }
}

/** Элемент бандла глобального экспорта/импорта схем (issue #248, этап D). */
export interface SchemaBundleItem {
  schemaSlug: string;
  schemaType: string;
  gameId: string | null;
  graphJson: unknown;
  description: string | null;
}

/** Уже существующая схема для сравнения с бандлом импорта. */
export interface ExistingSchema {
  schemaSlug: string;
  gameId: string | null;
  graphJson: unknown;
  description?: string | null;
}

export type SchemaImportAction = 'created' | 'updated' | 'unchanged';

export interface SchemaBundleDiffRow {
  slug: string;
  gameId: string | null;
  action: SchemaImportAction;
}

export interface SchemaBundleDiff {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  rows: SchemaBundleDiffRow[];
}

/** Сводка результата импорта с сервера (issue #248). */
export interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
}

/**
 * Разбирает файл глобального экспорта схем в список элементов бандла (issue #248).
 * Поддерживает как формат экспорта `{version, items: [...]}`, так и одиночную схему
 * (объект graph_json или запись с graphJson), оборачивая её в бандл из одного элемента.
 */
export function parseSchemaBundle(payload: unknown): SchemaBundleItem[] {
  if (isRecord(payload) && Array.isArray(payload.items)) {
    return payload.items
      .filter(isRecord)
      .map((item) => toBundleItem(item))
      .filter((item): item is SchemaBundleItem => item !== null);
  }
  // Одиночная схема как graph_json.
  if (isRecord(payload) && payload.version === 1 && Array.isArray(payload.nodes) && isSchemaType(payload.schemaType)) {
    return [
      {
        schemaSlug: typeof payload.slug === 'string' ? payload.slug : payload.schemaType,
        schemaType: payload.schemaType,
        gameId: typeof payload.gameId === 'string' ? payload.gameId : null,
        graphJson: payload,
        description: null,
      },
    ];
  }
  // Одиночная запись с graphJson/graph_json.
  if (isRecord(payload) && (payload.graphJson || payload.graph_json)) {
    const item = toBundleItem(payload);
    if (item) return [item];
  }
  throw new Error('Файл импорта должен содержать items[] глобального экспорта или одну схему graph_json');
}

function toBundleItem(item: Record<string, unknown>): SchemaBundleItem | null {
  const graphJson = item.graphJson ?? item.graph_json;
  if (graphJson === undefined || graphJson === null) return null;
  const slug = item.schemaSlug ?? item.schema_slug;
  const schemaType = item.schemaType ?? item.schema_type;
  const gameId = item.gameId ?? item.game_id;
  return {
    schemaSlug: typeof slug === 'string' ? slug : '',
    schemaType: typeof schemaType === 'string' ? schemaType : '',
    gameId: typeof gameId === 'string' ? gameId : null,
    graphJson,
    description: typeof item.description === 'string' ? item.description : null,
  };
}

function bundleKey(slug: string, gameId: string | null): string {
  return `${slug}@@${gameId ?? ''}`;
}

/**
 * Сравнивает элементы бандла импорта с уже существующими схемами и считает, сколько
 * будет создано/обновлено/без изменений (issue #248). Это предпросмотр на стороне
 * клиента: авторитетную сводку всё равно возвращает сервер после импорта.
 */
export function diffSchemaBundle(
  items: readonly SchemaBundleItem[],
  existing: readonly ExistingSchema[],
): SchemaBundleDiff {
  const byKey = new Map<string, ExistingSchema>();
  for (const schema of existing) byKey.set(bundleKey(schema.schemaSlug, schema.gameId ?? null), schema);

  const rows: SchemaBundleDiffRow[] = items.map((item) => {
    const match = byKey.get(bundleKey(item.schemaSlug, item.gameId));
    let action: SchemaImportAction;
    if (!match) action = 'created';
    else action = stableStringify(match.graphJson) === stableStringify(item.graphJson) ? 'unchanged' : 'updated';
    return { slug: item.schemaSlug, gameId: item.gameId, action };
  });

  return {
    total: rows.length,
    created: rows.filter((row) => row.action === 'created').length,
    updated: rows.filter((row) => row.action === 'updated').length,
    unchanged: rows.filter((row) => row.action === 'unchanged').length,
    rows,
  };
}

/** Форматирует сводку импорта (с сервера или предпросмотра) в строку (issue #248). */
export function formatImportSummary(summary: ImportSummary): string {
  return [
    `всего: ${summary.total}`,
    `создано: ${summary.created}`,
    `обновлено: ${summary.updated}`,
    `без изменений: ${summary.unchanged}`,
  ].join(' · ');
}

/** Детерминированная сериализация для сравнения графов независимо от порядка ключей. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function canConnectGraphPorts(graph: SchemaGraph, connection: GraphConnection): ConnectionValidation {
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target || !connection.sourceHandle || !connection.targetHandle) {
    return { valid: false, message: 'Не удалось определить узлы и порты соединения' };
  }
  if (source.id === target.id) {
    return { valid: false, message: 'Нельзя соединить узел сам с собой' };
  }

  const sourcePort = getNodePorts(source, graph).outputs.find((port) => port.id === connection.sourceHandle);
  const targetPort = getNodePorts(target, graph).inputs.find((port) => port.id === connection.targetHandle);
  if (!sourcePort) return { valid: false, message: `У ${source.id} нет output-порта ${connection.sourceHandle}` };
  if (!targetPort) return { valid: false, message: `У ${target.id} нет input-порта ${connection.targetHandle}` };
  if (!arePortTypesCompatible(sourcePort.type, targetPort.type)) {
    return {
      valid: false,
      message: `Несовместимые порты: ${sourcePort.type} -> ${targetPort.type}`,
    };
  }

  const duplicate = graph.edges.some(
    (edge) =>
      edge.from === source.id &&
      edge.fromPort === sourcePort.id &&
      edge.to === target.id &&
      edge.toPort === targetPort.id,
  );
  if (duplicate) return { valid: false, message: 'Такое соединение уже есть' };

  if (targetPort.type !== 'exec') {
    const occupied = graph.edges.some(
      (edge) =>
        !isExecPortId(edge.fromPort) &&
        edge.to === target.id &&
        edge.toPort === targetPort.id,
    );
    if (occupied) {
      return { valid: false, message: `input-порт ${target.id}.${targetPort.id} уже подключён` };
    }
  }

  return { valid: true };
}

export function connectGraphPorts(graph: SchemaGraph, connection: GraphConnection): SchemaGraph {
  const validation = canConnectGraphPorts(graph, connection);
  if (!validation.valid) {
    throw new Error(validation.message ?? 'Некорректное соединение');
  }
  const from = String(connection.source);
  const fromPort = String(connection.sourceHandle);
  const to = String(connection.target);
  const toPort = String(connection.targetHandle);
  const edge: EdgeDefinition = {
    id: edgeId(from, fromPort, to, toPort),
    from,
    fromPort,
    to,
    toPort,
  };
  return { ...graph, edges: [...graph.edges, edge] };
}

export function removeGraphSelection(
  graph: SchemaGraph,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): SchemaGraph {
  const removable = new Set(
    nodeIds.filter((nodeId) => {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      return node && node.type !== 'start' && node.type !== 'end';
    }),
  );
  const removedEdges = new Set(edgeIds);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !removable.has(node.id)),
    edges: graph.edges.filter(
      (edge) =>
        !removedEdges.has(edge.id) &&
        !removable.has(edge.from) &&
        !removable.has(edge.to),
    ),
  };
}

export function updateGraphNodePosition(
  graph: SchemaGraph,
  nodeId: string,
  position: { x: number; y: number },
): SchemaGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, position: { x: Math.round(position.x), y: Math.round(position.y) } }
        : node,
    ),
  };
}

export function createGraphNode(
  graph: SchemaGraph,
  type: NodeType,
  position: { x: number; y: number },
): NodeDefinition {
  const paletteKind = graphPaletteKind(graph);
  if (!isNodeTypeAllowedInSchema(paletteKind, type)) {
    const kindLabel = paletteKind ? paletteKindLabel(paletteKind) : '—';
    throw new Error(`Узел ${type} недоступен для схемы ${kindLabel}`);
  }
  const id = nextNodeId(graph, type);
  const config = type === 'graph_rag'
    ? { maxIterations: 3, bodyGraph: buildDefaultGraphRagBodyGraph(graph.slug, id) }
    : defaultConfigFor(type);
  return {
    id,
    type,
    position,
    label: NODE_TYPE_LABELS[type],
    config,
  };
}

export function duplicateGraphNode(
  graph: SchemaGraph,
  nodeId: string,
): { graph: SchemaGraph; duplicatedId: string | null } {
  const source = graph.nodes.find((node) => node.id === nodeId);
  if (!source || source.type === 'start' || source.type === 'end') {
    return { graph, duplicatedId: null };
  }
  const duplicated: NodeDefinition = {
    ...cloneValue(source),
    id: nextNodeId(graph, source.type),
    position: { x: source.position.x + 48, y: source.position.y + 48 },
    label: source.label ? `${source.label} copy` : `${NODE_TYPE_LABELS[source.type]} copy`,
  };
  return {
    graph: { ...graph, nodes: [...graph.nodes, duplicated] },
    duplicatedId: duplicated.id,
  };
}

/**
 * Снимок выделения для буфера обмена (issue #230): копируемые узлы и рёбра между
 * ними. Узлы start/end не копируются — они единственны в схеме.
 */
export interface GraphClipboard {
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
}

/** Узел можно копировать/вырезать/удалять — кроме единственных start и end. */
export function isCopyableNode(node: NodeDefinition | undefined): boolean {
  return Boolean(node) && node!.type !== 'start' && node!.type !== 'end';
}

/**
 * Собирает выбранные узлы и рёбра между ними в буфер обмена (issue #230). Узлы
 * start/end отбрасываются, как и рёбра, у которых хотя бы один конец вне выделения.
 */
export function extractGraphClipboard(graph: SchemaGraph, nodeIds: readonly string[]): GraphClipboard {
  const selected = new Set(
    nodeIds.filter((nodeId) => isCopyableNode(graph.nodes.find((node) => node.id === nodeId))),
  );
  return {
    nodes: graph.nodes.filter((node) => selected.has(node.id)).map((node) => cloneValue(node)),
    edges: graph.edges
      .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
      .map((edge) => cloneValue(edge)),
  };
}

/** В буфере есть что вставлять. */
export function clipboardHasContent(clipboard: GraphClipboard | null | undefined): boolean {
  return Boolean(clipboard) && clipboard!.nodes.length > 0;
}

/**
 * Вставляет содержимое буфера в граф с новыми id и сдвигом позиций (issue #230).
 * Рёбра переносятся только между вставленными узлами (id перемаппливаются),
 * возвращается граф и список id вставленных узлов для выделения.
 */
export function pasteGraphClipboard(
  graph: SchemaGraph,
  clipboard: GraphClipboard,
  offset: { x: number; y: number } = { x: 48, y: 48 },
): { graph: SchemaGraph; nodeIds: string[] } {
  const used = new Set(graph.nodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const newNodes: NodeDefinition[] = [];
  for (const node of clipboard.nodes) {
    if (!isCopyableNode(node)) continue;
    const newId = nextNodeIdFromUsed(used, node.type);
    used.add(newId);
    idMap.set(node.id, newId);
    newNodes.push({
      ...cloneValue(node),
      id: newId,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    });
  }
  const newEdges: EdgeDefinition[] = [];
  for (const edge of clipboard.edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue;
    newEdges.push({ id: edgeId(from, edge.fromPort, to, edge.toPort), from, fromPort: edge.fromPort, to, toPort: edge.toPort });
  }
  return {
    graph: { ...graph, nodes: [...graph.nodes, ...newNodes], edges: [...graph.edges, ...newEdges] },
    nodeIds: newNodes.map((node) => node.id),
  };
}

/**
 * Дублирует группу выбранных узлов вместе с рёбрами между ними (issue #230):
 * копирует выделение в буфер и тут же вставляет со сдвигом.
 */
export function duplicateGraphNodes(
  graph: SchemaGraph,
  nodeIds: readonly string[],
): { graph: SchemaGraph; nodeIds: string[] } {
  return pasteGraphClipboard(graph, extractGraphClipboard(graph, nodeIds));
}

export function updateNodeConfig(
  graph: SchemaGraph,
  nodeId: string,
  patch: Partial<Pick<NodeDefinition, 'label' | 'config'>>,
): SchemaGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.config !== undefined ? { config: patch.config } : {}),
          }
        : node,
    ),
  };
}

// ── Навигация по вложенным bodyGraph (issue #337) ─────────────────────────
// Узлы loop хранят своё тело в config.bodyGraph как полноценный SchemaGraph.
// Визуальный редактор «спускается» в это тело прямо на том же канвасе и
// сворачивает стек обратно в корневой граф при сохранении.

export type BodyGraphNodeType = 'loop' | 'graph_rag';

/** id узла-цикла, в тело которого спустился редактор, и граф-родитель кадра. */
export interface LoopBodyFrame {
  /** Граф, содержащий узел с bodyGraph: корневой граф или тело внешнего узла. */
  parentGraph: SchemaGraph;
  /** id узла loop, в чьё тело вошёл редактор. */
  loopNodeId: string;
  /** Тип узла с bodyGraph. Для старых кадров loop определяется по умолчанию. */
  nodeType?: BodyGraphNodeType;
}

/**
 * Структурный признак графа-тела цикла (issue #337): достаточно совпадения с формой
 * SchemaGraph (version/slug/nodes/edges + XOR-вид). Используется редактором, чтобы
 * решить — открывать сохранённое тело или создать пустое.
 */
function isBodyGraph(value: unknown): value is SchemaGraph {
  if (!isRecord(value)) return false;
  const hasKind = isSchemaType(value.schemaType) || isSubSchemaClass(value.subSchemaClass);
  return (
    value.version === 1 &&
    hasKind &&
    typeof value.slug === 'string' &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

export function bodyGraphSlug(parentSlug: string, nodeId: string, nodeType: BodyGraphNodeType): string {
  return `${parentSlug}::${nodeType}:${nodeId}`;
}

/** Slug графа-тела цикла: производный от slug родителя и id узла (issue #337). */
export function loopBodySlug(parentSlug: string, loopNodeId: string): string {
  return bodyGraphSlug(parentSlug, loopNodeId, 'loop');
}

/**
 * Пустое тело цикла (issue #337): валидный SchemaGraph со start/end, соединёнными
 * exec-ребром. Вид (schemaType либо subSchemaClass) наследуется от родительского
 * графа, чтобы палитра узлов и порты тела совпадали с остальной схемой.
 */
export function makeEmptyLoopBodyGraph(parent: SchemaGraph, loopNodeId: string): SchemaGraph {
  return makeEmptyBodyGraph(parent, loopNodeId, 'loop');
}

export function makeEmptyBodyGraph(
  parent: SchemaGraph,
  nodeId: string,
  nodeType: BodyGraphNodeType,
): SchemaGraph {
  if (nodeType === 'graph_rag') return buildDefaultGraphRagBodyGraph(parent.slug, nodeId);
  return {
    version: 1,
    slug: bodyGraphSlug(parent.slug, nodeId, nodeType),
    ...(parent.subSchemaClass !== undefined
      ? { subSchemaClass: parent.subSchemaClass }
      : { schemaType: parent.schemaType }),
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [edge('start', 'exec', 'end', 'exec')],
    variables: {},
  };
}

/** Тело выбранного цикла: сохранённое (клон) либо свежесозданное пустое (issue #337). */
export function getLoopBodyGraph(parent: SchemaGraph, loopNodeId: string): SchemaGraph {
  return getBodyGraph(parent, loopNodeId);
}

export function getBodyGraph(parent: SchemaGraph, nodeId: string): SchemaGraph {
  const node = parent.nodes.find((candidate) => candidate.id === nodeId);
  const body = node ? node.config.bodyGraph : undefined;
  if (isBodyGraph(body)) return cloneValue(body);
  return makeEmptyBodyGraph(parent, nodeId, node?.type === 'graph_rag' ? 'graph_rag' : 'loop');
}

/** Копия parent с обновлённым config.bodyGraph узла loop. */
export function writeBodyGraph(
  parent: SchemaGraph,
  nodeId: string,
  body: SchemaGraph,
): SchemaGraph {
  return {
    ...parent,
    nodes: parent.nodes.map((node) =>
      node.id === nodeId ? { ...node, config: { ...node.config, bodyGraph: body } } : node,
    ),
  };
}

/** Копия parent с обновлённым config.bodyGraph узла цикла (issue #337). */
export function writeLoopBodyGraph(
  parent: SchemaGraph,
  loopNodeId: string,
  body: SchemaGraph,
): SchemaGraph {
  return writeBodyGraph(parent, loopNodeId, body);
}

/**
 * Сворачивает стек открытых циклов обратно в корневой граф (issue #337): тело каждого
 * уровня записывается в config.bodyGraph своего узла, снизу вверх. При пустом стеке
 * возвращает сам leaf — это и есть корневой граф.
 */
export function collapseLoopFrames(
  frames: readonly LoopBodyFrame[],
  leaf: SchemaGraph,
): SchemaGraph {
  return collapseBodyGraphFrames(frames, leaf);
}

export function collapseBodyGraphFrames(
  frames: readonly LoopBodyFrame[],
  leaf: SchemaGraph,
): SchemaGraph {
  let result = leaf;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    result = writeBodyGraph(frames[i].parentGraph, frames[i].loopNodeId, result);
  }
  return result;
}

/**
 * Восстанавливает стек открытых тел узлов на свежем корневом графе (issue #393).
 * После сохранения схемы сервер возвращает весь граф заново, и редактор должен
 * остаться в той же открытой схеме узла, что и до сохранения. Проходим по тому же
 * пути идентификаторов `loopNodeId` сверху вниз, собирая новые кадры со снимками
 * актуальных родителей; листом становится тело самого вложенного узла. Если путь
 * оборвался (узел исчез или перестал быть контейнером тела), останавливаемся на
 * достигнутом уровне.
 */
export function reopenBodyGraphFrames(
  root: SchemaGraph,
  frames: readonly LoopBodyFrame[],
): { frames: LoopBodyFrame[]; leaf: SchemaGraph } {
  const rebuilt: LoopBodyFrame[] = [];
  let current = root;
  for (const frame of frames) {
    const node = current.nodes.find((candidate) => candidate.id === frame.loopNodeId);
    if (!node || (node.type !== 'loop' && node.type !== 'graph_rag')) break;
    const nodeType: BodyGraphNodeType = node.type === 'graph_rag' ? 'graph_rag' : 'loop';
    rebuilt.push({ parentGraph: current, loopNodeId: frame.loopNodeId, nodeType });
    current = getBodyGraph(current, frame.loopNodeId);
  }
  return { frames: rebuilt, leaf: current };
}

export function makeEmptyGraph(slug: string, schemaType: SchemaType): SchemaGraph {
  return {
    version: 1,
    slug,
    schemaType,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [edge('start', 'exec', 'end', 'exec')],
    variables: {},
  };
}

/**
 * Пустой граф суб-схемы (issue #310). Отличается от пайплайн-графа тем, что вместо
 * `schemaType` несёт `subSchemaClass`, а граничные узлы `start`/`end` получают
 * настраиваемые порты: `start.config.outputs` — входы суб-схемы, `end.config.inputs`
 * — её выходы. По умолчанию портов нет — редактор настраивает их вручную.
 */
export function makeEmptySubSchemaGraph(
  slug: string,
  subSchemaClass: SubSchemaClass,
  gameId?: string,
): SchemaGraph {
  return {
    version: 1,
    slug,
    subSchemaClass,
    ...(gameId ? { gameId } : {}),
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: { outputs: [] }, label: 'Start' },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: { inputs: [] }, label: 'End' },
    ],
    edges: [edge('start', 'exec', 'end', 'exec')],
    variables: {},
  };
}

export function normalizeSchemaGraph(value: unknown): SchemaGraph {
  if (!isRecord(value)) throw new Error('graph_json должен быть объектом');
  if (value.version !== 1) throw new Error('graph_json.version должен быть равен 1');
  if (typeof value.slug !== 'string' || !value.slug) throw new Error('graph_json.slug должен быть непустой строкой');
  // XOR-инвариант (issue #310): граф задаёт ровно одно из schemaType (пайплайн)
  // или subSchemaClass (суб-схема).
  const hasType = value.schemaType !== undefined && value.schemaType !== null;
  const hasClass = value.subSchemaClass !== undefined && value.subSchemaClass !== null;
  if (hasType === hasClass) {
    throw new Error('graph_json должен задавать ровно одно из schemaType или subSchemaClass');
  }
  if (hasType && !isSchemaType(value.schemaType)) throw new Error('graph_json.schemaType содержит неизвестный тип схемы');
  if (hasClass && !isSubSchemaClass(value.subSchemaClass)) {
    throw new Error('graph_json.subSchemaClass содержит неизвестный класс суб-схемы');
  }
  if (!Array.isArray(value.nodes)) throw new Error('graph_json.nodes должен быть массивом');
  if (!Array.isArray(value.edges)) throw new Error('graph_json.edges должен быть массивом');

  const nodes = value.nodes.map((item, index): NodeDefinition => {
    if (!isRecord(item)) throw new Error(`graph_json.nodes[${index}] должен быть объектом`);
    if (typeof item.id !== 'string' || !item.id) throw new Error(`graph_json.nodes[${index}].id должен быть строкой`);
    if (!isNodeType(item.type)) throw new Error(`graph_json.nodes[${index}].type содержит неизвестный тип`);
    const position = isRecord(item.position) ? item.position : {};
    return {
      id: item.id,
      type: item.type,
      position: {
        x: typeof position.x === 'number' && Number.isFinite(position.x) ? position.x : 0,
        y: typeof position.y === 'number' && Number.isFinite(position.y) ? position.y : 0,
      },
      config: isRecord(item.config) ? item.config : {},
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
    };
  });

  const edges = value.edges.map((item, index): EdgeDefinition => {
    if (!isRecord(item)) throw new Error(`graph_json.edges[${index}] должен быть объектом`);
    if (
      typeof item.from !== 'string' ||
      typeof item.fromPort !== 'string' ||
      typeof item.to !== 'string' ||
      typeof item.toPort !== 'string'
    ) {
      throw new Error(`graph_json.edges[${index}] должен содержать from/fromPort/to/toPort`);
    }
    return {
      id: typeof item.id === 'string' && item.id ? item.id : edgeId(item.from, item.fromPort, item.to, item.toPort),
      from: item.from,
      fromPort: item.fromPort,
      to: item.to,
      toPort: item.toPort,
    };
  });

  const graph: SchemaGraph = {
    version: 1,
    slug: value.slug,
    ...(hasType ? { schemaType: value.schemaType as SchemaType } : {}),
    ...(hasClass ? { subSchemaClass: value.subSchemaClass as SubSchemaClass } : {}),
    ...(typeof value.gameId === 'string' && value.gameId ? { gameId: value.gameId } : {}),
    nodes,
    edges,
    variables: isRecord(value.variables) ? value.variables : {},
  };
  try {
    validateSchemaGraphContract(graph);
  } catch (err) {
    if (err instanceof SchemaContractError) throw new Error(err.message);
    throw err;
  }
  return graph;
}

export function cloneGraph(graph: SchemaGraph): SchemaGraph {
  return cloneValue(graph);
}

export function formatConfigSummary(node: NodeDefinition): string {
  if (node.type === 'llm_request') {
    const inputs = Array.isArray(node.config.inputs) ? node.config.inputs.length : 0;
    const outputs = Array.isArray(node.config.outputs) ? node.config.outputs.length : 0;
    return [
      inputs > 0 ? `inputs ${inputs}` : 'без inputs',
      outputs > 0 ? `outputs ${outputs}` : 'без outputs',
    ].join(' · ');
  }
  if (node.type === 'condition') {
    return `${asString(node.config.input) ?? 'value'} ${asString(node.config.operator) ?? 'truthy'}`;
  }
  if (node.type === 'loop') return `max ${String(node.config.maxIterations ?? 1)}`;
  if (node.type === 'graph_rag') return `max ${String(node.config.maxIterations ?? 3)}`;
  if (node.type === 'transform') {
    const inputs = Array.isArray(node.config.inputs) ? node.config.inputs.length : 0;
    const outputs = Array.isArray(node.config.outputs) ? node.config.outputs.length : 0;
    return [
      inputs > 0 ? `inputs ${inputs}` : 'без inputs',
      outputs > 0 ? `outputs ${outputs}` : 'без outputs',
    ].join(' · ');
  }
  if (node.type === 'variable_read') {
    // issue #232: legacy config.name убран — пустая конфигурация даёт порт value.
    const count = Array.isArray(node.config.outputs) ? node.config.outputs.length : 0;
    return count > 0 ? `read ${count}` : 'value';
  }
  if (node.type === 'variable_write') {
    // issue #232: legacy config.name убран — пустая конфигурация даёт порт value.
    const count = Array.isArray(node.config.inputs) ? node.config.inputs.length : 0;
    return count > 0 ? `write ${count}` : 'value';
  }
  if (node.type === 'game_state_read') return 'state';
  if (node.type === 'game_state_write') return 'merge state';
  if (node.type === 'manifest') {
    const fields = Array.isArray(node.config.fields) ? node.config.fields.length : 0;
    return fields > 0 ? `fields ${fields}` : 'весь объект';
  }
  if (node.type === 'media_generate') {
    const inputs = Array.isArray(node.config.inputs) ? node.config.inputs.length : 0;
    return [
      inputs > 0 ? `inputs ${inputs}` : 'без inputs',
      asString(node.config.prompt) ? 'prompt задан' : 'prompt не задан',
    ].join(' · ');
  }
  if (node.type === 'log') return asString(node.config.message) ?? 'debug log';
  if (node.type === 'constant') {
    const outputs = Array.isArray(node.config.outputs) ? node.config.outputs.length : 0;
    return outputs > 0 ? `outputs ${outputs}` : 'нет портов';
  }
  return NODE_TYPE_LABELS[node.type];
}

function defaultConfigFor(type: NodeType): Record<string, unknown> {
  if (type === 'llm_request') {
    return {
      systemPrompt: '',
      userPrompt: '',
      retryPrompt: '',
      inputs: [],
      outputs: [{ name: 'value', jsonPath: 'value', type: 'any' }],
      jsonMode: true,
    };
  }
  if (type === 'condition') return { input: 'value', operator: 'truthy', right: '' };
  if (type === 'loop') return { maxIterations: 3, exitExpression: '' };
  if (type === 'graph_rag') return { maxIterations: 3 };
  if (type === 'transform') {
    return { code: 'return input;', inputs: [], outputs: [{ name: 'result', type: 'any', path: 'result' }] };
  }
  if (type === 'variable_read') return { outputs: [{ name: 'variable', type: 'any' }] };
  if (type === 'variable_write') return { inputs: [{ name: 'variable', type: 'any' }] };
  if (type === 'game_state_write') return {};
  if (type === 'game_state_read') return {};
  if (type === 'manifest') return { fields: [] };
  if (type === 'media_generate') return { prompt: '', inputs: [] };
  if (type === 'log') return { message: '' };
  if (type === 'sub_schema') return { schemaSlug: '', ports: { inputs: [], outputs: [] } };
  if (type === 'constant') return { outputs: [{ name: 'value', type: 'string', value: '' }] };
  return {};
}

/** Снимок граничных портов суб-схемы, кэшируемый в config.ports узла sub_schema. */
export interface SubSchemaPortsSnapshot {
  inputs: SchemaBoundaryPort[];
  outputs: SchemaBoundaryPort[];
}

/**
 * Патч конфига узла sub_schema при выборе суб-схемы (issue #315). Пишем slug и снимок
 * её граничных портов ОДНИМ объектом: раньше это делалось двумя setConfigKey подряд,
 * и второй вызов перетирал первый (оба строились из одного и того же снимка config),
 * из-за чего сохранялся либо slug, либо ports, но не оба — селектор «не работал».
 * Если slug не найден среди опций (ручной ввод нестандартного значения), снимок портов
 * сбрасывается, чтобы не висели порты ранее выбранной суб-схемы.
 */
export function subSchemaConfigPatch(
  config: Record<string, unknown>,
  nextSlug: string,
  options: ReadonlyArray<{ slug: string; ports: SubSchemaPortsSnapshot }>,
): Record<string, unknown> {
  const option = options.find((item) => item.slug === nextSlug);
  return {
    ...config,
    schemaSlug: nextSlug,
    ports: option ? { inputs: option.ports.inputs, outputs: option.ports.outputs } : undefined,
  };
}

function nextNodeId(graph: SchemaGraph, type: NodeType): string {
  return nextNodeIdFromUsed(new Set(graph.nodes.map((node) => node.id)), type);
}

function nextNodeIdFromUsed(used: Set<string>, type: NodeType): string {
  const prefix = type.replace(/_/g, '-');
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Не удалось подобрать id узла');
}

function edge(from: string, fromPort: string, to: string, toPort: string): EdgeDefinition {
  return { id: edgeId(from, fromPort, to, toPort), from, fromPort, to, toPort };
}

function edgeId(from: string, fromPort: string, to: string, toPort: string): string {
  return `${from}:${fromPort}->${to}:${toPort}`;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Минимально необходимое описание DOM-элемента для проверки фокуса ввода. */
export interface FocusableElementLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Элемент, в котором пользователь редактирует текст: input, textarea, select или
 * contenteditable. В таких элементах клавиши Backspace/Delete должны править текст,
 * а не удалять блок схемы (issue #211).
 */
export function isTextEditingElement(element: FocusableElementLike | null | undefined): boolean {
  if (!element) return false;
  const tag = (element.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/**
 * Решает, должно ли нажатие клавиши удалить выбранный блок/ребро схемы.
 *
 * По требованиям issue #211:
 * - Backspace не удаляет блок никогда (часто нажимается при правке текста в свойствах);
 * - Delete удаляет выделение только когда фокус не находится в поле ввода текста.
 */
export function shouldDeleteSchemaSelection(
  key: string,
  activeElement: FocusableElementLike | null | undefined,
): boolean {
  if (key !== 'Delete') return false;
  return !isTextEditingElement(activeElement);
}

/** Минимально необходимые поля события клавиатуры для разбора горячих клавиш. */
export interface ClipboardKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type SchemaClipboardAction = 'copy' | 'cut' | 'paste' | 'duplicate';

/**
 * Разбирает горячую клавишу буфера обмена для редактора схем (issue #230):
 * Ctrl/Cmd+C — копировать, +X — вырезать, +V — вставить, +D — дублировать.
 * В полях ввода текста горячие клавиши не перехватываются, чтобы не мешать
 * обычному копированию/вставке текста в свойствах узла.
 */
export function schemaClipboardAction(
  event: ClipboardKeyEvent,
  activeElement: FocusableElementLike | null | undefined,
): SchemaClipboardAction | null {
  if (isTextEditingElement(activeElement)) return null;
  if (!(event.ctrlKey || event.metaKey)) return null;
  switch (event.key.toLowerCase()) {
    case 'c':
      return 'copy';
    case 'x':
      return 'cut';
    case 'v':
      return 'paste';
    case 'd':
      return 'duplicate';
    default:
      return null;
  }
}
