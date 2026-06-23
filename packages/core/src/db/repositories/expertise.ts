import type { IEmbeddingProvider } from '../../llm/embeddings.js';
import type { RetrievedExpertiseDocumentTrace } from '../../llm/trace.js';
import { getPool } from '../pool.js';

/**
 * Сид-документ экспертизы игры (без id — он генерируется в БД). Тип принадлежит
 * репозиторию (его принимает {@link seedGameExpertiseDocuments}); примеры данных
 * (`src/examples/bomjExpertise.ts`) импортируют его отсюда, а не наоборот.
 */
export interface GameExpertiseSeedDocument {
  title: string;
  content: string;
  embeddingSources: string[];
  /** Семантические тэги документа (issue #321); опционально. */
  tags?: string[];
}

/**
 * Репозиторий документов экспертизы первой линии поддержки (issue #147).
 *
 * Документ хранит человекочитаемый заголовок (title), контент для промпта
 * консультанта (content) и набор поисковых фраз (embedding_sources). На каждую
 * фразу заводится строка с эмбеддингом в expertise_document_embeddings. Поиск
 * ведётся по косинусному расстоянию pgvector (оператор `<=>`).
 */

/** Документ экспертизы (запись таблицы expertise_documents). */
export interface ExpertiseDocument {
  id: string;
  title: string;
  content: string;
  embeddingSources: string[];
  /** Семантические тэги документа (issue #321). Фильтр узла knowledge_query. */
  tags: string[];
  /** Игра, к которой привязан документ (issue #154). null — документ поддержки. */
  gameId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ExpertiseDocumentRow {
  id: string;
  title: string;
  content: string;
  embedding_sources: string[];
  tags: string[] | null;
  game_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Область поиска документов (issue #154). `{ support: true }` — документы службы
 * поддержки (`game_id IS NULL`, исходное поведение); `{ gameId }` — документы
 * базы знаний конкретной игры.
 */
export type ExpertiseScope = { support: true } | { gameId: string };

function mapDocument(row: ExpertiseDocumentRow): ExpertiseDocument {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    embeddingSources: row.embedding_sources ?? [],
    tags: row.tags ?? [],
    gameId: row.game_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Преобразует вектор в текстовый литерал pgvector вида `[0.1,0.2,...]`.
 * Драйвер pg не умеет биндить векторы нативно, поэтому литерал передаётся
 * параметром и приводится к типу через `$n::vector`.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** Возвращает все документы экспертизы (для админки), новые — сверху. */
export async function listExpertiseDocuments(): Promise<ExpertiseDocument[]> {
  const pool = getPool();
  const result = await pool.query<ExpertiseDocumentRow>(
    `SELECT id, title, content, embedding_sources, tags, game_id, created_at, updated_at
       FROM expertise_documents
      ORDER BY created_at DESC`,
  );
  return result.rows.map(mapDocument);
}

/**
 * Документы базы знаний конкретной игры (issue #328, Graph RAG). В отличие от
 * векторного поиска отдаёт документы целиком и с их реальными id — это нужно
 * индексации графа: провенанс (source_document_id) ссылается на эти id. Порядок
 * детерминирован (по заголовку) — чтобы извлечение графа было воспроизводимым.
 */
export async function listGameExpertiseDocuments(gameId: string): Promise<ExpertiseDocument[]> {
  const pool = getPool();
  const result = await pool.query<ExpertiseDocumentRow>(
    `SELECT id, title, content, embedding_sources, tags, game_id, created_at, updated_at
       FROM expertise_documents
      WHERE game_id = $1
      ORDER BY title ASC`,
    [gameId],
  );
  return result.rows.map(mapDocument);
}

/** Возвращает документ по id или null. */
export async function getExpertiseDocument(id: string): Promise<ExpertiseDocument | null> {
  const pool = getPool();
  const result = await pool.query<ExpertiseDocumentRow>(
    `SELECT id, title, content, embedding_sources, tags, game_id, created_at, updated_at
       FROM expertise_documents
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapDocument(result.rows[0]) : null;
}

/** Документ экспертизы, найденный векторным поиском под запрос бота поддержки. */
export type RetrievedExpertiseDocument = RetrievedExpertiseDocumentTrace & {
  /** Контент документа для подстановки в промпт консультанта. */
  content: string;
};

interface SearchRow {
  id: string;
  title: string;
  content: string;
  matched_source: string;
  distance: number;
}

/**
 * Ищет наиболее близкие к запросу документы экспертизы (issue #147).
 *
 * Для каждого документа берётся ближайшая по косинусному расстоянию фраза-
 * источник (`DISTINCT ON (document_id)`), затем документы сортируются по этому
 * расстоянию и отсекаются по limit. Возвращает пустой массив, если limit ≤ 0
 * или вектор пуст.
 *
 * Необязательный `tags` (issue #321) сужает выборку до документов, чьи tags
 * пересекаются хотя бы с одним из заданных (оператор массивов `&&`). Пустой
 * список тэгов фильтр не накладывает (исходное поведение).
 */
export async function searchExpertiseDocuments(
  queryEmbedding: number[],
  limit: number,
  scope: ExpertiseScope = { support: true },
  tags: string[] = [],
): Promise<RetrievedExpertiseDocument[]> {
  if (limit <= 0 || queryEmbedding.length === 0) return [];
  const pool = getPool();
  const literal = toVectorLiteral(queryEmbedding);
  // Фильтр по области поиска (issue #154): поддержка — документы без игры
  // (game_id IS NULL), игра — документы своего game_id.
  const params: unknown[] = [literal, limit];
  const where: string[] = [];
  if ('gameId' in scope) {
    params.push(scope.gameId);
    where.push(`d.game_id = $${params.length}`);
  } else {
    where.push('d.game_id IS NULL');
  }
  // Фильтр по тэгам (issue #321): только документы с пересекающимся набором тэгов.
  const normalizedTags = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  if (normalizedTags.length > 0) {
    params.push(normalizedTags);
    where.push(`d.tags && $${params.length}::text[]`);
  }
  const result = await pool.query<SearchRow>(
    `SELECT id, title, content, matched_source, distance
       FROM (
         SELECT DISTINCT ON (e.document_id)
                d.id            AS id,
                d.title         AS title,
                d.content       AS content,
                e.source        AS matched_source,
                e.embedding <=> $1::vector AS distance
           FROM expertise_document_embeddings e
           JOIN expertise_documents d ON d.id = e.document_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.document_id, distance ASC
       ) best
      ORDER BY distance ASC
      LIMIT $2`,
    params,
  );
  return result.rows.map((row) => {
    const distance = Number(row.distance);
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      matchedSource: row.matched_source,
      distance,
      similarity: 1 - distance,
    };
  });
}

/**
 * Запись журнала поисковых запросов к экспертизе (issue #156).
 *
 * Сохраняет одну семантическую фразу поиска вместе с её эмбеддингом и найденными
 * документами. Эмбеддинг нужен для фильтра «семантически близкие запросы» в
 * аналитике админки; best_similarity — для фильтра по качеству лучшего совпадения.
 */
export interface ExpertiseSearchQueryRecord {
  /** Текст поисковой фразы (ключ ситуации игры или проблема клиента). */
  queryText: string;
  /** Эмбеддинг фразы (та же модель, что и у документов). */
  embedding: number[];
  /** Область поиска: null — поддержка, иначе game_id игры. */
  gameId: string | null;
  /** Документы, найденные под эту фразу (для показа результатов поиска). */
  retrieved: RetrievedExpertiseDocument[];
}

/**
 * Пишет в журнал один поисковый запрос к экспертизе. Лучшая близость берётся как
 * максимум similarity среди найденных документов (null, если ничего не найдено).
 */
export async function recordExpertiseSearchQuery(
  record: ExpertiseSearchQueryRecord,
): Promise<void> {
  if (record.embedding.length === 0) return;
  const pool = getPool();
  const bestSimilarity =
    record.retrieved.length > 0
      ? Math.max(...record.retrieved.map((doc) => doc.similarity))
      : null;
  await pool.query(
    `INSERT INTO expertise_search_queries
       (game_id, query_text, embedding, best_similarity, result_count, retrieved_documents)
     VALUES ($1, $2, $3::vector, $4, $5, $6)`,
    [
      record.gameId,
      record.queryText,
      toVectorLiteral(record.embedding),
      bestSimilarity,
      record.retrieved.length,
      record.retrieved.length > 0 ? JSON.stringify(record.retrieved) : null,
    ],
  );
}

/**
 * Best-effort запись журнала поиска: ошибка логирования не должна ломать игровой
 * ход или консультацию поддержки (аналогично аудиту LLM).
 */
export async function recordExpertiseSearchQuerySafely(
  record: ExpertiseSearchQueryRecord,
): Promise<void> {
  try {
    await recordExpertiseSearchQuery(record);
  } catch (err) {
    console.error('[expertise-search] не удалось записать журнал поиска экспертизы:', err);
  }
}

/**
 * Пересоздаёт эмбеддинги документа: удаляет старые строки и вставляет новые
 * (по одной на фразу-источник). Векторы передаются текстовыми литералами и
 * приводятся к типу через `$n::vector`. Длины sources и embeddings должны
 * совпадать. Выполняется в транзакции.
 */
export async function replaceExpertiseEmbeddings(
  documentId: string,
  sources: string[],
  embeddings: number[][],
): Promise<void> {
  if (sources.length !== embeddings.length) {
    throw new Error('Число фраз-источников не совпадает с числом эмбеддингов');
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM expertise_document_embeddings WHERE document_id = $1', [
      documentId,
    ]);
    for (let i = 0; i < sources.length; i += 1) {
      await client.query(
        `INSERT INTO expertise_document_embeddings (document_id, source, embedding)
         VALUES ($1, $2, $3::vector)`,
        [documentId, sources[i], toVectorLiteral(embeddings[i])],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Создаёт документ экспертизы (без эмбеддингов — их пишет вызывающий код). */
export async function createExpertiseDocument(input: {
  title: string;
  content: string;
  embeddingSources: string[];
  /** Семантические тэги документа (issue #321); по умолчанию пусто. */
  tags?: string[];
  /** Игра-владелец (issue #154); по умолчанию null — документ поддержки. */
  gameId?: string | null;
}): Promise<ExpertiseDocument> {
  const pool = getPool();
  const result = await pool.query<ExpertiseDocumentRow>(
    `INSERT INTO expertise_documents (title, content, embedding_sources, tags, game_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, content, embedding_sources, tags, game_id, created_at, updated_at`,
    [input.title, input.content, input.embeddingSources, input.tags ?? [], input.gameId ?? null],
  );
  return mapDocument(result.rows[0]);
}

/** Обновляет документ экспертизы (эмбеддинги пересоздаёт вызывающий код). */
export async function updateExpertiseDocument(
  id: string,
  input: {
    title: string;
    content: string;
    embeddingSources: string[];
    tags?: string[];
    gameId?: string | null;
  },
): Promise<ExpertiseDocument | null> {
  const pool = getPool();
  const result = await pool.query<ExpertiseDocumentRow>(
    `UPDATE expertise_documents
        SET title = $2, content = $3, embedding_sources = $4, tags = $5, game_id = $6, updated_at = now()
      WHERE id = $1
      RETURNING id, title, content, embedding_sources, tags, game_id, created_at, updated_at`,
    [id, input.title, input.content, input.embeddingSources, input.tags ?? [], input.gameId ?? null],
  );
  return result.rows[0] ? mapDocument(result.rows[0]) : null;
}

/** Удаляет документ экспертизы (эмбеддинги уходят каскадом). */
export async function deleteExpertiseDocument(id: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query('DELETE FROM expertise_documents WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Идемпотентно сидирует стартовый набор документов базы знаний игры (issue #154).
 *
 * Для каждого документа проверяется, нет ли уже документа этой игры с таким же
 * заголовком; если есть — он пропускается (правки через админку не перезатираются).
 * Недостающие документы вставляются вместе с эмбеддингами поисковых фраз
 * (считаются через переданный провайдер). Возвращает число добавленных документов.
 *
 * Требует провайдер эмбеддингов: без него поиск всё равно не работает, поэтому
 * сидирование пропускается (возвращает 0) — обратная совместимость сохраняется.
 */
export async function seedGameExpertiseDocuments(
  embeddingProvider: IEmbeddingProvider | null,
  gameId: string,
  documents: GameExpertiseSeedDocument[],
): Promise<number> {
  if (!embeddingProvider || documents.length === 0) return 0;
  const pool = getPool();

  // Уже заведённые заголовки этой игры — чтобы не дублировать и не перезатирать.
  const existing = await pool.query<{ title: string }>(
    'SELECT title FROM expertise_documents WHERE game_id = $1',
    [gameId],
  );
  const known = new Set(existing.rows.map((row) => row.title));
  const missing = documents.filter((doc) => !known.has(doc.title));
  if (missing.length === 0) return 0;

  let inserted = 0;
  for (const doc of missing) {
    const { embeddings } = await embeddingProvider.embed(doc.embeddingSources);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO expertise_documents (title, content, embedding_sources, tags, game_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [doc.title, doc.content, doc.embeddingSources, doc.tags ?? [], gameId],
      );
      const documentId = rows[0].id;
      for (let i = 0; i < doc.embeddingSources.length; i += 1) {
        const vector = embeddings[i];
        if (!Array.isArray(vector) || vector.length === 0) continue;
        await client.query(
          `INSERT INTO expertise_document_embeddings (document_id, source, embedding)
           VALUES ($1, $2, $3::vector)`,
          [documentId, doc.embeddingSources[i], toVectorLiteral(vector)],
        );
      }
      await client.query('COMMIT');
      inserted += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return inserted;
}
