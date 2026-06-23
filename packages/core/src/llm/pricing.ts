import type { LLMUsage } from './ILLMProvider.js';

/**
 * Цены LLM-моделей в долларах США за 1 миллион токенов.
 *
 * Поля:
 *  - input           — цена за 1M входных токенов
 *  - output          — цена за 1M выходных токенов
 *  - cacheRead       — цена за 1M токенов, прочитанных из кеша (опционально)
 *  - cacheCreation   — цена за 1M токенов при записи в кеш (опционально)
 */
export interface ModelPricing {
  /** Цена за 1M входных токенов, USD. */
  input: number;
  /** Цена за 1M выходных токенов, USD. */
  output: number;
  /** Цена за 1M токенов, прочитанных из кеша, USD (0 если нет кеша). */
  cacheRead: number;
  /** Цена за 1M токенов при создании кеша, USD (0 если нет кеша). */
  cacheCreation: number;
}

/**
 * Справочник цен для популярных LLM-моделей.
 * Ключ — идентификатор модели (как в API провайдера).
 *
 * Источники цен (актуальны на момент написания):
 *  - OpenAI:   https://openai.com/api/pricing/
 *  - Google:   https://ai.google.dev/gemini-api/docs/pricing
 *  - Anthropic: https://www.anthropic.com/pricing#api
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ──────────────── OpenAI ────────────────
  'gpt-4o': {
    input: 2.5,
    output: 10.0,
    cacheRead: 1.25,
    cacheCreation: 0,
  },
  'gpt-4o-mini': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.075,
    cacheCreation: 0,
  },
  'gpt-4o-mini-2024-07-18': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.075,
    cacheCreation: 0,
  },
  'gpt-4-turbo': {
    input: 10.0,
    output: 30.0,
    cacheRead: 0,
    cacheCreation: 0,
  },
  'gpt-4o-nano': {
    input: 0.1,
    output: 0.4,
    cacheRead: 0.025,
    cacheCreation: 0,
  },
  'gpt-5.4-nano': {
    input: 0.2,
    output: 1.25,
    cacheRead: 0.02,
    cacheCreation: 0,
  },
  'gpt-4o-mini-tts': {
    input: 0.6,
    output: 12.0,
    cacheRead: 0,
    cacheCreation: 0,
  },
  'gpt-image-1': {
    input: 5.0,
    output: 40.0,
    cacheRead: 1.25,
    cacheCreation: 0,
  },
  'gpt-image-1-mini': {
    input: 2.0,
    output: 8.0,
    cacheRead: 0.2,
    cacheCreation: 0,
  },
  'gpt-image-1.5': {
    input: 8.0,
    output: 32.0,
    cacheRead: 2.0,
    cacheCreation: 0,
  },

  // ──────────────── Google Gemini ────────────────
  'gemini-1.5-flash': {
    input: 0.075,
    output: 0.3,
    cacheRead: 0.01875,
    cacheCreation: 0,
  },
  'gemini-1.5-flash-8b': {
    input: 0.0375,
    output: 0.15,
    cacheRead: 0.01,
    cacheCreation: 0,
  },
  'gemini-1.5-pro': {
    input: 1.25,
    output: 5.0,
    cacheRead: 0.3125,
    cacheCreation: 0,
  },
  // Gemini 2.5 Flash — быстрая модель нового поколения
  'gemini-2.5-flash': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.0375,
    cacheCreation: 0,
  },
  'gemini-2.5-flash-preview-05-20': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.0375,
    cacheCreation: 0,
  },
  'gemini-2.5-pro': {
    input: 1.25,
    output: 10.0,
    cacheRead: 0.31,
    cacheCreation: 0,
  },

  // ──────────────── Anthropic Claude ────────────────
  // Claude 3.5 Haiku — быстрая и дешёвая модель Anthropic
  'claude-3-5-haiku-20241022': {
    input: 0.8,
    output: 4.0,
    cacheRead: 0.08,
    cacheCreation: 1.0,
  },
  'claude-3-5-sonnet-20241022': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
  },
  'claude-3-opus-20240229': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheCreation: 18.75,
  },
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.03,
    cacheCreation: 0.3,
  },
};

/**
 * Цены моделей эмбеддингов в долларах США за 1 миллион токенов (issue #147).
 * Для Azure OpenAI здесь используется каноническая модель из EMBEDDING_MODEL,
 * а не имя deployment. У эмбеддингов нет выходных токенов и кеша.
 * Источник: https://openai.com/api/pricing/
 */
export const EMBEDDING_PRICING: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.1,
};

/** Ищет цену модели эмбеддингов за 1M токенов. Возвращает null, если нет в справочнике. */
export function findEmbeddingPricePerMillion(model: string): number | null {
  return EMBEDDING_PRICING[model] ?? null;
}

/**
 * Стоимость запроса эмбеддингов в миллицентах (округление вверх).
 * 1 USD = 100_000 миллицентов. Возвращает 0, если модель не в справочнике.
 */
export function calcEmbeddingCostMillicents(tokens: number, model: string): number {
  const perMillion = findEmbeddingPricePerMillion(model);
  if (perMillion === null) return 0;
  const costUsd = (Math.max(0, tokens) * perMillion) / 1_000_000;
  return Math.max(0, Math.ceil(costUsd * 100_000));
}

/**
 * Детализированный расход токенов по категориям.
 * Разные провайдеры и модели предоставляют разные подмножества полей.
 */
export interface TokenUsage {
  /** Входные токены (обычный prompt). */
  inputTokens: number;
  /** Выходные токены (ответ модели). */
  outputTokens: number;
  /** Токены, прочитанные из кеша (дешевле обычных входных). */
  cacheReadTokens: number;
  /** Токены, записанные в кеш (дороже обычных входных). */
  cacheCreationTokens: number;
}

/** Возвращает пустой TokenUsage (все поля = 0). */
export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

/**
 * Нормализует usage одного ответа провайдера в детализированный TokenUsage.
 * promptTokens у OpenAI/Gemini включает cacheReadTokens, поэтому кеш вычитается
 * из обычных входных токенов, чтобы стоимость не считалась дважды.
 */
export function usageToTokenUsage(usage: LLMUsage | undefined): TokenUsage {
  const result = emptyTokenUsage();
  if (!usage) return result;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  result.inputTokens = Math.max(0, (usage.promptTokens ?? 0) - cacheRead);
  result.outputTokens = usage.completionTokens ?? 0;
  result.cacheReadTokens = cacheRead;
  result.cacheCreationTokens = cacheCreation;
  return result;
}

/**
 * Вычисляет стоимость в тысячных долях цента (millicents), округляя вверх.
 *
 * Формула:
 *   cost_usd = inputTokens / 1_000_000 * pricing.input
 *            + outputTokens / 1_000_000 * pricing.output
 *            + cacheReadTokens / 1_000_000 * pricing.cacheRead
 *            + cacheCreationTokens / 1_000_000 * pricing.cacheCreation
 *
 *   cost_millicents = ceil(cost_usd * 100_000)
 *
 * 1 доллар = 100 центов = 100_000 миллицентов.
 */
export function calcCostMillicents(usage: TokenUsage, pricing: ModelPricing): number {
  const costUsd =
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheCreationTokens * pricing.cacheCreation) /
    1_000_000;
  return Math.max(0, Math.ceil(costUsd * 100_000));
}

/**
 * Ищет цену модели по идентификатору.
 * Возвращает null, если модель не найдена в справочнике.
 */
export function findModelPricing(modelName: string): ModelPricing | null {
  return MODEL_PRICING[modelName] ?? null;
}
