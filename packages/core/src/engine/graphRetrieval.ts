/**
 * Graph RAG — сборка контекста по режиму ретрива (issue #334, §4.3).
 *
 * Локальный ретрив обходит граф концептов от якорей сцены и кладёт в
 * `{{expertise}}` локальный подграф. Graph RAG добавляет контекстный канал
 * `{{graph_context}}` и режим ретрива:
 *   • local  — только локальный подграф;
 *   • global — обзорные сводки сообществ (map-reduce: выбираем релевантные сцене
 *     кластеры и конкатенируем их сводки — БЕЗ LLM на горячем пути, дёшево и
 *     детерминированно, чего не даёт ни Vector RAG, ни локальный обход);
 *   • hybrid — подграф сцены плюс глобальный обзор.
 *
 * Здесь — чистая детерминированная логика (как ontology.ts/ontologyRetrieval.ts),
 * не зависящая от сети и БД: на вход подаются уже собранный локальный блок,
 * сводки сообществ (загружены репозиторием) и slug-и концептов сцены. Это делает
 * сборку тривиально тестируемой.
 */

export type GraphContextMode = 'local' | 'global' | 'hybrid';

/**
 * Сводка сообщества в форме, нужной сборке контекста. Структурно совместима с
 * {@link GraphCommunity} из репозитория (берём только title/summary/memberSlugs),
 * поэтому модуль не тянет за собой БД и тестируется на голых объектах.
 */
export interface CommunitySummary {
  title: string;
  summary: string;
  memberSlugs: string[];
}

/** Опции выбора релевантных сообществ для глобального обзора. */
export interface CommunitySelectionOptions {
  /** Максимум сообществ в обзоре (бюджет промпта). */
  maxCommunities?: number;
}

/** Сообществ в глобальном обзоре по умолчанию — небольшой бюджет промпта. */
export const DEFAULT_MAX_COMMUNITIES = 4;

/** Пометка отсутствия обзорных сводок — единая форма с ONTOLOGY_EMPTY_BLOCK. */
export const GRAPH_GLOBAL_EMPTY_BLOCK = 'Обзорных сводок о мире пока нет.';

/**
 * Выбирает релевантные сцене сообщества (фаза reduce глобального ретрива).
 *
 * Сообщество релевантно, если его концепты пересекаются с концептами сцены
 * (sceneSlugs — slug-и локального подграфа). Сортировка детерминированна: больше
 * пересечение → выше, ties → по заголовку (lexicographic). Бюджет — maxCommunities.
 *
 * Фолбэк на общий обзор: если якорей сцены нет или пересечений не нашлось, берём
 * первые сообщества как есть (источник уже отсортировал их по уровню/заголовку) —
 * обзорный запрос «о мире в целом» не должен молчать из-за неудачной привязки.
 */
export function selectRelevantCommunities(
  communities: CommunitySummary[],
  sceneSlugs: string[],
  options: CommunitySelectionOptions = {},
): CommunitySummary[] {
  const maxCommunities = options.maxCommunities ?? DEFAULT_MAX_COMMUNITIES;
  if (maxCommunities <= 0 || communities.length === 0) return [];

  const scene = new Set(sceneSlugs);
  if (scene.size === 0) return communities.slice(0, maxCommunities);

  const scored = communities.map((community, index) => {
    const overlap = community.memberSlugs.reduce((n, slug) => (scene.has(slug) ? n + 1 : n), 0);
    return { community, overlap, index };
  });
  const relevant = scored.filter((s) => s.overlap > 0);
  if (relevant.length === 0) return communities.slice(0, maxCommunities);

  relevant.sort((a, b) => {
    if (a.overlap !== b.overlap) return b.overlap - a.overlap;
    const ta = a.community.title;
    const tb = b.community.title;
    return ta < tb ? -1 : ta > tb ? 1 : a.index - b.index;
  });
  return relevant.slice(0, maxCommunities).map((s) => s.community);
}

/**
 * Сериализует сводки сообществ в блок обзора. Сообщества без сводки пропускаются;
 * пустой результат — явная пометка (модель не выдумывает обзор), как и в локальном
 * блоке (ONTOLOGY_EMPTY_BLOCK).
 */
export function buildCommunitySummariesBlock(communities: CommunitySummary[]): string {
  const lines = communities
    .filter((c) => c.summary.trim().length > 0)
    .map((c) => `- ${c.title.trim() || 'Без названия'}: ${c.summary.trim()}`);
  if (lines.length === 0) return GRAPH_GLOBAL_EMPTY_BLOCK;
  return lines.join('\n');
}

/** Параметры сборки graph_context. */
export interface GraphContextParams {
  /** Локальный блок подграфа сцены (результат buildOntologyBlock). */
  localBlock: string;
  /** Сводки сообществ игры (loadGameCommunities); пусто — глобальный обзор деградирует. */
  communities: CommunitySummary[];
  /** Slug-и концептов сцены (из локального подграфа) для привязки сообществ. */
  sceneSlugs: string[];
  /** Бюджет сообществ для глобального обзора. */
  maxCommunities?: number;
}

/**
 * Собирает значение выхода `graph_context` по режиму (issue #334, §4.3).
 *
 *   • local  — локальный подграф как есть (обратная совместимость с #323);
 *   • global — обзор релевантных сообществ (map-reduce, без LLM);
 *   • hybrid — подграф сцены и под ним глобальный обзор, оба под заголовками.
 *
 * Детерминированная конкатенация — горячий путь хода не делает LLM-вызовов.
 */
export function buildGraphContext(mode: GraphContextMode, params: GraphContextParams): string {
  if (mode === 'local') return params.localBlock;

  const selected = selectRelevantCommunities(params.communities, params.sceneSlugs, {
    maxCommunities: params.maxCommunities,
  });
  const globalBlock = buildCommunitySummariesBlock(selected);
  if (mode === 'global') return globalBlock;

  // hybrid: локальный подграф сцены плюс глобальный обзор сообществ.
  return [
    'Локальный контекст (подграф сцены):',
    params.localBlock,
    '',
    'Глобальный обзор (сводки сообществ):',
    globalBlock,
  ].join('\n');
}
