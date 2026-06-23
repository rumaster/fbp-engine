/**
 * Тесты глобальных моделей по умолчанию (issue #345).
 *
 * Старые правила model_rules больше не участвуют в маршрутизации: все текстовые
 * LLM-запросы используют один глобальный default поверх .env, а embeddings имеют
 * отдельный глобальный default model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, LLMProviderName } from '@tg-games/core/config.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import { GoogleProvider } from '@tg-games/core/llm/providers/GoogleProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const queryMock = vi.fn();

vi.mock('@tg-games/core/db/pool.js', () => ({
  getPool: () => ({ query: queryMock }),
  closePool: vi.fn(),
}));

import {
  clearModelDefaultsCache,
  loadModelDefaults,
  resolveModelDefaults,
} from '@tg-games/core/db/repositories/modelDefaults.js';
import { createModelRouter } from '@tg-games/core/llm/router.js';

function defaultRow(key: string, value: string): Record<string, unknown> {
  return { key, value, updated_at: new Date('2026-01-01T00:00:00Z') };
}

function makeConfig(overrides: Partial<AppConfig['llm']> = {}): AppConfig {
  const providerKeys: Record<LLMProviderName, string> = {
    OPENAI: '',
    GOOGLE: 'gkey',
    OPENROUTER: '',
    AZURE: '',
    ...overrides.providerKeys,
  };
  return {
    telegramBotToken: 'token',
    llm: {
      provider: 'GOOGLE',
      apiKey: 'gkey',
      modelName: 'gemini-env',
      temperature: 0.5,
      maxRetries: 3,
      providerKeys,
      ...overrides,
    },
    embedding: {
      provider: 'OPENAI',
      apiKey: 'okey',
      model: 'text-embedding-env',
      topK: 3,
      gameTopK: 2,
    },
    db: { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' },
  } as AppConfig;
}

const fallbacks = {
  llmModelName: 'gemini-env',
  embeddingModel: 'text-embedding-env',
};

const baseProvider: ILLMProvider = {
  name: 'Google',
  async generateText() {
    return '{}';
  },
};

beforeEach(() => {
  queryMock.mockReset();
  clearModelDefaultsCache();
});

afterEach(() => {
  clearModelDefaultsCache();
});

describe('resolveModelDefaults (issue #345)', () => {
  it('использует .env fallback, если глобальные defaults ещё не сохранены', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await expect(resolveModelDefaults(fallbacks)).resolves.toMatchObject({
      llmModelName: 'gemini-env',
      embeddingModel: 'text-embedding-env',
      llmModelSource: 'env',
      embeddingModelSource: 'env',
    });
    expect(String(queryMock.mock.calls[0][0])).toContain('FROM model_defaults');
  });

  it('берёт LLM и embedding модели из model_defaults', async () => {
    queryMock.mockResolvedValue({
      rows: [
        defaultRow('llm_model_name', 'gemini-2.5-flash'),
        defaultRow('embedding_model', 'text-embedding-3-large'),
      ],
    });

    await expect(resolveModelDefaults(fallbacks)).resolves.toMatchObject({
      llmModelName: 'gemini-2.5-flash',
      embeddingModel: 'text-embedding-3-large',
      llmModelSource: 'database',
      embeddingModelSource: 'database',
    });
  });

  it('кеширует defaults и перечитывает их после clearModelDefaultsCache', async () => {
    queryMock.mockResolvedValue({ rows: [defaultRow('llm_model_name', 'gemini-db')] });

    await resolveModelDefaults(fallbacks);
    await resolveModelDefaults(fallbacks);
    clearModelDefaultsCache();
    await resolveModelDefaults(fallbacks);

    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('при устаревании кеша и ошибке БД отдаёт прежний кеш', async () => {
    vi.useFakeTimers();
    try {
      queryMock.mockResolvedValueOnce({ rows: [defaultRow('llm_model_name', 'cached-model')] });
      await loadModelDefaults(fallbacks);
      vi.advanceTimersByTime(60_000);
      queryMock.mockRejectedValue(new Error('db down'));

      await expect(resolveModelDefaults(fallbacks)).resolves.toMatchObject({
        llmModelName: 'cached-model',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createModelRouter (issue #345)', () => {
  it('для всех типов LLM-запросов использует один глобальный default model', async () => {
    queryMock.mockResolvedValue({
      rows: [defaultRow('llm_model_name', 'gemini-2.5-flash')],
    });

    const router = createModelRouter(makeConfig(), baseProvider);
    const narrative = await router.resolve('narrative_generation');
    const support = await router.resolve('support_consultation');

    expect(narrative.providerName).toBe('GOOGLE');
    expect(narrative.model).toBe('gemini-2.5-flash');
    expect(narrative.provider).toBeInstanceOf(GoogleProvider);
    expect(support.model).toBe('gemini-2.5-flash');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('model_rules'))).toBe(false);
  });

  it('если в БД нет override, оставляет базовый провайдер из .env', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const router = createModelRouter(makeConfig(), baseProvider);
    const routed = await router.resolve('narrative_generation');

    expect(routed.provider).toBe(baseProvider);
    expect(routed.providerName).toBe('GOOGLE');
    expect(routed.model).toBe('gemini-env');
  });

  it('при ошибке чтения defaults откатывается к .env, не роняя ход', async () => {
    queryMock.mockRejectedValue(new Error('db down'));

    const router = createModelRouter(makeConfig(), baseProvider);
    const routed = await router.resolve('narrative_generation');

    expect(routed.provider).toBe(baseProvider);
    expect(routed.model).toBe('gemini-env');
  });
});

describe('схема model_defaults (issue #345)', () => {
  it('создаёт model_defaults и больше не создаёт model_rules', () => {
    const schema = readFileSync(join(repoRoot, 'packages/core/src/db/schema.sql'), 'utf8');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS model_defaults');
    expect(schema).toMatch(/key\s+VARCHAR\(50\)\s+PRIMARY KEY/);
    expect(schema).toMatch(/value\s+VARCHAR\(255\)\s+NOT NULL/);
    expect(schema).not.toContain('CREATE TABLE IF NOT EXISTS model_rules');
  });
});
