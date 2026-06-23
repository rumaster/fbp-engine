/**
 * Тест узла ontology_query в движке схем (issue #323).
 *
 * Проверяет сквозной путь: движок загружает граф онтологии игры (через мок-Neo4j),
 * получает явные query/graphScope/options, извлекает подграф и кладёт текстовый блок
 * в выход `expertise` — без провайдера эмбеддингов (база не зависит от RAG).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    runNeo4jWriteMock: vi.fn(),
  };
});

const { queryMock } = neo4jMocks;

vi.mock('@tg-games/core/db/neo4j.js', () => ({
  runNeo4jRead: neo4jMocks.runNeo4jReadMock,
  runNeo4jWrite: neo4jMocks.runNeo4jWriteMock,
  closeNeo4j: vi.fn(),
  migrateNeo4j: vi.fn(),
}));

import {
  executeSchema,
  type SchemaExecutionContext,
  type SchemaGraph,
} from '@tg-games/core/engine/schemaEngine.js';
import {
  buildDefaultOntologyExampleSubSchema,
  buildOntologyQueryTraversalBodyGraph,
} from '@tg-games/core/db/migrations/M001_prompt_templates_to_schemas.js';
import { invalidateOntologyCache } from '@tg-games/core/db/repositories/ontology.js';
import { invalidateCommunitiesCache } from '@tg-games/core/db/repositories/ontologyGraph.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameState } from '@tg-games/core/types.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const manifest = TEST_GAMES.bomj;

const provider: ILLMProvider = { name: 'stub', async generateText() { return ''; } };

const traversalOptions = {
  depth: 2,
  decay: 0.5,
  maxConcepts: 12,
  maxRelations: 16,
};

function ontologyQueryConfig(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'local',
    graphScope: { type: 'game', gameId: manifest.id },
    query: 'Коллектор',
    traversalContext: { season: 'зима', location: 'Коллектор', timeOfDay: 'ночь' },
    options: traversalOptions,
    bodyGraph: buildOntologyQueryTraversalBodyGraph(`test_ontology_query_body_${String(patch.mode ?? 'local')}`),
    ...patch,
  };
}

function state(): GameState {
  return {
    location: 'Коллектор',
    narrative: 'старт',
    character: { hp: 80, max_hp: 100, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'зима', date: '1 января', time: '02:00', time_of_day: 'ночь' },
    turn_count: 1,
  };
}

const graph: SchemaGraph = {
  version: 1,
  schemaType: 'action',
  slug: 'ontology_test',
  variables: {},
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
    { id: 'oq', type: 'ontology_query', position: { x: 200, y: 0 }, config: ontologyQueryConfig() },
    { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'start->oq', from: 'start', fromPort: 'exec', to: 'oq', toPort: 'exec' },
    { id: 'oq->end', from: 'oq', fromPort: 'exec', to: 'end', toPort: 'exec' },
    { id: 'expertise', from: 'oq', fromPort: 'expertise', to: 'end', toPort: 'narrative' },
  ],
};

function ctx(inputs: Record<string, unknown>): SchemaExecutionContext {
  return {
    inputs,
    nodeOutputs: new Map(),
    variables: new Map(),
    llmLog: [],
    provider,
    manifest,
    state: state(),
    maxRetries: 1,
  };
}

function mockGraphRows() {
  queryMock.mockImplementation((cypher: string) => {
    if (cypher.includes('MATCH (c:OntologyConcept')) {
      return Promise.resolve({
        records: [
          record({
            c: {
              properties: {
                id: 'c1', gameId: manifest.id, slug: 'kollektor', kind: 'место',
                title: 'Коллектор', synonyms: ['теплотрасса'], fact: 'Тёплое подземное укрытие зимой.',
                weight: '1', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
              },
            },
          }),
          record({
            c: {
              properties: {
                id: 'c2', gameId: manifest.id, slug: 'moroz', kind: 'угроза',
                title: 'Мороз', synonyms: [], fact: 'Зимой можно замёрзнуть насмерть.',
                weight: '0.9', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
              },
            },
          }),
        ],
      });
    }
    if (cypher.includes('MATCH (c:GraphCommunity')) {
      return Promise.resolve({
        records: [
          record({
            c: {
              properties: {
                id: 'gc1', gameId: manifest.id, level: 0, title: 'Опасности зимы',
                summary: 'Холод убивает без укрытия — нужно тепло.',
                memberSlugs: ['moroz', 'kollektor'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
              },
            },
          }),
          record({
            c: {
              properties: {
                id: 'gc2', gameId: manifest.id, level: 0, title: 'Документы',
                summary: 'Без паспорта закрыты приюты.',
                memberSlugs: ['pasport', 'priyut'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
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
              id: 'r1', gameId: manifest.id,
              relation: 'опасно_в', weight: '0.9', conditionJson: JSON.stringify({ season: 'зима' }),
              note: 'Без укрытия — смертельно.', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
            },
          },
          fromSlug: 'kollektor',
          toSlug: 'moroz',
        }),
      ],
    });
  });
}

beforeEach(() => {
  queryMock.mockReset();
  invalidateOntologyCache(manifest.id);
  invalidateCommunitiesCache(manifest.id);
  mockGraphRows();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ontology_query в движке (issue #323)', () => {
  it('кладёт связный подграф в выход expertise по явному query', async () => {
    // Query «Коллектор» совпадает с заголовком концепта → якорь; traversalContext
    // с зимой активирует условную связь «опасно в» к морозу.
    const outputs = await executeSchema(graph, ctx({ action: 'осматриваюсь' }));
    const expertise = String(outputs.narrative);
    expect(expertise).toContain('Коллектор: Тёплое подземное укрытие');
    expect(expertise).toContain('Мороз');
    expect(expertise).toContain('опасно в');
  });

  it('не требует провайдера эмбеддингов (база не зависит от RAG)', async () => {
    const context = ctx({ action: 'осматриваюсь' });
    expect(context.embeddingProvider).toBeUndefined();
    await expect(executeSchema(graph, context)).resolves.toBeDefined();
  });

  it('пустой граф даёт явную пометку об отсутствии знаний', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ records: [] });
    invalidateOntologyCache(manifest.id);
    const outputs = await executeSchema(graph, ctx({ action: 'осматриваюсь' }));
    expect(String(outputs.narrative)).toBe('Подходящих знаний о мире не найдено.');
  });

  it('загружает граф по явному graphScope, а не по ctx.manifest.id', async () => {
    const context = ctx({ action: 'осматриваюсь' });
    context.manifest = { ...manifest, id: 'wrong-game-id' };

    await executeSchema(graph, context);

    const gameIds = queryMock.mock.calls
      .map(([, params]) => (params as { gameId?: string } | undefined)?.gameId)
      .filter(Boolean);
    expect(gameIds).toContain(manifest.id);
    expect(gameIds).not.toContain('wrong-game-id');
  });
});

describe('ontoligy-example: игровая обвязка ontology_query (issue #375)', () => {
  it('принимает только action и готовит запрос из manifest + game_state_read внутри суб-схемы', async () => {
    const subGraph = buildDefaultOntologyExampleSubSchema();
    const outputs = await executeSchema(
      subGraph,
      ctx({ action: 'спуститься в Коллектор и спрятаться от мороза' }),
    );

    expect(subGraph).toMatchObject({ slug: 'ontoligy-example', subSchemaClass: 'game' });
    expect(subGraph.nodes.find((node) => node.id === 'start')?.config.outputs).toEqual([
      { id: 'action', label: 'Action', type: 'string' },
    ]);
    expect(String(outputs.result)).toContain('Локальный контекст (подграф сцены):');
    expect(String(outputs.result)).toContain('Глобальный обзор (сводки сообществ):');
    expect(String(outputs.expertise)).toContain('Коллектор: Тёплое подземное укрытие');
    expect(String(outputs.expertise)).toContain('Мороз');

    const gameIds = queryMock.mock.calls
      .map(([, params]) => (params as { gameId?: string } | undefined)?.gameId)
      .filter(Boolean);
    expect(gameIds).toContain(manifest.id);
  });
});

/**
 * Режим ретрива config.mode и выход graph_context (issue #334, Graph RAG).
 * Узел отдаёт второй блок graph_context; здесь он подключён к входу narrative,
 * чтобы проверить сборку по каждому режиму на сквозном пути движка.
 */
describe('ontology_query: режим mode и выход graph_context (issue #334)', () => {
  function graphWithMode(mode: string): SchemaGraph {
    return {
      version: 1,
      schemaType: 'action',
      slug: 'ontology_mode_test',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'oq', type: 'ontology_query', position: { x: 200, y: 0 }, config: ontologyQueryConfig({ mode }) },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->oq', from: 'start', fromPort: 'exec', to: 'oq', toPort: 'exec' },
        { id: 'oq->end', from: 'oq', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'gc', from: 'oq', fromPort: 'graph_context', to: 'end', toPort: 'narrative' },
      ],
    };
  }

  it('local — graph_context равен локальному подграфу, без запроса сообществ', async () => {
    const outputs = await executeSchema(graphWithMode('local'), ctx({ action: 'осматриваюсь' }));
    const gc = String(outputs.narrative);
    expect(gc).toContain('Коллектор: Тёплое подземное укрытие');
    // В режиме local сводки сообществ не грузятся вовсе.
    const calls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cypher) => cypher.includes('MATCH (c:GraphCommunity'))).toBe(false);
  });

  it('global — graph_context содержит обзор релевантных сообществ, не локальный подграф', async () => {
    const outputs = await executeSchema(graphWithMode('global'), ctx({ action: 'осматриваюсь' }));
    const gc = String(outputs.narrative);
    expect(gc).toContain('Опасности зимы');
    expect(gc).toContain('Холод убивает без укрытия');
    // Сцена (Коллектор/Мороз) не пересекает кластер «Документы» → он отсеян.
    expect(gc).not.toContain('Документы');
    // Это обзор, а не локальный список фактов с фактурой концепта.
    expect(gc).not.toContain('Тёплое подземное укрытие зимой.');
  });

  it('hybrid — graph_context объединяет локальный подграф и глобальный обзор', async () => {
    const outputs = await executeSchema(graphWithMode('hybrid'), ctx({ action: 'осматриваюсь' }));
    const gc = String(outputs.narrative);
    expect(gc).toContain('Локальный контекст (подграф сцены):');
    expect(gc).toContain('Коллектор: Тёплое подземное укрытие');
    expect(gc).toContain('Глобальный обзор (сводки сообществ):');
    expect(gc).toContain('Опасности зимы');
  });

  it('выход expertise остаётся локальным подграфом независимо от режима', async () => {
    // Совместимость с #323: expertise не меняется global-режимом.
    const g = graphWithMode('global');
    g.edges.push({ id: 'exp', from: 'oq', fromPort: 'expertise', to: 'end', toPort: 'hint' });
    const outputs = await executeSchema(g, ctx({ action: 'осматриваюсь' }));
    expect(String(outputs.hint)).toContain('Коллектор: Тёплое подземное укрытие');
  });
});

/**
 * Контекстная независимость (issue #361): если на вход query подан текст, узел
 * привязывает якоря ПО НЕМУ и не обращается к контексту игры. Это делает
 * ontology_query переиспользуемым вне игры (например, в схеме поддержки).
 */
describe('ontology_query: контекстно-независимый вход query (issue #361)', () => {
  // Граф со связью start.query -> oq.query: текст вопроса приходит как вход узла,
  // а не выводится из состояния игры.
  const queryGraph: SchemaGraph = {
    version: 1,
    schemaType: 'action',
    slug: 'ontology_query_input_test',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'oq', type: 'ontology_query', position: { x: 200, y: 0 }, config: ontologyQueryConfig({ query: undefined }) },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'start->oq', from: 'start', fromPort: 'exec', to: 'oq', toPort: 'exec' },
      { id: 'oq->end', from: 'oq', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'q', from: 'start', fromPort: 'query', to: 'oq', toPort: 'query' },
      { id: 'expertise', from: 'oq', fromPort: 'expertise', to: 'end', toPort: 'narrative' },
    ],
  };

  // Контекст с локацией и действием, которые НЕ совпадают ни с одним концептом:
  // без query привязка не нашла бы ничего. Любая привязка — только из query.
  function neutralCtx(inputs: Record<string, unknown>): SchemaExecutionContext {
    return {
      inputs,
      nodeOutputs: new Map(),
      variables: new Map(),
      llmLog: [],
      provider,
      manifest,
      state: { ...state(), location: 'Поверхность', narrative: '' },
      maxRetries: 1,
    };
  }

  it('привязывает якоря по тексту query, игнорируя локацию/действие игры', async () => {
    const outputs = await executeSchema(
      queryGraph,
      neutralCtx({ query: 'Расскажи про Коллектор и мороз' }),
    );
    const expertise = String(outputs.narrative);
    expect(expertise).toContain('Коллектор: Тёплое подземное укрытие');
    expect(expertise).toContain('Мороз');
  });

  it('не добирает якоря из action/location, когда явный query не совпал с графом', async () => {
    const outputs = await executeSchema(
      queryGraph,
      neutralCtx({ query: 'нет такого термина', action: 'осматриваю Коллектор' }),
    );
    expect(String(outputs.narrative)).toBe('Подходящих знаний о мире не найдено.');
  });

  it('без query/anchors граф не валидируется и не падает обратно в игровой контекст', async () => {
    // Контрольный случай: тот же нейтральный контекст, но query не подан.
    // Новый контракт должен остановить такой граф до исполнения узла.
    const noQueryGraph: SchemaGraph = {
      ...queryGraph,
      edges: queryGraph.edges.filter((e) => e.id !== 'q'),
    };
    await expect(executeSchema(noQueryGraph, neutralCtx({ action: '' }))).rejects.toThrow(/query или anchors/);
  });
});
