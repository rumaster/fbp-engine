/**
 * Тесты внутреннего graph_query для agentic Graph RAG (#386).
 *
 * Узел должен уметь грузить вершины по id и выбирать якоря по embedding-ключам,
 * возвращая компактный формат для LLM-шагов graph_rag. Neo4j здесь мокнут: тест
 * проверяет маппинг и ранжирование без внешней БД.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function record(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  };
}

const neo4jMocks = vi.hoisted(() => {
  const queryMock = vi.fn();
  return {
    queryMock,
    runNeo4jReadMock: vi.fn((work: (tx: { run: typeof queryMock }) => Promise<unknown>) =>
      work({ run: queryMock }),
    ),
  };
});

const { queryMock, runNeo4jReadMock } = neo4jMocks;

vi.mock('@tg-games/core/db/neo4j.js', () => ({
  runNeo4jRead: neo4jMocks.runNeo4jReadMock,
  closeNeo4j: vi.fn(),
  migrateNeo4j: vi.fn(),
}));

import { queryKnowledgeGraph } from '@tg-games/core/db/repositories/agenticGraphRag.js';
import type { IEmbeddingProvider } from '@tg-games/core/llm/embeddings.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ records: [] });
  runNeo4jReadMock.mockClear();
});

function conceptNode(props: Record<string, unknown>) {
  return { properties: props };
}

function relationEdge(props: Record<string, unknown>) {
  return { properties: props };
}

describe('agentic graph_query (#386)', () => {
  it('загружает вершину по id и отдаёт соседей в компактном формате', async () => {
    queryMock.mockResolvedValueOnce({
      records: [
        record({
          c: conceptNode({
            id: 'c1',
            slug: 'moroz',
            title: 'Мороз',
            fact: 'Опасен без укрытия.',
          }),
          edges: [
            {
              relation: relationEdge({ relation: 'опасен_в', note: 'Усиливается ночью' }),
              neighbor: conceptNode({
                id: 'c2',
                slug: 'noch',
                title: 'Ночь',
                fact: 'Температура падает.',
              }),
            },
          ],
        }),
      ],
    });

    const result = await queryKnowledgeGraph({ gameId: 'game-1', keys: ['c1'] });

    expect(result).toEqual([
      {
        id: 'c1',
        concept: 'Мороз',
        description: 'Опасен без укрытия.',
        score: expect.any(Number),
        edges: [
          {
            relationType: 'опасен_в',
            neighborId: 'c2',
            neighbor: 'Ночь',
            neighborDescription: 'Температура падает.',
          },
        ],
      },
    ]);
  });

  it('ранжирует текстовые ключи по keyEmbeddings, когда embedding provider доступен', async () => {
    queryMock.mockResolvedValueOnce({
      records: [
        record({
          c: conceptNode({
            id: 'cold',
            concept: 'Холод',
            description: 'Низкая температура.',
            keys: ['мороз'],
            keyEmbeddings: [[1, 0]],
          }),
          edges: [],
        }),
        record({
          c: conceptNode({
            id: 'shelter',
            concept: 'Укрытие',
            description: 'Место для защиты.',
            keys: ['убежище'],
            keyEmbeddings: [[0, 1]],
          }),
          edges: [],
        }),
      ],
    });
    const embeddingProvider: IEmbeddingProvider = {
      model: 'test-embedding',
      embed: vi.fn(async () => ({ embeddings: [[0, 1]] })),
    };

    const result = await queryKnowledgeGraph({
      gameId: 'game-1',
      keys: ['где спрятаться'],
      embeddingProvider,
      topK: 1,
    });

    expect(embeddingProvider.embed).toHaveBeenCalledWith(['где спрятаться']);
    expect(result.map((item) => item.id)).toEqual(['shelter']);
  });
});
