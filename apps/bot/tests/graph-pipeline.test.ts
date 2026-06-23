/**
 * Тест оркестратора indexGameGraph (issue #328/#334/#363, Этап 6 плана graph-rag-plan.md).
 *
 * Проверяет сквозной offline-пайплайн «документы базы знаний -> граф со сводками
 * сообществ» на мок-провайдере LLM и мок-Neo4j (без сети и настоящей БД):
 * извлечение подграфа из документа, подокументный апсерт с провенансом
 * (sourceDocumentId), перечитывание полного графа, кластеризацию и полную замену
 * сводок сообществ. Также покрывает вырожденный случай «документов нет».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function record(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  };
}

let conceptRows: Record<string, unknown>[] = [];
let relationRows: Record<string, unknown>[] = [];

const neo4jMocks = vi.hoisted(() => {
  const readQuery = vi.fn();
  const writeQuery = vi.fn();
  return {
    readQuery,
    writeQuery,
    runNeo4jReadMock: vi.fn((work: (tx: { run: typeof readQuery }) => Promise<unknown>) =>
      work({ run: readQuery }),
    ),
    runNeo4jWriteMock: vi.fn((work: (tx: { run: typeof writeQuery }) => Promise<unknown>) =>
      work({ run: writeQuery }),
    ),
  };
});

const { readQuery, writeQuery, runNeo4jWriteMock } = neo4jMocks;

vi.mock('@tg-games/core/db/neo4j.js', () => ({
  runNeo4jRead: neo4jMocks.runNeo4jReadMock,
  runNeo4jWrite: neo4jMocks.runNeo4jWriteMock,
  closeNeo4j: vi.fn(),
  migrateNeo4j: vi.fn(),
}));

import { indexGameGraph } from '@tg-games/core/engine/graphPipeline.js';
import { invalidateOntologyCache } from '@tg-games/core/db/repositories/ontology.js';
import { invalidateCommunitiesCache } from '@tg-games/core/db/repositories/ontologyGraph.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const manifest = TEST_GAMES.bomj;

const EXTRACTION_JSON = JSON.stringify({
  entities: [
    { title: 'Коллектор', kind: 'место', synonyms: ['теплотрасса'], fact: 'Тёплое подземное укрытие зимой.' },
    { title: 'Мороз', kind: 'угроза', synonyms: [], fact: 'Зимой можно замёрзнуть насмерть.' },
  ],
  relations: [
    {
      from: 'Коллектор', to: 'Мороз', type: 'опасно_в',
      note: 'Без укрытия - смертельно.', condition: { season: 'зима' },
    },
  ],
});
const SUMMARY_JSON = JSON.stringify({
  title: 'Опасности зимы',
  summary: 'Холод убивает без укрытия - нужно тепло.',
});

const generateText = vi.fn(async (options: LLMRequestOptions): Promise<string> => {
  const system = options.systemInstruction ?? '';
  if (system.includes('аналитик-онтолог')) return EXTRACTION_JSON;
  if (system.includes('хранитель мира')) return SUMMARY_JSON;
  return '{}';
});
const provider: ILLMProvider = { name: 'stub', generateText };

function graphReadResult(cypher: string) {
  if (cypher.includes('MATCH (c:OntologyConcept')) {
    return Promise.resolve({
      records: conceptRows.map((row) => record({ c: { properties: row } })),
    });
  }
  if (cypher.includes('ONTOLOGY_RELATION')) {
    return Promise.resolve({
      records: relationRows.map((row) =>
        record({
          r: { properties: row },
          fromSlug: row.fromSlug,
          toSlug: row.toSlug,
        }),
      ),
    });
  }
  return Promise.resolve({ records: [] });
}

/**
 * Имитирует граф, который вернёт loadGameOntology после апсёрта: две связанные
 * вершины (origin='extracted') - кластеризация увидит ровно одно сообщество.
 */
function extractedGraphRows(): void {
  conceptRows = [
    {
      id: 'c1',
      gameId: manifest.id,
      slug: 'kollektor',
      kind: 'место',
      title: 'Коллектор',
      synonyms: ['теплотрасса'],
      fact: 'Тёплое подземное укрытие зимой.',
      weight: 1,
      sourceDocumentId: 'doc-1',
      origin: 'extracted',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    {
      id: 'c2',
      gameId: manifest.id,
      slug: 'moroz',
      kind: 'угроза',
      title: 'Мороз',
      synonyms: [],
      fact: 'Зимой можно замёрзнуть насмерть.',
      weight: 0.9,
      sourceDocumentId: 'doc-1',
      origin: 'extracted',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ];
  relationRows = [
    {
      id: 'r1',
      gameId: manifest.id,
      fromSlug: 'kollektor',
      toSlug: 'moroz',
      relation: 'опасно_в',
      weight: 0.9,
      conditionJson: JSON.stringify({ season: 'зима' }),
      note: 'Без укрытия - смертельно.',
      sourceDocumentId: 'doc-1',
      origin: 'extracted',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ];
}

beforeEach(() => {
  readQuery.mockReset();
  readQuery.mockImplementation(graphReadResult);
  writeQuery.mockReset();
  writeQuery.mockResolvedValue({ records: [record({ written: true, c: { properties: {} } })] });
  neo4jMocks.runNeo4jReadMock.mockClear();
  runNeo4jWriteMock.mockClear();
  generateText.mockClear();
  conceptRows = [];
  relationRows = [];
  invalidateOntologyCache(manifest.id);
  invalidateCommunitiesCache(manifest.id);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('indexGameGraph - оркестратор offline-индексации (issue #328/#334/#363)', () => {
  it('строит граф из документа и перестраивает сообщества со сводками', async () => {
    extractedGraphRows();
    const result = await indexGameGraph(provider, manifest, [
      { id: 'doc-1', title: 'Зимняя теплотрасса', content: 'Коллектор спасает от мороза зимой.' },
    ]);

    expect(result.documents).toBe(1);
    expect(result.concepts).toBe(2);
    expect(result.relations).toBe(1);
    expect(result.detected).toBe(1);
    expect(result.communities).toBe(1);

    const systems = generateText.mock.calls.map((c) => c[0].systemInstruction ?? '');
    expect(systems.some((s) => s.includes('аналитик-онтолог'))).toBe(true);
    expect(systems.some((s) => s.includes('хранитель мира'))).toBe(true);
    expect(result.llmLog).toHaveLength(2);

    const conceptMerge = writeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (c:OntologyConcept'),
    );
    expect((conceptMerge?.[1] as Record<string, unknown>).sourceDocumentId).toBe('doc-1');

    const cyphers = writeQuery.mock.calls.map((c) => String(c[0]));
    expect(cyphers.some((s) => s.includes('MATCH (c:GraphCommunity') && s.includes('DETACH DELETE c'))).toBe(true);
    expect(cyphers.some((s) => s.includes('CREATE (c:GraphCommunity'))).toBe(true);
  });

  it('без документов не запускает извлечение, но перестраивает сообщества по текущему графу', async () => {
    extractedGraphRows();
    const result = await indexGameGraph(provider, manifest, []);

    expect(result.documents).toBe(0);
    expect(result.concepts).toBe(0);
    expect(result.relations).toBe(0);
    expect(result.detected).toBe(1);
    expect(result.communities).toBe(1);

    const systems = generateText.mock.calls.map((c) => c[0].systemInstruction ?? '');
    expect(systems.some((s) => s.includes('аналитик-онтолог'))).toBe(false);
    expect(systems.some((s) => s.includes('хранитель мира'))).toBe(true);
    expect(runNeo4jWriteMock).toHaveBeenCalledTimes(1);
  });
});
