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

  it('seeds only four active global schemas on a clean database', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await migratePromptTemplatesToSchemas();

    const insertCalls = queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO schemas'));
    expect(insertCalls).toHaveLength(4);
    expect(insertCalls.map(([, params]) => (params as unknown[])[0])).toEqual([
      'action',
      'hint',
      'illustration',
      'support',
    ]);
    expect(insertCalls.map(([, params]) => (params as unknown[])[1])).toEqual([
      'action',
      'hint',
      'illustration',
      'support',
    ]);
    expect(insertCalls.map(([, params]) => (params as unknown[])[2])).toEqual([
      null,
      null,
      null,
      null,
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
  });
});
