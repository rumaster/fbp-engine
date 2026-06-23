/**
 * Тесты репозитория Graph RAG (issue #328/#334/#363).
 *
 * Проверяют апсерт автоизвлечённого подграфа (origin='extracted', провенанс, не
 * перетирая authored), верификацию автором (extracted -> authored), CRUD/кеш
 * сообществ графа и расширение маппинга онтологии полями origin/sourceDocumentId.
 * Хранилище онтологии перенесено в Neo4j, поэтому тесты мокают Cypher-helper-ы.
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

const ontologyMocks = vi.hoisted(() => ({
  loadGameOntologyMock: vi.fn(),
  invalidateOntologyCacheMock: vi.fn(),
}));

vi.mock('@tg-games/core/db/neo4j.js', () => ({
  runNeo4jRead: neo4jMocks.runNeo4jReadMock,
  runNeo4jWrite: neo4jMocks.runNeo4jWriteMock,
  closeNeo4j: vi.fn(),
  migrateNeo4j: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/ontology.js', async (importActual) => {
  const actual = await importActual<typeof import('@tg-games/core/db/repositories/ontology.js')>();
  return {
    ...actual,
    loadGameOntology: ontologyMocks.loadGameOntologyMock,
    invalidateOntologyCache: ontologyMocks.invalidateOntologyCacheMock,
  };
});

import {
  loadGameCommunities,
  listGraphCommunities,
  invalidateCommunitiesCache,
  replaceGraphCommunities,
  seedGraphCommunities,
  applyExtractedGraph,
  verifyOntologyConcept,
  verifyOntologyRelation,
} from '@tg-games/core/db/repositories/ontologyGraph.js';
import { listOntologyConcepts } from '@tg-games/core/db/repositories/ontology.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ records: [] });
  writeQueryMock.mockReset();
  writeQueryMock.mockResolvedValue({ records: [record({ written: true, c: { properties: {} } })] });
  runNeo4jReadMock.mockClear();
  runNeo4jWriteMock.mockClear();
  invalidateCommunitiesCache('test-game');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('сообщества графа (#328/#363)', () => {
  const communityNode = {
    properties: {
      id: 'co1',
      gameId: 'test-game',
      level: 0,
      title: 'Опасности зимы',
      summary: 'Холод убивает без укрытия.',
      memberSlugs: ['moroz', 'kollektor'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  };

  it('listGraphCommunities мапит узлы Neo4j в домен', async () => {
    queryMock.mockResolvedValueOnce({ records: [record({ c: communityNode })] });
    const list = await listGraphCommunities('test-game');
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Опасности зимы');
    expect(list[0].memberSlugs).toEqual(['moroz', 'kollektor']);
    expect(list[0].level).toBe(0);
  });

  it('loadGameCommunities кеширует на процесс', async () => {
    queryMock.mockResolvedValueOnce({ records: [record({ c: communityNode })] });
    await loadGameCommunities('test-game');
    const calls = queryMock.mock.calls.length;
    await loadGameCommunities('test-game');
    expect(queryMock.mock.calls.length).toBe(calls);
  });

  it('replaceGraphCommunities перестраивает узлы GraphCommunity', async () => {
    const result = await replaceGraphCommunities('test-game', [
      { title: 'C1', summary: 's1', memberSlugs: ['a', 'b'] },
      { level: 1, title: 'C2', summary: 's2', memberSlugs: ['c'] },
    ]);
    const cyphers = writeQueryMock.mock.calls.map((c) => c[0] as string);
    expect(runNeo4jWriteMock).toHaveBeenCalledOnce();
    expect(cyphers.some((s) => s.includes('MATCH (c:GraphCommunity') && s.includes('DETACH DELETE c'))).toBe(true);
    expect(cyphers.some((s) => s.includes('CREATE (c:GraphCommunity'))).toBe(true);
    expect(result.communities).toBe(2);
  });

  it('replaceGraphCommunities сбрасывает кеш', async () => {
    queryMock.mockResolvedValueOnce({ records: [record({ c: communityNode })] });
    await loadGameCommunities('test-game');
    const before = queryMock.mock.calls.length;
    await replaceGraphCommunities('test-game', []);
    queryMock.mockResolvedValueOnce({ records: [] });
    await loadGameCommunities('test-game');
    expect(queryMock.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('applyExtractedGraph (#328/#363)', () => {
  it('апсертит с origin=extracted, провенансом и защитой authored', async () => {
    const result = await applyExtractedGraph(
      'test-game',
      {
        concepts: [{ slug: 'moroz', kind: 'угроза', title: 'Мороз', fact: 'Холод убивает' }],
        relations: [{ fromSlug: 'moroz', toSlug: 'kollektor', relation: 'опасно_в' }],
      },
      'doc-uuid-7',
    );
    expect(runNeo4jWriteMock).toHaveBeenCalledOnce();
    const cyphers = writeQueryMock.mock.calls.map((c) => c[0] as string);
    const conceptCypher = cyphers.find((s) => s.includes('MERGE (c:OntologyConcept'));
    expect(conceptCypher).toContain("c.origin = 'extracted'");
    expect(conceptCypher).toContain("CASE WHEN c.origin = 'extracted'");
    const relationCypher = cyphers.find((s) => s.includes('MERGE (from)-[r:ONTOLOGY_RELATION'));
    expect(relationCypher).toContain("r.origin = 'extracted'");
    expect(relationCypher).toContain("CASE WHEN r.origin = 'extracted'");
    const conceptParams = writeQueryMock.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (c:OntologyConcept'),
    )?.[1] as Record<string, unknown>;
    expect(conceptParams.sourceDocumentId).toBe('doc-uuid-7');
    expect(result.concepts).toBe(1);
    expect(result.relations).toBe(1);
  });

  it('пустой подграф не открывает write-транзакцию', async () => {
    const result = await applyExtractedGraph('test-game', { concepts: [], relations: [] }, null);
    expect(runNeo4jWriteMock).not.toHaveBeenCalled();
    expect(result).toEqual({ concepts: 0, relations: 0 });
  });

  it('пробрасывает ошибку Neo4j при сбое', async () => {
    writeQueryMock.mockImplementation((cypher: string) => {
      if (cypher.includes('MERGE (c:OntologyConcept')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ records: [] });
    });
    await expect(
      applyExtractedGraph('test-game', { concepts: [{ slug: 'a', kind: 'k', title: 'A' }], relations: [] }, null),
    ).rejects.toThrow('boom');
    expect(runNeo4jWriteMock).toHaveBeenCalledOnce();
  });
});

describe('верификация автором (#328/#363)', () => {
  it('verifyOntologyConcept помечает extracted -> authored', async () => {
    writeQueryMock.mockResolvedValueOnce({ records: [record({ c: { properties: {} } })] });
    const ok = await verifyOntologyConcept('test-game', 'c1');
    expect(ok).toBe(true);
    const cypher = writeQueryMock.mock.calls[0][0] as string;
    expect(cypher).toContain("origin: 'extracted'");
    expect(cypher).toContain("SET c.origin = 'authored'");
  });

  it('verifyOntologyRelation возвращает false, если связь не извлечённая', async () => {
    writeQueryMock.mockResolvedValueOnce({ records: [] });
    const ok = await verifyOntologyRelation('test-game', 'r1');
    expect(ok).toBe(false);
  });
});

describe('seedGraphCommunities (#371)', () => {
  const ontologyWithEdges = {
    concepts: [
      { slug: 'moroz', kind: 'угроза', title: 'Мороз', weight: 2, synonyms: [], fact: '' },
      { slug: 'noch', kind: 'угроза', title: 'Ночь', weight: 1, synonyms: [], fact: '' },
      { slug: 'eda', kind: 'ресурс', title: 'Еда', weight: 1, synonyms: [], fact: '' },
    ],
    relations: [
      { fromSlug: 'moroz', toSlug: 'noch', relation: 'совпадает_с', weight: 1, conditionJson: null, note: '' },
    ],
  };

  beforeEach(() => {
    ontologyMocks.loadGameOntologyMock.mockResolvedValue(ontologyWithEdges);
  });

  it('создаёт кластеры, когда GraphCommunity отсутствуют', async () => {
    // нет существующих сообществ
    queryMock.mockResolvedValueOnce({ records: [] });
    // replaceGraphCommunities: DELETE + 1 CREATE (moroz+noch кластер; eda — одиночка)
    writeQueryMock
      .mockResolvedValueOnce({ records: [] }) // DELETE
      .mockResolvedValueOnce({ records: [record({ c: {} })] }); // CREATE

    const result = await seedGraphCommunities('test-game');

    expect(ontologyMocks.loadGameOntologyMock).toHaveBeenCalledWith('test-game');
    expect(result.communities).toBe(1);
  });

  it('ничего не делает, если сообщества уже есть (идемпотентность)', async () => {
    const communityNode = {
      properties: {
        id: 'co1', gameId: 'test-game', level: 0,
        title: 'Опасности зимы', summary: 'Холод.',
        memberSlugs: ['moroz', 'noch'],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    };
    queryMock.mockResolvedValueOnce({ records: [record({ c: communityNode })] });

    const result = await seedGraphCommunities('test-game');

    expect(ontologyMocks.loadGameOntologyMock).not.toHaveBeenCalled();
    expect(runNeo4jWriteMock).not.toHaveBeenCalled();
    expect(result.communities).toBe(0);
  });

  it('возвращает 0, если в онтологии нет рёбер (не может создать кластеры ≥2)', async () => {
    queryMock.mockResolvedValueOnce({ records: [] });
    ontologyMocks.loadGameOntologyMock.mockResolvedValueOnce({
      concepts: [{ slug: 'a', kind: 'k', title: 'A', weight: 1, synonyms: [], fact: '' }],
      relations: [],
    });

    const result = await seedGraphCommunities('test-game');

    expect(runNeo4jWriteMock).not.toHaveBeenCalled();
    expect(result.communities).toBe(0);
  });
});

describe('маппинг онтологии с провенансом (#328/#363)', () => {
  it('listOntologyConcepts отдаёт origin и sourceDocumentId', async () => {
    queryMock.mockResolvedValueOnce({
      records: [
        record({
          c: {
            properties: {
              id: 'c1',
              gameId: 'test-game',
              slug: 'moroz',
              kind: 'угроза',
              title: 'Мороз',
              synonyms: [],
              fact: 'Холод',
              weight: '1',
              sourceDocumentId: 'doc-1',
              origin: 'extracted',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          },
        }),
      ],
    });
    const list = await listOntologyConcepts('test-game');
    expect(list[0].origin).toBe('extracted');
    expect(list[0].sourceDocumentId).toBe('doc-1');
    expect(String(queryMock.mock.calls[0][0])).toContain('MATCH (c:OntologyConcept');
  });
});
