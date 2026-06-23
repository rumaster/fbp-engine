import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingService } from '../src/embedding/embedding.service';
import type { DatabaseService } from '../src/database/database.service';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function mockEmbeddingFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({
      data: [
        { index: 1, embedding: [0.2, 0.3] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmbeddingService', () => {
  it('по умолчанию отправляет запрос в OpenAI embeddings API', async () => {
    const fetchMock = mockEmbeddingFetch();
    const service = new EmbeddingService(makeConfig({ OPENAI_API_KEY: 'openai-key' }));

    const result = await service.embed(['b', 'a']);

    expect(result).toEqual([[0.1, 0.2], [0.2, 0.3]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer openai-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['b', 'a'],
    });
  });

  it('берёт модель OpenAI embeddings из глобального default в БД', async () => {
    const fetchMock = mockEmbeddingFetch();
    const database = {
      query: vi.fn(async () => ({ rows: [{ value: 'text-embedding-3-large' }] })),
    };
    const service = new EmbeddingService(
      makeConfig({ OPENAI_API_KEY: 'openai-key', EMBEDDING_MODEL: 'text-embedding-env' }),
      database as unknown as DatabaseService,
    );

    await service.embed(['запрос']);

    expect(database.query).toHaveBeenCalledWith(
      'SELECT value FROM model_defaults WHERE key = $1',
      ['embedding_model'],
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'text-embedding-3-large',
      input: ['запрос'],
    });
  });

  it('при EMBEDDING_PROVIDER=AZURE использует deployment Azure OpenAI', async () => {
    const fetchMock = mockEmbeddingFetch();
    const service = new EmbeddingService(makeConfig({
      EMBEDDING_PROVIDER: 'azure',
      AZURE_OPENAI_API_KEY: 'azure-key',
      AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com/',
      AZURE_OPENAI_API_VERSION: '2025-01-01-preview',
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embedding deployment',
    }));

    await service.embed(['запрос']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://example.openai.azure.com/openai/deployments/embedding%20deployment/embeddings?api-version=2025-01-01-preview',
    );
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'api-key': 'azure-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({ input: ['запрос'] });
  });

  it('считает Azure-эмбеддинги недоступными без deployment', async () => {
    const service = new EmbeddingService(makeConfig({
      EMBEDDING_PROVIDER: 'AZURE',
      AZURE_OPENAI_API_KEY: 'azure-key',
      AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com/',
    }));

    expect(service.isEnabled()).toBe(false);
    await expect(service.embed(['запрос'])).rejects.toThrow(/AZURE_OPENAI_EMBEDDING_DEPLOYMENT/);
  });
});
