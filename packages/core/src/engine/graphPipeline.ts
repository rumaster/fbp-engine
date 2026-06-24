/**
 * Graph RAG — оркестратор offline-индексации графа игры (issue #328/#334, Этап 6).
 *
 * Связывает чистые билдеры (graphIndex.ts), кластеризацию (graphCommunities.ts) и
 * запись в БД (репозитории ontologyGraph.ts/ontology.ts) в один пайплайн «из
 * документов экспертизы — в граф со сводками сообществ»:
 *
 *   документы → извлечение графа (LLM) → апсёрт подокументно с провенансом
 *   (origin='extracted') → перечитываем полный граф (authored #323 + extracted) →
 *   кластеризация → сводки сообществ (LLM) → полная замена узлов GraphCommunity.
 *
 * Дорогой LLM-проход — ВНЕ горячего пути хода (§6 плана): запускается best-effort
 * при старте бота под флагом или админ-задачей. На ход остаётся дешёвый
 * детерминированный графовый ретрив.
 *
 * Ключевые инварианты (§10 плана): ручная онтология #323 (origin='authored') не
 * перетирается (это гарантирует applyExtractedGraph), сообщества — производная
 * графа и заменяются целиком (replaceGraphCommunities).
 */

import type { ILLMProvider } from '../llm/ILLMProvider.js';
import type { LLMCallLogEntry } from '../llm/trace.js';
import type { GameManifest } from '../games/manifests.js';
import {
  buildGraphFromExpertise,
  type GraphExtractionDocument,
  type GraphIndexOptions,
} from './graphIndex.js';
import {
  detectCommunities,
  summarizeCommunities,
  type CommunityDetectionOptions,
  type CommunitySummaryOptions,
} from './graphCommunities.js';
import { applyExtractedGraph, replaceGraphCommunities } from '../db/repositories/ontologyGraph.js';
import { loadGameOntology } from '../db/repositories/ontology.js';

/** Опции полной индексации графа игры. */
export interface IndexGameGraphOptions extends GraphIndexOptions {
  /** Опции кластеризации (минимальный вес ребра/размер сообщества). */
  detection?: CommunityDetectionOptions;
  /** Опции сводок сообществ (число попыток LLM). */
  summary?: CommunitySummaryOptions;
}

/** Сводка результата индексации графа игры. */
export interface IndexGameGraphResult {
  /** Сколько документов дали непустой подграф (обработано в апсёрте). */
  documents: number;
  /** Затронуто концептов при апсёрте (origin='extracted'). */
  concepts: number;
  /** Затронуто связей при апсёрте (origin='extracted'). */
  relations: number;
  /** Найдено сообществ (кластеров) на полном графе. */
  detected: number;
  /** Записано сводок сообществ (могло быть меньше detected — часть без сводки). */
  communities: number;
  /** Полный лог LLM-вызовов (извлечение + сводки) для аудита/трассы. */
  llmLog: LLMCallLogEntry[];
}

/**
 * Строит граф знаний игры из её документов экспертизы и перестраивает сообщества
 * со сводками (issue #328, §3.1 плана). Идемпотентно по смыслу: повторный запуск
 * обновляет extracted-строки и заменяет набор сообществ; authored-разметка (#323)
 * сохраняется. При пустом наборе документов всё равно перестраивает сообщества по
 * уже имеющемуся графу (например, только из authored-онтологии).
 *
 * Возвращает сводку чисел и полный LLM-лог; ничего не бросает «наверх» сверх того,
 * что бросят репозитории при сбое БД — вызывающая сторона (старт бота) оборачивает
 * вызов в best-effort try/catch, как сид экспертизы (§4.2 плана).
 */
export async function indexGameGraph(
  provider: ILLMProvider,
  manifest: GameManifest,
  documents: GraphExtractionDocument[],
  options: IndexGameGraphOptions = {},
): Promise<IndexGameGraphResult> {
  const gameId = manifest.id;

  // 1. Извлечение графа из каждого документа (LLM) + слияние — чистая часть.
  const built = await buildGraphFromExpertise(provider, manifest, documents, options);
  const llmLog: LLMCallLogEntry[] = [...built.llmLog];

  // 2. Апсёрт подокументно — у каждой строки свой source_document_id (провенанс),
  //    origin='extracted'; ручные authored-строки #323 не перетираются.
  let concepts = 0;
  let relations = 0;
  for (const { documentId, graph } of built.perDocument) {
    const applied = await applyExtractedGraph(gameId, graph, documentId);
    concepts += applied.concepts;
    relations += applied.relations;
  }

  // 3. Перечитываем ПОЛНЫЙ граф (authored #323 + extracted) — кеш онтологии сброшен
  //    апсёртом — и кластеризуем его (детерминированно, без LLM).
  const ontology = await loadGameOntology(gameId);
  const detected = detectCommunities(ontology, options.detection);

  // 4. Сводки сообществ (LLM) и полная замена набора сообществ игры.
  const summarized = await summarizeCommunities(
    provider,
    manifest,
    ontology,
    detected,
    options.summary,
  );
  llmLog.push(...summarized.llmLog);
  const { communities } = await replaceGraphCommunities(gameId, summarized.seeds);

  return {
    documents: built.perDocument.length,
    concepts,
    relations,
    detected: detected.length,
    communities,
    llmLog,
  };
}
