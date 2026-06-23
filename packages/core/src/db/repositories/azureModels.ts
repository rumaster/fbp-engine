import type { LLMProviderName } from '../../config.js';
import { findModelPricing, type ModelPricing } from '../../llm/pricing.js';
import { getPool } from '../pool.js';

interface AzureModelRow {
  alias: string;
  model: string;
}

/**
 * In-memory кеш карты алиасов Azure: deployment (алиас) → каноническая модель.
 *
 * Карта алиасов меняется редко (только при ручной правке БД или сидировании на
 * старте), а резолв нужен на каждом запросе к LLM. Поэтому держим карту в
 * памяти и сбрасываем кеш при upsert/seed. `null` означает «ещё не загружали».
 */
let aliasCache: Map<string, string> | null = null;

/** Загружает карту алиасов Azure из БД и обновляет кеш. */
export async function loadAzureModelMap(): Promise<Map<string, string>> {
  const pool = getPool();
  const { rows } = await pool.query<AzureModelRow>('SELECT alias, model FROM azure_models');
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.alias, row.model);
  }
  aliasCache = map;
  return map;
}

/**
 * Возвращает каноническую модель по алиасу Azure. Если алиас не найден в
 * таблице — возвращает сам алиас (поведение как раньше: цена не определится).
 * Ошибка обращения к БД не должна ломать ход — тогда тоже возвращаем алиас.
 */
export async function resolveAzureAlias(alias: string): Promise<string> {
  if (!aliasCache) {
    try {
      await loadAzureModelMap();
    } catch (err) {
      console.error('[azure-models] не удалось загрузить карту алиасов:', err);
      return alias;
    }
  }
  return aliasCache?.get(alias) ?? alias;
}

/** Сбрасывает кеш карты алиасов (после правок и в тестах). */
export function clearAzureModelCache(): void {
  aliasCache = null;
}

/** Создаёт или обновляет алиас Azure (для админских скриптов и ручных правок). */
export async function upsertAzureModelAlias(alias: string, model: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO azure_models (alias, model)
     VALUES ($1, $2)
     ON CONFLICT (alias)
     DO UPDATE SET model = EXCLUDED.model,
                   updated_at = now()`,
    [alias, model],
  );
  clearAzureModelCache();
}

/**
 * Первичное сидирование алиасов из конфигурации (env `AZURE_MODELS`).
 * ON CONFLICT DO NOTHING сохраняет правки, сделанные прямо в БД.
 */
export async function seedAzureModelAliases(models: Record<string, string>): Promise<void> {
  const entries = Object.entries(models);
  if (entries.length === 0) return;
  const pool = getPool();
  for (const [alias, model] of entries) {
    await pool.query(
      `INSERT INTO azure_models (alias, model)
       VALUES ($1, $2)
       ON CONFLICT (alias) DO NOTHING`,
      [alias, model],
    );
  }
  clearAzureModelCache();
}

/**
 * Возвращает цену модели с учётом провайдера. Для Azure поле `modelName` — это
 * имя deployment (алиас), поэтому сначала маппим алиас в каноническую модель,
 * и только потом ищем цену в справочнике. Для остальных провайдеров имя модели
 * совпадает с ключом справочника, поэтому БД не запрашивается.
 */
export async function resolveModelPricing(
  provider: LLMProviderName,
  modelName: string,
): Promise<ModelPricing | null> {
  const model = provider === 'AZURE' ? await resolveAzureAlias(modelName) : modelName;
  return findModelPricing(model);
}
