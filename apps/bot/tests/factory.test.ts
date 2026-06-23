import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmbeddingProvider, createLLMProvider } from '@tg-games/core/llm/factory.js';
import { OpenAIProvider } from '@tg-games/core/llm/providers/OpenAIProvider.js';
import { GoogleProvider } from '@tg-games/core/llm/providers/GoogleProvider.js';
import { OpenRouterProvider } from '@tg-games/core/llm/providers/OpenRouterProvider.js';
import { AzureOpenAIProvider } from '@tg-games/core/llm/providers/AzureOpenAIProvider.js';
import {
  AzureOpenAIEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from '@tg-games/core/llm/embeddings.js';
import { loadConfig, resetConfigCache } from '@tg-games/core/config.js';
import type { AppConfig } from '@tg-games/core/config.js';

function makeConfig(provider: AppConfig['llm']['provider']): AppConfig {
  return {
    telegramBotToken: 'token',
    llm: {
      provider,
      apiKey: 'key',
      modelName: 'model',
      temperature: 0.5,
      maxRetries: 3,
      providerKeys: { OPENAI: 'key', GOOGLE: 'key', OPENROUTER: 'key', AZURE: 'key' },
    },
    db: { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' },
    millicentsPerStar: 2000,
    embedding: {
      provider: 'OPENAI',
      apiKey: 'openai-key',
      model: 'text-embedding-3-small',
      topK: 3,
      gameTopK: 2,
    },
    memory: { topK: 12 },
    support: {
      clientBotToken: '',
      adminBotToken: '',
      botUsername: '',
      adminIds: [],
      llmConsultation: true,
    },
    media: {
      provider,
      apiKey: 'key',
      tts: { enabled: true, model: 'tts', voice: 'voice' },
      image: { enabled: true, model: 'image', size: '1024x1024' },
      stt: { enabled: true, model: 'stt' },
    },
  };
}

describe('createLLMProvider', () => {
  it('создаёт OpenAIProvider для OPENAI', () => {
    expect(createLLMProvider(makeConfig('OPENAI'))).toBeInstanceOf(OpenAIProvider);
  });

  it('создаёт GoogleProvider для GOOGLE', () => {
    expect(createLLMProvider(makeConfig('GOOGLE'))).toBeInstanceOf(GoogleProvider);
  });

  it('создаёт OpenRouterProvider для OPENROUTER', () => {
    const p = createLLMProvider(makeConfig('OPENROUTER'));
    expect(p).toBeInstanceOf(OpenRouterProvider);
    // OpenRouter наследует OpenAIProvider
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.name).toBe('OpenRouter');
  });

  it('создаёт AzureOpenAIProvider для AZURE', () => {
    const config = makeConfig('AZURE');
    config.llm.azure = {
      endpoint: 'https://example.openai.azure.com/',
      apiVersion: '2024-10-21',
      models: {},
    };

    const p = createLLMProvider(config);

    expect(p).toBeInstanceOf(AzureOpenAIProvider);
    expect(p.name).toBe('AzureOpenAI');
  });
});

describe('createEmbeddingProvider', () => {
  it('по умолчанию создаёт OpenAI-провайдер эмбеддингов', () => {
    const provider = createEmbeddingProvider(makeConfig('GOOGLE'));

    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(provider?.model).toBe('text-embedding-3-small');
  });

  it('создаёт Azure OpenAI-провайдер эмбеддингов по EMBEDDING_PROVIDER=AZURE', () => {
    const config = makeConfig('GOOGLE');
    config.embedding = {
      provider: 'AZURE',
      apiKey: 'azure-key',
      model: 'text-embedding-3-small',
      azure: {
        endpoint: 'https://example.openai.azure.com/',
        apiVersion: '2025-01-01-preview',
        deploymentName: 'embedding-deployment',
      },
      topK: 3,
      gameTopK: 2,
    };

    const provider = createEmbeddingProvider(config);

    expect(provider).toBeInstanceOf(AzureOpenAIEmbeddingProvider);
    expect(provider?.model).toBe('text-embedding-3-small');
  });

  it('выключает Azure-эмбеддинги, если не задан deployment', () => {
    const config = makeConfig('GOOGLE');
    config.embedding = {
      provider: 'AZURE',
      apiKey: 'azure-key',
      model: 'text-embedding-3-small',
      topK: 3,
      gameTopK: 2,
    };

    expect(createEmbeddingProvider(config)).toBeNull();
  });
});

describe('loadConfig', () => {
  const ENV = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_VERSION;
    delete process.env.AZURE_MODELS;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
    delete process.env.LLM_MODEL_NAME;
  });

  afterEach(() => {
    process.env = { ...ENV };
    resetConfigCache();
  });

  it('читает конфигурацию для GOOGLE по умолчанию', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.GOOGLE_API_KEY = 'gkey';
    const cfg = loadConfig();
    expect(cfg.llm.provider).toBe('GOOGLE');
    expect(cfg.llm.apiKey).toBe('gkey');
  });

  it('требует ключ выбранного провайдера', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'OPENAI';
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it('читает конфигурацию Azure OpenAI', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'AZURE';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com/';
    process.env.AZURE_OPENAI_API_VERSION = '2025-01-01-preview';
    process.env.LLM_MODEL_NAME = 'story-deployment';

    const cfg = loadConfig();

    expect(cfg.llm.provider).toBe('AZURE');
    expect(cfg.llm.apiKey).toBe('azure-key');
    expect(cfg.llm.modelName).toBe('story-deployment');
    expect(cfg.llm.azure).toEqual({
      endpoint: 'https://example.openai.azure.com/',
      apiVersion: '2025-01-01-preview',
      models: {},
    });
    expect(cfg.media.provider).toBe('AZURE');
  });

  it('по умолчанию оставляет эмбеддинги на OpenAI независимо от LLM_PROVIDER', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'GOOGLE';
    process.env.GOOGLE_API_KEY = 'gkey';

    const cfg = loadConfig();

    expect(cfg.embedding.provider).toBe('OPENAI');
    expect(cfg.embedding.apiKey).toBe('');
    expect(cfg.embedding.model).toBe('text-embedding-3-small');
  });

  it('читает конфигурацию Azure OpenAI для эмбеддингов отдельно от LLM_PROVIDER', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'GOOGLE';
    process.env.GOOGLE_API_KEY = 'gkey';
    process.env.EMBEDDING_PROVIDER = 'azure';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com/';
    process.env.AZURE_OPENAI_API_VERSION = '2025-01-01-preview';
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = 'embedding-deployment';

    const cfg = loadConfig();

    expect(cfg.embedding).toMatchObject({
      provider: 'AZURE',
      apiKey: 'azure-key',
      model: 'text-embedding-3-small',
      azure: {
        endpoint: 'https://example.openai.azure.com/',
        apiVersion: '2025-01-01-preview',
        deploymentName: 'embedding-deployment',
      },
    });
  });

  it('отклоняет недопустимый EMBEDDING_PROVIDER', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'GOOGLE';
    process.env.GOOGLE_API_KEY = 'gkey';
    process.env.EMBEDDING_PROVIDER = 'LOCAL';

    expect(() => loadConfig()).toThrow(/EMBEDDING_PROVIDER/);
  });

  it('разбирает карту алиасов AZURE_MODELS в конфигурацию (issue #120)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'AZURE';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com/';
    process.env.LLM_MODEL_NAME = 'story-deployment';
    process.env.AZURE_MODELS = 'story-deployment=gpt-4o,hints-deployment=gpt-4o-mini';

    const cfg = loadConfig();

    expect(cfg.llm.azure?.models).toEqual({
      'story-deployment': 'gpt-4o',
      'hints-deployment': 'gpt-4o-mini',
    });
  });

  it('требует endpoint для Azure OpenAI', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'AZURE';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';

    expect(() => loadConfig()).toThrow(/AZURE_OPENAI_ENDPOINT/);
  });

  it('отклоняет недопустимый LLM_PROVIDER', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'UNKNOWN';
    expect(() => loadConfig()).toThrow(/LLM_PROVIDER/);
  });

  it('требует TELEGRAM_BOT_TOKEN', () => {
    process.env.LLM_PROVIDER = 'GOOGLE';
    process.env.GOOGLE_API_KEY = 'g';
    expect(() => loadConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  // Регрессия issue #78: настройки MEDIA_* из окружения должны попадать в конфиг
  // как есть, а не подменяться дефолтами провайдера.
  it('читает MEDIA_* из окружения, а не подставляет дефолты', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'OPENAI';
    process.env.OPENAI_API_KEY = 'okey';
    process.env.MEDIA_TTS_VOICE = 'ballad';
    process.env.MEDIA_IMAGE_MODEL = 'gpt-image-1-mini';
    const cfg = loadConfig();
    expect(cfg.media.tts.voice).toBe('ballad');
    expect(cfg.media.image.model).toBe('gpt-image-1-mini');
  });

  // Регрессия issue #78: docker-compose прокидывает `${VAR:-}` пустой строкой,
  // если переменной нет в .env. Пустое значение НЕ должно перетирать дефолт.
  it('трактует пустую MEDIA_*-строку как отсутствие значения (дефолт)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.LLM_PROVIDER = 'OPENAI';
    process.env.OPENAI_API_KEY = 'okey';
    process.env.MEDIA_TTS_VOICE = '';
    process.env.MEDIA_IMAGE_MODEL = '';
    process.env.MEDIA_PROVIDER = '';
    const cfg = loadConfig();
    expect(cfg.media.provider).toBe('OPENAI');
    expect(cfg.media.tts.voice).toBe('alloy');
    // Актуальный дефолт OpenAI — gpt-image-1 (dall-e-3 устарел, issue #78).
    expect(cfg.media.image.model).toBe('gpt-image-1');
  });
});
