/**
 * Концептуальная онтология — обход графа знаний (issue #323).
 *
 * Альтернатива RAG (`expertiseRetrieval.ts`): вместо векторного поиска по абзацам
 * прозы знания мира хранятся типизированным графом концептов и связей, а в промпт
 * нарратива (`{{expertise}}`) едет связный подграф рассуждения о текущей сцене.
 *
 * Здесь — чистая, детерминированная логика обхода (фазы A и B плана), не зависящая
 * ни от сети, ни от БД: на вход подаётся уже загруженный граф игры, на выход —
 * подграф (вершины + рёбра с весами). Это делает поиск тривиально тестируемым,
 * в отличие от векторного (преимущество §9 плана). Загрузка графа — отдельно в
 * `db/repositories/ontology.ts`, сериализация подграфа в текст — в `engine/ontology.ts`.
 */

/** Концепт (вершина графа знаний) в форме, нужной обходу. */
export interface OntologyConceptNode {
  slug: string;
  kind: string;
  title: string;
  synonyms: string[];
  fact: string;
  weight: number;
}

/** Связь (типизированное ребро) в форме, нужной обходу. */
export interface OntologyRelationEdge {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight: number;
  /** Условие применимости связи, напр. {"season":"зима"}; null — без условия. */
  condition: Record<string, unknown> | null;
  note: string;
}

/** Граф знаний игры: концепты и связи. */
export interface OntologyGraph {
  concepts: OntologyConceptNode[];
  relations: OntologyRelationEdge[];
}

/** Контекст текущей сцены для фильтрации условных связей (фаза B). */
export interface OntologyContext {
  season?: string;
  location?: string;
  timeOfDay?: string;
}

/** Параметры обхода графа (фаза B). Все — с разумными значениями по умолчанию. */
export interface OntologyTraversalOptions {
  /** Глубина обхода от якорей (число шагов по рёбрам). */
  depth?: number;
  /** Коэффициент затухания вклада на каждый шаг (0..1). */
  decay?: number;
  /** Максимум концептов в подграфе (бюджет узлов). */
  maxConcepts?: number;
  /** Максимум связей в подграфе (бюджет рёбер). */
  maxRelations?: number;
}

const DEFAULT_OPTIONS: Required<OntologyTraversalOptions> = {
  depth: 2,
  decay: 0.5,
  maxConcepts: 12,
  maxRelations: 16,
};

/** Концепт подграфа с накопленным весом (score) и шагом обнаружения. */
export interface OntologySubgraphConcept {
  concept: OntologyConceptNode;
  score: number;
  /** Расстояние в шагах от ближайшего якоря (0 — сам якорь). */
  step: number;
  /** true — концепт стал якорём на фазе A. */
  anchor: boolean;
}

/** Связь подграфа с готовыми к сериализации именами концов. */
export interface OntologySubgraphRelation {
  fromSlug: string;
  toSlug: string;
  fromTitle: string;
  toTitle: string;
  relation: string;
  weight: number;
  note: string;
}

/** Результат фаз A–B: связный подграф рассуждения о сцене. */
export interface OntologySubgraph {
  anchors: string[];
  concepts: OntologySubgraphConcept[];
  relations: OntologySubgraphRelation[];
}

/** Нормализует строку для детерминированного матча: lower-case, схлопывание пробелов. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Проверяет вхождение нормализованного термина в нормализованный текст по границам
 * слов (термин окружён началом/концом строки или пробелом). Это отсекает ложные
 * срабатывания внутри других слов, оставаясь толерантным к пунктуации.
 */
function containsTerm(normalizedText: string, term: string): boolean {
  const needle = normalize(term);
  if (needle.length === 0) return false;
  // Оба конца дополнены пробелом — термин (слово или фраза) ищется по границам
  // слов, а не как подстрока внутри другого слова.
  return ` ${normalizedText} `.includes(` ${needle} `);
}

/**
 * Фаза A — привязка к онтологии («якоря»).
 *
 * Детерминированно (без сети) находит стартовые концепты, которых касается ход:
 *   • explicit — явные якоря с входного порта узла (slug, title или синоним);
 *   • text — свободный текст хода (действие + локация + последний нарратив),
 *     в котором ищутся вхождения имён и синонимов концептов.
 * Возвращает уникальные slug в порядке: сначала явные, затем найденные по тексту.
 */
export function matchAnchors(
  graph: OntologyGraph,
  params: { text?: string; explicit?: string[] },
): string[] {
  const bySlug = new Map(graph.concepts.map((c) => [c.slug, c]));
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (slug: string) => {
    if (slug && bySlug.has(slug) && !seen.has(slug)) {
      seen.add(slug);
      result.push(slug);
    }
  };

  // Явные якоря: совпадение по slug, заголовку или синониму (нормализованно).
  for (const raw of params.explicit ?? []) {
    const norm = normalize(raw);
    if (norm.length === 0) continue;
    if (bySlug.has(raw)) {
      add(raw);
      continue;
    }
    const matched = graph.concepts.find(
      (c) =>
        normalize(c.title) === norm ||
        c.synonyms.some((s) => normalize(s) === norm) ||
        normalize(c.slug) === norm,
    );
    if (matched) add(matched.slug);
  }

  // Текстовый матч: по заголовку и синонимам концептов.
  const normalizedText = params.text ? normalize(params.text) : '';
  if (normalizedText.length > 0) {
    for (const concept of graph.concepts) {
      const terms = [concept.title, ...concept.synonyms];
      if (terms.some((t) => containsTerm(normalizedText, t))) add(concept.slug);
    }
  }

  return result;
}

/** Проверяет, выполнено ли условие связи в текущем контексте сцены. */
function conditionSatisfied(
  condition: Record<string, unknown> | null,
  context: OntologyContext,
): boolean {
  if (!condition) return true;
  for (const [key, expected] of Object.entries(condition)) {
    const actual = (context as Record<string, unknown>)[key];
    if (actual === undefined || actual === null) return false;
    const actualNorm = normalize(String(actual));
    const values = Array.isArray(expected) ? expected : [expected];
    const ok = values.some((v) => normalize(String(v)) === actualNorm);
    if (!ok) return false;
  }
  return true;
}

/**
 * Фаза B — извлечение подграфа рассуждения.
 *
 * От якорей обходит граф по исходящим связям на глубину `depth`, отбирая концепты
 * и связи, релевантные сцене. Вклад затухает с расстоянием (вес × decay^шаг), обход
 * ограничен бюджетом узлов/рёбер, условные связи (`condition`) учитываются только
 * при совпадении контекста (например `{"season":"зима"}` — лишь зимой). Многошаговые
 * причинно-следственные цепочки попадают в подграф целиком — то, чего RAG не давал.
 */
export function extractSubgraph(
  graph: OntologyGraph,
  anchorSlugs: string[],
  options: OntologyTraversalOptions = {},
  context: OntologyContext = {},
): OntologySubgraph {
  // Берём только реально заданные опции: спред с undefined-значениями затёр бы
  // значения по умолчанию (частая ловушка — вызывающий передаёт {depth: undefined}).
  const opts: Required<OntologyTraversalOptions> = { ...DEFAULT_OPTIONS };
  if (options.depth !== undefined) opts.depth = options.depth;
  if (options.decay !== undefined) opts.decay = options.decay;
  if (options.maxConcepts !== undefined) opts.maxConcepts = options.maxConcepts;
  if (options.maxRelations !== undefined) opts.maxRelations = options.maxRelations;
  const bySlug = new Map(graph.concepts.map((c) => [c.slug, c]));

  // Исходящие связи по slug источника (с учётом условий контекста).
  const outgoing = new Map<string, OntologyRelationEdge[]>();
  for (const rel of graph.relations) {
    if (!bySlug.has(rel.fromSlug) || !bySlug.has(rel.toSlug)) continue;
    if (!conditionSatisfied(rel.condition, context)) continue;
    const list = outgoing.get(rel.fromSlug) ?? [];
    list.push(rel);
    outgoing.set(rel.fromSlug, list);
  }

  // Лучший (максимальный) накопленный вес и минимальный шаг на концепт.
  const score = new Map<string, number>();
  const stepOf = new Map<string, number>();
  const anchors: string[] = [];
  const anchorSet = new Set<string>();

  let frontier: Array<{ slug: string; acc: number }> = [];
  for (const slug of anchorSlugs) {
    const concept = bySlug.get(slug);
    if (!concept || anchorSet.has(slug)) continue;
    anchorSet.add(slug);
    anchors.push(slug);
    const acc = concept.weight;
    score.set(slug, acc);
    stepOf.set(slug, 0);
    frontier.push({ slug, acc });
  }

  const usedRelations: OntologyRelationEdge[] = [];
  const relationSeen = new Set<string>();

  for (let step = 1; step <= opts.depth && frontier.length > 0; step += 1) {
    const next: Array<{ slug: string; acc: number }> = [];
    for (const { slug, acc } of frontier) {
      for (const rel of outgoing.get(slug) ?? []) {
        const contribution = acc * rel.weight * opts.decay;
        const relKey = `${rel.fromSlug}|${rel.relation}|${rel.toSlug}`;
        if (!relationSeen.has(relKey)) {
          relationSeen.add(relKey);
          usedRelations.push(rel);
        }
        const prev = score.get(rel.toSlug);
        if (prev === undefined || contribution > prev) {
          score.set(rel.toSlug, contribution);
          if (!stepOf.has(rel.toSlug) || step < (stepOf.get(rel.toSlug) ?? Infinity)) {
            stepOf.set(rel.toSlug, step);
          }
          next.push({ slug: rel.toSlug, acc: contribution });
        }
      }
    }
    frontier = next;
  }

  // Бюджет узлов: топ-N концептов по весу (якоря всегда приоритетны по score).
  const concepts: OntologySubgraphConcept[] = [...score.entries()]
    .map(([slug, sc]) => ({
      concept: bySlug.get(slug)!,
      score: sc,
      step: stepOf.get(slug) ?? 0,
      anchor: anchorSet.has(slug),
    }))
    .sort((a, b) => {
      if (a.anchor !== b.anchor) return a.anchor ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, opts.maxConcepts);

  const selectedSlugs = new Set(concepts.map((c) => c.concept.slug));

  // Бюджет рёбер: только связи между выбранными концептами, топ-M по весу.
  const relations: OntologySubgraphRelation[] = usedRelations
    .filter((rel) => selectedSlugs.has(rel.fromSlug) && selectedSlugs.has(rel.toSlug))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, opts.maxRelations)
    .map((rel) => ({
      fromSlug: rel.fromSlug,
      toSlug: rel.toSlug,
      fromTitle: bySlug.get(rel.fromSlug)?.title ?? rel.fromSlug,
      toTitle: bySlug.get(rel.toSlug)?.title ?? rel.toSlug,
      relation: rel.relation,
      weight: rel.weight,
      note: rel.note,
    }));

  return { anchors, concepts, relations };
}

/**
 * Удобная обёртка фаз A+B: по тексту хода и/или явным якорям возвращает подграф.
 * Чистая функция поверх загруженного графа — используется движком и тестами.
 */
export function retrieveOntologySubgraph(
  graph: OntologyGraph,
  params: { text?: string; explicit?: string[] },
  options: OntologyTraversalOptions = {},
  context: OntologyContext = {},
): OntologySubgraph {
  const anchors = matchAnchors(graph, params);
  return extractSubgraph(graph, anchors, options, context);
}
