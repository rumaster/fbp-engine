import type { AppConfig, LLMProviderName } from '../config.js';
import type { ILLMProvider } from './ILLMProvider.js';
import {
  AzureOpenAIEmbeddingProvider,
  OpenAIEmbeddingProvider,
  type IEmbeddingProvider,
} from './embeddings.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { GoogleProvider } from './providers/GoogleProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { AzureOpenAIProvider } from './providers/AzureOpenAIProvider.js';
import { resolveModelDefaultsSafe } from '../db/repositories/modelDefaults.js';

/**
 * Фабрика провайдеров LLM.
 *
 * Считывает выбранный провайдер из конфигурации и отдаёт нужный инстанс
 * (`OpenAIProvider`, `GoogleProvider`, `OpenRouterProvider` или `AzureOpenAIProvider`).
 * Бот не знает деталей конкретного SDK.
 */
export function createLLMProvider(config: AppConfig): ILLMProvider {
  const { provider, apiKey, modelName, temperature } = config.llm;

  switch (provider) {
    case 'OPENAI':
      return new OpenAIProvider({ apiKey, modelName, temperature });
    case 'GOOGLE':
      return new GoogleProvider({ apiKey, modelName, temperature });
    case 'OPENROUTER':
      return new OpenRouterProvider({ apiKey, modelName, temperature });
    case 'AZURE':
      if (!config.llm.azure) {
        throw new Error('Для LLM_PROVIDER=AZURE не задана конфигурация Azure OpenAI');
      }
      return new AzureOpenAIProvider({
        apiKey,
        endpoint: config.llm.azure.endpoint,
        deploymentName: modelName,
        apiVersion: config.llm.azure.apiVersion,
        temperature,
      });
    default:
      // Исчерпывающая проверка: TS гарантирует, что все варианты разобраны.
      return assertNever(provider);
  }
}

/**
 * Строит провайдера LLM для произвольной пары провайдер+модель.
 *
 * В отличие от {@link createLLMProvider}, не привязан к активному провайдеру из
 * конфига и используется runtime-роутером defaults. Возвращает `null`, если для
 * запрошенного провайдера не задан ключ API или для Azure не настроен endpoint.
 */
export function buildLLMProvider(
  config: AppConfig,
  providerName: LLMProviderName,
  modelName: string,
): ILLMProvider | null {
  const { temperature, providerKeys } = config.llm;
  const apiKey = providerKeys[providerName];
  if (!apiKey) return null;

  switch (providerName) {
    case 'OPENAI':
      return new OpenAIProvider({ apiKey, modelName, temperature });
    case 'GOOGLE':
      return new GoogleProvider({ apiKey, modelName, temperature });
    case 'OPENROUTER':
      return new OpenRouterProvider({ apiKey, modelName, temperature });
    case 'AZURE':
      if (!config.llm.azure) return null;
      return new AzureOpenAIProvider({
        apiKey,
        endpoint: config.llm.azure.endpoint,
        deploymentName: modelName,
        apiVersion: config.llm.azure.apiVersion,
        temperature,
      });
    default:
      return null;
  }
}

/**
 * Фабрика провайдера эмбеддингов (issue #147, #279). Возвращает `null`, если
 * выбранный провайдер эмбеддингов не настроен полностью — тогда поиск экспертизы
 * отключается, а бот-консультант работает без справочных материалов.
 */
export function createEmbeddingProvider(config: AppConfig): IEmbeddingProvider | null {
  const { provider, apiKey, model } = config.embedding;
  if (!apiKey) return null;
  switch (provider) {
    case 'OPENAI':
      return new OpenAIEmbeddingProvider({ apiKey, model });
    case 'AZURE':
      if (!config.embedding.azure) return null;
      return new AzureOpenAIEmbeddingProvider({
        apiKey,
        model,
        endpoint: config.embedding.azure.endpoint,
        apiVersion: config.embedding.azure.apiVersion,
        deploymentName: config.embedding.azure.deploymentName,
      });
    default:
      return null;
  }
}

/** Создаёт провайдер эмбеддингов с глобальной default model из БД. */
export async function createDefaultEmbeddingProvider(config: AppConfig): Promise<IEmbeddingProvider | null> {
  const defaults = await resolveModelDefaultsSafe({
    llmModelName: config.llm.modelName,
    embeddingModel: config.embedding.model,
  });
  return createEmbeddingProvider({
    ...config,
    embedding: {
      ...config.embedding,
      model: defaults.embeddingModel,
    },
  });
}

function assertNever(value: never): never {
  throw new Error(`Неподдерживаемый LLM_PROVIDER: ${value as LLMProviderName}`);
}
