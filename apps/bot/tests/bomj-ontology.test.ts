/**
 * Тесты целостности стартовой онтологии «Выживания бомжа» (issue #323).
 *
 * Граф сидируется в БД, поэтому ссылочная целостность важна заранее: каждая связь
 * должна указывать на существующие концепты, slug — быть уникальными, веса —
 * корректными. Плюс sanity-проверка обхода: по типичному ходу собирается осмысленный
 * подграф (ночлег зимой ведёт к теплу/теплотрассе/морозу).
 */
import { describe, it, expect } from 'vitest';
import { BOMJ_ONTOLOGY, BOMJ_GAME_ID } from '@tg-games/core/examples/bomjOntology.js';
import { retrieveOntologySubgraph } from '@tg-games/core/engine/ontologyRetrieval.js';
import type { OntologyGraph } from '@tg-games/core/engine/ontologyRetrieval.js';
import { buildOntologyBlock } from '@tg-games/core/engine/ontology.js';

const seed = BOMJ_ONTOLOGY;

describe('целостность онтологии «Выживания бомжа» (issue #323)', () => {
  it('game_id совпадает с базой знаний', () => {
    expect(BOMJ_GAME_ID).toBe('bomj');
  });

  it('slug концептов уникальны', () => {
    const slugs = seed.concepts.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('каждая связь ссылается на существующие концепты', () => {
    const slugs = new Set(seed.concepts.map((c) => c.slug));
    for (const rel of seed.relations) {
      expect(slugs.has(rel.fromSlug), `from ${rel.fromSlug}`).toBe(true);
      expect(slugs.has(rel.toSlug), `to ${rel.toSlug}`).toBe(true);
    }
  });

  it('связи уникальны по (from, to, relation)', () => {
    const keys = seed.relations.map((r) => `${r.fromSlug}|${r.toSlug}|${r.relation}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('у концептов есть фактура и положительный вес', () => {
    for (const c of seed.concepts) {
      expect(c.title.length, c.slug).toBeGreaterThan(0);
      expect(c.fact?.trim().length ?? 0, c.slug).toBeGreaterThan(0);
      expect(c.weight ?? 1).toBeGreaterThan(0);
    }
  });
});

describe('обход стартовой онтологии (issue #323)', () => {
  const graph: OntologyGraph = {
    concepts: seed.concepts.map((c) => ({
      slug: c.slug,
      kind: c.kind,
      title: c.title,
      synonyms: c.synonyms ?? [],
      fact: c.fact ?? '',
      weight: c.weight ?? 1,
    })),
    relations: seed.relations.map((r) => ({
      fromSlug: r.fromSlug,
      toSlug: r.toSlug,
      relation: r.relation,
      weight: r.weight ?? 1,
      condition: r.condition ?? null,
      note: r.note ?? '',
    })),
  };

  it('по ходу «ищу где переночевать» зимой собирает осмысленный подграф', () => {
    const sub = retrieveOntologySubgraph(
      graph,
      { text: 'Ищу, где переночевать, на улице мороз' },
      {},
      { season: 'зима', timeOfDay: 'ночь' },
    );
    const slugs = sub.concepts.map((c) => c.concept.slug);
    expect(slugs).toContain('nochleg');
    expect(slugs).toContain('teplo');
    expect(slugs).toContain('teplotrassa');
    // Через тепло/мороз зимой подтягивается угроза здоровью.
    expect(slugs).toContain('moroz');

    const block = buildOntologyBlock(sub);
    expect(block).toContain('Связи:');
    expect(block).toContain('требует');
  });

  it('летом сезонные связи мороза не активируются', () => {
    const sub = retrieveOntologySubgraph(
      graph,
      { text: 'Ищу, где переночевать' },
      {},
      { season: 'лето' },
    );
    const moroz = sub.relations.find((r) => r.toSlug === 'moroz' || r.fromSlug === 'moroz');
    expect(moroz).toBeUndefined();
  });
});
