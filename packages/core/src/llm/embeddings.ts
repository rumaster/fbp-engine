/**
 * Провайдер эмбеддингов для семантического поиска экспертизы службы поддержки
 * (issue #147).
 *
 * Эмбеддинги считаются через OpenAI embeddings API или Azure OpenAI deployment.
 * Модель по умолчанию text-embedding-3-small даёт 1536 измерений; при смене
 * модели/deployment важно сохранять размерность, совместимую с уже сохранёнными
 * в БД эмбеддингами документов.
 */

import OpenAI, { AzureOpenAI } from 'openai';
import '@azure/openai/types';

/** Расход токенов на один запрос эмбеддингов. */
export interface EmbeddingUsage {
  promptTokens?: number;
  totalTokens?: number;
}

/** Результат запроса эмбеддингов: векторы в порядке входных строк + usage. */
export interface EmbeddingResult {
  embeddings: number[][];
  usage?: EmbeddingUsage;
}

/** Общий интерфейс провайдера эмбеддингов (паттерн «Стратегия»). */
export interface IEmbeddingProvider {
  /** Имя модели эмбеддингов (для логов и расчёта стоимости). */
  readonly model: string;
  /** Считает эмбеддинги для набора строк, сохраняя их порядок. */
  embed(inputs: string[]): Promise<EmbeddingResult>;
}

export interface OpenAIEmbeddingProviderConfig {
  apiKey: string;
  /** Модель эмбеддингов. По умолчанию text-embedding-3-small. */
  model?: string;
  /** Базовый URL API (для совместимых шлюзов). */
  baseURL?: string;
}

export interface AzureOpenAIEmbeddingProviderConfig {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  apiVersion: string;
  /** Каноническая модель эмбеддингов для логов и расчёта стоимости. */
  model?: string;
}

/** Модель эмбеддингов по умолчанию (1536 измерений). */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Провайдер эмбеддингов OpenAI. */
export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  public readonly model: string;
  private readonly client: OpenAI;

  constructor(config: OpenAIEmbeddingProviderConfig) {
    this.model = config.model ?? DEFAULT_EMBEDDING_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async embed(inputs: string[]): Promise<EmbeddingResult> {
    if (inputs.length === 0) return { embeddings: [], usage: undefined };
    const response = await this.client.embeddings.create({
      model: this.model,
      input: inputs,
    });
    // Гарантируем порядок векторов по индексу входных строк.
    const embeddings = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding as number[]);
    return {
      embeddings,
      usage: response.usage
        ? { promptTokens: response.usage.prompt_tokens, totalTokens: response.usage.total_tokens }
        : undefined,
    };
  }
}

/** Провайдер эмбеддингов Azure OpenAI. */
export class AzureOpenAIEmbeddingProvider implements IEmbeddingProvider {
  public readonly model: string;
  private readonly client: AzureOpenAI;
  private readonly deploymentName: string;

  constructor(config: AzureOpenAIEmbeddingProviderConfig) {
    this.model = config.model ?? DEFAULT_EMBEDDING_MODEL;
    this.deploymentName = config.deploymentName;
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      deployment: config.deploymentName,
      apiVersion: config.apiVersion,
    });
  }

  async embed(inputs: string[]): Promise<EmbeddingResult> {
    if (inputs.length === 0) return { embeddings: [], usage: undefined };
    const response = await this.client.embeddings.create({
      model: this.deploymentName,
      input: inputs,
    });
    const embeddings = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding as number[]);
    return {
      embeddings,
      usage: response.usage
        ? { promptTokens: response.usage.prompt_tokens, totalTokens: response.usage.total_tokens }
        : undefined,
    };
  }
}
