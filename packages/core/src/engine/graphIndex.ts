/**
 * Graph RAG — индексация графа знаний из документов экспертизы (issue #328/#334).
 *
 * Offline-пайплайн (вне горячего пути хода, §3.1 плана docs/graph-rag-plan.md):
 * LLM читает каждый документ базы знаний игры и ИЗВЛЕКАЕТ из прозы сущности,
 * типизированные связи и короткую фактуру по ЗАКРЫТОМУ справочнику типов (модель
 * ВЫБИРАЕТ тип связи, а не выдумывает) — это держит автоизвлечение в одной системе
 * понятий с ручной онтологией (#323) и позволяет слить их в одни таблицы. Извлечённое
 * сливается с дедупликацией, опционально проходит критик-проход (борьба с шумом) и
 * получает провенанс (документ-источник) перед апсертом с origin='extracted'.
 *
 * Здесь — только чистые билдеры/парсер/слияние и LLM-вызовы (тестируются с мок-
 * провайдером, без сети и БД). Запись в Б           (applyExtractedGraph) и
 * кластеризация — отдельно (репозиторий ontologyGraph.ts, оркестратор Этапа 6).
 */

import type { ILLMProvider } from '../llm/ILLMProvider.js';
import { generateTextWithLog, type LLMCallLogEntry } from '../llm/trace.js';
import { extractJson } from './validation.js';
import type { GameManifest } from '../games/manifests.js';

/**
 * Закрытый справочник видов концептов и типов связей (issue #328). Совпадает с
 * понятиями ручной онтологии «бомжа» (#323, bomjOntology.ts), чтобы извлечённый и
 * авторский граф говорили на одном языке и сериализовались одинаково (в
 * engine/ontology.ts тип связи отображается во фразу через RELATION_PHRASES).
 */
export interface GraphExtractionVocabulary {
  /** Допустимые виды концептов (вершин). */
  conceptKinds: string[];
  /** Допустимые типы связей (рёбер). */
  relationTypes: string[];
}

/** Виды концептов по умолчанию (как в онтологии «бомжа» #323). */
export const ONTOLOGY_CONCEPT_KINDS = [
  'потребность',
  'ресурс',
  'место',
  'угроза',
  'действие',
  'состояние',
  'время',
] as const;

/** Типы связей по умолчанию (закрытый справочник, как в онтологии «бомжа» #323). */
export const ONTOLOGY_RELATION_TYPES = [
  'требует',
  'даёт',
  'тратит',
  'находится_в',
  'опасно_в',
  'вызывает',
  'ускоряет',
  'конфликтует_с',
  'противоречит',
  'часть_чего',
  'альтернатива',
] as const;

/** Справочник по умолчанию для извлечения (виды + типы связей онтологии #323). */
export const DEFAULT_GRAPH_VOCABULARY: GraphExtractionVocabulary = {
  conceptKinds: [...ONTOLOGY_CONCEPT_KINDS],
  relationTypes: [...ONTOLOGY_RELATION_TYPES],
};

/**
 * Извлечённый концепт (структурно совместим с ExtractedConceptInput репозитория
 * ontologyGraph.ts — апсерт принимает его напрямую). Слаг генерируется
 * транслитерацией заголовка детерминированно (slugify).
 */
export interface ExtractedConcept {
  slug: string;
  kind: string;
  title: string;
  synonyms: string[];
  fact: string;
  weight?: number;
}

/** Извлечённая связь (структурно совместима с ExtractedRelationInput репозитория). */
export interface ExtractedRelation {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight?: number;
  condition?: Record<string, unknown> | null;
  note?: string;
}

/** Извлечённый из прозы подграф. */
export interface ExtractedGraph {
  concepts: ExtractedConcept[];
  relations: ExtractedRelation[];
}

/** Документ экспертизы на входе индексации (минимум полей). */
export interface GraphExtractionDocument {
  id: string;
  title: string;
  content: string;
}

/** Карта транслитерации кириллицы в латиницу для детерминированных slug. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Детерминированный слаг из заголовка: транслитерация кириллицы, нижний регистр,
 * не-буквенно-цифровые символы → '_', схлопывание и обрезка. Стиль совпадает с
 * ручными slug онтологии (ночлег→nochleg, теплотрасса→teplotrassa).
 */
export function slugify(text: string): string {
  const lower = text.toLowerCase().trim();
  let out = '';
  for (const ch of lower) {
    out += ch in TRANSLIT ? TRANSLIT[ch] : ch;
  }
  return out
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Системная инструкция извлечения (issue #328): роль аналитика-онтолога, ЗАКРЫТЫЙ
 * справочник видов и типов связей (модель ВЫБИРАЕТ, а не выдумывает) и схема JSON.
 */
export function buildGraphExtractionSystemPrompt(
  manifest: GameManifest,
  vocabulary: GraphExtractionVocabulary = DEFAULT_GRAPH_VOCABULARY,
): string {
  return [
    `Ты — аналитик-онтолог игры «${manifest.name}». ${manifest.description}`,
    '',
    'Задача: прочитать документ базы знаний и извлечь из прозы граф знаний —',
    'сущности (вершины) и типизированные связи между ними (рёбра).',
    '',
    'Виды сущностей (выбирай ТОЛЬКО из списка, ничего не выдумывай):',
    vocabulary.conceptKinds.map((k) => `- ${k}`).join('\n'),
    '',
    'Типы связей (выбирай ТОЛЬКО из списка):',
    vocabulary.relationTypes.map((r) => `- ${r}`).join('\n'),
    '',
    'Правила:',
    '- Извлекай только то, что прямо следует из текста; не фантазируй.',
    '- title — короткое имя сущности на русском; synonyms — иные названия из текста.',
    '- fact — одно ёмкое предложение сути сущности (как в тексте).',
    '- В relations поля from и to ссылаются на title сущностей этого же ответа.',
    '- note к связи — короткое пояснение причинности из текста.',
    '- condition — объект-условие применимости связи или null (например',
    '  {"season":"зима"}, если связь действует только зимой).',
    '',
    'Ответ — строго JSON без пояснений:',
    '{"entities":[{"title":"...","kind":"...","synonyms":["..."],"fact":"..."}],',
    ' "relations":[{"from":"...","to":"...","type":"...","note":"...","condition":null}]}',
  ].join('\n');
}

/** Пользовательский промпт извлечения: заголовок и контент документа. */
export function buildGraphExtractionPrompt(doc: GraphExtractionDocument): string {
  return `Документ «${doc.title}»:\n\n${doc.content.trim()}`;
}

/** Безопасно достаёт массив объектов по ключу из распарсенного JSON. */
function readArray(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
    }
  }
  return [];
}

function readString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

function readSynonyms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
}

/**
 * Парсит ответ извлечения в подграф (issue #328). Концепты получают слаг из
 * заголовка (slugify). Связи нормализуются по закрытому справочнику: тип вне
 * справочника отбрасывается; ребро с концом, не объявленным сущностью,
 * отбрасывается (без «висячих» рёбер). Возвращает null, если JSON невалиден.
 */
export function parseGraphExtraction(
  raw: string,
  vocabulary: GraphExtractionVocabulary = DEFAULT_GRAPH_VOCABULARY,
): ExtractedGraph | null {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;

  const relationTypes = new Set(vocabulary.relationTypes);
  const concepts: ExtractedConcept[] = [];
  const titleToSlug = new Map<string, string>();
  const seenSlugs = new Set<string>();

  for (const entity of readArray(root, 'entities', 'concepts')) {
    const title = readString(entity, 'title', 'name');
    if (!title) continue;
    const slug = readString(entity, 'slug') || slugify(title);
    if (!slug) continue;
    titleToSlug.set(title.toLowerCase(), slug);
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    concepts.push({
      slug,
      kind: readString(entity, 'kind', 'type') || 'состояние',
      title,
      synonyms: readSynonyms(entity.synonyms),
      fact: readString(entity, 'fact', 'description'),
    });
  }

  const resolveSlug = (ref: string): string | null => {
    if (!ref) return null;
    const direct = titleToSlug.get(ref.toLowerCase());
    if (direct) return direct;
    const slug = slugify(ref);
    return seenSlugs.has(slug) ? slug : null;
  };

  const relations: ExtractedRelation[] = [];
  for (const rel of readArray(root, 'relations', 'edges')) {
    const relation = readString(rel, 'type', 'relation');
    if (!relationTypes.has(relation)) continue;
    const fromSlug = resolveSlug(readString(rel, 'from', 'fromSlug', 'from_slug'));
    const toSlug = resolveSlug(readString(rel, 'to', 'toSlug', 'to_slug'));
    if (!fromSlug || !toSlug || fromSlug === toSlug) continue;
    const condition = rel.condition;
    relations.push({
      fromSlug,
      toSlug,
      relation,
      note: readString(rel, 'note'),
      condition: condition && typeof condition === 'object' && !Array.isArray(condition)
        ? (condition as Record<string, unknown>)
        : null,
    });
  }

  return { concepts, relations };
}

/**
 * Сливает подграфы нескольких документов в один с дедупликацией (issue #328):
 * концепты — по slug (объединяя синонимы, оставляя самую длинную фактуру), связи
 * — по тройке from|relation|to. Детерминированно: порядок входа сохраняется.
 */
export function mergeExtractions(graphs: ExtractedGraph[]): ExtractedGraph {
  const conceptBySlug = new Map<string, ExtractedConcept>();
  for (const graph of graphs) {
    for (const c of graph.concepts) {
      const existing = conceptBySlug.get(c.slug);
      if (!existing) {
        conceptBySlug.set(c.slug, { ...c, synonyms: [...c.synonyms] });
        continue;
      }
      // Объединяем синонимы и оставляем более информативную фактуру/заголовок.
      const synonyms = new Set([...existing.synonyms, ...c.synonyms]);
      existing.synonyms = [...synonyms];
      if (c.fact.length > existing.fact.length) existing.fact = c.fact;
      if (!existing.title && c.title) existing.title = c.title;
    }
  }

  const relationByKey = new Map<string, ExtractedRelation>();
  for (const graph of graphs) {
    for (const r of graph.relations) {
      const key = `${r.fromSlug}|${r.relation}|${r.toSlug}`;
      if (!relationByKey.has(key)) {
        relationByKey.set(key, { ...r });
      }
    }
  }

  return {
    concepts: [...conceptBySlug.values()],
    relations: [...relationByKey.values()],
  };
}

/** Опции индексации графа. */
export interface GraphIndexOptions {
  /** Число попыток LLM на документ (как у фазы 0). */
  maxRetries?: number;
  /** Справочник видов/типов связей (по умолчанию — онтологии #323). */
  vocabulary?: GraphExtractionVocabulary;
  /** Включить критик-проход (отбраковку сомнительных связей). */
  critic?: boolean;
}

/** Результат извлечения из одного документа. */
export interface DocumentExtractionResult {
  graph: ExtractedGraph;
  llmLog: LLMCallLogEntry[];
}

/**
 * Извлекает подграф из одного документа (issue #328): дешёвый JSON-вызов с
 * закрытым справочником и повторами при невалидном ответе (как фаза 0,
 * expertiseKeys.ts). При неуспехе всех попыток — пустой подграф (индексация
 * документа просто ничего не добавит, без падения всего процесса).
 */
export async function runDocumentExtraction(
  provider: ILLMProvider,
  manifest: GameManifest,
  doc: GraphExtractionDocument,
  options: GraphIndexOptions = {},
): Promise<DocumentExtractionResult> {
  const llmLog: LLMCallLogEntry[] = [];
  const vocabulary = options.vocabulary ?? DEFAULT_GRAPH_VOCABULARY;
  const maxRetries = options.maxRetries ?? 3;
  const systemInstruction = buildGraphExtractionSystemPrompt(manifest, vocabulary);
  const prompt = buildGraphExtractionPrompt(doc);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let rawResponse: string;
    try {
      rawResponse = await generateTextWithLog(
        provider,
        { prompt, systemInstruction, jsonMode: true },
        llmLog,
        { kind: 'graph_extraction' },
      );
    } catch (err) {
      console.warn(
        `[graph] извлечение из «${doc.title}»: ошибка провайдера на попытке ${attempt}/${maxRetries}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseGraphExtraction(rawResponse, vocabulary);
    if (parsed) return { graph: parsed, llmLog };
    console.warn(`[graph] извлечение из «${doc.title}»: невалидный JSON на попытке ${attempt}/${maxRetries}.`);
  }
  console.warn(`[graph] извлечение из «${doc.title}»: не удалось — документ пропущен.`);
  return { graph: { concepts: [], relations: [] }, llmLog };
}

/** Системная инструкция критик-прохода (issue #328, §4.1: борьба с шумом). */
export function buildGraphCriticSystemPrompt(manifest: GameManifest): string {
  return [
    `Ты — придирчивый редактор графа знаний игры «${manifest.name}». ${manifest.description}`,
    '',
    'Тебе дан список автоизвлечённых связей. Отметь номера тех, что СОМНИТЕЛЬНЫ:',
    'противоречат логике мира, дублируют смысл или выглядят галлюцинацией.',
    'Достоверные и осмысленные связи НЕ трогай.',
    '',
    'Ответ — строго JSON: {"reject":[номера сомнительных связей]}',
  ].join('\n');
}

/** Промпт критика: нумерованный список связей подграфа (1-based). */
export function buildGraphCriticPrompt(graph: ExtractedGraph): string {
  const lines = graph.relations.map(
    (r, i) => `${i + 1}. ${r.fromSlug} —${r.relation}→ ${r.toSlug}${r.note ? ` (${r.note})` : ''}`,
  );
  return `Связи:\n${lines.join('\n')}`;
}

/** Парсит ответ критика в множество отбракованных индексов (1-based → 0-based). */
export function parseGraphCritic(raw: string, total: number): Set<number> {
  const rejected = new Set<number>();
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    return rejected;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return rejected;
  const list = (json as Record<string, unknown>).reject;
  if (!Array.isArray(list)) return rejected;
  for (const item of list) {
    const n = typeof item === 'number' ? item : Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= total) rejected.add(n - 1);
  }
  return rejected;
}

/** Результат критик-прохода: отфильтрованный граф и отброшенные связи. */
export interface GraphCriticResult {
  graph: ExtractedGraph;
  rejected: ExtractedRelation[];
  llmLog: LLMCallLogEntry[];
}

/**
 * Критик-проход (issue #328): второй LLM-вызов отбраковывает сомнительные связи
 * (прямой ответ на риск галлюцинаций автоизвлечения, §9 плана). Концепты не
 * трогаются. При пустом графе или ошибке провайдера граф возвращается как есть
 * (корректная деградация — критик опционален).
 */
export async function runGraphCritic(
  provider: ILLMProvider,
  manifest: GameManifest,
  graph: ExtractedGraph,
): Promise<GraphCriticResult> {
  const llmLog: LLMCallLogEntry[] = [];
  if (graph.relations.length === 0) return { graph, rejected: [], llmLog };
  let rawResponse: string;
  try {
    rawResponse = await generateTextWithLog(
      provider,
      {
        prompt: buildGraphCriticPrompt(graph),
        systemInstruction: buildGraphCriticSystemPrompt(manifest),
        jsonMode: true,
      },
      llmLog,
      { kind: 'graph_community_summary' },
    );
  } catch (err) {
    console.warn(
      `[graph] критик: ошибка провайдера — связи приняты без отбраковки: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { graph, rejected: [], llmLog };
  }
  const rejectedIdx = parseGraphCritic(rawResponse, graph.relations.length);
  const keptRelations: ExtractedRelation[] = [];
  const rejected: ExtractedRelation[] = [];
  graph.relations.forEach((r, i) => {
    (rejectedIdx.has(i) ? rejected : keptRelations).push(r);
  });
  return { graph: { concepts: graph.concepts, relations: keptRelations }, rejected, llmLog };
}

/** Извлечённый из одного документа подграф с привязкой к источнику (провенанс). */
export interface PerDocumentGraph {
  documentId: string;
  graph: ExtractedGraph;
}

/** Сводный результат индексации набора документов. */
export interface GraphFromExpertiseResult {
  /** Слитый граф всех документов (для инспекции/кластеризации). */
  graph: ExtractedGraph;
  /** Подграф каждого документа с его id — для апсерта с провенансом. */
  perDocument: PerDocumentGraph[];
  llmLog: LLMCallLogEntry[];
}

/**
 * Строит граф знаний из набора документов экспертизы игры (issue #328, §3.1).
 * Чистая (без БД) часть пайплайна: на каждый документ — извлечение и опц. критик,
 * затем слияние всех подграфов с дедупликацией. Провенанс сохраняется в
 * perDocument (id документа-источника) — апсорт (applyExtractedGraph) выполняется
 * подокументно в оркестраторе (Этап 6), чтобы у каждой строки был source_document_id.
 */
export async function buildGraphFromExpertise(
  provider: ILLMProvider,
  manifest: GameManifest,
  documents: GraphExtractionDocument[],
  options: GraphIndexOptions = {},
): Promise<GraphFromExpertiseResult> {
  const llmLog: LLMCallLogEntry[] = [];
  const perDocument: PerDocumentGraph[] = [];

  for (const doc of documents) {
    const extraction = await runDocumentExtraction(provider, manifest, doc, options);
    llmLog.push(...extraction.llmLog);
    let graph = extraction.graph;
    if (options.critic && graph.relations.length > 0) {
      const critic = await runGraphCritic(provider, manifest, graph);
      llmLog.push(...critic.llmLog);
      graph = critic.graph;
    }
    if (graph.concepts.length > 0 || graph.relations.length > 0) {
      perDocument.push({ documentId: doc.id, graph });
    }
  }

  return {
    graph: mergeExtractions(perDocument.map((d) => d.graph)),
    perDocument,
    llmLog,
  };
}
