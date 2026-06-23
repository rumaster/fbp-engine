import { describe, it, expect } from 'vitest';
// @ts-expect-error — пакет на чистом ESM без локальных типов в тесте.
import {
  NODE_TYPES,
  NODE_PALETTE,
  NODE_TYPE_LABELS,
  getNodePortDefinitions,
  getNodeInputPortType,
  getNodeOutputPortType,
  ONTOLOGY_QUERY_MODES,
  DEFAULT_ONTOLOGY_QUERY_MODE,
  ONTOLOGY_QUERY_MODE_LABELS,
  isOntologyQueryMode,
  ontologyQueryMode,
  validateSchemaGraphContract,
  SchemaContractError,
} from '../index.mjs';

const traversalOptions = {
  depth: 2,
  decay: 0.5,
  maxConcepts: 12,
  maxRelations: 16,
};

function bodyGraph(slug = 'oq-body') {
  return {
    version: 1,
    subSchemaClass: 'common',
    slug,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'end', type: 'end', position: { x: 200, y: 0 }, config: {} },
    ],
    edges: [{ id: 'exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' }],
    variables: {},
  };
}

function validConfig(patch: Record<string, unknown> = {}) {
  return {
    mode: 'local',
    options: traversalOptions,
    graphScope: { type: 'game', gameId: 'bomj' },
    query: 'Коллектор',
    bodyGraph: bodyGraph(),
    ...patch,
  };
}

function wrap(config: Record<string, unknown>, edges: Array<Record<string, unknown>> = []) {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'oq-mode',
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'oq-1', type: 'ontology_query', position: { x: 100, y: 100 }, config },
      { id: 'end-1', type: 'end', position: { x: 200, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'exec-1', from: 'start-1', fromPort: 'exec', to: 'oq-1', toPort: 'exec' },
      { id: 'exec-2', from: 'oq-1', fromPort: 'exec', to: 'end-1', toPort: 'exec' },
      ...edges,
    ],
    variables: {},
  };
}

function expectContractCode(fn: () => void, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SchemaContractError);
  expect((caught as { code: string }).code).toBe(code);
}

describe('ontology_query: контракт узла (issue #323/#334/#361/#375)', () => {
  const node = { id: 'oq', type: 'ontology_query', config: {} };
  const graph = { nodes: [node], edges: [], variables: {} };

  it('ontology_query и внутренние ontology-узлы зарегистрированы в типах, палитре и метках', () => {
    for (const type of [
      'ontology_query',
      'ontology_anchor_match',
      'ontology_frontier_expand',
      'ontology_budget_select',
      'ontology_context_build',
    ]) {
      expect(NODE_TYPES).toContain(type);
      expect(NODE_PALETTE).toContain(type);
      expect(NODE_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it('ontology_query объявляет явные входы и результаты graph retriever', () => {
    const { inputs, outputs } = getNodePortDefinitions(node, graph) as {
      inputs: Array<{ id: string; type: string }>;
      outputs: Array<{ id: string; type: string }>;
    };
    expect(inputs.map((p) => [p.id, p.type])).toEqual([
      ['exec', 'exec'],
      ['query', 'string'],
      ['anchors', 'string_array'],
      ['graphScope', 'object'],
      ['graph', 'object'],
      ['traversalContext', 'object'],
      ['options', 'object'],
      ['mode', 'string'],
    ]);
    expect(outputs.map((p) => [p.id, p.type])).toEqual([
      ['exec', 'exec'],
      ['expertise', 'expertise'],
      ['graph_context', 'expertise'],
      ['subgraph', 'object'],
      ['trace', 'object'],
    ]);
    expect(getNodeInputPortType(graph, node, 'query')).toBe('string');
    expect(getNodeInputPortType(graph, node, 'anchors')).toBe('string_array');
    expect(getNodeInputPortType(graph, node, 'options')).toBe('object');
    expect(getNodeOutputPortType(graph, node, 'graph_context')).toBe('expertise');
    expect(getNodeOutputPortType(graph, node, 'trace')).toBe('object');
  });

  it('внутренние ontology-узлы имеют порты для канонического bodyGraph', () => {
    const anchor = { id: 'a', type: 'ontology_anchor_match', config: {} };
    const frontier = { id: 'f', type: 'ontology_frontier_expand', config: {} };
    const budget = { id: 'b', type: 'ontology_budget_select', config: {} };
    const context = { id: 'c', type: 'ontology_context_build', config: {} };
    expect(getNodeInputPortType(graph, anchor, 'graph')).toBe('object');
    expect(getNodeOutputPortType(graph, anchor, 'anchorSlugs')).toBe('string_array');
    expect(getNodeInputPortType(graph, frontier, 'anchorSlugs')).toBe('string_array');
    expect(getNodeOutputPortType(graph, frontier, 'subgraph')).toBe('object');
    expect(getNodeInputPortType(graph, budget, 'options')).toBe('object');
    expect(getNodeOutputPortType(graph, budget, 'trace')).toBe('object');
    expect(getNodeInputPortType(graph, context, 'communities')).toBe('object_array');
    expect(getNodeOutputPortType(graph, context, 'graph_context')).toBe('expertise');
  });

  it('набор режимов и подписи оставлены для UI, но runtime fallback не выполняется', () => {
    expect(ONTOLOGY_QUERY_MODES).toEqual(['local', 'global', 'hybrid']);
    expect(DEFAULT_ONTOLOGY_QUERY_MODE).toBe('local');
    expect(Object.keys(ONTOLOGY_QUERY_MODE_LABELS).sort()).toEqual(['global', 'hybrid', 'local']);
    expect(isOntologyQueryMode('local')).toBe(true);
    expect(isOntologyQueryMode('bogus')).toBe(false);
    expect(ontologyQueryMode('global')).toBe('global');
    expect(ontologyQueryMode('bogus')).toBeNull();
    expect(ontologyQueryMode(undefined)).toBeNull();
  });

  it('валидация пропускает только полностью явный ontology_query', () => {
    expect(() => validateSchemaGraphContract(wrap(validConfig()))).not.toThrow();
  });

  it('mode может прийти входом, но недопустимый config.mode остаётся ошибкой', () => {
    const configWithoutMode = validConfig({ mode: undefined });
    expect(() =>
      validateSchemaGraphContract(
        wrap(configWithoutMode, [
          { id: 'mode', from: 'start-1', fromPort: 'mode', to: 'oq-1', toPort: 'mode' },
        ]),
      ),
    ).not.toThrow();
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ mode: 'superglobal' }))),
      'invalid_ontology_mode',
    );
  });

  it('валидация требует bodyGraph, источник графа, query/anchors и options', () => {
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ bodyGraph: undefined }))),
      'missing_ontology_body_graph',
    );
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ graphScope: undefined, graph: undefined }))),
      'missing_ontology_graph_source',
    );
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ query: '', anchors: [] }))),
      'missing_ontology_anchor_source',
    );
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ options: undefined }))),
      'missing_ontology_options',
    );
  });

  it('валидация отличает некорректный bodyGraph от отсутствующего', () => {
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ bodyGraph: { slug: 'broken' } }))),
      'invalid_ontology_body_graph',
    );
    expectContractCode(
      () => validateSchemaGraphContract(wrap(validConfig({ bodyGraph: { ...bodyGraph(), subSchemaClass: 'bad' } }))),
      'invalid_ontology_body_graph',
    );
  });
});
