import { describe, it, expect } from 'vitest';
// @ts-expect-error — пакет на чистом ESM без локальных типов в тесте.
import { getNodePortDefinitions, getNodeInputPortType } from '../index.mjs';

/**
 * Контракт узла knowledge_query с тэгами (issue #321): у узла появляется вход
 * `tags` типа `string_array`, согласованный с фильтром экспертизы в движке.
 */
describe('knowledge_query: вход tags (issue #321)', () => {
  const node = { id: 'kq', type: 'knowledge_query', config: {} };
  const graph = { nodes: [node], edges: [], variables: {} };

  it('getNodePortDefinitions включает вход tags типа string_array', () => {
    const { inputs } = getNodePortDefinitions(node, graph) as {
      inputs: Array<{ id: string; type: string }>;
    };
    const tags = inputs.find((p) => p.id === 'tags');
    expect(tags).toBeDefined();
    expect(tags?.type).toBe('string_array');
  });

  it('рядом сохраняется существующий вход keys типа string_array', () => {
    const { inputs } = getNodePortDefinitions(node, graph) as {
      inputs: Array<{ id: string; type: string }>;
    };
    const keys = inputs.find((p) => p.id === 'keys');
    expect(keys?.type).toBe('string_array');
  });

  it('getNodeInputPortType для tags возвращает string_array', () => {
    expect(getNodeInputPortType(graph, node, 'tags')).toBe('string_array');
  });
});
