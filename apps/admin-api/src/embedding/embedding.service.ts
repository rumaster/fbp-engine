import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

/**
 * Сервис эмбеддингов админ-API (issue #147).
 *
 * Считает эмбеддинги поисковых фраз документов экспертизы при их сохранении.
 * По умолчанию используется OpenAI embeddings API; для Azure OpenAI задайте
 * EMBEDDING_PROVIDER=AZURE и AZURE_OPENAI_EMBEDDING_DEPLOYMENT. Запрос идёт
 * напрямую через fetch, без SDK — backend не зависит от пакета openai.
 */

type EmbeddingProviderName = 'OPENAI' | 'AZURE';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const AZURE_OPENAI_DEFAULT_API_VERSION = '2024-10-21';
const EMBEDDING_MODEL_DEFAULT_KEY = 'embedding_model';

interface OpenAIEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

@Injectable()
export class EmbeddingService {
  private readonly provider: EmbeddingProviderName;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly azureEndpoint: string;
  private readonly azureApiVersion: string;
  private readonly azureDeployment: string;

  constructor(config: ConfigService, @Optional() private readonly database?: DatabaseService) {
    const provider = ((config.get<string>('EMBEDDING_PROVIDER') ?? '').trim() || 'OPENAI').toUpperCase();
    if (provider !== 'OPENAI' && provider !== 'AZURE') {
      throw new Error(`Недопустимое значение EMBEDDING_PROVIDER: ${provider}. Ожидается OPENAI | AZURE`);
    }
    this.provider = provider;
    this.model = (config.get<string>('EMBEDDING_MODEL') ?? '').trim() || DEFAULT_EMBEDDING_MODEL;
    if (this.provider === 'AZURE') {
      this.apiKey = (config.get<string>('AZURE_OPENAI_API_KEY') ?? '').trim();
      this.azureEndpoint = (config.get<string>('AZURE_OPENAI_ENDPOINT') ?? '').trim();
      this.azureApiVersion = (config.get<string>('AZURE_OPENAI_API_VERSION') ?? '').trim()
        || AZURE_OPENAI_DEFAULT_API_VERSION;
      this.azureDeployment = (config.get<string>('AZURE_OPENAI_EMBEDDING_DEPLOYMENT') ?? '').trim();
      this.baseUrl = '';
    } else {
      this.apiKey = (config.get<string>('OPENAI_API_KEY') ?? '').trim();
      const base = (config.get<string>('OPENAI_BASE_URL') ?? '').trim();
      this.baseUrl = base ? `${base.replace(/\/$/, '')}/embeddings` : OPENAI_EMBEDDINGS_URL;
      this.azureEndpoint = '';
      this.azureApiVersion = AZURE_OPENAI_DEFAULT_API_VERSION;
      this.azureDeployment = '';
    }
  }

  /** Доступен ли расчёт эмбеддингов (настроен ли выбранный провайдер). */
  isEnabled(): boolean {
    return this.missingConfigKeys().length === 0;
  }

  /**
   * Считает эмбеддинги для набора фраз, сохраняя их порядок. Возвращает пустой
   * массив для пустого ввода. Бросает понятную ошибку, если ключ не задан или
   * API вернул некорректный ответ.
   */
  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const missing = this.missingConfigKeys();
    if (missing.length > 0) {
      throw new Error(
        `Не настроены переменные окружения для расчёта эмбеддингов (${this.provider}): ${missing.join(', ')}`,
      );
    }
    const request = await this.buildRequest(inputs);
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${this.provider} embeddings вернул ${response.status}: ${detail.slice(0, 500)}`);
    }
    const payload = (await response.json()) as OpenAIEmbeddingResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error(`Некорректный ответ ${this.provider} embeddings: отсутствует поле data`);
    }
    return [...payload.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }

  private missingConfigKeys(): string[] {
    const missing: string[] = [];
    if (!this.apiKey) {
      missing.push(this.provider === 'AZURE' ? 'AZURE_OPENAI_API_KEY' : 'OPENAI_API_KEY');
    }
    if (this.provider === 'AZURE') {
      if (!this.azureEndpoint) missing.push('AZURE_OPENAI_ENDPOINT');
      if (!this.azureDeployment) missing.push('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
    }
    return missing;
  }

  private async buildRequest(inputs: string[]): Promise<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> {
    if (this.provider === 'AZURE') {
      return {
        url: this.azureEmbeddingsUrl(),
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
        },
        body: { input: inputs },
      };
    }

    const model = await this.effectiveModel();
    return {
      url: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: { model, input: inputs },
    };
  }

  private async effectiveModel(): Promise<string> {
    if (!this.database) return this.model;
    try {
      const { rows } = await this.database.query<{ value: string }>(
        'SELECT value FROM model_defaults WHERE key = $1',
        [EMBEDDING_MODEL_DEFAULT_KEY],
      );
      return rows[0]?.value?.trim() || this.model;
    } catch (err) {
      console.error('[embedding] не удалось прочитать default-модель, использую .env:', err);
      return this.model;
    }
  }

  private azureEmbeddingsUrl(): string {
    const endpoint = this.azureEndpoint.replace(/\/$/, '');
    const deployment = encodeURIComponent(this.azureDeployment);
    const apiVersion = encodeURIComponent(this.azureApiVersion);
    return `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
  }
}
