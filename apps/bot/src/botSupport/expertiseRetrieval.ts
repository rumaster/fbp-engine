/**
 * Извлечение справочных материалов экспертизы для бота поддержки (issue #147).
 *
 * Стадия 1 даёт точные формулировки проблем клиента; здесь по ним считаются
 * эмбеддинги через настроенный провайдер и через косинусную близость pgvector
 * подтягиваются наиболее релевантные документы. Результат идёт в промпт
 * консультанта (стадия 2) и в аудит LLM (видно в админке).
 */

import type { IEmbeddingProvider } from '@tg-games/core/llm/embeddings.js';
import {
  recordExpertiseSearchQuerySafely,
  searchExpertiseDocuments,
  type RetrievedExpertiseDocument,
} from '@tg-games/core/db/repositories/expertise.js';

/**
 * По набору формулировок проблем подтягивает до topK документов экспертизы.
 *
 * Для каждой формулировки выполняется отдельный векторный поиск, результаты
 * объединяются с сохранением наименьшего расстояния на документ, затем берутся
 * topK ближайших. Возвращает пустой массив, если проблем нет или topK ≤ 0.
 * Каждый поисковый запрос пишется в журнал аналитики поддержки (issue #156).
 */
export async function retrieveSupportExpertise(
  embeddingProvider: IEmbeddingProvider,
  problems: string[],
  topK: number,
): Promise<RetrievedExpertiseDocument[]> {
  const queries = problems.map((p) => p.trim()).filter((p) => p.length > 0);
  if (queries.length === 0 || topK <= 0) return [];

  const { embeddings } = await embeddingProvider.embed(queries);

  // Лучшее (минимальное) расстояние на документ среди всех запросов.
  const best = new Map<string, RetrievedExpertiseDocument>();
  for (let i = 0; i < embeddings.length; i += 1) {
    const found = await searchExpertiseDocuments(embeddings[i], topK, { support: true });
    await recordExpertiseSearchQuerySafely({
      queryText: queries[i],
      embedding: embeddings[i],
      gameId: null,
      retrieved: found,
    });
    for (const doc of found) {
      const prev = best.get(doc.id);
      if (!prev || doc.distance < prev.distance) {
        best.set(doc.id, doc);
      }
    }
  }

  return [...best.values()].sort((a, b) => a.distance - b.distance).slice(0, topK);
}
