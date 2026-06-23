import { GoogleGenAI } from '@google/genai';
import type { ILLMProvider, LLMRequestOptions, LLMTextResult } from '../ILLMProvider.js';

export interface GoogleProviderConfig {
  apiKey: string;
  modelName: string;
  temperature: number;
}

/**
 * Провайдер Google Gemini (модели gemini-1.5-pro, gemini-1.5-flash).
 *
 * JSON Mode включается через `responseMimeType: "application/json"`
 * в generationConfig.
 */
export class GoogleProvider implements ILLMProvider {
  public readonly name = 'Google';
  private readonly client: GoogleGenAI;
  private readonly modelName: string;
  private readonly temperature: number;

  constructor(config: GoogleProviderConfig) {
    this.modelName = config.modelName;
    this.temperature = config.temperature;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generateText(options: LLMRequestOptions): Promise<string> {
    return (await this.generateTextResult(options)).text;
  }

  async generateTextResult(options: LLMRequestOptions): Promise<LLMTextResult> {
    const response = await this.client.models.generateContent({
      model: this.modelName,
      contents: options.prompt,
      config: {
        temperature: this.temperature,
        ...(options.systemInstruction
          ? { systemInstruction: options.systemInstruction }
          : {}),
        ...(options.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error('Google: пустой ответ от модели');
    }
    return {
      text,
      usage: response.usageMetadata
        ? {
            promptTokens: response.usageMetadata.promptTokenCount,
            completionTokens: response.usageMetadata.candidatesTokenCount,
            totalTokens: response.usageMetadata.totalTokenCount,
            // Gemini сообщает число токенов из кешированного контента в
            // `cachedContentTokenCount` (входит в promptTokenCount).
            cacheReadTokens: response.usageMetadata.cachedContentTokenCount ?? 0,
          }
        : undefined,
    };
  }
}
