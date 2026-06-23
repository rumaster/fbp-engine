/**
 * Тесты сборки graph_context по режиму (issue #334, Этап 5 плана graph-rag-plan.md).
 *
 * Покрывают чистую детерминированную логику ретрива узла ontology_query: выбор
 * релевантных сцене сообществ (пересечение по slug, сортировка, бюджет, фолбэк на
 * общий обзор), сериализацию сводок и сборку по трём режимам (local/global/hybrid).
 * Без сети и БД — голые объекты.
 */
import { describe, expect, it } from 'vitest';
import {
  selectRelevantCommunities,
  buildCommunitySummariesBlock,
  buildGraphContext,
  GRAPH_GLOBAL_EMPTY_BLOCK,
  type CommunitySummary,
} from '@tg-games/core/engine/graphRetrieval.js';

function community(title: string, summary: string, memberSlugs: string[]): CommunitySummary {
  return { title, summary, memberSlugs };
}

const COMMUNITIES: CommunitySummary[] = [
  community('Опасности зимы', 'Холод убивает без укрытия.', ['moroz', 'nochleg']),
  community('Добыча еды', 'Голод гонит к мусоркам и столовым.', ['golod', 'pomoyka']),
  community('Документы', 'Без паспорта закрыты приюты.', ['pasport', 'priyut']),
];

describe('selectRelevantCommunities (#334)', () => {
  it('берёт только пересекающиеся со сценой сообщества', () => {
    const selected = selectRelevantCommunities(COMMUNITIES, ['moroz']);
    expect(selected).toHaveLength(1);
    expect(selected[0].title).toBe('Опасности зимы');
  });

  it('сортирует по величине пересечения (больше → выше)', () => {
    const selected = selectRelevantCommunities(COMMUNITIES, ['golod', 'pomoyka', 'moroz']);
    expect(selected.map((c) => c.title)).toEqual(['Добыча еды', 'Опасности зимы']);
  });

  it('ties по пересечению разрешает по заголовку (детерминизм)', () => {
    const ties: CommunitySummary[] = [
      community('Бета', 's', ['x']),
      community('Альфа', 's', ['y']),
    ];
    const selected = selectRelevantCommunities(ties, ['x', 'y']);
    expect(selected.map((c) => c.title)).toEqual(['Альфа', 'Бета']);
  });

  it('соблюдает бюджет maxCommunities', () => {
    const selected = selectRelevantCommunities(COMMUNITIES, ['moroz', 'golod', 'pasport'], {
      maxCommunities: 2,
    });
    expect(selected).toHaveLength(2);
  });

  it('фолбэк на общий обзор без якорей сцены', () => {
    const selected = selectRelevantCommunities(COMMUNITIES, [], { maxCommunities: 2 });
    expect(selected.map((c) => c.title)).toEqual(['Опасности зимы', 'Добыча еды']);
  });

  it('фолбэк на общий обзор, если сцена не пересекает ни один кластер', () => {
    const selected = selectRelevantCommunities(COMMUNITIES, ['neizvestno'], { maxCommunities: 1 });
    expect(selected).toHaveLength(1);
    expect(selected[0].title).toBe('Опасности зимы');
  });

  it('возвращает пусто при нулевом бюджете или отсутствии сообществ', () => {
    expect(selectRelevantCommunities(COMMUNITIES, ['moroz'], { maxCommunities: 0 })).toEqual([]);
    expect(selectRelevantCommunities([], ['moroz'])).toEqual([]);
  });
});

describe('buildCommunitySummariesBlock (#334)', () => {
  it('сериализует заголовки и сводки списком', () => {
    const block = buildCommunitySummariesBlock(COMMUNITIES.slice(0, 2));
    expect(block).toContain('- Опасности зимы: Холод убивает без укрытия.');
    expect(block).toContain('- Добыча еды: Голод гонит к мусоркам и столовым.');
  });

  it('пропускает сообщества без сводки и помечает пустоту', () => {
    expect(buildCommunitySummariesBlock([community('X', '   ', ['a'])])).toBe(GRAPH_GLOBAL_EMPTY_BLOCK);
    expect(buildCommunitySummariesBlock([])).toBe(GRAPH_GLOBAL_EMPTY_BLOCK);
  });

  it('подставляет «Без названия» для пустого заголовка', () => {
    expect(buildCommunitySummariesBlock([community('', 'дух', ['a'])])).toContain('- Без названия: дух');
  });
});

describe('buildGraphContext (#334)', () => {
  const localBlock = 'ЛОКАЛЬНЫЙ ПОДГРАФ';

  it('local — только локальный подграф (обратная совместимость)', () => {
    const ctx = buildGraphContext('local', { localBlock, communities: COMMUNITIES, sceneSlugs: ['moroz'] });
    expect(ctx).toBe(localBlock);
  });

  it('global — только обзор релевантных сообществ', () => {
    const ctx = buildGraphContext('global', { localBlock, communities: COMMUNITIES, sceneSlugs: ['moroz'] });
    expect(ctx).not.toContain(localBlock);
    expect(ctx).toContain('Опасности зимы');
    expect(ctx).not.toContain('Документы');
  });

  it('hybrid — подграф сцены и под ним глобальный обзор', () => {
    const ctx = buildGraphContext('hybrid', { localBlock, communities: COMMUNITIES, sceneSlugs: ['moroz'] });
    expect(ctx).toContain('Локальный контекст (подграф сцены):');
    expect(ctx).toContain(localBlock);
    expect(ctx).toContain('Глобальный обзор (сводки сообществ):');
    expect(ctx).toContain('Опасности зимы');
  });

  it('global без сообществ деградирует до явной пометки', () => {
    const ctx = buildGraphContext('global', { localBlock, communities: [], sceneSlugs: ['moroz'] });
    expect(ctx).toBe(GRAPH_GLOBAL_EMPTY_BLOCK);
  });
});
