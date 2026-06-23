import { describe, expect, it, vi } from 'vitest';
import { neo4jMigrations, postgresMigrations } from '@tg-games/core/db/migrations/registry.js';

/**
 * Тесты реестра версионных миграций (issue #336, О4).
 *
 * Neo4j-baseline вынесен из inline-Cypher в файл
 * `migrations/cypher/0001_baseline_constraints_and_indexes.cypher`. Проверяем, что
 * реестр читает файл и выполняет операторы по одному (Neo4j `tx.run` принимает
 * ровно один statement за вызов), разбивая текст по `;` и игнорируя комментарии.
 */
describe('реестр миграций: Cypher baseline вынесен в файл (issue #336, О4)', () => {
  it('baseline графа выполняет ровно 5 операторов (4 CONSTRAINT + 1 INDEX)', async () => {
    const baseline = neo4jMigrations.find((m) => m.version === '0001');
    expect(baseline?.name).toBe('baseline_constraints_and_indexes');

    const run = vi.fn(async () => ({ records: [] }));
    await baseline!.run({ run } as never);

    expect(run).toHaveBeenCalledTimes(5);
    const statements = run.mock.calls.map((c) => c[0] as string);

    // Каждый оператор передаётся отдельным вызовом, без хвостовой `;`,
    // комментарии (`//`) отброшены.
    for (const statement of statements) {
      expect(statement).not.toContain(';');
      expect(statement).not.toContain('//');
      expect(statement.trim().length).toBeGreaterThan(0);
    }

    const joined = statements.join('\n');
    expect(joined).toContain('CREATE CONSTRAINT ontology_concept_id');
    expect(joined).toContain('CREATE CONSTRAINT ontology_concept_game_slug');
    expect(joined).toContain('CREATE CONSTRAINT ontology_relation_id');
    expect(joined).toContain('CREATE CONSTRAINT graph_community_id');
    expect(joined).toContain('CREATE INDEX graph_community_game');

    // Каждый оператор идемпотентен.
    expect(statements.every((s) => s.includes('IF NOT EXISTS'))).toBe(true);
  });
});

describe('реестр миграций: Postgres baseline (issue #336)', () => {
  it('нулевая миграция — baseline_schema, непривязанная к транзакции', () => {
    const baseline = postgresMigrations.find((m) => m.version === '0001');
    expect(baseline?.name).toBe('baseline_schema');
    expect(baseline?.transactional).toBe(false);
  });
});
