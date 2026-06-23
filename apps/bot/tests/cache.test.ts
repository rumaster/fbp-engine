import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '@tg-games/core/llm/providers/OpenAIProvider.js';
import { AzureOpenAIProvider } from '@tg-games/core/llm/providers/AzureOpenAIProvider.js';
import type { ILLMProvider, LLMRequestOptions, LLMTextResult } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameState } from '@tg-games/core/types.js';

// issue #238: исполнение идёт только через активные схемы — мокируем репозиторий
// схем (action повторяет прежний 5-фазный пайплайн, поэтому счётчики LLM-вызовов
// в тестах остаются прежними).
const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

import { processTurn, getHintsWithLog } from '@tg-games/core/engine/reducer.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import { mockActiveSchemasByType } from './fixtures/schemas.js';

const manifest = GAMES.bomj;

beforeEach(() => {
  schemaRepositoryMock.getActiveSchema.mockReset();
  schemaRepositoryMock.logSchemaExecution.mockReset();
  schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
  mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
});

function state(): GameState {
  return {
    location: 'Теплотрасса',
    narrative: 'старт',
    character: { hp: 80, max_hp: 100, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time_of_day: 'утро' },
    turn_count: 0,
  };
}

/**
 * Мок-провайдер, запоминающий все полученные опции запроса
 * (включая cacheKey), чтобы проверить, как они прокидываются из reducer.
 */
function capturingProvider(text: string): {
  provider: ILLMProvider;
  calls: LLMRequestOptions[];
} {
  const calls: LLMRequestOptions[] = [];
  const provider: ILLMProvider = {
    name: 'Capturing',
    generateText: vi.fn(async (opts: LLMRequestOptions) => {
      calls.push(opts);
      return text;
    }),
    generateTextResult: vi.fn(async (opts: LLMRequestOptions): Promise<LLMTextResult> => {
      calls.push(opts);
      return { text, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
    }),
  };
  return { provider, calls };
}

function processTestTurn(options: Parameters<typeof processTurn>[0]) {
  return processTurn(options);
}

function getTestHintsWithLog(
  provider: ILLMProvider,
  currentState: GameState,
  maxRetries?: number,
  history?: Parameters<typeof getHintsWithLog>[3],
  pricing?: Parameters<typeof getHintsWithLog>[4],
  cacheKey?: string,
) {
  return getHintsWithLog(provider, currentState, maxRetries, history, pricing, cacheKey);
}

describe('processTurn прокидывает cacheKey в провайдер', () => {
  it('передаёт cacheKey (ID сессии) в опции запроса', async () => {
    const next = state();
    const { provider, calls } = capturingProvider(
      JSON.stringify({ narrative: 'ок', updated_state: next }),
    );

    await processTestTurn({
      provider,
      manifest,
      state: state(),
      action: 'идти',
      cacheKey: 'session-abc-123',
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].cacheKey).toBe('session-abc-123');
  });

  it('не задаёт cacheKey, если он не указан', async () => {
    const next = state();
    const { provider, calls } = capturingProvider(
      JSON.stringify({ narrative: 'ок', updated_state: next }),
    );

    await processTestTurn({
      provider,
      manifest,
      state: state(),
      action: 'идти',
    });

    expect(calls[0].cacheKey).toBeUndefined();
  });

  it('сохраняет cacheKey между ретраями', async () => {
    const next = state();
    const { provider, calls } = capturingProvider('не json');
    // Переопределим, чтобы вернуть мусор первый раз и валидный далее.
    // Совмещённый ответ {narrative, updated_state} валиден для всех фаз.
    let attempt = 0;
    provider.generateTextResult = vi.fn(async (opts: LLMRequestOptions) => {
      calls.push(opts);
      attempt += 1;
      if (attempt === 1) return { text: 'мусор', usage: { totalTokens: 10 } };
      // issue #238: совмещённый ответ удовлетворяет все типизированные узлы action-схемы.
      return {
        text: JSON.stringify({
          narrative: 'ок',
          inventory: [],
          characteristics: {},
          world_flags: {},
          updated_state: next,
        }),
        usage: { totalTokens: 10 },
      };
    });

    await processTestTurn({
      provider,
      manifest,
      state: state(),
      action: 'идти',
      cacheKey: 'sess-42',
      maxRetries: 3,
    });

    // Фаза нарратива: мусор → ретрай → ок (2 вызова), затем 4 фазы состояния.
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.cacheKey).toBe('sess-42');
    }
  });
});

describe('getHintsWithLog прокидывает cacheKey в провайдер', () => {
  it('передаёт cacheKey в опции запроса', async () => {
    const { provider, calls } = capturingProvider(
      JSON.stringify({ hints: ['а', 'б', 'в'] }),
    );

    await getTestHintsWithLog(provider, state(), 3, [], null, 'session-xyz');

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].cacheKey).toBe('session-xyz');
  });

  it('не задаёт cacheKey, если он не передан', async () => {
    const { provider, calls } = capturingProvider(
      JSON.stringify({ hints: ['а', 'б', 'в'] }),
    );

    await getTestHintsWithLog(provider, state(), 3);

    expect(calls[0].cacheKey).toBeUndefined();
  });
});

describe('OpenAIProvider передаёт prompt_cache_key в OpenAI SDK', () => {
  let createMock: ReturnType<typeof vi.fn>;
  let provider: OpenAIProvider;

  beforeEach(() => {
    createMock = vi.fn(async () => ({
      choices: [{ message: { content: '{"narrative":"x","updated_state":{}}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }));
    provider = new OpenAIProvider({ apiKey: 'k', modelName: 'gpt-4o-mini', temperature: 0.5 });
    // подменяем внутренний клиент мок-объектом
    (provider as unknown as { client: { chat: { completions: { create: typeof createMock } } } }).client = {
      chat: { completions: { create: createMock } },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('добавляет prompt_cache_key, когда задан cacheKey', async () => {
    await provider.generateTextResult({
      prompt: 'что делать?',
      systemInstruction: 'роль ведущего',
      jsonMode: true,
      cacheKey: 'session-id-42',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const params = createMock.mock.calls[0][0];
    expect(params.prompt_cache_key).toBe('session-id-42');
    expect(params.model).toBe('gpt-4o-mini');
    expect(params.response_format).toEqual({ type: 'json_object' });
  });

  it('не добавляет prompt_cache_key, если cacheKey не задан', async () => {
    await provider.generateTextResult({
      prompt: 'что делать?',
      systemInstruction: 'роль ведущего',
      jsonMode: true,
    });

    const params = createMock.mock.calls[0][0];
    expect(params.prompt_cache_key).toBeUndefined();
  });

  it('передаёт sessionId как cacheKey даже без jsonMode', async () => {
    await provider.generateTextResult({
      prompt: 'свободный текст',
      cacheKey: 'sess-1',
    });

    const params = createMock.mock.calls[0][0];
    expect(params.prompt_cache_key).toBe('sess-1');
    expect(params.response_format).toBeUndefined();
  });

  it('извлекает cacheReadTokens из prompt_tokens_details.cached_tokens', async () => {
    createMock.mockImplementationOnce(async () => ({
      choices: [{ message: { content: '{"narrative":"x","updated_state":{}}' } }],
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 30,
        total_tokens: 1530,
        prompt_tokens_details: { cached_tokens: 1280 },
      },
    }));

    const result = await provider.generateTextResult({
      prompt: 'что делать?',
      cacheKey: 'sess-cache',
    });

    expect(result.usage?.promptTokens).toBe(1500);
    expect(result.usage?.cacheReadTokens).toBe(1280);
  });

  it('возвращает cacheReadTokens=0, когда кеш не использовался', async () => {
    // createMock по умолчанию не содержит prompt_tokens_details
    const result = await provider.generateTextResult({ prompt: 'что делать?' });

    expect(result.usage?.cacheReadTokens).toBe(0);
  });
});

describe('AzureOpenAIProvider вызывает Azure OpenAI Chat Completions', () => {
  let createMock: ReturnType<typeof vi.fn>;
  let provider: AzureOpenAIProvider;

  beforeEach(() => {
    createMock = vi.fn(async () => ({
      choices: [{ message: { content: '{"narrative":"azure","updated_state":{}}' } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 4,
        total_tokens: 24,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    }));
    provider = new AzureOpenAIProvider({
      apiKey: 'k',
      endpoint: 'https://example.openai.azure.com/',
      deploymentName: 'story-deployment',
      apiVersion: '2024-10-21',
      temperature: 0.3,
    });
    (provider as unknown as { client: { chat: { completions: { create: typeof createMock } } } }).client = {
      chat: { completions: { create: createMock } },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('передаёт deployment как model и включает JSON Mode', async () => {
    const result = await provider.generateTextResult({
      prompt: 'что делать?',
      systemInstruction: 'роль ведущего',
      jsonMode: true,
      cacheKey: 'session-id-42',
    });

    expect(result.text).toBe('{"narrative":"azure","updated_state":{}}');
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 4,
      totalTokens: 24,
      cacheReadTokens: 8,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const params = createMock.mock.calls[0][0];
    expect(params.model).toBe('story-deployment');
    expect(params.temperature).toBe(0.3);
    expect(params.response_format).toEqual({ type: 'json_object' });
    expect(params.prompt_cache_key).toBeUndefined();
    expect(params.messages).toEqual([
      { role: 'system', content: 'роль ведущего' },
      { role: 'user', content: 'что делать?' },
    ]);
  });
});
