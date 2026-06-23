import OpenAI from 'openai';
import type { ILLMProvider, LLMRequestOptions, LLMTextResult } from '../ILLMProvider.js';

export interface OpenAIProviderConfig {
  apiKey: string;
  modelName: string;
  temperature: number;
  /** Базовый URL API. Переопределяется для OpenRouter. */
  baseURL?: string;
  /** Имя провайдера для логов. */
  name?: string;
}

/**
 * Провайдер OpenAI (модели gpt-4o, gpt-4o-mini).
 *
 * JSON Mode включается через `response_format: { type: "json_object" }`.
 * Тот же класс переиспользуется для OpenRouter (совместимый API) через
 * переопределение baseURL.
 */
export class OpenAIProvider implements ILLMProvider {
  public readonly name: string;
  private readonly client: OpenAI;
  private readonly modelName: string;
  private readonly temperature: number;

  constructor(config: OpenAIProviderConfig) {
    this.name = config.name ?? 'OpenAI';
    this.modelName = config.modelName;
    this.temperature = config.temperature;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async generateText(options: LLMRequestOptions): Promise<string> {
    return (await this.generateTextResult(options)).text;
  }

  async generateTextResult(options: LLMRequestOptions): Promise<LLMTextResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options.systemInstruction) {
      messages.push({ role: 'system', content: options.systemInstruction });
    }
    messages.push({ role: 'user', content: options.prompt });

    // prompt_cache_key — это подсказка для маршрутизации запросов с общим
    // префиксом в один бекенд, чтобы они попадали в один кеш промпта.
    // В типах SDK v4 этого поля пока нет, поэтому добавляем его через каст.
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.modelName,
      temperature: this.temperature,
      messages,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    if (options.cacheKey) {
      (params as { prompt_cache_key?: string }).prompt_cache_key = options.cacheKey;
    }

    const completion = await this.client.chat.completions.create(params);

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error(`${this.name}: пустой ответ от модели`);
    }
    // OpenAI кеширует промпт автоматически (для запросов ≥ 1024 токенов) и
    // сообщает число токенов, прочитанных из кеша, в
    // `usage.prompt_tokens_details.cached_tokens`. Важно: `prompt_tokens`
    // уже ВКЛЮЧАЕТ кешированные токены, поэтому отдаём cached_tokens отдельно,
    // а агрегатор (reducer.aggregateTokenUsage) вычитает их из promptTokens,
    // чтобы не считать вход дважды.
    return {
      text: content,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
            cacheReadTokens: completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
          }
        : undefined,
    };
  }
}
