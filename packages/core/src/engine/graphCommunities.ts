/**
 * Graph RAG — сообщества графа и их сводки (issue #328/#334, §4.2 плана).
 *
 * Offline-этап над построенным графом онтологии: ищем плотно связанные кластеры
 * концептов (минимум — связные компоненты по сильным рёбрам, как и указано в
 * плане; цель — Leiden с весами) и просим LLM написать короткую сводку — «дух»
 * каждого кластера (законы, тон, опасности). Сводки кешируются в Neo4j как
 * узлы GraphCommunity и питают ГЛОБАЛЬНЫЙ (обзорный) запрос узла ontology_query
 * через map-reduce — то, чего не даёт ни Vector RAG, ни локальный обход подграфа.
 *
 * detectCommunities — чистая детерминированная функция (тестируется без LLM/БД).
 * summarizeCommunities — единственный LLM-вызов (мок-провайдер в тестах).
 */

import type { ILLMProvider } from '../llm/ILLMProvider.js';
import { generateTextWithLog, type LLMCallLogEntry } from '../llm/trace.js';
import { extractJson } from './validation.js';
import type { GameManifest } from '../games/manifests.js';
import type { OntologyGraph } from './ontologyRetrieval.js';
import type { GraphCommunitySeed } from '../db/repositories/ontologyGraph.js';

/** Параметры кластеризации графа. */
export interface CommunityDetectionOptions {
  /** Минимальный вес ребра, чтобы оно соединяло кластер (отсев слабых связей). */
  minWeight?: number;
  /** Минимальный размер кластера (одиночные концепты — не сообщество). */
  minSize?: number;
}

const DEFAULT_DETECTION: Required<CommunityDetectionOptions> = {
  minWeight: 0,
  minSize: 2,
};

/** Найденный кластер концептов (до LLM-сводки). */
export interface DetectedCommunity {
  /** Slug-и концептов кластера (детерминированный порядок: вес ↓, затем slug ↑). */
  memberSlugs: string[];
  /** Якорь кластера — самый «тяжёлый» концепт (ties → slug ↑). */
  anchorSlug: string;
  /** Заголовок-заготовка по якорю (LLM может заменить на сводке). */
  anchorTitle: string;
}

/**
 * Кластеризация графа в связные компоненты по сильным рёбрам (issue #328, §4.2).
 * Детерминированно (union-find не зависит от порядка объединений; результат
 * стабильно сортируется), без LLM. Рёбра неориентированы для целей кластеризации;
 * слабые (< minWeight) и петли игнорируются; компоненты меньше minSize
 * отбрасываются (одиночный концепт — не сообщество).
 */
export function detectCommunities(
  graph: OntologyGraph,
  options: CommunityDetectionOptions = {},
): DetectedCommunity[] {
  const minWeight = options.minWeight ?? DEFAULT_DETECTION.minWeight;
  const minSize = options.minSize ?? DEFAULT_DETECTION.minSize;

  const weightBySlug = new Map<string, number>();
  const titleBySlug = new Map<string, string>();
  for (const c of graph.concepts) {
    weightBySlug.set(c.slug, c.weight);
    titleBySlug.set(c.slug, c.title);
  }

  // Union-Find по концептам, существующим в графе.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Сжатие путей.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Корень — лексикографически меньший slug: делает разбиение стабильным.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const slug of weightBySlug.keys()) parent.set(slug, slug);
  for (const r of graph.relations) {
    if (r.fromSlug === r.toSlug) continue;
    if (r.weight < minWeight) continue;
    if (!parent.has(r.fromSlug) || !parent.has(r.toSlug)) continue;
    union(r.fromSlug, r.toSlug);
  }

  // Группируем slug-и по корню компоненты.
  const groups = new Map<string, string[]>();
  for (const slug of parent.keys()) {
    const root = find(slug);
    const bucket = groups.get(root);
    if (bucket) bucket.push(slug);
    else groups.set(root, [slug]);
  }

  const byWeightThenSlug = (a: string, b: string): number => {
    const wa = weightBySlug.get(a) ?? 0;
    const wb = weightBySlug.get(b) ?? 0;
    if (wa !== wb) return wb - wa;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const communities: DetectedCommunity[] = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    const sorted = [...members].sort(byWeightThenSlug);
    const anchorSlug = sorted[0];
    communities.push({
      memberSlugs: sorted,
      anchorSlug,
      anchorTitle: titleBySlug.get(anchorSlug) ?? anchorSlug,
    });
  }

  // Стабильный порядок сообществ: крупнее → выше, ties → по якорю.
  communities.sort((a, b) => {
    if (a.memberSlugs.length !== b.memberSlugs.length) return b.memberSlugs.length - a.memberSlugs.length;
    return a.anchorSlug < b.anchorSlug ? -1 : a.anchorSlug > b.anchorSlug ? 1 : 0;
  });
  return communities;
}

/** Опции построения сводок сообществ. */
export interface CommunitySummaryOptions {
  /** Число попыток LLM на сообщество. */
  maxRetries?: number;
}

/** Результат построения сводок: сиды для replaceGraphCommunities и лог LLM. */
export interface CommunitySummaryResult {
  seeds: GraphCommunitySeed[];
  llmLog: LLMCallLogEntry[];
}

/** Системная инструкция сводки сообщества (issue #328, §4.2: «дух» кластера). */
export function buildCommunitySummarySystemPrompt(manifest: GameManifest): string {
  return [
    `Ты — хранитель мира игры «${manifest.name}». ${manifest.description}`,
    '',
    'Тебе дан кластер связанных понятий мира. Напиши его краткий «дух»: общие',
    'законы, тон и опасности этого среза мира — то, что важно для обзорного',
    'взгляда, а не перечисление фактов. 1–2 ёмких предложения.',
    '',
    'Ответ — строго JSON: {"title":"короткий заголовок кластера","summary":"дух кластера"}',
  ].join('\n');
}

/** Промпт сводки: концепты кластера (с фактурой) и связи между ними. */
export function buildCommunitySummaryPrompt(
  community: DetectedCommunity,
  graph: OntologyGraph,
): string {
  const members = new Set(community.memberSlugs);
  const conceptLines = graph.concepts
    .filter((c) => members.has(c.slug))
    .map((c) => `- ${c.title} (${c.kind})${c.fact ? `: ${c.fact}` : ''}`);
  const relationLines = graph.relations
    .filter((r) => members.has(r.fromSlug) && members.has(r.toSlug))
    .map((r) => `- ${r.fromSlug} —${r.relation}→ ${r.toSlug}${r.note ? ` (${r.note})` : ''}`);
  return [
    'Понятия кластера:',
    conceptLines.join('\n') || '- (нет)',
    '',
    'Связи внутри кластера:',
    relationLines.join('\n') || '- (нет)',
  ].join('\n');
}

/** Парсит ответ сводки в {title, summary}; null — если JSON невалиден/пуст. */
export function parseCommunitySummary(raw: string): { title: string; summary: string } | null {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) return null;
  return { title, summary };
}

/**
 * Пишет короткую сводку на каждое сообщество (issue #328, §4.2). На каждый
 * кластер — дешёвый JSON-вызов с повторами при невалидном ответе. При неуспехе
 * сводка пропускается (без сводки сообщество не попадает в глобальный поиск, но
 * это не валит индексацию — корректная деградация, как и сид экспертизы). Заголовок
 * берётся из ответа LLM либо из якоря кластера (anchorTitle). Возвращает сиды,
 * готовые к записи через replaceGraphCommunities.
 */
export async function summarizeCommunities(
  provider: ILLMProvider,
  manifest: GameManifest,
  graph: OntologyGraph,
  communities: DetectedCommunity[],
  options: CommunitySummaryOptions = {},
): Promise<CommunitySummaryResult> {
  const llmLog: LLMCallLogEntry[] = [];
  const maxRetries = options.maxRetries ?? 3;
  const systemInstruction = buildCommunitySummarySystemPrompt(manifest);
  const seeds: GraphCommunitySeed[] = [];

  for (const community of communities) {
    const prompt = buildCommunitySummaryPrompt(community, graph);
    let parsed: { title: string; summary: string } | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let raw: string;
      try {
        raw = await generateTextWithLog(
          provider,
          { prompt, systemInstruction, jsonMode: true },
          llmLog,
          { kind: 'graph_community_summary' },
        );
      } catch (err) {
        console.warn(
          `[graph] сводка кластера «${community.anchorTitle}»: ошибка провайдера на попытке ` +
            `${attempt}/${maxRetries}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      parsed = parseCommunitySummary(raw);
      if (parsed) break;
      console.warn(
        `[graph] сводка кластера «${community.anchorTitle}»: невалидный JSON на попытке ${attempt}/${maxRetries}.`,
      );
    }
    if (!parsed) {
      console.warn(`[graph] сводка кластера «${community.anchorTitle}»: пропущена.`);
      continue;
    }
    seeds.push({
      level: 0,
      title: parsed.title || community.anchorTitle,
      summary: parsed.summary,
      memberSlugs: community.memberSlugs,
    });
  }

  return { seeds, llmLog };
}
