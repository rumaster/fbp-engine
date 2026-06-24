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
  'graph_rag',
  'graph_query',
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
  graph_rag: 'Graph RAG',
  graph_query: 'Graph query',
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
  'graph_rag',
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
  invalid_graph_rag_limits: ({ nodeId }) => `graph_rag-узлу ${nodeId} нужен maxIterations от 1 до 5`,
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
  if (nodeType === 'graph_query') return false;
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
  if (node.type === 'graph_rag') return portId === 'result' ? 'string' : 'any';
  if (node.type === 'graph_query') return portId === 'concepts' ? 'object_array' : 'any';
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
  if (node.type === 'graph_rag') {
    if (portId === 'query') return 'string';
    // options (issue #392): необязательный объект настроек узла, который пробрасывается
    // в граничный выход options тела. Вход questions у публичного узла убран — это
    // внутренний механизм повторных итераций, недоступный извне.
    if (portId === 'options') return 'object';
  }
  if (node.type === 'graph_query' && portId === 'keys') return 'string_array';
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
  if (node.type === 'graph_rag') {
    addInput('query', 'string', 'query');
    // options (issue #392): объект настроек узла. У публичного узла нет входа
    // questions — повторные итерации размышления управляются внутри тела.
    addInput('options', 'object', 'options');
    addOutput('result', 'string', 'result');
    return;
  }
  if (node.type === 'graph_query') {
    addInput('keys', 'string_array', 'keys');
    addOutput('concepts', 'object_array', 'concepts');
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

function bodyEdge(from, fromPort, to, toPort) {
  return { id: `${from}:${fromPort}->${to}:${toPort}`, from, fromPort, to, toPort };
}

function graphRagLlmOutputs(outputs) {
  return outputs.map((item) => ({
    name: item.name,
    jsonPath: item.jsonPath || item.name,
    type: item.type,
  }));
}

function buildDefaultGraphRagBodyGraph(parentSlug = 'graph_rag', nodeId = 'graph_rag') {
  // Тело по умолчанию для graph_rag (issue #388). Топология построена на data-pull-узлах
  // (transform / condition), без промежуточных variable_write/read: значения тянутся
  // напрямую по рёбрам, что делает граф короче и читаемее. Логика одной итерации:
  //   1. Определяем источник ключей: уточняющие вопросы прошлой итерации или ключи,
  //      выделенные LLM из исходного запроса (select_keys).
  //   2. Ищем вершины-якоря в графе знаний и оставляем релевантные (select_anchors).
  //   3. Раскрываем соседей якорей и снова фильтруем (select_neighbors).
  //   4. Критик решает, хватает ли фактов: пустой список вопросов → формируем финальный
  //      ответ и выходим; непустой → готовим вход для следующей итерации и выходим в end,
  //      откуда graph_rag-движок запустит новую итерацию (см. executeGraphRag).
  // Важно: critic.answers берётся из start.answers (ответы прошлых итераций), а не из
  // summarize_iteration — иначе образуется data-цикл critic↔summarize_iteration.
  return {
    version: 1,
    subSchemaClass: 'common',
    slug: `${parentSlug}::graph_rag:${nodeId}`,
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 180 },
        label: 'Старт',
        config: {
          outputs: [
            port('query', 'string', 'Запрос'),
            port('questions', 'string_array', 'Уточняющие вопросы'),
            port('answers', 'string_array', 'Ответы прошлых итераций'),
            // options (issue #392): настройки узла из публичного входа options.
            port('options', 'object', 'Опции узла'),
            // lastIteration (issue #392): движок выставляет true на последней
            // итерации — телу пора прекратить поиск и сформировать финальный ответ.
            port('lastIteration', 'boolean', 'Последняя итерация'),
          ],
        },
      },
      {
        id: 'has_questions',
        type: 'transform',
        position: { x: 240, y: 300 },
        label: 'Есть вопросы от прошлой итерации?',
        config: {
          code: [
            'const items = Array.isArray(input.questions) ? input.questions : [];',
            'return { hasQuestions: items.some((item) => typeof item === "string" && item.trim().length > 0) };',
          ].join('\n'),
          inputs: [{ name: 'questions', type: 'string_array' }],
          outputs: [{ name: 'hasQuestions', type: 'boolean', path: 'result.hasQuestions' }],
        },
      },
      {
        id: 'question_branch',
        type: 'condition',
        position: { x: 480, y: 180 },
        label: 'Есть вопросы?',
        config: { input: 'value', operator: 'truthy', right: '' },
      },
      {
        id: 'extract_keys',
        type: 'llm_request',
        position: { x: 720, y: 60 },
        label: 'Выделить ключи из запроса',
        config: {
          systemPrompt: 'Выдели короткие ключи для поиска в графе знаний игры. Верни только JSON.',
          userPrompt: 'Вопрос: {{query}}\nВерни {"keys":["ключ"]}.',
          retryPrompt: 'Верни валидный JSON вида {"keys":["ключ"]}.',
          inputs: [{ name: 'query', type: 'string' }],
          outputs: graphRagLlmOutputs([{ name: 'keys', type: 'string_array' }]),
          jsonMode: true,
        },
      },
      {
        id: 'select_keys',
        type: 'transform',
        position: { x: 720, y: 300 },
        label: 'Выбрать источник ключей',
        config: {
          // useQuestions=true → ключи берём из уточняющих вопросов прошлой итерации;
          // иначе используем ключи, выделенные LLM из исходного запроса.
          code: [
            'const source = input.useQuestions ? input.questionKeys : input.llmKeys;',
            'return Array.isArray(source) ? source.filter((item) => typeof item === "string" && item.trim().length > 0) : [];',
          ].join('\n'),
          inputs: [
            { name: 'llmKeys', type: 'string_array' },
            { name: 'questionKeys', type: 'string_array' },
            { name: 'useQuestions', type: 'boolean' },
          ],
          outputs: [{ name: 'keys', type: 'string_array', path: 'result' }],
        },
      },
      {
        id: 'graph_query_anchors',
        type: 'graph_query',
        position: { x: 1000, y: 180 },
        label: 'Граф: вершины-якоря',
        config: { topK: 8 },
      },
      {
        id: 'select_anchors',
        type: 'llm_request',
        position: { x: 1280, y: 180 },
        label: 'Отобрать якоря',
        config: {
          systemPrompt: 'Выбери релевантные вершины графа для вопроса. Верни только JSON.',
          userPrompt: [
            'Вопрос: {{query}}',
            'Кандидаты: {{anchorConcepts}}',
            'Верни {"keep":["id"],"load":["id"]}. keep — полезные вершины, load — какие id раскрыть глубже.',
          ].join('\n'),
          retryPrompt: 'Верни валидный JSON вида {"keep":["id"],"load":["id"]}.',
          inputs: [
            { name: 'query', type: 'string' },
            { name: 'anchorConcepts', type: 'object_array' },
          ],
          outputs: graphRagLlmOutputs([
            { name: 'keep', type: 'string_array' },
            { name: 'load', type: 'string_array' },
          ]),
          jsonMode: true,
        },
      },
      {
        id: 'graph_query_neighbors',
        type: 'graph_query',
        position: { x: 1560, y: 180 },
        label: 'Граф: соседние вершины',
        config: { topK: 8 },
      },
      {
        id: 'select_neighbors',
        type: 'llm_request',
        position: { x: 1840, y: 180 },
        label: 'Отобрать соседей',
        config: {
          systemPrompt: 'Выбери итоговые вершины графа, достаточные для ответа. Верни только JSON.',
          userPrompt: [
            'Вопрос: {{query}}',
            'Якоря: {{anchorConcepts}}',
            'Раскрытые соседи: {{neighborConcepts}}',
            'Верни {"keep":["id"],"load":["id"]}.',
          ].join('\n'),
          retryPrompt: 'Верни валидный JSON вида {"keep":["id"],"load":["id"]}.',
          inputs: [
            { name: 'query', type: 'string' },
            { name: 'anchorConcepts', type: 'object_array' },
            { name: 'neighborConcepts', type: 'object_array' },
          ],
          outputs: graphRagLlmOutputs([
            { name: 'keep', type: 'string_array' },
            { name: 'load', type: 'string_array' },
          ]),
          jsonMode: true,
        },
      },
      {
        id: 'merge_concepts',
        type: 'transform',
        position: { x: 2080, y: 320 },
        label: 'Объединить концепты',
        config: {
          code: [
            'const anchors = Array.isArray(input.anchorConcepts) ? input.anchorConcepts : [];',
            'const neighbors = Array.isArray(input.neighborConcepts) ? input.neighborConcepts : [];',
            'const keep = [];',
            'for (const item of Array.isArray(input.anchorKeep) ? input.anchorKeep : []) if (typeof item === "string") keep.push(item);',
            'for (const item of Array.isArray(input.neighborKeep) ? input.neighborKeep : []) if (typeof item === "string") keep.push(item);',
            'const filterActive = keep.length > 0;',
            'const byId = {};',
            'const add = (item) => {',
            '  if (!item || typeof item !== "object") return;',
            '  const id = typeof item.id === "string" ? item.id : "";',
            '  if (!id) return;',
            '  if (filterActive && !keep.includes(id)) return;',
            '  byId[id] = item;',
            '};',
            'for (const item of anchors) add(item);',
            'for (const item of neighbors) add(item);',
            'return Object.keys(byId).map((id) => byId[id]);',
          ].join('\n'),
          inputs: [
            { name: 'anchorConcepts', type: 'object_array' },
            { name: 'neighborConcepts', type: 'object_array' },
            { name: 'anchorKeep', type: 'string_array' },
            { name: 'neighborKeep', type: 'string_array' },
          ],
          outputs: [{ name: 'concepts', type: 'object_array', path: 'result' }],
        },
      },
      {
        id: 'critic',
        type: 'llm_request',
        position: { x: 2320, y: 180 },
        label: 'Критик: достаточно ли фактов',
        config: {
          systemPrompt: 'Проверь, хватает ли найденных графовых фактов для ответа. Верни только JSON.',
          userPrompt: [
            'Вопрос: {{query}}',
            'Найденные концепты: {{concepts}}',
            'Ответы прошлых итераций: {{answers}}',
            'Если нужны ещё факты, верни {"questions":["что найти"]}. Если хватает, верни {"questions":[]}.',
          ].join('\n'),
          retryPrompt: 'Верни валидный JSON вида {"questions":["что найти"]}.',
          inputs: [
            { name: 'query', type: 'string' },
            { name: 'concepts', type: 'object_array' },
            { name: 'answers', type: 'string_array' },
          ],
          outputs: graphRagLlmOutputs([{ name: 'questions', type: 'string_array' }]),
          jsonMode: true,
        },
      },
      {
        id: 'has_missing_questions',
        type: 'transform',
        position: { x: 2560, y: 320 },
        label: 'Нужны ещё факты?',
        config: {
          // lastIteration (issue #392): на последней итерации поиск прерывается
          // принудительно — вопросы критика игнорируются, и ветка уходит на
          // финальный ответ, иначе тело завершилось бы без result.
          code: [
            'const items = Array.isArray(input.questions) ? input.questions : [];',
            'const hasNew = items.some((item) => typeof item === "string" && item.trim().length > 0);',
            'return { hasQuestions: input.lastIteration ? false : hasNew };',
          ].join('\n'),
          inputs: [
            { name: 'questions', type: 'string_array' },
            { name: 'lastIteration', type: 'boolean' },
          ],
          outputs: [{ name: 'hasQuestions', type: 'boolean', path: 'result.hasQuestions' }],
        },
      },
      {
        id: 'critique_branch',
        type: 'condition',
        position: { x: 2800, y: 180 },
        label: 'Нужна ещё итерация?',
        config: { input: 'value', operator: 'truthy', right: '' },
      },
      {
        id: 'summarize_iteration',
        type: 'transform',
        position: { x: 3040, y: 320 },
        label: 'Подготовить следующую итерацию',
        config: {
          code: [
            'const answers = Array.isArray(input.answers) ? input.answers.filter((item) => typeof item === "string") : [];',
            'const concepts = Array.isArray(input.concepts) ? input.concepts : [];',
            'const labels = concepts.map((item) => item && typeof item === "object" && typeof item.concept === "string" ? item.concept : "").filter((item) => item.length > 0);',
            'const nextAnswers = labels.length > 0 ? answers.concat([labels.join(", ")]) : answers;',
            'const questions = Array.isArray(input.questions) ? input.questions.filter((item) => typeof item === "string" && item.trim().length > 0) : [];',
            'return { answers: nextAnswers, questions };',
          ].join('\n'),
          inputs: [
            { name: 'answers', type: 'string_array' },
            { name: 'concepts', type: 'object_array' },
            { name: 'questions', type: 'string_array' },
          ],
          outputs: [
            { name: 'answers', type: 'string_array', path: 'result.answers' },
            { name: 'questions', type: 'string_array', path: 'result.questions' },
          ],
        },
      },
      {
        id: 'final_answer',
        type: 'llm_request',
        position: { x: 3040, y: 60 },
        label: 'Финальный ответ',
        config: {
          systemPrompt: 'Ответь на исходный вопрос только по найденным концептам графа. Верни только JSON.',
          userPrompt: [
            'Вопрос: {{query}}',
            'Найденные концепты: {{concepts}}',
            'Ответы прошлых итераций: {{answers}}',
            'Верни {"result":"ответ"}.',
          ].join('\n'),
          retryPrompt: 'Верни валидный JSON вида {"result":"ответ"}.',
          inputs: [
            { name: 'query', type: 'string' },
            { name: 'concepts', type: 'object_array' },
            { name: 'answers', type: 'string_array' },
          ],
          outputs: graphRagLlmOutputs([{ name: 'result', type: 'string' }]),
          jsonMode: true,
        },
      },
      {
        id: 'end',
        type: 'end',
        position: { x: 3340, y: 180 },
        label: 'Конец',
        config: {
          inputs: [
            port('result', 'string', 'Ответ'),
            port('answers', 'string_array', 'Ответы для следующей итерации'),
            port('questions', 'string_array', 'Вопросы для следующей итерации'),
          ],
        },
      },
    ],
    edges: [
      // Поток управления: ветка по наличию уточняющих вопросов прошлой итерации.
      bodyEdge('start', 'exec', 'question_branch', 'exec'),
      bodyEdge('start', 'questions', 'has_questions', 'questions'),
      bodyEdge('has_questions', 'hasQuestions', 'question_branch', 'value'),
      // Нет вопросов → выделяем ключи запроса через LLM; есть → сразу к поиску в графе.
      bodyEdge('question_branch', 'false', 'extract_keys', 'exec'),
      bodyEdge('start', 'query', 'extract_keys', 'query'),
      bodyEdge('extract_keys', 'exec', 'graph_query_anchors', 'exec'),
      bodyEdge('question_branch', 'true', 'graph_query_anchors', 'exec'),
      // Источник ключей выбирается data-узлом без побочных эффектов.
      bodyEdge('extract_keys', 'keys', 'select_keys', 'llmKeys'),
      bodyEdge('start', 'questions', 'select_keys', 'questionKeys'),
      bodyEdge('has_questions', 'hasQuestions', 'select_keys', 'useQuestions'),
      bodyEdge('select_keys', 'keys', 'graph_query_anchors', 'keys'),
      // Якоря: запрос к графу и LLM-фильтр.
      bodyEdge('graph_query_anchors', 'exec', 'select_anchors', 'exec'),
      bodyEdge('start', 'query', 'select_anchors', 'query'),
      bodyEdge('graph_query_anchors', 'concepts', 'select_anchors', 'anchorConcepts'),
      // Соседи: раскрываем выбранные load-вершины и снова фильтруем.
      bodyEdge('select_anchors', 'exec', 'graph_query_neighbors', 'exec'),
      bodyEdge('select_anchors', 'load', 'graph_query_neighbors', 'keys'),
      bodyEdge('graph_query_neighbors', 'exec', 'select_neighbors', 'exec'),
      bodyEdge('start', 'query', 'select_neighbors', 'query'),
      bodyEdge('graph_query_anchors', 'concepts', 'select_neighbors', 'anchorConcepts'),
      bodyEdge('graph_query_neighbors', 'concepts', 'select_neighbors', 'neighborConcepts'),
      // Итоговый набор концептов: оставляем вершины из keep якорей и соседей.
      bodyEdge('graph_query_anchors', 'concepts', 'merge_concepts', 'anchorConcepts'),
      bodyEdge('graph_query_neighbors', 'concepts', 'merge_concepts', 'neighborConcepts'),
      bodyEdge('select_anchors', 'keep', 'merge_concepts', 'anchorKeep'),
      bodyEdge('select_neighbors', 'keep', 'merge_concepts', 'neighborKeep'),
      // Критик оценивает достаточность фактов.
      bodyEdge('select_neighbors', 'exec', 'critic', 'exec'),
      bodyEdge('start', 'query', 'critic', 'query'),
      bodyEdge('merge_concepts', 'concepts', 'critic', 'concepts'),
      bodyEdge('start', 'answers', 'critic', 'answers'),
      bodyEdge('critic', 'exec', 'critique_branch', 'exec'),
      bodyEdge('critic', 'questions', 'has_missing_questions', 'questions'),
      // Принудительное прерывание поиска на последней итерации (issue #392).
      bodyEdge('start', 'lastIteration', 'has_missing_questions', 'lastIteration'),
      bodyEdge('has_missing_questions', 'hasQuestions', 'critique_branch', 'value'),
      // Нужна ещё итерация → подготовка входа и выход; иначе → финальный ответ.
      bodyEdge('critique_branch', 'true', 'end', 'exec'),
      bodyEdge('critique_branch', 'false', 'final_answer', 'exec'),
      bodyEdge('final_answer', 'exec', 'end', 'exec'),
      bodyEdge('start', 'query', 'final_answer', 'query'),
      bodyEdge('merge_concepts', 'concepts', 'final_answer', 'concepts'),
      bodyEdge('start', 'answers', 'final_answer', 'answers'),
      // Подготовка следующей итерации (питает граничные выходы end).
      bodyEdge('start', 'answers', 'summarize_iteration', 'answers'),
      bodyEdge('merge_concepts', 'concepts', 'summarize_iteration', 'concepts'),
      bodyEdge('critic', 'questions', 'summarize_iteration', 'questions'),
      // Граничные выходы тела: result — финальный ответ, answers/questions — для следующей итерации.
      bodyEdge('final_answer', 'result', 'end', 'result'),
      bodyEdge('summarize_iteration', 'answers', 'end', 'answers'),
      bodyEdge('summarize_iteration', 'questions', 'end', 'questions'),
    ],
    variables: {},
  };
}

function validateSchemaGraphContract(graph, options = {}) {
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
    const internalGraphQueryAllowed = options.allowInternalGraphQuery === true && node.type === 'graph_query';
    if (!internalGraphQueryAllowed && !isNodeTypeAllowedInSchema(paletteKind, node.type)) {
      throw contractError('node_type_blocked', { schemaType: paletteKind, nodeType: node.type });
    }
    // Граничные порты суб-схемы (issue #310): для start — config.outputs, для end —
    // config.inputs. Строгая проверка id/типа/дубликатов (нормализация в boundaryPortRows
    // молча отбрасывает плохие записи, здесь же это ошибка контракта).
    if (isSub && node.type === 'start') validateBoundaryPorts(node, 'outputs');
    if (isSub && node.type === 'end') validateBoundaryPorts(node, 'inputs');
    validateNodeConfig(node, options);
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
  assertNoExecCycles(graph, nodeById);
}

function validateNodeConfig(node, options = {}) {
  const config = isRecord(node.config) ? node.config : {};
  if (node.type === 'loop') {
    const maxIterations = config.maxIterations;
    if (!Number.isSafeInteger(maxIterations) || Number(maxIterations) < 1 || Number(maxIterations) > 100) {
      throw contractError('invalid_loop_limits', { nodeId: node.id });
    }
  }
  if (node.type === 'graph_rag') {
    const maxIterations = config.maxIterations;
    if (!Number.isSafeInteger(maxIterations) || Number(maxIterations) < 1 || Number(maxIterations) > 5) {
      throw contractError('invalid_graph_rag_limits', { nodeId: node.id });
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
  if (node.type === 'loop' && config.bodyGraph !== undefined) {
    if (!isSchemaGraphShape(config.bodyGraph)) {
      throw contractError('invalid_sub_schema_class', { nodeId: node.id });
    }
    validateSchemaGraphContract(config.bodyGraph, options);
  }
  if (node.type === 'graph_rag' && config.bodyGraph !== undefined) {
    if (!isSchemaGraphShape(config.bodyGraph)) {
      throw contractError('invalid_sub_schema_class', { nodeId: node.id });
    }
    validateSchemaGraphContract(config.bodyGraph, { ...options, allowInternalGraphQuery: true });
  }
  if (node.type === 'sub_schema' && config.graph !== undefined && isSchemaGraphShape(config.graph)) {
    validateSchemaGraphContract(config.graph, options);
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
  buildDefaultGraphRagBodyGraph,
  validateSchemaGraphContract,
};
