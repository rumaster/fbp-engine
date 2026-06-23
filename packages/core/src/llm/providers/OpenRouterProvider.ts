import { OpenAIProvider } from './OpenAIProvider.js';

export interface OpenRouterProviderConfig {
  apiKey: string;
  modelName: string;
  temperature: number;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Провайдер OpenRouter — доступ к сторонним моделям (Claude, Llama и т.д.)
 * через единый OpenAI-совместимый API.
 *
 * JSON Mode передаётся как `response_format: { type: "json_object" }`
 * (поддержка зависит от выбранной модели).
 */
export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: OpenRouterProviderConfig) {
    super({
      apiKey: config.apiKey,
      modelName: config.modelName,
      temperature: config.temperature,
      baseURL: OPENROUTER_BASE_URL,
      name: 'OpenRouter',
    });
  }
}
