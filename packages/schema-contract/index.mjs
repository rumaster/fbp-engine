const SCHEMA_TYPES = Object.freeze(['action', 'hint', 'illustration', 'support']);
// Классы суб-схем (issue #310). Суб-схема — самостоятельная сущность со своим
// классом вместо типа схемы: класс задаёт палитру доступных узлов (см.
// SUB_SCHEMA_NODE_POLICY). `game` повторяет политику игровых схем
// (action/hint/illustration), `support` — политику поддержки, `common` — их
// пересечение (разрешено только то, что доступно во всех классах), поэтому общая
// суб-схема применима в любой схеме.
const SUB_SCHEMA_CLASSES = Object.freeze(['game', 'support', 'common']);
const SUB_SCHEMA_CLASS_LABELS = Object.freeze({
  game: 'Игровая',
  support: 'Поддержка',
  common: 'Общая',
});
const NODE_TYPES = Object.freeze([
  'start',
  'end',
  'llm_request',
  'knowledge_query',
  'ontology_query',
  'ontology_anchor_match',
  'ontology_frontier_expand',
  'ontology_budget_select',
  'ontology_context_build',
  'game_memory_read',
  'game_memory_write',
  'manifest',
  'game_state_read',
  'game_state_write',
  'support_history_read',
  'game_history_read',
  'condition',
  'variable_read',
  'variable_write',
  'loop',
  'transform',
  'merge',
  'sub_schema',
  'media_generate',
  'log',
  'constant',
]);
const PORT_TYPES = Object.freeze([
  'exec',
  'string',
  'number',
  'boolean',
  'object',
  'string_array',
  'object_array',
  'expertise',
  'memory',
  'any',
]);

// Режимы ретрива узла ontology_query (issue #334/#375, Graph RAG): `local` —
// обход подграфа от якорей сцены; `global` — map-reduce по сводкам сообществ;
// `hybrid` — оба источника в одном блоке. Начиная с issue #375 режим должен быть
// задан явно через config.mode или вход mode; DEFAULT оставлен только для старых
// UI/миграционных подсказок и не используется как runtime fallback.
const ONTOLOGY_QUERY_MODES = Object.freeze(['local', 'global', 'hybrid']);
const DEFAULT_ONTOLOGY_QUERY_MODE = 'local';
const ONTOLOGY_QUERY_MODE_LABELS = Object.freeze({
  local: 'Локальный (подграф)',
  global: 'Глобальный (сводки сообществ)',
  hybrid: 'Гибрид (подграф + сводки)',
});

const SCHEMA_TABS = Object.freeze([
  Object.freeze({ slug: 'action', schemaType: 'action', label: 'Действие' }),
  Object.freeze({ slug: 'hint', schemaType: 'hint', label: 'Подсказка' }),
  Object.freeze({ slug: 'illustration', schemaType: 'illustration', label: 'Иллюстрация' }),
  Object.freeze({ slug: 'support', schemaType: 'support', label: 'Поддержка' }),
]);

const NODE_TYPE_LABELS = Object.freeze({
  start: 'Start',
  end: 'End',
  llm_request: 'LLM request',
  knowledge_query: 'Knowledge query',
  ontology_query: 'Ontology query',
  ontology_anchor_match: 'Ontology anchor match',
  ontology_frontier_expand: 'Ontology frontier expand',
  ontology_budget_select: 'Ontology budget select',
  ontology_context_build: 'Ontology context build',
  game_memory_read: 'Memory read',
  game_memory_write: 'Memory write',
  manifest: 'Manifest',
  game_state_read: 'State read',
  game_state_write: 'State write',
  support_history_read: 'Support history',
  game_history_read: 'Game history',
  condition: 'Condition',
  variable_read: 'Variable read',
  variable_write: 'Variable write',
  loop: 'Loop',
  transform: 'Transform',
  merge: 'Merge',
  sub_schema: 'Sub-schema',
  media_generate: 'Media generate',
  log: 'Log',
  constant: 'Constant',
});

const BASE_NODE_PALETTE = Object.freeze([
  'llm_request',
  'knowledge_query',
  'ontology_query',
  'ontology_anchor_match',
  'ontology_frontier_expand',
  'ontology_budget_select',
  'ontology_context_build',
  'game_memory_read',
  'game_memory_write',
  'manifest',
  'game_state_read',
  'game_state_write',
  'support_history_read',
  'game_history_read',
  'condition',
  'variable_read',
  'variable_write',
  'loop',
  'transform',
  'merge',
  'sub_schema',
  'media_generate',
  'log',
  'constant',
]);

const PORT_COLORS = Object.freeze({
  exec: '#ffffff',
  string: '#ff6fb1',
  number: '#31c48d',
  boolean: '#ef4444',
  object: '#3b82f6',
  string_array: '#f9a8d4',
  object_array: '#67e8f9',
  expertise: '#f59e0b',
  memory: '#a855f7',
  any: '#9ca3af',
});

// Граничные порты start/end по типу схемы (issue #213). У конечных узлов остаются
// только обозначенные порты; снятые порты раньше дублировали данные, которые теперь
// либо сохраняются внутри схемы, либо подтягиваются к end отдельными data-рёбрами.
//
// Как по факту использовались удалённые порты:
// - action.end.narrative / action.end.state_delta — нарратив и дельта состояния хода.
//   В рабочих схемах нарратив и обновлённое состояние сохраняются внутри схемы блоками
//   game_state_write и не передаются в end (reducer берёт нарратив из ctx.state, если
//   его нет среди выходов end). Поэтому у action.end остаётся только exec.
// - hint.start.state / illustration.start.{state,narrative} — объект состояния игры и
//   нарратив на входе схемы. Сейчас и подсказки, и иллюстрация читают состояние внутри
//   схемы (game_state_read), а не получают его из start, поэтому у start остаётся exec.
// - illustration.end.prompt — текст промпта картинки. Иллюстрация отдаёт наружу только
//   готовый image_url, а промпт остаётся внутренней деталью схемы.
const SCHEMA_PORTS = Object.freeze({
  action: freezeSchemaPorts({
    startOutputs: [port('action', 'string')],
    endInputs: [],
  }),
  hint: freezeSchemaPorts({
    startOutputs: [],
    endInputs: [port('hints', 'string_array')],
  }),
  illustration: freezeSchemaPorts({
    startOutputs: [],
    endInputs: [port('image_url', 'string')],
  }),
  // Поддержка (issue #213, #244): user_query на входе; на выходе reply (ответ
  // клиенту) и решение консультанта escalate/resolved, по которым после графа
  // эскалируется или закрывается обращение. summary — краткое резюме обращения
  // для оператора, его готовит внутренний блок support_compilation.
  // Флаги escalate/resolved объявлены boolean, но узлы-источники отдают их без
  // строгого типа (any) — модель может опустить флаг или вернуть строку, а any
  // совместим с boolean на ребре и не роняет граф.
  support: freezeSchemaPorts({
    startOutputs: [port('user_query', 'string')],
    endInputs: [
      port('reply', 'string'),
      port('escalate', 'boolean'),
      port('resolved', 'boolean'),
      port('summary', 'string'),
    ],
  }),
});

// game_state_read (issue #208): единственный выход state с полным объектом состояния
// игры. Константа задаёт канонический набор выходных портов блока и служит единым
// источником истины как для типизации портов, так и для их построения в редакторе.
const GAME_STATE_READ_OUTPUTS = Object.freeze([Object.freeze(port('state', 'object'))]);

// История переписки (support_history_read) имеет смысл только в схеме support, а
// история ходов игры (game_history_read) — только в игровых схемах (action/hint/
// illustration). Поэтому каждый из узлов истории заблокирован в «чужих» схемах
// (issue #271).
const SCHEMA_NODE_POLICY = Object.freeze({
  action: Object.freeze({ blocked: Object.freeze(['support_history_read']) }),
  hint: Object.freeze({ blocked: Object.freeze(['support_history_read']) }),
  illustration: Object.freeze({ blocked: Object.freeze(['support_history_read']) }),
  support: Object.freeze({ blocked: Object.freeze(['game_state_write', 'game_history_read']) }),
});

// Политика палитры узлов по классу суб-схемы (issue #310). `game` повторяет
// политику игровых схем, `support` — политику поддержки, `common` блокирует
// объединение их blocked-списков (то есть разрешает только пересечение узлов,
// общих для всех классов), поэтому общая суб-схема применима в любой схеме.
const SUB_SCHEMA_NODE_POLICY = Object.freeze({
  game: Object.freeze({ blocked: Object.freeze(['support_history_read']) }),
  support: Object.freeze({ blocked: Object.freeze(['game_state_write', 'game_history_read']) }),
  common: Object.freeze({
    blocked: Object.freeze(['support_history_read', 'game_state_write', 'game_history_read']),
  }),
});

// Data-only узлы — аналог pure-функций UV5 (issue #201): не имеют exec-портов и
// исполняются по требованию, когда их выход кому-то нужен (pull-based). Сюда входят
// блоки чтения/записи памяти, состояния игры, манифеста, переменных, transform и constant.
const DATA_ONLY_NODE_TYPES = Object.freeze([
  'game_memory_read',
  'game_memory_write',
  'manifest',
  'game_state_read',
  'game_state_write',
  'support_history_read',
  'game_history_read',
  'variable_read',
  'variable_write',
  'transform',
  'constant',
]);
const EXEC_PORT_IDS = Object.freeze(['exec', 'true', 'false', 'done', 'next']);

// Блок merge (issue #203) синхронизирует несколько потоков исполнения: у него один
// exec-выход и динамический набор exec-входов exec_1, exec_2, … На новом блоке два
// входа, при подключении к последнему свободному добавляется ещё один, а лишние
// свободные входы убираются — всегда остаётся ровно один свободный вход.
const MERGE_MIN_EXEC_INPUTS = 2;
const MERGE_EXEC_INPUT_PATTERN = /^exec_([1-9][0-9]*)$/;

const VALIDATION_ERROR_MESSAGES = Object.freeze({
  duplicate_node_id: ({ nodeId }) => `Дублирующий id узла: ${nodeId}`,
  node_type_blocked: ({ nodeType, schemaType }) => `Узел ${nodeType} недоступен для схемы ${schemaType}`,
  single_start: () => 'Схема должна содержать ровно один start-узел',
  single_end: () => 'Схема должна содержать ровно один end-узел',
  unknown_edge_from: ({ edgeId, nodeId }) => `Ребро ${edgeId} ссылается на неизвестный узел ${nodeId}`,
  unknown_edge_to: ({ edgeId, nodeId }) => `Ребро ${edgeId} ссылается на неизвестный узел ${nodeId}`,
  mixed_port_kinds: ({ edgeId }) => `Ребро ${edgeId} смешивает exec-порт и data-порт`,
  missing_exec_output: ({ nodeId, portId }) => `У узла ${nodeId} нет exec-выхода ${portId}`,
  missing_exec_input: ({ nodeId, portId }) => `У узла ${nodeId} нет exec-входа ${portId}`,
  incompatible_ports: ({ edgeId, fromNodeId, fromPortId, fromType, toNodeId, toPortId, toType }) =>
    `Несовместимые порты в ребре ${edgeId}: ${fromNodeId}.${fromPortId} (${fromType}) -> ${toNodeId}.${toPortId} (${toType})`,
  duplicate_data_input: ({ nodeId, portId }) => `input-порт ${nodeId}.${portId} уже подключён`,
  invalid_loop_limits: ({ nodeId }) => `loop-узлу ${nodeId} нужен maxIterations от 1 до 100`,
  invalid_llm_ports_shape: ({ nodeId, key }) => `llm_request-узлу ${nodeId} нужен массив config.${key}`,
  invalid_llm_port_name: ({ nodeId, key }) => `llm_request-узел ${nodeId} содержит порт config.${key} без name`,
  invalid_llm_port_type: ({ nodeId, portType }) =>
    `llm_request-узел ${nodeId} содержит неизвестный тип порта ${portType}`,
  invalid_transform_ports_shape: ({ nodeId, key }) => `transform-узлу ${nodeId} нужен массив config.${key}`,
  invalid_transform_port_name: ({ nodeId, key }) => `transform-узел ${nodeId} содержит порт config.${key} без name`,
  invalid_transform_port_type: ({ nodeId, portType }) =>
    `transform-узел ${nodeId} содержит неизвестный тип порта ${portType}`,
  invalid_variable_ports_shape: ({ nodeId, key }) => `variable-узлу ${nodeId} нужен массив config.${key}`,
  invalid_variable_port_name: ({ nodeId, key }) => `variable-узел ${nodeId} содержит порт config.${key} без имени переменной`,
  invalid_variable_port_type: ({ nodeId, portType }) =>
    `variable-узел ${nodeId} содержит неизвестный тип порта ${portType}`,
  duplicate_variable_port: ({ nodeId, name }) =>
    `variable-узел ${nodeId} содержит повторяющееся имя переменной ${name}`,
  invalid_constant_ports_shape: ({ nodeId }) => `constant-узлу ${nodeId} нужен массив config.outputs`,
  invalid_constant_port_name: ({ nodeId }) => `constant-узел ${nodeId} содержит порт без имени`,
  invalid_constant_port_type: ({ nodeId, portType }) =>
    `constant-узел ${nodeId} содержит неизвестный тип порта ${portType}`,
  duplicate_constant_port: ({ nodeId, name }) =>
    `constant-узел ${nodeId} содержит повторяющееся имя порта ${name}`,
  exec_cycle: ({ nodeId }) => `Exec-граф содержит цикл около узла ${nodeId}`,
  invalid_sub_schema_class: ({ subSchemaClass }) =>
    `Недопустимый класс суб-схемы: ${subSchemaClass}`,
  invalid_boundary_port_id: ({ nodeId, portId }) =>
    `Граничный порт ${nodeId}.${portId} имеет недопустимый id (нужен ^[A-Za-z0-9_]{1,40}$)`,
  invalid_boundary_port_type: ({ nodeId, portType }) =>
    `Граничный порт узла ${nodeId} имеет недопустимый тип ${portType}`,
  duplicate_boundary_port: ({ nodeId, portId }) =>
    `Граничный порт ${nodeId}.${portId} объявлен повторно`,
  invalid_ontology_mode: ({ nodeId, mode }) =>
    `ontology_query-узлу ${nodeId} нужен config.mode из набора local|global|hybrid (получено: ${mode})`,
  missing_ontology_mode: ({ nodeId }) =>
    `ontology_query-узлу ${nodeId} нужен явный mode через вход mode или config.mode`,
  missing_ontology_body_graph: ({ nodeId }) =>
    `ontology_query-узлу ${nodeId} нужен config.bodyGraph`,
  invalid_ontology_body_graph: ({ nodeId }) =>
    `ontology_query-узел ${nodeId} содержит некорректный config.bodyGraph`,
  missing_ontology_graph_source: ({ nodeId }) =>
    `ontology_query-узлу ${nodeId} нужен вход graph или graphScope`,
  missing_ontology_anchor_source: ({ nodeId }) =>
    `ontology_query-узлу ${nodeId} нужен вход query или anchors`,
  missing_ontology_options: ({ nodeId }) =>
    `ontology_query-узлу ${nodeId} нужны traversal options через вход options или config.options`,
});

class SchemaContractError extends Error {
  constructor(code, details = {}) {
    super(formatSchemaContractError(code, details));
    this.name = 'SchemaContractError';
    this.code = code;
    this.details = details;
  }
}

function formatSchemaContractError(code, details = {}) {
  const format = VALIDATION_ERROR_MESSAGES[code];
  return format ? format(details) : `Некорректный граф схемы: ${code}`;
}

function freezeSchemaPorts(value) {
  return Object.freeze({
    startOutputs: Object.freeze(value.startOutputs.map((item) => Object.freeze(item))),
    endInputs: Object.freeze(value.endInputs.map((item) => Object.freeze(item))),
  });
}

function port(id, type, label = id) {
  return { id, label, type };
}

function schemaTypeLabel(type) {
  const tab = SCHEMA_TABS.find((item) => item.schemaType === type);
  return tab ? tab.label : String(type);
}

function isSchemaType(value) {
  return typeof value === 'string' && SCHEMA_TYPES.includes(value);
}

function isNodeType(value) {
  return typeof value === 'string' && NODE_TYPES.includes(value);
}

function isPortType(value) {
  return typeof value === 'string' && PORT_TYPES.includes(value);
}

function isOntologyQueryMode(value) {
  return typeof value === 'string' && ONTOLOGY_QUERY_MODES.includes(value);
}

// Строго читает режим ontology_query: неизвестное или отсутствующее значение не
// нормализуется в local, потому что issue #375 убирает runtime fallback.
function ontologyQueryMode(value) {
  return isOntologyQueryMode(value) ? value : null;
}

function isSubSchemaClass(value) {
  return typeof value === 'string' && SUB_SCHEMA_CLASSES.includes(value);
}

// Граничный порт суб-схемы не может быть exec-портом: start/end суб-схемы
// обмениваются только данными (issue #310).
function isBoundaryPortType(value) {
  return isPortType(value) && value !== 'exec';
}

// Граф является суб-схемой ⟺ задан корректный subSchemaClass (issue #310).
function isSubSchemaGraph(graph) {
  return isRecord(graph) && isSubSchemaClass(graph.subSchemaClass);
}

function subSchemaClassLabel(subClass) {
  return SUB_SCHEMA_CLASS_LABELS[subClass] || String(subClass);
}

// Класс политики палитры графа: для суб-схемы — её класс, для пайплайна — тип
// схемы. Обе ветви обслуживает isNodeTypeAllowedInSchema/getNodePaletteForSchema.
function graphPaletteKind(graph) {
  return isSubSchemaGraph(graph) ? graph.subSchemaClass : graph && graph.schemaType;
}

// «Домен» вида графа (issue #310): игровой (action/hint/illustration/класс game),
// поддержки (схема support/класс support) или общий (класс common). Домен решает,
// какие суб-схемы можно вызвать из данного контекста.
function paletteKindDomain(kind) {
  if (kind === 'common') return 'common';
  if (kind === 'support') return 'support';
  if (kind === 'game' || kind === 'action' || kind === 'hint' || kind === 'illustration') {
    return 'game';
  }
  return null;
}

// Можно ли сослаться на суб-схему класса subSchemaClass из контекста callerKind
// (issue #310): common — отовсюду; game/support — только из своего домена. Так
// общая суб-схема остаётся универсальной, а игровая/поддержки не протекает в
// чужой контекст.
function isSubSchemaUsableIn(subSchemaClass, callerKind) {
  if (!isSubSchemaClass(subSchemaClass)) return false;
  if (subSchemaClass === 'common') return true;
  return paletteKindDomain(callerKind) === subSchemaClass;
}

function isExecPortId(portId) {
  return EXEC_PORT_IDS.includes(portId) || isMergeExecInputId(portId);
}

function isMergeExecInputId(portId) {
  return typeof portId === 'string' && MERGE_EXEC_INPUT_PATTERN.test(portId);
}

function mergeExecInputIndex(portId) {
  const match = typeof portId === 'string' ? portId.match(MERGE_EXEC_INPUT_PATTERN) : null;
  return match ? Number(match[1]) : 0;
}

// Список exec-входов блока merge по текущим связям графа: непрерывный набор
// exec_1..exec_N, где N — это (максимальный подключённый индекс + 1), но не меньше
// MERGE_MIN_EXEC_INPUTS. Так гарантируется хотя бы один свободный вход в конце.
function mergeExecInputPortIds(node, graph) {
  let maxConnected = 0;
  if (graph && Array.isArray(graph.edges)) {
    for (const edge of graph.edges) {
      if (edge.to !== node.id) continue;
      const index = mergeExecInputIndex(edge.toPort);
      if (index > maxConnected) maxConnected = index;
    }
  }
  const count = Math.max(MERGE_MIN_EXEC_INPUTS, maxConnected + 1);
  const ids = [];
  for (let index = 1; index <= count; index += 1) ids.push(`exec_${index}`);
  return ids;
}

function portColor(type) {
  return PORT_COLORS[type] || PORT_COLORS.any;
}

function arePortTypesCompatible(fromType, toType) {
  if (fromType === 'exec' || toType === 'exec') return fromType === 'exec' && toType === 'exec';
  return fromType === toType || fromType === 'any' || toType === 'any';
}

function schemaStartPorts(schemaType) {
  return schemaPorts(schemaType).startOutputs.map((item) => ({ ...item }));
}

function schemaEndPorts(schemaType) {
  return schemaPorts(schemaType).endInputs.map((item) => ({ ...item }));
}

function schemaStartPortType(schemaType, portId) {
  var _a;
  return ((_a = schemaPorts(schemaType).startOutputs.find((item) => item.id === portId)) === null || _a === void 0 ? void 0 : _a.type) || null;
}

function schemaEndPortType(schemaType, portId) {
  var _a;
  return ((_a = schemaPorts(schemaType).endInputs.find((item) => item.id === portId)) === null || _a === void 0 ? void 0 : _a.type) || null;
}

function schemaPorts(schemaType) {
  return SCHEMA_PORTS[schemaType] || { startOutputs: [], endInputs: [] };
}

// Нормализует список настраиваемых граничных портов суб-схемы из конфига узла
// start/end (issue #310). Порт = { id, label, type }: id валиден по
// BOUNDARY_PORT_ID_PATTERN, type — любой PORT_TYPES, кроме exec; дубликаты id и
// некорректные записи отбрасываются (строгая проверка — в валидации контракта).
const BOUNDARY_PORT_ID_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

function boundaryPortRows(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  const seen = new Set();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!BOUNDARY_PORT_ID_PATTERN.test(id) || seen.has(id)) continue;
    if (!isBoundaryPortType(item.type)) continue;
    seen.add(id);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label : id;
    rows.push({ id, label, type: item.type });
  }
  return rows;
}

// Граничные порты конкретного узла start/end суб-схемы (issue #310): для start —
// config.outputs (что суб-схема получает на вход), для end — config.inputs (что
// отдаёт наружу).
function nodeBoundaryPorts(node, which) {
  if (!node) return [];
  const key = which === 'start' ? 'outputs' : 'inputs';
  return boundaryPortRows(node.config && node.config[key]);
}

// Граничные порты start/end графа: для суб-схемы — из конфига её узлов start/end,
// для пайплайн-схемы — фиксированы из SCHEMA_PORTS по типу (issue #213, #310).
function boundaryStartPorts(graph) {
  if (isSubSchemaGraph(graph)) {
    const start = (graph.nodes || []).find((node) => node.type === 'start');
    return nodeBoundaryPorts(start, 'start');
  }
  return schemaStartPorts(graph && graph.schemaType);
}

function boundaryEndPorts(graph) {
  if (isSubSchemaGraph(graph)) {
    const end = (graph.nodes || []).find((node) => node.type === 'end');
    return nodeBoundaryPorts(end, 'end');
  }
  return schemaEndPorts(graph && graph.schemaType);
}

// Порты узла sub_schema (issue #310): входы — граничные start-порты выбранной
// суб-схемы (то, что узел подаёт ей на вход), выходы — граничные end-порты (её
// результат). Источник: инлайн-граф (config.graph) приоритетнее снимка
// config.ports, который редактор кэширует при выборе slug (контракт не резолвит
// slug сам). Пустой результат восстанавливается динамически по рёбрам.
function subSchemaNodePorts(node) {
  const inlineGraph = node && node.config && node.config.graph;
  if (isSubSchemaGraph(inlineGraph)) {
    return { inputs: boundaryStartPorts(inlineGraph), outputs: boundaryEndPorts(inlineGraph) };
  }
  const ports = node && node.config && node.config.ports;
  return {
    inputs: boundaryPortRows(ports && ports.inputs),
    outputs: boundaryPortRows(ports && ports.outputs),
  };
}

// Политика палитры узлов по «виду» графа: SchemaType (пайплайн-схема) или
// SubSchemaClass (суб-схема, issue #310). Для класса политика берётся из
// SUB_SCHEMA_NODE_POLICY, для типа — из SCHEMA_NODE_POLICY.
function nodePolicyFor(kind) {
  if (isSubSchemaClass(kind)) return SUB_SCHEMA_NODE_POLICY[kind];
  if (isSchemaType(kind)) return SCHEMA_NODE_POLICY[kind];
  return null;
}

function isNodeTypeAllowedInSchema(kind, nodeType) {
  if (nodeType === 'start' || nodeType === 'end') return true;
  if (!isNodeType(nodeType)) return false;
  const policy = nodePolicyFor(kind);
  if (!policy) return false;
  return !policy.blocked.includes(nodeType);
}

function getNodePaletteForSchema(kind) {
  return BASE_NODE_PALETTE.filter((nodeType) => isNodeTypeAllowedInSchema(kind, nodeType));
}

function isDataOnlyNodeType(type) {
  return DATA_ONLY_NODE_TYPES.includes(type);
}

// game_state_write/variable_write (issue #208) — побочные эффекты без выходов: они
// исполняются в exec-потоке, поэтому получают exec-порты, несмотря на присутствие в
// DATA_ONLY_NODE_TYPES.
function isExecSideEffectNode(nodeOrType) {
  const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType.type;
  return type === 'game_state_write' || type === 'variable_write';
}

function execInputPortIds(nodeOrType, graph) {
  const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType.type;
  if (isExecSideEffectNode(nodeOrType)) return ['exec'];
  if (type === 'start' || isDataOnlyNodeType(type)) return [];
  if (type === 'merge') {
    return typeof nodeOrType === 'string'
      ? mergeExecInputPortIds({ id: undefined }, undefined)
      : mergeExecInputPortIds(nodeOrType, graph);
  }
  return ['exec'];
}

function execOutputPortIds(nodeOrType) {
  const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType.type;
  if (isExecSideEffectNode(nodeOrType)) return ['exec'];
  if (type === 'end' || isDataOnlyNodeType(type)) return [];
  if (type === 'condition') return ['true', 'false'];
  return type === 'loop' ? ['exec', 'done'] : ['exec'];
}

function getNodeOutputPortType(graph, node, portId) {
  if (node.type === 'start') {
    const found = boundaryStartPorts(graph).find((item) => item.id === portId);
    return found ? found.type : 'any';
  }
  // sub_schema (issue #310): выходы узла = end-порты выбранной суб-схемы.
  if (node.type === 'sub_schema') {
    const found = subSchemaNodePorts(node).outputs.find((item) => item.id === portId);
    return found ? found.type : 'any';
  }
  if (node.type === 'llm_request') {
    if (portId === 'raw') return 'string';
    return llmPortType(node.config && node.config.outputs, portId);
  }
  if (node.type === 'knowledge_query') return portId === 'expertise' ? 'expertise' : portId === 'documents' ? 'object_array' : 'any';
  // ontology_query (issue #323/#334): expertise — сериализованный локальный подграф;
  // graph_context — блок по режиму mode (локальный/глобальный/гибрид) для нового
  // плейсхолдера {{graph_context}}; subgraph — структурный результат обхода для аудита.
  if (node.type === 'ontology_query') {
    if (portId === 'expertise' || portId === 'graph_context') return 'expertise';
    if (portId === 'subgraph' || portId === 'trace') return 'object';
    return 'any';
  }
  if (node.type === 'ontology_anchor_match') {
    if (portId === 'anchorSlugs') return 'string_array';
    if (portId === 'trace') return 'object';
    return 'any';
  }
  if (node.type === 'ontology_frontier_expand') {
    if (portId === 'subgraph' || portId === 'trace') return 'object';
    return 'any';
  }
  if (node.type === 'ontology_budget_select') {
    if (portId === 'subgraph' || portId === 'trace') return 'object';
    return 'any';
  }
  if (node.type === 'ontology_context_build') {
    if (portId === 'expertise' || portId === 'graph_context') return 'expertise';
    if (portId === 'trace') return 'object';
    return 'any';
  }
  if (node.type === 'game_memory_read') return portId === 'memory' ? 'memory' : 'any';
  if (node.type === 'game_memory_write') return portId === 'added' ? 'object_array' : portId === 'memoryUpdate' ? 'object' : 'any';
  if (node.type === 'manifest') return portId === 'manifest' ? 'object' : 'any';
  // game_state_read (issue #208): единственный выход state с полным объектом состояния.
  if (node.type === 'game_state_read') {
    const predefined = GAME_STATE_READ_OUTPUTS.find((item) => item.id === portId);
    return predefined ? predefined.type : 'any';
  }
  if (node.type === 'game_state_write') return portId === 'state' ? 'object' : 'any';
  // support_history_read / game_history_read (issue #271): единственный выход
  // messages — массив реплик {role, message}.
  if (node.type === 'support_history_read' || node.type === 'game_history_read') {
    return portId === 'messages' ? 'object_array' : 'any';
  }
  if (node.type === 'condition') return portId === 'condition' ? 'boolean' : 'any';
  if (node.type === 'media_generate') return portId === 'image_url' ? 'string' : 'any';
  if (node.type === 'transform') return llmPortType(node.config && node.config.outputs, portId);
  // variable_read (issue #208): множество именованных выходов, тип берётся из config.outputs.
  if (node.type === 'variable_read') return llmPortType(variablePortRows(node, 'outputs'), portId);
  return 'any';
}

function getNodeInputPortType(graph, node, portId) {
  if (node.type === 'end') {
    const found = boundaryEndPorts(graph).find((item) => item.id === portId);
    return found ? found.type : 'any';
  }
  // sub_schema (issue #310): входы узла = start-порты выбранной суб-схемы.
  if (node.type === 'sub_schema') {
    const found = subSchemaNodePorts(node).inputs.find((item) => item.id === portId);
    return found ? found.type : 'any';
  }
  if (node.type === 'llm_request') return llmPortType(node.config && node.config.inputs, portId);
  if (node.type === 'knowledge_query' && (portId === 'keys' || portId === 'tags')) return 'string_array';
  // ontology_query (issue #323): необязательные явные якоря (slug/имена концептов).
  if (node.type === 'ontology_query' && portId === 'anchors') return 'string_array';
  // ontology_query (issue #361): контекстно-независимый текстовый вход привязки.
  if (node.type === 'ontology_query' && portId === 'query') return 'string';
  // ontology_query (issue #375): строгий graph retriever получает источник графа,
  // контекст условий, traversal budgets и mode явно через входы или config.
  if (node.type === 'ontology_query' && portId === 'graphScope') return 'object';
  if (node.type === 'ontology_query' && portId === 'graph') return 'object';
  if (node.type === 'ontology_query' && portId === 'traversalContext') return 'object';
  if (node.type === 'ontology_query' && portId === 'options') return 'object';
  if (node.type === 'ontology_query' && portId === 'mode') return 'string';
  if (node.type === 'ontology_anchor_match') {
    if (portId === 'graph') return 'object';
    if (portId === 'query') return 'string';
    if (portId === 'anchors') return 'string_array';
  }
  if (node.type === 'ontology_frontier_expand') {
    if (portId === 'graph') return 'object';
    if (portId === 'anchorSlugs') return 'string_array';
    if (portId === 'traversalContext') return 'object';
    if (portId === 'options') return 'object';
  }
  if (node.type === 'ontology_budget_select') {
    if (portId === 'subgraph') return 'object';
    if (portId === 'options') return 'object';
    if (portId === 'trace') return 'object';
  }
  if (node.type === 'ontology_context_build') {
    if (portId === 'subgraph') return 'object';
    if (portId === 'communities') return 'object_array';
    if (portId === 'mode') return 'string';
    if (portId === 'trace') return 'object';
  }
  if (node.type === 'game_memory_write') {
    if (portId === 'enabled') return 'boolean';
    if (portId === 'narrative') return 'string';
  }
  if (node.type === 'game_state_write') {
    // game_state_write (issue #208): канонический вход state — объект состояния.
    if (portId === 'state') return 'object';
  }
  if (node.type === 'transform') return llmPortType(node.config && node.config.inputs, portId);
  // variable_write (issue #208): множество именованных входов, тип берётся из config.inputs.
  if (node.type === 'variable_write') return llmPortType(variablePortRows(node, 'inputs'), portId);
  // media_generate (issue #225): настраиваемые входы как у llm_request — тип берётся из config.inputs.
  if (node.type === 'media_generate') return llmPortType(node.config && node.config.inputs, portId);
  return 'any';
}

function getNodePortDefinitions(node, graph) {
  const inputs = new Map();
  const outputs = new Map();
  const addInput = (id, type, label = id) => {
    if (!inputs.has(id)) inputs.set(id, { id, label, type, direction: 'input' });
  };
  const addOutput = (id, type, label = id) => {
    if (!outputs.has(id)) outputs.set(id, { id, label, type, direction: 'output' });
  };

  for (const id of execInputPortIds(node, graph)) addInput(id, 'exec', id);
  for (const id of execOutputPortIds(node)) addOutput(id, 'exec', id);

  addBaseDataPorts(node, graph, addInput, addOutput);
  addDynamicPortsFromGraph(node, graph, addInput, addOutput);

  return { inputs: [...inputs.values()], outputs: [...outputs.values()] };
}

function addBaseDataPorts(node, graph, addInput, addOutput) {
  if (node.type === 'start') {
    // У start остаются только обозначенные граничные порты (issue #213). Для пайплайн-
    // схемы они фиксированы по типу, для суб-схемы — настраиваются в config.outputs
    // самого узла start (issue #310). Прежние универсальные выходы inputs/value убраны;
    // уже подключённые в существующих схемах порты восстанавливаются как динамические
    // по рёбрам ниже.
    for (const item of boundaryStartPorts(graph)) addOutput(item.id, item.type, item.label);
    return;
  }
  if (node.type === 'end') {
    // У end остаются только обозначенные граничные порты (issue #213). Для пайплайн-схемы
    // они фиксированы по типу, для суб-схемы — настраиваются в config.inputs узла end
    // (issue #310). Прежний универсальный вход result убран; уже подключённые порты
    // восстанавливаются как динамические по рёбрам ниже.
    for (const item of boundaryEndPorts(graph)) addInput(item.id, item.type, item.label);
    return;
  }
  if (node.type === 'llm_request') {
    for (const input of portRows(node.config && node.config.inputs)) addInput(input.name, input.type, input.name);
    addOutput('raw', 'string', 'raw');
    for (const output of portRows(node.config && node.config.outputs)) addOutput(output.name, output.type, output.name);
    return;
  }
  if (node.type === 'knowledge_query') {
    addInput('keys', 'string_array', 'keys');
    // Тэги (issue #321): необязательный вход — фильтр области поиска по тэгам документов.
    addInput('tags', 'string_array', 'tags');
    addOutput('expertise', 'expertise', 'expertise');
    addOutput('documents', 'object_array', 'documents');
    return;
  }
  // ontology_query (issue #323): альтернатива knowledge_query — вместо векторного
  // поиска по абзацам обходит граф концептов от якорей. Выход expertise того же типа,
  // что у knowledge_query, поэтому узел нарратива принимает результат без изменений.
  if (node.type === 'ontology_query') {
    // query/anchors (issue #361/#375): контекстно-независимые источники привязки.
    // Хотя бы один из них должен быть подключён явно; runtime больше не выводит
    // текст из игрового ctx.inputs/ctx.state.
    addInput('query', 'string', 'query');
    addInput('anchors', 'string_array', 'anchors');
    addInput('graphScope', 'object', 'graphScope');
    addInput('graph', 'object', 'graph');
    addInput('traversalContext', 'object', 'traversalContext');
    addInput('options', 'object', 'options');
    addInput('mode', 'string', 'mode');
    addOutput('expertise', 'expertise', 'expertise');
    // graph_context (issue #334): блок по режиму config.mode — локальный подграф,
    // глобальные сводки сообществ или их гибрид. Тип expertise, как у expertise/
    // knowledge_query, поэтому подключается к узлу нарратива без изменений.
    addOutput('graph_context', 'expertise', 'graph_context');
    addOutput('subgraph', 'object', 'subgraph');
    addOutput('trace', 'object', 'trace');
    return;
  }
  if (node.type === 'ontology_anchor_match') {
    addInput('graph', 'object', 'graph');
    addInput('query', 'string', 'query');
    addInput('anchors', 'string_array', 'anchors');
    addOutput('anchorSlugs', 'string_array', 'anchorSlugs');
    addOutput('trace', 'object', 'trace');
    return;
  }
  if (node.type === 'ontology_frontier_expand') {
    addInput('graph', 'object', 'graph');
    addInput('anchorSlugs', 'string_array', 'anchorSlugs');
    addInput('traversalContext', 'object', 'traversalContext');
    addInput('options', 'object', 'options');
    addOutput('subgraph', 'object', 'subgraph');
    addOutput('trace', 'object', 'trace');
    return;
  }
  if (node.type === 'ontology_budget_select') {
    addInput('subgraph', 'object', 'subgraph');
    addInput('options', 'object', 'options');
    addInput('trace', 'object', 'trace');
    addOutput('subgraph', 'object', 'subgraph');
    addOutput('trace', 'object', 'trace');
    return;
  }
  if (node.type === 'ontology_context_build') {
    addInput('subgraph', 'object', 'subgraph');
    addInput('communities', 'object_array', 'communities');
    addInput('mode', 'string', 'mode');
    addInput('trace', 'object', 'trace');
    addOutput('expertise', 'expertise', 'expertise');
    addOutput('graph_context', 'expertise', 'graph_context');
    addOutput('trace', 'object', 'trace');
    return;
  }
  if (node.type === 'game_memory_read') {
    addOutput('memory', 'memory', 'memory');
    return;
  }
  if (node.type === 'game_memory_write') {
    addInput('narrative', 'string', 'narrative');
    addInput('enabled', 'boolean', 'enabled');
    addOutput('added', 'object_array', 'added');
    addOutput('memoryUpdate', 'object', 'memoryUpdate');
    return;
  }
  if (node.type === 'manifest') {
    addOutput('manifest', 'object', 'manifest');
    for (const field of stringArray(node.config && node.config.fields)) addOutput(field, 'any', field);
    return;
  }
  if (node.type === 'game_state_read') {
    // game_state_read (issue #208): единственный выход state с объектом состояния игры.
    for (const item of GAME_STATE_READ_OUTPUTS) addOutput(item.id, item.type, item.label);
    return;
  }
  if (node.type === 'game_state_write') {
    // game_state_write (issue #208): единственный вход state, блок мержит переданный
    // объект с текущим состоянием и не имеет выходов.
    addInput('state', 'object', 'state');
    return;
  }
  if (node.type === 'support_history_read' || node.type === 'game_history_read') {
    // support_history_read / game_history_read (issue #271): pull-источник без входов,
    // единственный выход messages — массив реплик {role, message} в хронологическом
    // порядке. Для поддержки role ∈ {bot, operator, user}, для игры — {master, player};
    // в обоих случаях зарезервирована роль будущего агента-пересказчика (см.
    // docs/role-chronicler.md).
    addOutput('messages', 'object_array', 'messages');
    return;
  }
  if (node.type === 'condition') {
    addInput('value', 'any', 'value');
    addInput('right', 'any', 'right');
    addOutput('condition', 'boolean', 'condition');
    return;
  }
  if (node.type === 'variable_read') {
    // variable_read (issue #208): множество именованных выходов, имя порта = имени
    // переменной. Входов нет. config.outputs хранит порты (issue #232: legacy config.name убран).
    for (const output of variablePortRows(node, 'outputs')) addOutput(output.name, output.type, output.name);
    return;
  }
  if (node.type === 'variable_write') {
    // variable_write (issue #208): множество именованных входов, имя порта = имени
    // переменной. Выходов нет. config.inputs хранит порты (issue #232: legacy config.name убран).
    for (const input of variablePortRows(node, 'inputs')) addInput(input.name, input.type, input.name);
    return;
  }
  if (node.type === 'transform') {
    // transform (issue #204): именованные входы любого типа (как у llm_request) и
    // настраиваемые выходы с путём. По умолчанию — один выход result типа any.
    for (const input of portRows(node.config && node.config.inputs)) addInput(input.name, input.type, input.name);
    const outputs = portRows(node.config && node.config.outputs);
    if (outputs.length === 0) {
      const name = asString(node.config && node.config.output) || 'result';
      addOutput(name, 'any', name);
    } else {
      for (const output of outputs) addOutput(output.name, output.type, output.name);
    }
    return;
  }
  if (node.type === 'merge') {
    // merge — чистый exec-синхронизатор (issue #203): только динамические exec-входы
    // и один exec-выход, добавленные общим циклом выше. Data-портов у блока нет.
    return;
  }
  if (node.type === 'loop') {
    addInput('value', 'any', 'value');
    addOutput('value', 'any', 'value');
    return;
  }
  if (node.type === 'sub_schema') {
    // sub_schema (issue #310): порты узла повторяют граничные порты выбранной суб-схемы —
    // входы соответствуют её start-портам, выходы её end-портам. Жёстко зашитые value/value
    // убраны. Если порты ещё не известны (slug не выбран), узел остаётся без data-портов, а
    // фактически подключённые восстанавливаются динамически по рёбрам ниже.
    const ports = subSchemaNodePorts(node);
    for (const input of ports.inputs) addInput(input.id, input.type, input.label);
    for (const output of ports.outputs) addOutput(output.id, output.type, output.label);
    return;
  }
  if (node.type === 'media_generate') {
    // media_generate (issue #225): настраиваемые входы как у llm_request (config.inputs);
    // предопределённые narrative/state убраны. Единственный выход — image_url с готовой
    // ссылкой на иллюстрацию.
    for (const input of portRows(node.config && node.config.inputs)) addInput(input.name, input.type, input.name);
    addOutput('image_url', 'string', 'image_url');
    return;
  }
  if (node.type === 'log') {
    addInput('value', 'any', 'value');
    addOutput('value', 'any', 'value');
    return;
  }
  if (node.type === 'constant') {
    // constant (issue #319): набор именованных выходов с фиксированными значениями.
    // Каждый выход хранится в config.outputs как { name, type, value }. Входов нет.
    for (const output of constantPortRows(node)) addOutput(output.name, output.type, output.name);
  }
}

function addDynamicPortsFromGraph(node, graph, addInput, addOutput) {
  if (!graph || !Array.isArray(graph.edges)) return;
  for (const edge of graph.edges) {
    if (edge.from === node.id) {
      if (isExecPortId(edge.fromPort) && !execOutputPortIds(node).includes(edge.fromPort)) continue;
      addOutput(edge.fromPort, isExecPortId(edge.fromPort) ? 'exec' : 'any', edge.fromPort);
    }
    if (edge.to === node.id) {
      if (isExecPortId(edge.toPort) && !execInputPortIds(node, graph).includes(edge.toPort)) continue;
      addInput(edge.toPort, isExecPortId(edge.toPort) ? 'exec' : 'any', edge.toPort);
    }
  }
}

function portRows(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) continue;
    rows.push({ name: item.name.trim(), type: isPortType(item.type) ? item.type : 'any' });
  }
  return rows;
}

function llmPortType(value, portId) {
  for (const row of portRows(value)) {
    if (row.name === portId) return row.type;
  }
  return 'any';
}

// Типы портов, допустимые для блока constant (issue #319). Только конкретные data-типы
// (без exec/expertise/memory/any) — значение должно быть статически типизировано.
const CONSTANT_PORT_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'string_array', 'object_array']);

// Порты блока constant (issue #319): берутся из config.outputs как [{ name, type, value }].
// Пустая конфигурация даёт один порт value типа string.
function constantPortRows(node) {
  const config = node && node.config;
  const rows = [];
  if (Array.isArray(config && config.outputs)) {
    for (const item of config.outputs) {
      if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) continue;
      const type = CONSTANT_PORT_TYPES.includes(item.type) ? item.type : 'string';
      rows.push({ name: item.name.trim(), type });
    }
  }
  if (rows.length > 0) return rows;
  return [{ name: 'value', type: 'string' }];
}

// Порты блоков variable_read/variable_write (issue #208): берутся из config.outputs /
// config.inputs. Пустая конфигурация даёт один порт value, чтобы блок не оставался без
// портов. Legacy config.name больше не поддерживается (issue #232).
function variablePortRows(node, key) {
  const config = node && node.config;
  const rows = portRows(config && config[key]);
  if (rows.length > 0) return rows;
  return [{ name: 'value', type: 'any' }];
}

function validateSchemaGraphContract(graph) {
  // Граф — либо пайплайн-схема (schemaType), либо суб-схема (subSchemaClass), но не оба
  // сразу (issue #310). Палитра узлов выбирается по «виду» через graphPaletteKind.
  const isSub = isSubSchemaGraph(graph);
  if (isSub && graph.schemaType !== undefined) {
    throw contractError('invalid_sub_schema_class', { reason: 'schema_type_present' });
  }
  if (!isSub && graph.subSchemaClass !== undefined && !isSubSchemaClass(graph.subSchemaClass)) {
    throw contractError('invalid_sub_schema_class', { subSchemaClass: String(graph.subSchemaClass) });
  }
  const paletteKind = graphPaletteKind(graph);

  const ids = new Set();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) throw contractError('duplicate_node_id', { nodeId: node.id });
    ids.add(node.id);
    if (!isNodeTypeAllowedInSchema(paletteKind, node.type)) {
      throw contractError('node_type_blocked', { schemaType: paletteKind, nodeType: node.type });
    }
    // Граничные порты суб-схемы (issue #310): для start — config.outputs, для end —
    // config.inputs. Строгая проверка id/типа/дубликатов (нормализация в boundaryPortRows
    // молча отбрасывает плохие записи, здесь же это ошибка контракта).
    if (isSub && node.type === 'start') validateBoundaryPorts(node, 'outputs');
    if (isSub && node.type === 'end') validateBoundaryPorts(node, 'inputs');
    validateNodeConfig(node);
  }

  const starts = graph.nodes.filter((node) => node.type === 'start');
  const ends = graph.nodes.filter((node) => node.type === 'end');
  if (starts.length !== 1) throw contractError('single_start');
  if (ends.length !== 1) throw contractError('single_end');

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const occupiedDataInputs = new Set();
  for (const edge of graph.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from) throw contractError('unknown_edge_from', { edgeId: edge.id, nodeId: edge.from });
    if (!to) throw contractError('unknown_edge_to', { edgeId: edge.id, nodeId: edge.to });
    validateEdgePorts(graph, edge, from, to);
    if (!isExecPortId(edge.fromPort)) {
      const key = `${edge.to}:${edge.toPort}`;
      if (occupiedDataInputs.has(key)) {
        throw contractError('duplicate_data_input', { nodeId: edge.to, portId: edge.toPort });
      }
      occupiedDataInputs.add(key);
    }
  }
  for (const node of graph.nodes) {
    if (node.type === 'ontology_query') validateOntologyQueryNode(graph, node);
  }
  assertNoExecCycles(graph, nodeById);
}

function hasIncomingDataEdge(graph, nodeId, portId) {
  return graph.edges.some(
    (edge) => edge.to === nodeId && edge.toPort === portId && !isExecPortId(edge.fromPort),
  );
}

function hasAnyIncomingDataEdge(graph, nodeId, portIds) {
  return portIds.some((portId) => hasIncomingDataEdge(graph, nodeId, portId));
}

function validateOntologyQueryNode(graph, node) {
  const config = isRecord(node.config) ? node.config : {};
  if (!isSchemaGraphShape(config.bodyGraph)) {
    throw contractError('missing_ontology_body_graph', { nodeId: node.id });
  }
  if (!isOntologyQueryMode(config.mode) && !hasIncomingDataEdge(graph, node.id, 'mode')) {
    throw contractError('missing_ontology_mode', { nodeId: node.id });
  }
  if (!isRecord(config.options) && !hasIncomingDataEdge(graph, node.id, 'options')) {
    throw contractError('missing_ontology_options', { nodeId: node.id });
  }
  if (
    !isRecord(config.graphScope) &&
    !isRecord(config.graph) &&
    !hasAnyIncomingDataEdge(graph, node.id, ['graphScope', 'graph'])
  ) {
    throw contractError('missing_ontology_graph_source', { nodeId: node.id });
  }
  const configAnchors =
    typeof config.query === 'string' && config.query.trim().length > 0
      ? true
      : Array.isArray(config.anchors) && config.anchors.length > 0;
  if (!configAnchors && !hasAnyIncomingDataEdge(graph, node.id, ['query', 'anchors'])) {
    throw contractError('missing_ontology_anchor_source', { nodeId: node.id });
  }
}

function validateNodeConfig(node) {
  const config = isRecord(node.config) ? node.config : {};
  if (node.type === 'loop') {
    const maxIterations = config.maxIterations;
    if (!Number.isSafeInteger(maxIterations) || Number(maxIterations) < 1 || Number(maxIterations) > 100) {
      throw contractError('invalid_loop_limits', { nodeId: node.id });
    }
  }
  if (node.type === 'llm_request') {
    validateLlmPortRows(node, config, 'inputs');
    validateLlmPortRows(node, config, 'outputs');
  }
  if (node.type === 'transform') {
    validateConfigPortRows(node, config, 'inputs', TRANSFORM_PORT_CODES);
    validateConfigPortRows(node, config, 'outputs', TRANSFORM_PORT_CODES);
  }
  if (node.type === 'variable_write') validateVariablePortRows(node, config, 'inputs');
  if (node.type === 'variable_read') validateVariablePortRows(node, config, 'outputs');
  if (node.type === 'constant') validateConstantPortRows(node, config);
  if ((node.type === 'loop' || node.type === 'ontology_query') && config.bodyGraph !== undefined) {
    if (!isSchemaGraphShape(config.bodyGraph)) {
      throw contractError(
        node.type === 'ontology_query' ? 'invalid_ontology_body_graph' : 'invalid_sub_schema_class',
        { nodeId: node.id },
      );
    }
    validateSchemaGraphContract(config.bodyGraph);
  }
  // ontology_query (issue #334/#375): режим ретрива, если задан в config, обязан
  // быть из закрытого набора local|global|hybrid. Отсутствие валидируется ниже на
  // уровне графа, потому что mode может прийти входом.
  if (node.type === 'ontology_query' && config.mode !== undefined && config.mode !== null) {
    if (!ONTOLOGY_QUERY_MODES.includes(config.mode)) {
      throw contractError('invalid_ontology_mode', { nodeId: node.id, mode: String(config.mode) });
    }
  }
  if (node.type === 'sub_schema' && config.graph !== undefined && isSchemaGraphShape(config.graph)) {
    validateSchemaGraphContract(config.graph);
  }
}

const LLM_PORT_CODES = Object.freeze({
  shape: 'invalid_llm_ports_shape',
  name: 'invalid_llm_port_name',
  type: 'invalid_llm_port_type',
});
const TRANSFORM_PORT_CODES = Object.freeze({
  shape: 'invalid_transform_ports_shape',
  name: 'invalid_transform_port_name',
  type: 'invalid_transform_port_type',
});
const VARIABLE_PORT_CODES = Object.freeze({
  shape: 'invalid_variable_ports_shape',
  name: 'invalid_variable_port_name',
  type: 'invalid_variable_port_type',
});

function validateLlmPortRows(node, config, key) {
  validateConfigPortRows(node, config, key, LLM_PORT_CODES);
}

// Порты variable-блоков (issue #208): кроме общих проверок имени и типа требуется
// уникальность имён переменных — иначе один экспорт затрёт другой.
function validateVariablePortRows(node, config, key) {
  validateConfigPortRows(node, config, key, VARIABLE_PORT_CODES);
  const seen = new Set();
  for (const row of Array.isArray(config[key]) ? config[key] : []) {
    if (!isRecord(row) || typeof row.name !== 'string') continue;
    const name = row.name.trim();
    if (!name) continue;
    if (seen.has(name)) throw contractError('duplicate_variable_port', { nodeId: node.id, name });
    seen.add(name);
  }
}

function validateConfigPortRows(node, config, key, codes) {
  const value = config[key];
  if (value !== undefined && !Array.isArray(value)) {
    throw contractError(codes.shape, { nodeId: node.id, key });
  }
  for (const row of Array.isArray(value) ? value : []) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name.trim() === '') {
      throw contractError(codes.name, { nodeId: node.id, key });
    }
    if (row.type !== undefined && !isPortType(row.type)) {
      throw contractError(codes.type, { nodeId: node.id, portType: String(row.type) });
    }
  }
}

// Валидация портов constant-узла (issue #319): каждый порт = { name, type, value };
// name непустое, type ∈ CONSTANT_PORT_TYPES, имена уникальны.
function validateConstantPortRows(node, config) {
  const value = config.outputs;
  if (value !== undefined && !Array.isArray(value)) {
    throw contractError('invalid_constant_ports_shape', { nodeId: node.id });
  }
  const seen = new Set();
  for (const row of Array.isArray(value) ? value : []) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name.trim() === '') {
      throw contractError('invalid_constant_port_name', { nodeId: node.id });
    }
    const name = row.name.trim();
    if (row.type !== undefined && !CONSTANT_PORT_TYPES.includes(row.type)) {
      throw contractError('invalid_constant_port_type', { nodeId: node.id, portType: String(row.type) });
    }
    if (seen.has(name)) throw contractError('duplicate_constant_port', { nodeId: node.id, name });
    seen.add(name);
  }
}

// Строгая валидация настраиваемых граничных портов суб-схемы (issue #310): каждый
// порт = { id, type } с id по BOUNDARY_PORT_ID_PATTERN и type ∈ PORT_TYPES\{exec};
// id должны быть уникальны. Пустой список допустим (граница без data-портов).
function validateBoundaryPorts(node, key) {
  const value = node.config && node.config[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) throw contractError('invalid_boundary_port_id', { nodeId: node.id, key });
  const seen = new Set();
  for (const row of value) {
    const id = isRecord(row) && typeof row.id === 'string' ? row.id.trim() : '';
    if (!BOUNDARY_PORT_ID_PATTERN.test(id)) {
      throw contractError('invalid_boundary_port_id', { nodeId: node.id, portId: id });
    }
    if (!isBoundaryPortType(row.type)) {
      throw contractError('invalid_boundary_port_type', { nodeId: node.id, portId: id, portType: String(row && row.type) });
    }
    if (seen.has(id)) throw contractError('duplicate_boundary_port', { nodeId: node.id, portId: id });
    seen.add(id);
  }
}

function validateEdgePorts(graph, edge, from, to) {
  const fromExec = isExecPortId(edge.fromPort);
  const toExec = isExecPortId(edge.toPort);
  if (fromExec || toExec) {
    if (!fromExec || !toExec) {
      throw contractError('mixed_port_kinds', { edgeId: edge.id });
    }
    if (!execOutputPortIds(from).includes(edge.fromPort)) {
      throw contractError('missing_exec_output', { nodeId: from.id, portId: edge.fromPort });
    }
    if (!execInputPortIds(to, graph).includes(edge.toPort)) {
      throw contractError('missing_exec_input', { nodeId: to.id, portId: edge.toPort });
    }
    return;
  }

  const fromType = getNodeOutputPortType(graph, from, edge.fromPort);
  const toType = getNodeInputPortType(graph, to, edge.toPort);
  if (!arePortTypesCompatible(fromType, toType)) {
    throw contractError('incompatible_ports', {
      edgeId: edge.id,
      fromNodeId: from.id,
      fromPortId: edge.fromPort,
      fromType,
      toNodeId: to.id,
      toPortId: edge.toPort,
      toType,
    });
  }
}

function assertNoExecCycles(graph, nodeById) {
  const outgoing = new Map();
  for (const edge of graph.edges) {
    if (!isExecPortId(edge.fromPort)) continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to || from.type === 'loop' || to.type === 'loop') continue;
    const list = outgoing.get(edge.from) || [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw contractError('exec_cycle', { nodeId });
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) || []) visit(next);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of graph.nodes) visit(node.id);
}

function contractError(code, details = {}) {
  return new SchemaContractError(code, details);
}

function isSchemaGraphShape(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.slug !== 'string' ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !isRecord(value.variables)
  ) {
    return false;
  }
  // XOR-дискриминатор (issue #310): граф — пайплайн-схема (валидный schemaType, без
  // subSchemaClass) либо суб-схема (валидный subSchemaClass, без schemaType).
  const asPipeline = isSchemaType(value.schemaType) && value.subSchemaClass === undefined;
  const asSub = isSubSchemaClass(value.subSchemaClass) && value.schemaType === undefined;
  return asPipeline || asSub;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export {
  SCHEMA_TYPES,
  NODE_TYPES,
  PORT_TYPES,
  ONTOLOGY_QUERY_MODES,
  DEFAULT_ONTOLOGY_QUERY_MODE,
  ONTOLOGY_QUERY_MODE_LABELS,
  SCHEMA_TABS,
  NODE_TYPE_LABELS,
  BASE_NODE_PALETTE,
  BASE_NODE_PALETTE as NODE_PALETTE,
  PORT_COLORS,
  SCHEMA_PORTS,
  GAME_STATE_READ_OUTPUTS,
  SCHEMA_NODE_POLICY,
  SUB_SCHEMA_CLASSES,
  SUB_SCHEMA_CLASS_LABELS,
  SUB_SCHEMA_NODE_POLICY,
  DATA_ONLY_NODE_TYPES,
  CONSTANT_PORT_TYPES,
  EXEC_PORT_IDS,
  VALIDATION_ERROR_MESSAGES,
  SchemaContractError,
  formatSchemaContractError,
  schemaTypeLabel,
  subSchemaClassLabel,
  isSchemaType,
  isSubSchemaClass,
  isBoundaryPortType,
  isSubSchemaGraph,
  graphPaletteKind,
  isSubSchemaUsableIn,
  isNodeType,
  isPortType,
  isOntologyQueryMode,
  ontologyQueryMode,
  isExecPortId,
  isMergeExecInputId,
  mergeExecInputPortIds,
  isDataOnlyNodeType,
  portColor,
  arePortTypesCompatible,
  schemaStartPorts,
  schemaEndPorts,
  schemaStartPortType,
  schemaEndPortType,
  boundaryStartPorts,
  boundaryEndPorts,
  subSchemaNodePorts,
  isNodeTypeAllowedInSchema,
  getNodePaletteForSchema,
  execInputPortIds,
  execOutputPortIds,
  getNodeInputPortType,
  getNodeOutputPortType,
  getNodePortDefinitions,
  validateSchemaGraphContract,
};
