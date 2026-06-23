import { describe, it, expect, vi, beforeEach } from 'vitest';

// Узел knowledge_query выбирает область поиска экспертизы: документы поддержки
// (`game_id IS NULL`) или игры (`scope { gameId }`). Пайплайн-схема несёт об этом
// собственный schemaType, а суб-схема (класс common/game/support) — нет. Раньше
// узел смотрел только на schemaType графа, поэтому суб-схема всегда уходила в
// экспертизу игры и в support-контексте возвращала пустоту (issue #353). Теперь
// область берётся из ctx.expertiseDomain, когда у графа нет schemaType.

// Захватываем scope, с которым knowledge_query обращается в репозиторий экспертизы.
// vi.hoisted — чтобы моки существовали до hoisted-фабрики vi.mock.
const { searchExpertiseDocuments, recordExpertiseSearchQuerySafely } = vi.hoisted(() => ({
  searchExpertiseDocuments: vi.fn(async () => []),
  recordExpertiseSearchQuerySafely: vi.fn(async () => {}),
}));

vi.mock('@tg-games/core/db/repositories/expertise.js', () => ({
  searchExpertiseDocuments,
  recordExpertiseSearchQuerySafely,
}));

import {
  executeSchema,
  type SchemaExecutionContext,
  type SchemaGraph,
} from '@tg-games/core/engine/schemaEngine.js';
import type { IEmbeddingProvider } from '@tg-games/core/llm/embeddings.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import type { GameState } from '@tg-games/core/types.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const manifest: GameManifest = TEST_GAMES.bomj;

function state(): GameState {
  return {
    location: 'Теплотрасса',
    narrative: 'старт',
    character: { hp: 80, max_hp: 100, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    turn_count: 1,
  };
}

const embeddingProvider: IEmbeddingProvider = {
  model: 'text-embedding-3-small',
  async embed(inputs: string[]) {
    return { embeddings: inputs.map(() => [0.1, 0.2]), model: 'text-embedding-3-small', tokens: 0 };
  },
};

const noopProvider: ILLMProvider = { name: 'Mock', generateText: vi.fn(async () => '') };

// knowledge_query собирает ключи из start.keys и отдаёт экспертизу в end.
function knowledgeQueryGraph(meta: { schemaType?: string; subSchemaClass?: string }): SchemaGraph {
  return {
    version: 1,
    ...meta,
    slug: 'kq',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [{ id: 'keys', label: 'Ключи', type: 'string_array' }] } },
      { id: 'kq', type: 'knowledge_query', position: { x: 200, y: 0 }, config: {} },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: [{ id: 'expertise', label: 'Экспертиза', type: 'expertise' }] } },
    ],
    edges: [
      // knowledge_query — exec-узел: его держит поток start → kq → end.
      { id: 'start-kq', from: 'start', fromPort: 'exec', to: 'kq', toPort: 'exec' },
      { id: 'kq-end', from: 'kq', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'keys', from: 'start', fromPort: 'keys', to: 'kq', toPort: 'keys' },
      { id: 'expertise', from: 'kq', fromPort: 'expertise', to: 'end', toPort: 'expertise' },
    ],
  } as SchemaGraph;
}

function ctx(graph: SchemaGraph, overrides: Partial<SchemaExecutionContext> = {}): SchemaExecutionContext {
  return {
    inputs: { keys: ['оплата'], expertiseTopK: 3 },
    nodeOutputs: new Map(),
    variables: new Map(),
    llmLog: [],
    provider: noopProvider,
    embeddingProvider,
    manifest,
    state: state(),
    maxRetries: 1,
    ...overrides,
  };
}

function lastScope() {
  const call = searchExpertiseDocuments.mock.calls.at(-1);
  return call?.[2];
}

describe('knowledge_query: область экспертизы (issue #353)', () => {
  beforeEach(() => {
    searchExpertiseDocuments.mockClear();
    recordExpertiseSearchQuerySafely.mockClear();
  });

  it('пайплайн support ищет в документах поддержки по своему schemaType', async () => {
    const graph = knowledgeQueryGraph({ schemaType: 'support' });
    await executeSchema(graph, ctx(graph));
    expect(searchExpertiseDocuments).toHaveBeenCalled();
    expect(lastScope()).toEqual({ support: true });
  });

  it('пайплайн action ищет в экспертизе игры по своему schemaType', async () => {
    const graph = knowledgeQueryGraph({ schemaType: 'action' });
    await executeSchema(graph, ctx(graph));
    expect(lastScope()).toEqual({ gameId: manifest.id });
  });

  it('суб-схема в контексте поддержки ищет в документах поддержки', async () => {
    // Регрессия issue #353: общая суб-схема без schemaType должна уважать домен
    // вызывающей стороны, а не уходить по умолчанию в экспертизу игры.
    const graph = knowledgeQueryGraph({ subSchemaClass: 'common' });
    await executeSchema(graph, ctx(graph, { expertiseDomain: 'support' }));
    expect(lastScope()).toEqual({ support: true });
  });

  it('суб-схема в контексте игры ищет в экспертизе игры', async () => {
    const graph = knowledgeQueryGraph({ subSchemaClass: 'common' });
    await executeSchema(graph, ctx(graph, { expertiseDomain: 'game' }));
    expect(lastScope()).toEqual({ gameId: manifest.id });
  });

  it('суб-схема без домена по умолчанию ищет в экспертизе игры', async () => {
    const graph = knowledgeQueryGraph({ subSchemaClass: 'common' });
    await executeSchema(graph, ctx(graph));
    expect(lastScope()).toEqual({ gameId: manifest.id });
  });

  it('домен наследуется вложенной суб-схемой через sub_schema', async () => {
    // support-пайплайн вызывает common-суб-схему с узлом knowledge_query: домен
    // поддержки протекает в неё через spread ...ctx и направляет поиск в документы СП.
    const inner = knowledgeQueryGraph({ subSchemaClass: 'common' });
    const outer: SchemaGraph = {
      version: 1,
      schemaType: 'support',
      slug: 'outer',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [{ id: 'keys', label: 'Ключи', type: 'string_array' }] } },
        { id: 'sub', type: 'sub_schema', position: { x: 200, y: 0 }, config: { graph: inner } },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: [{ id: 'expertise', label: 'Экспертиза', type: 'expertise' }] } },
      ],
      edges: [
        { id: 'start-sub', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
        { id: 'sub-end', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'keys-in', from: 'start', fromPort: 'keys', to: 'sub', toPort: 'keys' },
        // expertiseTopK проксируем во вложенную суб-схему как data-вход: её inputs
        // изолированы, без этого узел knowledge_query увидит topK=0 и не запустится.
        { id: 'topk-in', from: 'start', fromPort: 'expertiseTopK', to: 'sub', toPort: 'expertiseTopK' },
        { id: 'expertise-out', from: 'sub', fromPort: 'expertise', to: 'end', toPort: 'expertise' },
      ],
    } as SchemaGraph;
    await executeSchema(outer, ctx(outer, { expertiseDomain: 'support' }));
    expect(lastScope()).toEqual({ support: true });
  });
});
