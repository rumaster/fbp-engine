/**
 * Тесты чистого обхода графа онтологии и сериализации подграфа (issue #323).
 *
 * Проверяют фазы плана без БД и сети: A — привязка к якорям по тексту/явному
 * входу, B — извлечение связного подграфа с затуханием, бюджетом и условиями
 * контекста, C — сериализация подграфа в текстовый блок `{{expertise}}`.
 */
import { describe, it, expect } from 'vitest';
import {
  matchAnchors,
  extractSubgraph,
  retrieveOntologySubgraph,
} from '@tg-games/core/engine/ontologyRetrieval.js';
import type { OntologyGraph } from '@tg-games/core/engine/ontologyRetrieval.js';
import { buildOntologyBlock, ONTOLOGY_EMPTY_BLOCK } from '@tg-games/core/engine/ontology.js';

/** Небольшой тестовый граф: бомж → ночлег/еда/зима. */
function graph(): OntologyGraph {
  return {
    concepts: [
      { slug: 'kollektor', kind: 'место', title: 'Коллектор', synonyms: ['теплотрасса', 'труба'], fact: 'Тёплое подземное укрытие зимой.', weight: 1 },
      { slug: 'nochleg', kind: 'потребность', title: 'Ночлег', synonyms: ['переночевать', 'сон'], fact: 'Без сна силы не восстанавливаются.', weight: 1 },
      { slug: 'moroz', kind: 'угроза', title: 'Мороз', synonyms: ['холод'], fact: 'Зимой можно замёрзнуть насмерть.', weight: 0.9 },
      { slug: 'eda', kind: 'потребность', title: 'Еда', synonyms: ['покушать'], fact: 'Голод снижает здоровье.', weight: 0.8 },
      { slug: 'pomoyka', kind: 'место', title: 'Помойка', synonyms: ['мусорка'], fact: 'Источник объедков.', weight: 0.5 },
    ],
    relations: [
      { fromSlug: 'nochleg', toSlug: 'kollektor', relation: 'находится_в', weight: 1, condition: null, note: 'Идеальное место для сна.' },
      { fromSlug: 'kollektor', toSlug: 'moroz', relation: 'опасно_в', weight: 0.9, condition: { season: 'зима' }, note: 'Без укрытия — смертельно.' },
      { fromSlug: 'eda', toSlug: 'pomoyka', relation: 'находится_в', weight: 0.7, condition: null, note: '' },
    ],
  };
}

describe('matchAnchors — фаза A (issue #323)', () => {
  it('находит якоря по тексту хода через заголовок и синонимы', () => {
    const anchors = matchAnchors(graph(), { text: 'Моя теплотрасса, хочу переночевать' });
    expect(anchors).toContain('kollektor');
    expect(anchors).toContain('nochleg');
  });

  it('не срабатывает на подстроке внутри другого слова', () => {
    // «едал» не должно матчить концепт «Еда» (синоним «покушать» тоже нет).
    const anchors = matchAnchors(graph(), { text: 'Он пообедал давно' });
    expect(anchors).not.toContain('eda');
  });

  it('явные якоря идут первыми и принимают slug/title/синоним', () => {
    const anchors = matchAnchors(graph(), { text: 'мороз кусается', explicit: ['Еда', 'kollektor'] });
    expect(anchors.slice(0, 2)).toEqual(['eda', 'kollektor']);
    expect(anchors).toContain('moroz');
  });
});

describe('extractSubgraph — фаза B (issue #323)', () => {
  it('обходит исходящие связи от якоря и тянет соседей', () => {
    const sub = extractSubgraph(graph(), ['nochleg'], {}, { season: 'зима' });
    const slugs = sub.concepts.map((c) => c.concept.slug);
    expect(slugs).toContain('nochleg');
    expect(slugs).toContain('kollektor');
    // На шаге 2 через коллектор зимой доступен мороз.
    expect(slugs).toContain('moroz');
  });

  it('условные связи отсекаются вне подходящего контекста', () => {
    const summer = extractSubgraph(graph(), ['nochleg'], {}, { season: 'лето' });
    expect(summer.concepts.map((c) => c.concept.slug)).not.toContain('moroz');
  });

  it('бюджет узлов ограничивает размер подграфа, якоря приоритетны', () => {
    const sub = extractSubgraph(graph(), ['nochleg'], { maxConcepts: 2 }, { season: 'зима' });
    expect(sub.concepts).toHaveLength(2);
    expect(sub.concepts[0].concept.slug).toBe('nochleg');
    expect(sub.concepts[0].anchor).toBe(true);
  });

  it('глубина 0 даёт только якоря', () => {
    const sub = extractSubgraph(graph(), ['nochleg'], { depth: 0 });
    expect(sub.concepts.map((c) => c.concept.slug)).toEqual(['nochleg']);
  });

  it('undefined-опции не затирают значения по умолчанию', () => {
    // Регрессия: спред {...DEFAULT, ...{depth: undefined}} раньше делал depth=undefined
    // и обход не выполнялся вовсе. Явно заданный undefined должен означать «по умолчанию».
    const sub = extractSubgraph(
      graph(),
      ['nochleg'],
      { depth: undefined, decay: undefined, maxConcepts: undefined, maxRelations: undefined },
      { season: 'зима' },
    );
    expect(sub.concepts.map((c) => c.concept.slug)).toContain('kollektor');
  });
});

describe('retrieveOntologySubgraph — обёртка A+B (issue #323)', () => {
  it('по тексту собирает связный подграф', () => {
    const sub = retrieveOntologySubgraph(graph(), { text: 'хочу переночевать' }, {}, { season: 'зима' });
    expect(sub.anchors).toContain('nochleg');
    expect(sub.relations.length).toBeGreaterThan(0);
  });
});

describe('buildOntologyBlock — фаза C (issue #323)', () => {
  it('пустой подграф даёт явную пометку', () => {
    expect(buildOntologyBlock({ anchors: [], concepts: [], relations: [] })).toBe(ONTOLOGY_EMPTY_BLOCK);
  });

  it('сериализует концепты с фактурой и связи словами', () => {
    const sub = retrieveOntologySubgraph(graph(), { text: 'хочу переночевать' }, {}, { season: 'зима' });
    const block = buildOntologyBlock(sub);
    expect(block).toContain('Ночлег: Без сна');
    expect(block).toContain('Связи:');
    expect(block).toContain('находится в');
    expect(block).toContain('— Идеальное место для сна.');
  });
});
