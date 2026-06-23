import type { QueryResult, QueryResultRow } from 'pg';
import { getPool } from '../pool.js';

export const LLM_MODEL_DEFAULT_KEY = 'llm_model_name';
export const EMBEDDING_MODEL_DEFAULT_KEY = 'embedding_model';

type ModelDefaultKey = typeof LLM_MODEL_DEFAULT_KEY | typeof EMBEDDING_MODEL_DEFAULT_KEY;
type ModelDefaultSource = 'database' | 'env';

export interface ModelDefaultFallbacks {
  llmModelName: string;
  embeddingModel: string;
}

export interface ModelDefaults {
  llmModelName: string;
  embeddingModel: string;
  llmModelSource: ModelDefaultSource;
  embeddingModelSource: ModelDefaultSource;
  llmUpdatedAt?: Date;
  embeddingUpdatedAt?: Date;
}

interface ModelDefaultRow extends QueryResultRow {
  key: ModelDefaultKey;
  value: string;
  updated_at: Date;
}

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.MODEL_DEFAULTS_CACHE_TTL_MS ?? '30000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 30000;
})();

let cache: ModelDefaults | null = null;
let cachedAt = 0;

export function clearModelDefaultsCache(): void {
  cache = null;
  cachedAt = 0;
}

export async function readModelDefaults(
  client: Queryable,
  fallbacks: ModelDefaultFallbacks,
): Promise<ModelDefaults> {
  const { rows } = await client.query<ModelDefaultRow>(
    `SELECT key, value, updated_at
       FROM model_defaults
      WHERE key = ANY($1::text[])`,
    [[LLM_MODEL_DEFAULT_KEY, EMBEDDING_MODEL_DEFAULT_KEY]],
  );
  return defaultsFromRows(rows, fallbacks);
}

export async function loadModelDefaults(fallbacks: ModelDefaultFallbacks): Promise<ModelDefaults> {
  const defaults = await readModelDefaults(getPool(), fallbacks);
  cache = defaults;
  cachedAt = Date.now();
  return defaults;
}

export async function resolveModelDefaults(fallbacks: ModelDefaultFallbacks): Promise<ModelDefaults> {
  const fresh = cache !== null && Date.now() - cachedAt < CACHE_TTL_MS;
  if (fresh) return cache as ModelDefaults;
  try {
    return await loadModelDefaults(fallbacks);
  } catch (err) {
    if (cache) {
      console.error('[model-defaults] не удалось обновить кеш defaults, использую прежний:', err);
      return cache;
    }
    throw err;
  }
}

export async function resolveModelDefaultsSafe(fallbacks: ModelDefaultFallbacks): Promise<ModelDefaults> {
  try {
    return await resolveModelDefaults(fallbacks);
  } catch (err) {
    console.error('[model-defaults] не удалось прочитать defaults, использую .env:', err);
    return defaultsFromRows([], fallbacks);
  }
}

export async function saveModelDefaults(input: {
  llmModelName: string;
  embeddingModel: string;
}): Promise<ModelDefaults> {
  const llmModelName = input.llmModelName.trim();
  const embeddingModel = input.embeddingModel.trim();
  if (!llmModelName || !embeddingModel) {
    throw new Error('LLM и embedding модели должны быть непустыми');
  }
  const pool = getPool();
  await pool.query(
    `INSERT INTO model_defaults (key, value)
     VALUES
       ($1, $3),
       ($2, $4)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value,
                   updated_at = now()`,
    [LLM_MODEL_DEFAULT_KEY, EMBEDDING_MODEL_DEFAULT_KEY, llmModelName, embeddingModel],
  );
  clearModelDefaultsCache();
  return loadModelDefaults({ llmModelName, embeddingModel });
}

function defaultsFromRows(rows: readonly ModelDefaultRow[], fallbacks: ModelDefaultFallbacks): ModelDefaults {
  const byKey = new Map<ModelDefaultKey, ModelDefaultRow>();
  for (const row of rows) {
    if (row.key === LLM_MODEL_DEFAULT_KEY || row.key === EMBEDDING_MODEL_DEFAULT_KEY) {
      const value = row.value.trim();
      if (value) byKey.set(row.key, { ...row, value });
    }
  }
  const llm = byKey.get(LLM_MODEL_DEFAULT_KEY);
  const embedding = byKey.get(EMBEDDING_MODEL_DEFAULT_KEY);
  return {
    llmModelName: llm?.value ?? fallbacks.llmModelName,
    embeddingModel: embedding?.value ?? fallbacks.embeddingModel,
    llmModelSource: llm ? 'database' : 'env',
    embeddingModelSource: embedding ? 'database' : 'env',
    ...(llm?.updated_at ? { llmUpdatedAt: new Date(llm.updated_at) } : {}),
    ...(embedding?.updated_at ? { embeddingUpdatedAt: new Date(embedding.updated_at) } : {}),
  };
}
