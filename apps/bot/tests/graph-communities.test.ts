/**
 * Тесты сообществ графа и сводок (issue #328/#334, Этап 4 плана graph-rag-plan.md).
 *
 * Покрывают детерминированную кластеризацию (связные компоненты по сильным
 * рёбрам, отсев слабых связей и одиночек, стабильный порядок и якорь) и
 * построение LLM-сводок «духа» кластеров с повторами/деградацией. LLM —
 * мок-провайдер, без сети и БД.
 */
import { describe, expect, it } from 'vitest';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { OntologyGraph } from '@tg-games/core/engine/ontologyRetrieval.js';
import {
  detectCommunities,
  summarizeCommunities,
  parseCommunitySummary,
  buildCommunitySummaryPrompt,
} from '@tg-games/core/engine/graphCommunities.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const bomj = TEST_GAMES.bomj;

function concept(slug: string, weight = 1, title = slug, kind = 'состояние', fact = '') {
  return { slug, kind, title, synonyms: [] as string[], fact, weight };
}
function relation(fromSlug: string, toSlug: string, relation = 'требует', weight = 1) {
  return { fromSlug, toSlug, relation, weight, condition: null, note: '' };
}

function stubProvider(responses: Array<string | Error>): ILLMProvider {
  let i = 0;
  return {
    name: 'stub',
    async generateText() {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('detectCommunities (#328)', () => {
  it('находит связные компоненты и отбрасывает одиночек', () => {
    const graph: OntologyGraph = {
      concepts: [concept('a'), concept('b'), concept('c'), concept('lonely')],
      relations: [relation('a', 'b'), relation('b', 'c')],
    };
    const communities = detectCommunities(graph);
    expect(communities).toHaveLength(1);
    expect(communities[0].memberSlugs.sort()).toEqual(['a', 'b', 'c']);
  });

  it('разделяет несвязанные кластеры', () => {
    const graph: OntologyGraph = {
      concepts: [concept('a'), concept('b'), concept('x'), concept('y')],
      relations: [relation('a', 'b'), relation('x', 'y')],
    };
    const communities = detectCommunities(graph);
    expect(communities).toHaveLength(2);
  });

  it('отсекает слабые рёбра по minWeight', () => {
    const graph: OntologyGraph = {
      concepts: [concept('a'), concept('b'), concept('c')],
      relations: [relation('a', 'b', 'требует', 0.9), relation('b', 'c', 'требует', 0.1)],
    };
    const communities = detectCommunities(graph, { minWeight: 0.5 });
    // c отвалилось (слабое ребро) и стало одиночкой → выброшено.
    expect(communities).toHaveLength(1);
    expect(communities[0].memberSlugs.sort()).toEqual(['a', 'b']);
  });

  it('выбирает якорь по максимальному весу (ties → slug)', () => {
    const graph: OntologyGraph = {
      concepts: [concept('a', 1), concept('b', 5), concept('c', 5)],
      relations: [relation('a', 'b'), relation('b', 'c')],
    };
    const [community] = detectCommunities(graph);
    expect(community.anchorSlug).toBe('b');
    // memberSlugs упорядочены: вес ↓, затем slug ↑.
    expect(community.memberSlugs).toEqual(['b', 'c', 'a']);
  });

  it('игнорирует петли и порядок рёбер (детерминизм)', () => {
    const g1: OntologyGraph = {
      concepts: [concept('a'), concept('b'), concept('c')],
      relations: [relation('a', 'a'), relation('a', 'b'), relation('c', 'b')],
    };
    const g2: OntologyGraph = {
      concepts: [concept('c'), concept('b'), concept('a')],
      relations: [relation('c', 'b'), relation('b', 'a')],
    };
    expect(detectCommunities(g1)).toEqual(detectCommunities(g2));
  });

  it('сортирует сообщества: крупнее выше, ties по якорю', () => {
    const graph: OntologyGraph = {
      concepts: [concept('a'), concept('b'), concept('c'), concept('x'), concept('y')],
      relations: [relation('a', 'b'), relation('b', 'c'), relation('x', 'y')],
    };
    const communities = detectCommunities(graph);
    expect(communities[0].memberSlugs).toHaveLength(3);
    expect(communities[1].memberSlugs).toHaveLength(2);
  });
});

describe('parseCommunitySummary (#328)', () => {
  it('парсит title и summary', () => {
    expect(parseCommunitySummary('{"title":"Опасности зимы","summary":"Холод убивает."}')).toEqual({
      title: 'Опасности зимы',
      summary: 'Холод убивает.',
    });
  });

  it('возвращает null без summary или на мусоре', () => {
    expect(parseCommunitySummary('{"title":"x"}')).toBeNull();
    expect(parseCommunitySummary('не json')).toBeNull();
  });
});

describe('buildCommunitySummaryPrompt (#328)', () => {
  it('включает концепты с фактурой и внутренние связи', () => {
    const graph: OntologyGraph = {
      concepts: [concept('moroz', 1, 'Мороз', 'угроза', 'Убивает.'), concept('nochleg', 1, 'Ночлег', 'место', 'Спасает.')],
      relations: [relation('moroz', 'nochleg', 'опасно_в')],
    };
    const community = detectCommunities(graph)[0];
    const prompt = buildCommunitySummaryPrompt(community, graph);
    expect(prompt).toContain('Мороз (угроза): Убивает.');
    expect(prompt).toContain('moroz —опасно_в→ nochleg');
  });
});

describe('summarizeCommunities (#328)', () => {
  const graph: OntologyGraph = {
    concepts: [concept('moroz', 1, 'Мороз', 'угроза'), concept('nochleg', 1, 'Ночлег', 'место')],
    relations: [relation('moroz', 'nochleg', 'опасно_в')],
  };

  it('строит сид сводки на каждый кластер', async () => {
    const provider = stubProvider(['{"title":"Опасности зимы","summary":"Холод убивает без укрытия."}']);
    const communities = detectCommunities(graph);
    const { seeds } = await summarizeCommunities(provider, bomj, graph, communities);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].title).toBe('Опасности зимы');
    expect(seeds[0].summary).toBe('Холод убивает без укрытия.');
    expect(seeds[0].memberSlugs.sort()).toEqual(['moroz', 'nochleg']);
  });

  it('подменяет пустой title заголовком якоря', async () => {
    const provider = stubProvider(['{"summary":"Только дух, без заголовка."}']);
    const communities = detectCommunities(graph);
    const { seeds } = await summarizeCommunities(provider, bomj, graph, communities);
    expect(seeds[0].title).toBe(communities[0].anchorTitle);
  });

  it('пропускает кластер, если все попытки провалились', async () => {
    const provider = stubProvider([new Error('сеть упала')]);
    const communities = detectCommunities(graph);
    const { seeds } = await summarizeCommunities(provider, bomj, graph, communities, { maxRetries: 2 });
    expect(seeds).toHaveLength(0);
  });
});
