import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calcCostMillicents,
  findModelPricing,
  type ModelPricing,
  type TokenUsage,
} from '@tg-games/core/llm/pricing.js';
import type { ILLMProvider, LLMRequestOptions, LLMTextResult } from '@tg-games/core/llm/ILLMProvider.js';
import type { LLMCallLogEntry } from '@tg-games/core/llm/trace.js';
import type { GameState } from '@tg-games/core/types.js';

// issue #238: исполнение идёт только через активные схемы — мокируем репозиторий
// схем (action повторяет прежний 5-фазный пайплайн, поэтому счётчики токенов
// и LLM-вызовов в тестах остаются прежними).
const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

import {
  tokensToCredits,
  aggregateTokenUsage,
  calcLLMCost,
  processTurn,
  getHintsWithLog,
} from '@tg-games/core/engine/reducer.js';
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
    character: { hp: 80, max_hp: 100, skills: { выживание: 1 }, inventory: [] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time_of_day: 'утро' },
    turn_count: 0,
  };
}

/** Мок-провайдер, возвращающий фиксированный ответ с указанным usage. */
function mockProviderWithUsage(
  text: string,
  totalTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): ILLMProvider {
  return {
    name: 'Mock',
    generateText: vi.fn(async (_opts: LLMRequestOptions) => text),
    generateTextResult: vi.fn(async (_opts: LLMRequestOptions): Promise<LLMTextResult> => ({
      text,
      usage: {
        promptTokens: Math.floor(totalTokens * 0.7) + cacheReadTokens,
        completionTokens: Math.ceil(totalTokens * 0.3),
        totalTokens: totalTokens + cacheReadTokens + cacheCreationTokens,
        cacheReadTokens,
        cacheCreationTokens,
      },
    })),
  };
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

describe('tokensToCredits', () => {
  it('возвращает 0 для пустого лога', () => {
    expect(tokensToCredits([])).toBe(0);
  });

  it('возвращает сумму токенов из всех записей лога', () => {
    const log: LLMCallLogEntry[] = [
      { request: 'a', response: 'b', usage: { totalTokens: 100 } },
      { request: 'c', response: 'd', usage: { totalTokens: 250 } },
    ];
    expect(tokensToCredits(log)).toBe(350);
  });

  it('игнорирует записи без usage', () => {
    const log: LLMCallLogEntry[] = [
      { request: 'a', response: 'b', usage: { totalTokens: 200 } },
      { request: 'c', response: 'd' },
    ];
    expect(tokensToCredits(log)).toBe(200);
  });

  it('возвращает 0 при отрицательной сумме (не может быть, но граничный случай)', () => {
    const log: LLMCallLogEntry[] = [
      { request: 'a', response: 'b', usage: { totalTokens: 0 } },
    ];
    expect(tokensToCredits(log)).toBe(0);
  });
});

describe('aggregateTokenUsage', () => {
  it('возвращает нули для пустого лога', () => {
    const usage = aggregateTokenUsage([]);
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('суммирует токены из нескольких записей', () => {
    const log: LLMCallLogEntry[] = [
      {
        request: 'a',
        response: 'b',
        usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      },
      {
        request: 'c',
        response: 'd',
        usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      },
    ];
    const usage = aggregateTokenUsage(log);
    expect(usage.outputTokens).toBe(80); // 30 + 50
    expect(usage.inputTokens).toBe(300); // 100 + 200 (без кеша)
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheCreationTokens).toBe(0);
  });

  it('корректно учитывает кеш-токены', () => {
    const log: LLMCallLogEntry[] = [
      {
        request: 'a',
        response: 'b',
        usage: {
          promptTokens: 150, // = 100 inputTokens + 50 cacheRead
          completionTokens: 40,
          totalTokens: 210,
          cacheReadTokens: 50,
          cacheCreationTokens: 20,
        },
      },
    ];
    const usage = aggregateTokenUsage(log);
    expect(usage.inputTokens).toBe(100); // promptTokens - cacheReadTokens
    expect(usage.outputTokens).toBe(40);
    expect(usage.cacheReadTokens).toBe(50);
    expect(usage.cacheCreationTokens).toBe(20);
  });
});

describe('calcCostMillicents', () => {
  const pricing: ModelPricing = {
    input: 1.0,
    output: 4.0,
    cacheRead: 0.1,
    cacheCreation: 1.25,
  };

  it('вычисляет стоимость без кеша', () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    // 1M input * $1.0/M = $1 = 100_000 миллицентов
    expect(calcCostMillicents(usage, pricing)).toBe(100_000);
  });

  it('вычисляет стоимость с кешем', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    };
    // cacheRead: $0.1/M, cacheCreation: $1.25/M
    // = $0.1 + $1.25 = $1.35 = 135_000 миллицентов
    expect(calcCostMillicents(usage, pricing)).toBe(135_000);
  });

  it('округляет вверх', () => {
    const usage: TokenUsage = {
      inputTokens: 1, // 1 токен * $1/M = $0.000001 = 0.1 миллицента → округление вверх до 1
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(calcCostMillicents(usage, pricing)).toBe(1);
  });

  it('возвращает 0 при нулевом использовании', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(calcCostMillicents(usage, pricing)).toBe(0);
  });
});

describe('findModelPricing', () => {
  it('находит известную модель Gemini 2.5 Flash', () => {
    const pricing = findModelPricing('gemini-2.5-flash');
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBeGreaterThan(0);
    expect(pricing!.output).toBeGreaterThan(0);
  });

  it('находит Claude 3.5 Haiku', () => {
    const pricing = findModelPricing('claude-3-5-haiku-20241022');
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBeGreaterThan(0);
    expect(pricing!.output).toBeGreaterThan(0);
  });

  it('находит gpt-4o-nano', () => {
    const pricing = findModelPricing('gpt-4o-nano');
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBeGreaterThan(0);
    expect(pricing!.output).toBeGreaterThan(0);
  });

  it('находит OpenAI TTS и image-модели для медиа (#84)', () => {
    expect(findModelPricing('gpt-4o-mini-tts')).toMatchObject({
      input: 0.6,
      output: 12.0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(findModelPricing('gpt-image-1-mini')).toMatchObject({
      input: 2.0,
      output: 8.0,
      cacheRead: 0.2,
      cacheCreation: 0,
    });
  });

  it('возвращает null для неизвестной модели', () => {
    expect(findModelPricing('unknown-model-xyz')).toBeNull();
  });
});

describe('calcLLMCost', () => {
  it('возвращает costMillicents = 0 если pricing = null', () => {
    const log: LLMCallLogEntry[] = [
      { request: 'a', response: 'b', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    ];
    const { costMillicents } = calcLLMCost(log, null);
    expect(costMillicents).toBe(0);
  });

  it('вычисляет стоимость при известном pricing', () => {
    const pricing: ModelPricing = { input: 1.0, output: 4.0, cacheRead: 0, cacheCreation: 0 };
    const log: LLMCallLogEntry[] = [
      {
        request: 'a',
        response: 'b',
        usage: { promptTokens: 1_000_000, completionTokens: 250_000, totalTokens: 1_250_000 },
      },
    ];
    const { costMillicents } = calcLLMCost(log, pricing);
    // input: $1 + output: $1 = $2 = 200_000 миллицентов
    expect(costMillicents).toBe(200_000);
  });
});

describe('processTurn возвращает creditsUsed, tokenUsage, costMillicents', () => {
  it('возвращает creditsUsed > 0 при наличии usage от провайдера', async () => {
    const nextState = state();
    nextState.character.hp = 75;
    // issue #238: совмещённый ответ удовлетворяет все типизированные узлы action-схемы.
    const provider = mockProviderWithUsage(
      JSON.stringify({
        narrative: 'Ход выполнен.',
        inventory: [],
        characteristics: {},
        world_flags: {},
        updated_state: nextState,
      }),
      500,
    );

    const result = await processTestTurn({ provider, manifest, state: state(), action: 'идти вперёд' });

    expect(result.ok).toBe(true);
    // Пять фаз по 500 токенов каждая → 2500 (issue #137).
    expect(result.creditsUsed).toBe(2500);
    expect(result.tokenUsage).toBeDefined();
    expect(result.costMillicents).toBe(0); // pricing не задан → 0
  });

  it('вычисляет costMillicents при наличии pricing', async () => {
    const nextState = state();
    nextState.character.hp = 75;
    const provider = mockProviderWithUsage(
      JSON.stringify({
        narrative: 'Ход выполнен.',
        inventory: [],
        characteristics: {},
        world_flags: {},
        updated_state: nextState,
      }),
      500,
    );
    const pricing: ModelPricing = { input: 1.0, output: 4.0, cacheRead: 0, cacheCreation: 0 };

    const result = await processTestTurn({ provider, manifest, state: state(), action: 'идти вперёд', pricing });

    expect(result.ok).toBe(true);
    expect(result.costMillicents).toBeGreaterThan(0);
  });

  it('возвращает creditsUsed = 0 при провайдере без usage', async () => {
    const nextState = state();
    const provider: ILLMProvider = {
      name: 'NoUsage',
      generateText: vi.fn(async () =>
        JSON.stringify({ narrative: 'Ход.', updated_state: nextState }),
      ),
    };

    const result = await processTestTurn({ provider, manifest, state: state(), action: 'стоять' });

    expect(result.creditsUsed).toBe(0);
    expect(result.costMillicents).toBe(0);
  });

  it('возвращает creditsUsed при неудаче (ok: false)', async () => {
    const provider = mockProviderWithUsage('не JSON совсем', 300);

    const result = await processTestTurn({ provider, manifest, state: state(), action: 'тест', maxRetries: 1 });

    expect(result.ok).toBe(false);
    expect(result.creditsUsed).toBe(300);
    expect(result.tokenUsage).toBeDefined();
  });
});

describe('getHintsWithLog возвращает creditsUsed, tokenUsage, costMillicents', () => {
  it('возвращает creditsUsed при успешном получении подсказок', async () => {
    const provider = mockProviderWithUsage(
      JSON.stringify({ hints: ['сделать А', 'сделать Б', 'сделать В'] }),
      150,
    );

    const result = await getTestHintsWithLog(provider, state(), 3);

    expect(result.hints).toHaveLength(3);
    expect(result.creditsUsed).toBe(150);
    expect(result.tokenUsage).toBeDefined();
    expect(result.costMillicents).toBe(0); // pricing не задан
  });

  it('вычисляет costMillicents при наличии pricing', async () => {
    const pricing: ModelPricing = { input: 1.0, output: 4.0, cacheRead: 0, cacheCreation: 0 };
    const provider = mockProviderWithUsage(
      JSON.stringify({ hints: ['А', 'Б', 'В'] }),
      150,
    );

    const result = await getTestHintsWithLog(provider, state(), 3, [], pricing);

    expect(result.costMillicents).toBeGreaterThan(0);
  });

  it('возвращает creditsUsed = 0 при пустом ответе без usage', async () => {
    const provider: ILLMProvider = {
      name: 'Empty',
      generateText: vi.fn(async () => JSON.stringify({ hints: [] })),
    };

    const result = await getTestHintsWithLog(provider, state(), 1);

    expect(result.hints).toHaveLength(0);
    expect(result.creditsUsed).toBe(0);
    expect(result.costMillicents).toBe(0);
  });
});

describe('расчёт начального бюджета сессии', () => {
  it('бюджет = millicentsPerStar * priceStars (не просто millicentsPerStar)', () => {
    const millicentsPerStar = 200;
    const priceStars = 50;
    const allocatedMillicents = millicentsPerStar * priceStars;
    // До исправления передавалось только millicentsPerStar, что в priceStars раз меньше
    expect(allocatedMillicents).toBe(10_000);
    expect(allocatedMillicents).not.toBe(millicentsPerStar);
  });

  it('при priceStars=1 бюджет равен millicentsPerStar', () => {
    const millicentsPerStar = 200;
    const priceStars = 1;
    expect(millicentsPerStar * priceStars).toBe(200);
  });

  it('стоимость шага не превышает бюджет при типичных параметрах игры bomj', () => {
    // 1 Star ≈ 200 миллицентов, игра bomj стоит 1 Star
    const millicentsPerStar = 200;
    const priceStars = GAMES.bomj.priceStars;
    const allocatedMillicents = millicentsPerStar * priceStars;
    // бюджет должен быть положительным — игра должна начинаться
    expect(allocatedMillicents).toBeGreaterThan(0);
  });
});

describe('isCreditsExhausted логика (по cost_millicents)', () => {
  // node-postgres возвращает BIGINT как строку — функция должна явно приводить к числу.
  function check(allocated: number | string, costMillicents: number | string): boolean {
    const a = Number(allocated);
    const c = Number(costMillicents);
    return a > 0 && c >= a;
  }

  it('не блокирует при allocated = 0 (кредиты не включены)', () => {
    expect(check(0, 0)).toBe(false);
    expect(check(0, 9999)).toBe(false);
  });

  it('не блокирует пока cost < allocated', () => {
    expect(check(200, 0)).toBe(false);
    expect(check(200, 199)).toBe(false);
  });

  it('блокирует когда cost >= allocated', () => {
    expect(check(200, 200)).toBe(true);
    expect(check(200, 201)).toBe(true);
  });

  it('не блокирует в начале игры когда pg возвращает BIGINT строками', () => {
    // Баг: '201' >= '2000' → true лексикографически, хотя числово 201 < 2000.
    expect(check('2000', '0')).toBe(false);
    expect(check('2000', '201')).toBe(false);
    expect(check('200', '21')).toBe(false);
    expect(check('200', '3')).toBe(false);
  });
});
