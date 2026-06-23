export type SchemaType = 'action' | 'hint' | 'illustration' | 'support';

export type SubSchemaClass = 'game' | 'support' | 'common';

// «Вид» графа для политики палитры узлов: пайплайн-схема (SchemaType) либо
// суб-схема (SubSchemaClass) (issue #310).
export type SchemaPaletteKind = SchemaType | SubSchemaClass;

// Тип граничного порта суб-схемы — любой PortType, кроме exec (issue #310).
export type BoundaryPortType = Exclude<PortType, 'exec'>;

export type NodeType =
  | 'start'
  | 'end'
  | 'llm_request'
  | 'knowledge_query'
  | 'ontology_query'
  | 'ontology_anchor_match'
  | 'ontology_frontier_expand'
  | 'ontology_budget_select'
  | 'ontology_context_build'
  | 'game_memory_read'
  | 'game_memory_write'
  | 'manifest'
  | 'game_state_read'
  | 'game_state_write'
  | 'support_history_read'
  | 'game_history_read'
  | 'condition'
  | 'variable_read'
  | 'variable_write'
  | 'loop'
  | 'transform'
  | 'merge'
  | 'sub_schema'
  | 'media_generate'
  | 'log'
  | 'constant';

export type PortType =
  | 'exec'
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'string_array'
  | 'object_array'
  | 'expertise'
  | 'memory'
  | 'any';

export type PortDirection = 'input' | 'output';

// Режим ретрива узла ontology_query (issue #334, Graph RAG).
export type OntologyQueryMode = 'local' | 'global' | 'hybrid';

export type SchemaContractErrorCode =
  | 'duplicate_node_id'
  | 'node_type_blocked'
  | 'single_start'
  | 'single_end'
  | 'unknown_edge_from'
  | 'unknown_edge_to'
  | 'mixed_port_kinds'
  | 'missing_exec_output'
  | 'missing_exec_input'
  | 'incompatible_ports'
  | 'duplicate_data_input'
  | 'invalid_loop_limits'
  | 'invalid_llm_ports_shape'
  | 'invalid_llm_port_name'
  | 'invalid_llm_port_type'
  | 'invalid_transform_ports_shape'
  | 'invalid_transform_port_name'
  | 'invalid_transform_port_type'
  | 'invalid_variable_ports_shape'
  | 'invalid_variable_port_name'
  | 'invalid_variable_port_type'
  | 'duplicate_variable_port'
  | 'invalid_constant_ports_shape'
  | 'invalid_constant_port_name'
  | 'invalid_constant_port_type'
  | 'duplicate_constant_port'
  | 'invalid_sub_schema_class'
  | 'invalid_boundary_port_id'
  | 'invalid_boundary_port_type'
  | 'duplicate_boundary_port'
  | 'invalid_ontology_mode'
  | 'missing_ontology_mode'
  | 'missing_ontology_body_graph'
  | 'invalid_ontology_body_graph'
  | 'missing_ontology_graph_source'
  | 'missing_ontology_anchor_source'
  | 'missing_ontology_options'
  | 'exec_cycle';

export interface NodeDefinition {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  label?: string;
}

export interface EdgeDefinition {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

// Граф схемы (issue #310): XOR-дискриминатор — задан либо schemaType (пайплайн-
// схема), либо subSchemaClass (суб-схема), но не оба сразу.
export interface SchemaGraph {
  version: 1;
  schemaType?: SchemaType;
  subSchemaClass?: SubSchemaClass;
  slug: string;
  gameId?: string;
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  variables: Record<string, unknown>;
}

export interface SchemaTab {
  slug: SchemaType;
  schemaType: SchemaType;
  label: string;
}

export interface PortDefinition {
  id: string;
  label: string;
  type: PortType;
  direction: PortDirection;
}

export interface SchemaBoundaryPort {
  id: string;
  label: string;
  type: PortType;
}

export interface SchemaPorts {
  startOutputs: readonly SchemaBoundaryPort[];
  endInputs: readonly SchemaBoundaryPort[];
}

export interface SchemaNodePolicy {
  blocked: readonly NodeType[];
}

export class SchemaContractError extends Error {
  readonly code: SchemaContractErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: SchemaContractErrorCode, details?: Record<string, unknown>);
}

export const SCHEMA_TYPES: readonly SchemaType[];
export const NODE_TYPES: readonly NodeType[];
export const PORT_TYPES: readonly PortType[];
export const ONTOLOGY_QUERY_MODES: readonly OntologyQueryMode[];
export const DEFAULT_ONTOLOGY_QUERY_MODE: OntologyQueryMode;
export const ONTOLOGY_QUERY_MODE_LABELS: Readonly<Record<OntologyQueryMode, string>>;
export const SCHEMA_TABS: readonly SchemaTab[];
export const NODE_TYPE_LABELS: Readonly<Record<NodeType, string>>;
export const BASE_NODE_PALETTE: readonly NodeType[];
export const NODE_PALETTE: readonly NodeType[];
export const PORT_COLORS: Readonly<Record<PortType, string>>;
export const SCHEMA_PORTS: Readonly<Record<SchemaType, SchemaPorts>>;
export const GAME_STATE_READ_OUTPUTS: readonly SchemaBoundaryPort[];
export const SCHEMA_NODE_POLICY: Readonly<Record<SchemaType, SchemaNodePolicy>>;
export const SUB_SCHEMA_CLASSES: readonly SubSchemaClass[];
export const SUB_SCHEMA_CLASS_LABELS: Readonly<Record<SubSchemaClass, string>>;
export const SUB_SCHEMA_NODE_POLICY: Readonly<Record<SubSchemaClass, SchemaNodePolicy>>;
export const DATA_ONLY_NODE_TYPES: readonly NodeType[];
export const CONSTANT_PORT_TYPES: readonly string[];
export const EXEC_PORT_IDS: readonly string[];
export const VALIDATION_ERROR_MESSAGES: Readonly<
  Record<SchemaContractErrorCode, (details: Record<string, unknown>) => string>
>;

export function formatSchemaContractError(
  code: SchemaContractErrorCode,
  details?: Record<string, unknown>,
): string;
export function schemaTypeLabel(type: string): string;
export function subSchemaClassLabel(subClass: string): string;
export function isSchemaType(value: unknown): value is SchemaType;
export function isSubSchemaClass(value: unknown): value is SubSchemaClass;
export function isBoundaryPortType(value: unknown): value is BoundaryPortType;
export function isSubSchemaGraph(graph: unknown): graph is SchemaGraph;
export function graphPaletteKind(graph: SchemaGraph): SchemaPaletteKind | undefined;
export function isSubSchemaUsableIn(
  subSchemaClass: unknown,
  callerKind: SchemaPaletteKind | undefined,
): boolean;
export function isNodeType(value: unknown): value is NodeType;
export function isPortType(value: unknown): value is PortType;
export function isOntologyQueryMode(value: unknown): value is OntologyQueryMode;
export function ontologyQueryMode(value: unknown): OntologyQueryMode | null;
export function isExecPortId(portId: string): boolean;
export function isMergeExecInputId(portId: string): boolean;
export function mergeExecInputPortIds(node: NodeDefinition, graph?: SchemaGraph): string[];
export function isDataOnlyNodeType(type: NodeType): boolean;
export function portColor(type: PortType): string;
export function arePortTypesCompatible(fromType: PortType, toType: PortType): boolean;
export function schemaStartPorts(schemaType: SchemaType | undefined): SchemaBoundaryPort[];
export function schemaEndPorts(schemaType: SchemaType | undefined): SchemaBoundaryPort[];
export function schemaStartPortType(schemaType: SchemaType, portId: string): PortType | null;
export function schemaEndPortType(schemaType: SchemaType, portId: string): PortType | null;
export function boundaryStartPorts(graph: SchemaGraph): SchemaBoundaryPort[];
export function boundaryEndPorts(graph: SchemaGraph): SchemaBoundaryPort[];
export function subSchemaNodePorts(node: NodeDefinition): {
  inputs: SchemaBoundaryPort[];
  outputs: SchemaBoundaryPort[];
};
export function isNodeTypeAllowedInSchema(kind: SchemaPaletteKind | undefined, nodeType: NodeType): boolean;
export function getNodePaletteForSchema(kind: SchemaPaletteKind | undefined): NodeType[];
export function execInputPortIds(nodeOrType: NodeDefinition | NodeType, graph?: SchemaGraph): string[];
export function execOutputPortIds(nodeOrType: NodeDefinition | NodeType): string[];
export function getNodeInputPortType(graph: SchemaGraph, node: NodeDefinition, portId: string): PortType;
export function getNodeOutputPortType(graph: SchemaGraph, node: NodeDefinition, portId: string): PortType;
export function getNodePortDefinitions(
  node: NodeDefinition,
  graph?: SchemaGraph,
): { inputs: PortDefinition[]; outputs: PortDefinition[] };
export function validateSchemaGraphContract(graph: SchemaGraph): void;
