/**
 * Тесты репозитория концептуальной онтологии в Neo4j (issue #363).
 *
 * Проверяют, что loadGameOntology собирает граф и кеширует его на процесс,
 * CRUD сбрасывает кеш, а seedGameOntology идемпотентно создаёт концепты/связи
 * через Cypher. Внешний Neo4j не нужен: транзакционные helper-функции мокнуты.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function record(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  };
}

const neo4jMocks = vi.hoisted(() => {
  const queryMock = vi.fn();
  const writeQueryMock = vi.fn();
  return {
    queryMock,
    writeQueryMock,
    runNeo4jReadMock: vi.fn((work: (tx: { run: typeof queryMock }) => Promise<unknown>) =>
      work({ run: queryMock }),
    ),
    runNeo4jWriteMock: vi.fn((work: (tx: { run: typeof writeQueryMock }) => Promise<unknown>) =>
      work({ run: writeQueryMock }),
    ),
  };
});

const { queryMock, writeQueryMock, runNeo4jReadMock, runNeo4jWriteMock } = neo4jMocks;

vi.mock('@tg-games/core/db/neo4j.js', () => ({
  runNeo4jRead: neo4jMocks.runNeo4jReadMock,
  runNeo4jWrite: neo4jMocks.runNeo4jWriteMock,
  closeNeo4j: vi.fn(),
  migrateNeo4j: vi.fn(),
}));

import {
  loadGameOntology,
  invalidateOntologyCache,
  createOntologyConcept,
  seedGameOntology,
} from '@tg-games/core/db/repositories/ontology.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ records: [] });
  writeQueryMock.mockReset();
  writeQueryMock.mockResolvedValue({ records: [record({ c: { properties: {} }, r: { properties: {} } })] });
  runNeo4jReadMock.mockClear();
  runNeo4jWriteMock.mockClear();
  invalidateOntologyCache('test-game');
  invalidateOntologyCache('seed-game');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadGameOntology (#363)', () => {
  it('собирает граф из концептов и связей', async () => {
    queryMock.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (c:OntologyConcept')) {
        return Promise.resolve({
          records: [
            record({
              c: {
                properties: {
                  id: 'c1',
                  gameId: 'test-game',
                  slug: 'kollektor',
                  kind: 'место',
                  title: 'Коллектор',
                  synonyms: ['труба'],
                  fact: 'Укрытие',
                  weight: '1',
                  origin: 'authored',
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                },
              },
            }),
          ],
        });
      }
      return Promise.resolve({
        records: [
          record({
            r: {
              properties: {
                id: 'r1',
                gameId: 'test-game',
                relation: 'находится_в',
                weight: '1',
                conditionJson: null,
                note: '',
                origin: 'authored',
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
              },
            },
            fromSlug: 'nochleg',
            toSlug: 'kollektor',
          }),
        ],
      });
    });

    const g = await loadGameOntology('test-game');
    expect(g.concepts).toHaveLength(1);
    expect(g.concepts[0].weight).toBe(1);
    expect(g.concepts[0].synonyms).toEqual(['труба']);
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0].relation).toBe('находится_в');
  });

  it('кеширует граф на процесс — повторный вызов не бьёт в Neo4j', async () => {
    await loadGameOntology('test-game');
    const callsAfterFirst = queryMock.mock.calls.length;
    await loadGameOntology('test-game');
    expect(queryMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('CRUD сбрасывает кеш игры', async () => {
    await loadGameOntology('test-game');
    const before = queryMock.mock.calls.length;
    writeQueryMock.mockResolvedValueOnce({
      records: [
        record({
          c: {
            properties: {
              id: 'c2',
              gameId: 'test-game',
              slug: 'eda',
              kind: 'потребность',
              title: 'Еда',
              synonyms: [],
              fact: '',
              weight: '1',
              origin: 'authored',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          },
        }),
      ],
    });
    await createOntologyConcept('test-game', { slug: 'eda', kind: 'потребность', title: 'Еда' });
    await loadGameOntology('test-game');
    expect(queryMock.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('seedGameOntology (#363)', () => {
  it('создаёт концепты и связи через Cypher', async () => {
    const result = await seedGameOntology('seed-game', {
      concepts: [{ slug: 'a', kind: 'k', title: 'A' }],
      relations: [{ fromSlug: 'a', toSlug: 'b', relation: 'требует' }],
    });
    expect(runNeo4jWriteMock).toHaveBeenCalledOnce();
    const cyphers = writeQueryMock.mock.calls.map((c) => c[0] as string);
    expect(cyphers.some((s) => s.includes('CREATE (c:OntologyConcept'))).toBe(true);
    expect(cyphers.some((s) => s.includes('CREATE (from)-[r:ONTOLOGY_RELATION'))).toBe(true);
    expect(result.concepts).toBe(1);
    expect(result.relations).toBe(1);
  });

  it('пустой сид не открывает write-транзакцию', async () => {
    const result = await seedGameOntology('seed-game', { concepts: [], relations: [] });
    expect(runNeo4jWriteMock).not.toHaveBeenCalled();
    expect(result).toEqual({ concepts: 0, relations: 0 });
  });

  it('пробрасывает ошибку Neo4j при сбое', async () => {
    writeQueryMock.mockImplementation((cypher: string) => {
      if (cypher.includes('CREATE (c:OntologyConcept')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ records: [] });
    });
    await expect(
      seedGameOntology('seed-game', { concepts: [{ slug: 'a', kind: 'k', title: 'A' }], relations: [] }),
    ).rejects.toThrow('boom');
  });
});
