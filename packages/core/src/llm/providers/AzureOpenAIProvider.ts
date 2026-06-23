import OpenAI, { AzureOpenAI } from 'openai';
import '@azure/openai/types';
import type { ILLMProvider, LLMRequestOptions, LLMTextResult } from '../ILLMProvider.js';

export interface AzureOpenAIProviderConfig {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  apiVersion: string;
  temperature: number;
}

/**
 * Провайдер Azure OpenAI.
 *
 * В Azure поле `model` для Chat Completions содержит имя deployment.
 * JSON Mode включается тем же `response_format: { type: "json_object" }`.
 */
export class AzureOpenAIProvider implements ILLMProvider {
  public readonly name = 'AzureOpenAI';
  private readonly client: AzureOpenAI;
  private readonly deploymentName: string;
  private readonly temperature: number;

  constructor(config: AzureOpenAIProviderConfig) {
    this.deploymentName = config.deploymentName;
    this.temperature = config.temperature;
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      deployment: config.deploymentName,
      apiVersion: config.apiVersion,
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

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.deploymentName,
      temperature: this.temperature,
      messages,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    const completion = await this.client.chat.completions.create(params);

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error(`${this.name}: пустой ответ от модели`);
    }

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
