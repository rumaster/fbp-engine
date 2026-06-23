/**
 * Извлечение справочных материалов экспертизы для узла `knowledge_query`.
 *
 * По ключам ситуации считаются эмбеддинги и через косинусную близость pgvector
 * подтягиваются наиболее релевантные документы базы знаний. Игровые схемы ищут
 * в области конкретной игры (scope `{ gameId }`), support-схемы — в документах
 * поддержки (`game_id IS NULL`). Результат идёт в промпт LLM и в аудит поиска.
 */

import type { IEmbeddingProvider } from '../llm/embeddings.js';
import {
  recordExpertiseSearchQuerySafely,
  searchExpertiseDocuments,
  type ExpertiseScope,
  type RetrievedExpertiseDocument,
} from '../db/repositories/expertise.js';

async function retrieveExpertise(
  embeddingProvider: IEmbeddingProvider,
  keys: string[],
  topK: number,
  scope: ExpertiseScope,
  gameIdForLog: string | null,
  tags: string[],
): Promise<RetrievedExpertiseDocument[]> {
  const queries = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  if (queries.length === 0 || topK <= 0) return [];

  const { embeddings } = await embeddingProvider.embed(queries);

  // Лучшее (минимальное) расстояние на документ среди всех запросов.
  const best = new Map<string, RetrievedExpertiseDocument>();
  for (let i = 0; i < embeddings.length; i += 1) {
    const found = await searchExpertiseDocuments(embeddings[i], topK, scope, tags);
    await recordExpertiseSearchQuerySafely({
      queryText: queries[i],
      embedding: embeddings[i],
      gameId: gameIdForLog,
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

/**
 * По набору ключей ситуации подтягивает до topK документов экспертизы игры.
 *
 * Для каждого ключа выполняется отдельный векторный поиск (в области gameId),
 * результаты объединяются с сохранением наименьшего расстояния на документ,
 * затем берутся topK ближайших. Возвращает пустой массив, если ключей нет или
 * topK ≤ 0. Каждый поисковый запрос пишется в журнал аналитики (issue #156).
 *
 * Необязательный `tags` (issue #321) сужает выборку до документов с пересекающимся
 * набором тэгов; пустой список — поиск без фильтра по тэгам.
 */
export async function retrieveGameExpertise(
  embeddingProvider: IEmbeddingProvider,
  keys: string[],
  topK: number,
  gameId: string,
  tags: string[] = [],
): Promise<RetrievedExpertiseDocument[]> {
  return retrieveExpertise(embeddingProvider, keys, topK, { gameId }, gameId, tags);
}

/**
 * По набору ключей обращения подтягивает до topK документов экспертизы службы
 * поддержки (`game_id IS NULL`). Нужен support-схемам, где `knowledge_query`
 * работает с тем же узлом, что и игровые схемы, но область поиска другая.
 *
 * Необязательный `tags` (issue #321) сужает выборку до документов с пересекающимся
 * набором тэгов; пустой список — поиск без фильтра по тэгам.
 */
export async function retrieveSupportExpertise(
  embeddingProvider: IEmbeddingProvider,
  keys: string[],
  topK: number,
  tags: string[] = [],
): Promise<RetrievedExpertiseDocument[]> {
  return retrieveExpertise(embeddingProvider, keys, topK, { support: true }, null, tags);
}
