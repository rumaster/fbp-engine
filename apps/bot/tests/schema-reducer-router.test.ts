import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchemaGraph } from '@tg-games/core/engine/schemaEngine.js';
import { MissingActiveSchemaError } from '@tg-games/core/engine/schemaEngine.js';
import type { SchemaRecord } from '@tg-games/core/db/repositories/schemas.js';
import type { ILLMProvider, LLMRequestOptions, LLMTextResult } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameState } from '@tg-games/core/types.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

import { processTurn, getHintsWithLog } from '@tg-games/core/engine/reducer.js';

function state(): GameState {
  return {
    location: 'Теплотрасса',
    narrative: 'старт',
    character: { hp: 80, max_hp: 100, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    turn_count: 0,
  };
}

function actionSchema(): SchemaGraph {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'narrative',
        type: 'llm_request',
        position: { x: 200, y: 0 },
        config: {
          kind: 'narrative_generation',
          userPrompt: 'Действие: {{action}}',
          outputs: [{ name: 'narrative', jsonPath: 'narrative', type: 'string' }],
        },
      },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'start->narrative', from: 'start', fromPort: 'exec', to: 'narrative', toPort: 'exec' },
      { id: 'narrative->end', from: 'narrative', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'narrative-data', from: 'narrative', fromPort: 'narrative', to: 'end', toPort: 'narrative' },
      { id: 'raw-data', from: 'narrative', fromPort: 'raw', to: 'end', toPort: 'rawNarrative' },
    ],
  };
}

function activeSchema(graph: SchemaGraph): SchemaRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    schemaSlug: 'action',
    schemaType: 'action',
    gameId: null,
    graphJson: graph,
    isActive: true,
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('processTurn со schema engine и router', () => {
  beforeEach(() => {
    schemaRepositoryMock.getActiveSchema.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    schemaRepositoryMock.logMissingActiveSchema.mockReset();
    schemaRepositoryMock.logMissingActiveSchema.mockResolvedValue(undefined);
  });

  it('считает costMillicents по pricing из router route', async () => {
    const graph = actionSchema();
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeSchema(graph));
    const routedProvider: ILLMProvider = {
      name: 'Routed',
      generateText: vi.fn(async () => JSON.stringify({ narrative: 'Схема отработала.' })),
      generateTextResult: vi.fn(async (_opts: LLMRequestOptions): Promise<LLMTextResult> => ({
        text: JSON.stringify({ narrative: 'Схема отработала.' }),
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      })),
    };
    const baseProvider: ILLMProvider = {
      name: 'Base',
      generateText: vi.fn(async () => {
        throw new Error('base provider не должен вызываться');
      }),
    };
    const router = {
      resolve: vi.fn(async () => ({
        provider: routedProvider,
        providerName: 'OPENAI' as const,
        model: 'gpt-4o',
        pricing: { input: 1, output: 4, cacheRead: 0, cacheCreation: 0 },
      })),
    };

    const result = await processTurn({
      provider: baseProvider,
      router,
      manifest: TEST_GAMES.bomj,
      state: state(),
      action: 'осмотреться',
    });

    expect(result.ok).toBe(true);
    expect(result.creditsUsed).toBe(1500);
    expect(result.costMillicents).toBe(300);
    expect(routedProvider.generateTextResult).toHaveBeenCalledTimes(1);
    expect(baseProvider.generateText).not.toHaveBeenCalled();
  });

  it('передаёт gameId сессии в hint-схему и бросает ошибку без активной схемы (issue #238)', async () => {
    // Активной hint-схемы нет: legacy-путь удалён, поэтому ожидаем
    // MissingActiveSchemaError и проверяем аргумент getActiveSchema.
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(null);
    const provider: ILLMProvider = {
      name: 'Mock',
      generateText: vi.fn(async () => JSON.stringify({ hints: ['Осмотреться'] })),
    };

    await expect(
      getHintsWithLog(provider, state(), 1, [], null, undefined, 'game-42'),
    ).rejects.toBeInstanceOf(MissingActiveSchemaError);

    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('hint', 'game-42');
    // issue #255, этап F: отсутствие активной схемы фиксируется в журнале,
    // чтобы оператор увидел причину в админке.
    expect(schemaRepositoryMock.logMissingActiveSchema).toHaveBeenCalledWith(
      expect.objectContaining({ schemaType: 'hint', gameId: 'game-42' }),
    );
  });

  it('пишет статус error и детали упавшего узла в журнал (issue #255, этап F)', async () => {
    // Узел нарратива возвращает невалидный JSON: схема падает на нём, и в журнал
    // должна уйти запись status='error' с nodeId/nodeType и текстом ошибки.
    const graph = actionSchema();
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeSchema(graph));
    const provider: ILLMProvider = {
      name: 'Broken',
      generateText: vi.fn(async () => 'не-json-ответ'),
      generateTextResult: vi.fn(async (): Promise<LLMTextResult> => ({
        text: 'не-json-ответ',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })),
    };

    const result = await processTurn({
      provider,
      manifest: TEST_GAMES.bomj,
      state: state(),
      action: 'осмотреться',
    });

    expect(result.ok).toBe(false);
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalled();
    const logged = schemaRepositoryMock.logSchemaExecution.mock.calls.at(-1)?.[0];
    expect(logged).toMatchObject({
      schemaType: 'action',
      status: 'error',
      errorNodeId: 'narrative',
      errorNodeType: 'llm_request',
    });
    expect(typeof logged.errorMessage).toBe('string');
    expect(logged.errorMessage.length).toBeGreaterThan(0);
  });
});
