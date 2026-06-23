import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('@tg-games/core/db/pool.js', () => ({
  getPool: () => ({ query: queryMock }),
}));

import { migratePromptTemplatesToSchemas } from '@tg-games/core/db/migrations/M001_prompt_templates_to_schemas.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('migratePromptTemplatesToSchemas', () => {
  it('casts seed parameters so PostgreSQL does not infer conflicting types', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await migratePromptTemplatesToSchemas();

    const insertSql = queryMock.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('INSERT INTO schemas'));

    expect(insertSql).toBeDefined();
    expect(insertSql).toContain('$1::varchar(100)');
    expect(insertSql).toContain('$2::schema_type');
    expect(insertSql).toContain('$3::schema_class');
    expect(insertSql).toContain('$4::jsonb');
    expect(insertSql).toContain('$5::text');
    expect(insertSql).toMatch(/schema_slug = \$1::varchar\(100\)/);
  });

  it('seeds four active global schemas and game ontoligy-example sub-schema on a clean database', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await migratePromptTemplatesToSchemas();

    const insertCalls = queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO schemas'));
    expect(insertCalls).toHaveLength(5);
    expect(insertCalls.map(([, params]) => (params as unknown[])[0])).toEqual([
      'action',
      'hint',
      'illustration',
      'support',
      'ontoligy-example',
    ]);
    expect(insertCalls.map(([, params]) => (params as unknown[])[1])).toEqual([
      'action',
      'hint',
      'illustration',
      'support',
      null,
    ]);
    expect(insertCalls.map(([, params]) => (params as unknown[])[2])).toEqual([
      null,
      null,
      null,
      null,
      'game',
    ]);
    for (const [, params] of insertCalls) {
      const graph = JSON.parse(String((params as unknown[])[3])) as {
        slug: string;
        schemaType?: string;
        subSchemaClass?: string;
        variables: unknown;
      };
      expect(graph.slug).toBe((params as unknown[])[0]);
      expect(graph.schemaType ?? null).toBe((params as unknown[])[1]);
      expect(graph.subSchemaClass ?? null).toBe((params as unknown[])[2]);
      expect(graph.variables).toEqual({});
    }
    expect((insertCalls[0][1] as unknown[])[4]).toEqual(expect.stringContaining('Глобальная схема'));
    expect((insertCalls[4][1] as unknown[])[4]).toEqual(expect.stringContaining('ontoligy-example'));

    const ontologyExample = JSON.parse(String((insertCalls[4][1] as unknown[])[3])) as {
      slug: string;
      subSchemaClass?: string;
      nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
      edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>;
    };
    expect(ontologyExample.slug).toBe('ontoligy-example');
    expect(ontologyExample.subSchemaClass).toBe('game');
    expect(ontologyExample.nodes.map((node) => node.type)).toEqual([
      'start',
      'manifest',
      'game_state_read',
      'transform',
      'ontology_query',
      'end',
    ]);
    expect(ontologyExample.nodes.find((node) => node.id === 'start')?.config?.outputs).toEqual([
      { id: 'action', label: 'Action', type: 'string' },
    ]);
    expect(ontologyExample.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'manifest', fromPort: 'manifest', to: 'prepare_query', toPort: 'manifest' }),
        expect.objectContaining({ from: 'state_read', fromPort: 'state', to: 'prepare_query', toPort: 'state' }),
        expect.objectContaining({ from: 'prepare_query', fromPort: 'query', to: 'ontology_query', toPort: 'query' }),
        expect.objectContaining({ from: 'prepare_query', fromPort: 'graphScope', to: 'ontology_query', toPort: 'graphScope' }),
        expect.objectContaining({ from: 'prepare_query', fromPort: 'options', to: 'ontology_query', toPort: 'options' }),
        expect.objectContaining({ from: 'prepare_query', fromPort: 'mode', to: 'ontology_query', toPort: 'mode' }),
      ]),
    );
  });
});
