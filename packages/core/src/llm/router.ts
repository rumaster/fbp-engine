import type { AppConfig, LLMProviderName } from '../config.js';
import type { ILLMProvider } from './ILLMProvider.js';
import type { ModelPricing } from './pricing.js';
import { buildLLMProvider } from './factory.js';
import { resolveModelPricing } from '../db/repositories/azureModels.js';
import { resolveModelDefaultsSafe } from '../db/repositories/modelDefaults.js';

/** Разрешённые для LLM-запроса провайдер, модель и их цена. */
export interface RoutedModel {
  provider: ILLMProvider;
  /** Имя провайдера в формате конфига (для аудита и логов). */
  providerName: LLMProviderName;
  model: string;
  pricing: ModelPricing | null;
}

/**
 * Маршрутизатор модели (issue #345): все текстовые LLM-запросы используют один
 * глобальный default model поверх активного провайдера из .env. Аргумент
 * «тип запроса» убран (issue #403) — он не влиял на выбор модели.
 */
export interface ModelRouter {
  resolve(): Promise<RoutedModel>;
}

/**
 * Создаёт маршрутизатор для одного действия/обращения. Результат кешируется
 * внутри инстанса, чтобы исполнение схемы и аудит видели одну и ту же модель.
 */
export function createModelRouter(
  config: AppConfig,
  baseProvider: ILLMProvider,
): ModelRouter {
  let cached: Promise<RoutedModel> | null = null;

  async function fallback(): Promise<RoutedModel> {
    return {
      provider: baseProvider,
      providerName: config.llm.provider,
      model: config.llm.modelName,
      pricing: await resolveModelPricing(config.llm.provider, config.llm.modelName),
    };
  }

  async function resolveDefault(): Promise<RoutedModel> {
    const defaults = await resolveModelDefaultsSafe({
      llmModelName: config.llm.modelName,
      embeddingModel: config.embedding?.model ?? 'text-embedding-3-small',
    });
    if (defaults.llmModelName === config.llm.modelName) return fallback();

    const provider = buildLLMProvider(config, config.llm.provider, defaults.llmModelName);
    if (!provider) {
      console.warn(
        `[model-router] default model ${config.llm.provider}/${defaults.llmModelName} пропущен: ` +
          'активный провайдер не настроен. Использую .env.',
      );
      return fallback();
    }

    return {
      provider,
      providerName: config.llm.provider,
      model: defaults.llmModelName,
      pricing: await resolveModelPricing(config.llm.provider, defaults.llmModelName),
    };
  }

  return {
    resolve(): Promise<RoutedModel> {
      if (!cached) {
        cached = resolveDefault();
      }
      return cached;
    },
  };
}
