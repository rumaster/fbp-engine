import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSchemaGraphContract } from '@tg-games/schema-contract';
import type {
  SchemaExecutionContext,
  SchemaGraph,
} from '@tg-games/core/engine/schemaEngine.js';
import { executeSchema } from '@tg-games/core/engine/schemaEngine.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import type { IEmbeddingProvider } from '@tg-games/core/llm/embeddings.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import type { GameState } from '@tg-games/core/types.js';

const expertiseRepositoryMock = vi.hoisted(() => ({
  searchExpertiseDocuments: vi.fn(),
  recordExpertiseSearchQuerySafely: vi.fn(async () => undefined),
}));

vi.mock('@tg-games/core/db/repositories/expertise.js', () => expertiseRepositoryMock);

interface SchemaBundle {
  items: Array<{ schemaSlug: string; schemaType: string; graphJson: SchemaGraph }>;
}

function loadExampleGraph(): SchemaGraph {
  const path = fileURLToPath(
    new URL('../../../examples/support-expertise-filter-schema.json', import.meta.url),
  );
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as SchemaBundle;
  expect(bundle.items).toHaveLength(1);
  expect(bundle.items[0]).toMatchObject({ schemaSlug: 'support', schemaType: 'support' });
  return bundle.items[0].graphJson;
}

function mockProvider(responses: string[]): ILLMProvider {
  let i = 0;
  return {
    name: 'MockSupport',
    generateText: vi.fn(async (_opts: LLMRequestOptions) => {
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    }),
  };
}

function embeddingProvider(): IEmbeddingProvider {
  return {
    model: 'mock-embedding',
    embed: vi.fn(async (inputs: string[]) => ({
      embeddings: inputs.map(() => [0.1, 0.2, 0.3]),
    })),
  };
}

function supportManifest(): GameManifest {
  return {
    id: 'global',
    name: 'Поддержка',
    description: '',
    priceStars: 1,
    limits: { maxHp: 1, maxInventoryItems: 0 },
    worldRules: [],
    startTime: { season: 'весна', date: '', time: '00:00', time_of_day: 'утро' },
    characterPresets: [],
    locationPresets: [],
  };
}

function supportState(): GameState {
  return {
    location: '',
    narrative: '',
    character: { hp: 1, max_hp: 1, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'весна', date: '', time: '00:00', time_of_day: 'утро' },
    turn_count: 0,
  };
}

function context(graph: SchemaGraph, provider: ILLMProvider): SchemaExecutionContext {
  return {
    inputs: {
      user_query: 'Бот не отвечает после оплаты',
      expertiseTopK: 5,
    },
    nodeOutputs: new Map(),
    variables: new Map(Object.entries(graph.variables ?? {})),
    llmLog: [],
    provider,
    embeddingProvider: embeddingProvider(),
    manifest: supportManifest(),
    state: supportState(),
    supportHistory: [
      { role: 'user', message: 'Бот не отвечает после оплаты' },
      { role: 'operator', message: 'Проверяю платёж' },
    ],
    maxRetries: 1,
  };
}

describe('пример support-схемы с фильтром экспертизы (issue #278)', () => {
  beforeEach(() => {
    expertiseRepositoryMock.searchExpertiseDocuments.mockReset();
    expertiseRepositoryMock.recordExpertiseSearchQuerySafely.mockClear();
  });

  it('импортируемый JSON проходит контракт и передаёт в ответ только выбранный документ', async () => {
    const graph = loadExampleGraph();
    validateSchemaGraphContract(graph);
    expertiseRepositoryMock.searchExpertiseDocuments.mockResolvedValue([
      {
        id: 'doc-a',
        title: 'Документ A',
        content: 'Содержимое документа A.',
        matchedSource: 'бот не отвечает',
        distance: 0.1,
        similarity: 0.9,
      },
      {
        id: 'doc-b',
        title: 'Документ B',
        content: 'Содержимое документа B.',
        matchedSource: 'оплата прошла',
        distance: 0.2,
        similarity: 0.8,
      },
    ]);
    const provider = mockProvider([
      JSON.stringify({ problems: ['бот не отвечает после оплаты'] }),
      JSON.stringify({ keep: [2] }),
      JSON.stringify({ reply: 'Проверьте статус платежа.', escalate: false, resolved: false }),
    ]);
    const execContext = context(graph, provider);

    const outputs = await executeSchema(graph, execContext);

    expect(outputs).toMatchObject({
      reply: 'Проверьте статус платежа.',
      escalate: false,
      resolved: false,
    });
    expect(expertiseRepositoryMock.searchExpertiseDocuments).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      5,
      { support: true },
      [],
    );
    expect(expertiseRepositoryMock.recordExpertiseSearchQuerySafely).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: null }),
    );
    expect(provider.generateText).toHaveBeenCalledTimes(3);

    const calls = vi.mocked(provider.generateText).mock.calls;
    expect(calls[0][0].prompt).toContain('Клиент: Бот не отвечает после оплаты');
    expect(calls[1][0].prompt).toContain('1. Документ A');
    expect(calls[1][0].prompt).toContain('2. Документ B');
    expect(calls[2][0].prompt).toContain('Содержимое документа B.');
    expect(calls[2][0].prompt).not.toContain('Содержимое документа A.');
    expect(execContext.llmLog.map((entry) => entry.nodeId)).toEqual([
      'support_expertise',
      'document_filter',
      'support_reply',
    ]);
    expect(execContext.llmLog.every((entry) => entry.schemaSlug === 'support')).toBe(true);
  });
});
