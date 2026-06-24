import { describe, expect, it } from 'vitest';

import * as contract from '../index.mjs';

const removedMainType = ['ontology', 'query'].join('_');
const removedInternalTypes = [
  ['ontology', 'anchor', 'match'].join('_'),
  ['ontology', 'frontier', 'expand'].join('_'),
  ['ontology', 'budget', 'select'].join('_'),
  ['ontology', 'context', 'build'].join('_'),
];

describe('schema-contract: удалённый graph retriever', () => {
  it('не регистрирует удалённые типы узлов в контракте и палитре', () => {
    for (const nodeType of [removedMainType, ...removedInternalTypes]) {
      expect(contract.isNodeType(nodeType)).toBe(false);
      expect(contract.NODE_TYPES).not.toContain(nodeType);
      expect(contract.NODE_PALETTE).not.toContain(nodeType);
      expect(contract.NODE_TYPE_LABELS).not.toHaveProperty(nodeType);
    }
  });

  it('не экспортирует режимы и helpers удалённого ретривера', () => {
    const removedExports = [
      ['ONTOLOGY', 'QUERY', 'MODES'].join('_'),
      ['DEFAULT', 'ONTOLOGY', 'QUERY', 'MODE'].join('_'),
      ['ONTOLOGY', 'QUERY', 'MODE', 'LABELS'].join('_'),
      ['is', 'Ontology', 'Query', 'Mode'].join(''),
      ['ontology', 'Query', 'Mode'].join(''),
    ];

    for (const exportName of removedExports) {
      expect(contract).not.toHaveProperty(exportName);
    }
  });

  it('отклоняет графы с удалёнными типами узлов', () => {
    const graph = {
      version: 1,
      slug: 'removed-retriever',
      schemaType: 'action',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'removed', type: removedMainType, position: { x: 200, y: 0 }, config: {} },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start:exec->removed:exec', from: 'start', fromPort: 'exec', to: 'removed', toPort: 'exec' },
        { id: 'removed:exec->end:exec', from: 'removed', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
    };

    expect(() => contract.validateSchemaGraphContract(graph as never)).toThrow(contract.SchemaContractError);
  });
});
