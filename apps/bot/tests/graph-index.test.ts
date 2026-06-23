/**
 * Тесты индексации графа знаний (issue #328/#334, Этап 3 плана graph-rag-plan.md).
 *
 * Покрывают чистый offline-пайплайн извлечения: детерминированный slug
 * (кириллица→латиница, как у ручных онтологий), парсинг ответа LLM по закрытому
 * справочнику (отбраковка неизвестных типов связей и «висячих» рёбер), слияние
 * подграфов с дедупликацией, повторы/деградацию при сбое провайдера, критик-
 * проход и сборку графа из набора документов с провенансом. Без сети и БД —
 * LLM подменяется мок-провайдером (как в game-expertise.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import {
  slugify,
  parseGraphExtraction,
  mergeExtractions,
  runDocumentExtraction,
  runGraphCritic,
  buildGraphFromExpertise,
  buildGraphExtractionSystemPrompt,
  parseGraphCritic,
  DEFAULT_GRAPH_VOCABULARY,
  type ExtractedGraph,
} from '@tg-games/core/engine/graphIndex.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const bomj = TEST_GAMES.bomj;

/** Мок-провайдер: отдаёт заранее заданные ответы по очереди (как в фазе 0). */
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

describe('slugify (#328)', () => {
  it('транслитерирует кириллицу в латиницу как ручные slug', () => {
    expect(slugify('Ночлег')).toBe('nochleg');
    expect(slugify('Теплотрасса')).toBe('teplotrassa');
    expect(slugify('Мороз')).toBe('moroz');
  });

  it('схлопывает разделители и обрезает края', () => {
    expect(slugify('  Тёплая  одежда!  ')).toBe('teplaya_odezhda');
    expect(slugify('Пункт обогрева (МЧС)')).toBe('punkt_obogreva_mchs');
  });

  it('сохраняет уже латинские токены и цифры', () => {
    expect(slugify('Wi-Fi 5G')).toBe('wi_fi_5g');
  });
});

describe('parseGraphExtraction (#328)', () => {
  it('парсит валидный ответ: концепты со slug и связи', () => {
    const raw = JSON.stringify({
      entities: [
        { title: 'Мороз', kind: 'угроза', synonyms: ['холод'], fact: 'Убивает без укрытия.' },
        { title: 'Ночлег', kind: 'место', synonyms: [], fact: 'Тёплое место для сна.' },
      ],
      relations: [{ from: 'Мороз', to: 'Ночлег', type: 'опасно_в', note: 'на улице', condition: null }],
    });
    const graph = parseGraphExtraction(raw);
    expect(graph).not.toBeNull();
    expect(graph!.concepts.map((c) => c.slug)).toEqual(['moroz', 'nochleg']);
    expect(graph!.concepts[0].synonyms).toEqual(['холод']);
    expect(graph!.relations).toHaveLength(1);
    expect(graph!.relations[0]).toMatchObject({ fromSlug: 'moroz', toSlug: 'nochleg', relation: 'опасно_в' });
  });

  it('отбрасывает связь с типом вне закрытого справочника', () => {
    const raw = JSON.stringify({
      entities: [
        { title: 'Мороз', kind: 'угроза', fact: '' },
        { title: 'Ночлег', kind: 'место', fact: '' },
      ],
      relations: [{ from: 'Мороз', to: 'Ночлег', type: 'любит', note: '' }],
    });
    const graph = parseGraphExtraction(raw);
    expect(graph!.concepts).toHaveLength(2);
    expect(graph!.relations).toHaveLength(0);
  });

  it('отбрасывает «висячее» ребро на необъявленный концепт', () => {
    const raw = JSON.stringify({
      entities: [{ title: 'Мороз', kind: 'угроза', fact: '' }],
      relations: [{ from: 'Мороз', to: 'Призрак', type: 'опасно_в' }],
    });
    const graph = parseGraphExtraction(raw);
    expect(graph!.concepts).toHaveLength(1);
    expect(graph!.relations).toHaveLength(0);
  });

  it('сохраняет условие связи только как объект', () => {
    const raw = JSON.stringify({
      entities: [
        { title: 'Мороз', kind: 'угроза', fact: '' },
        { title: 'Ночлег', kind: 'место', fact: '' },
      ],
      relations: [
        { from: 'Мороз', to: 'Ночлег', type: 'опасно_в', condition: { season: 'зима' } },
        { from: 'Ночлег', to: 'Мороз', type: 'противоречит', condition: 'зимой' },
      ],
    });
    const graph = parseGraphExtraction(raw);
    expect(graph!.relations[0].condition).toEqual({ season: 'зима' });
    expect(graph!.relations[1].condition).toBeNull();
  });

  it('возвращает null на нераспарсиваемом ответе', () => {
    expect(parseGraphExtraction('это не json')).toBeNull();
  });

  it('извлекает JSON из обёртки и кодовых ограждений', () => {
    const raw = '```json\n{"entities":[{"title":"Мороз","kind":"угроза","fact":"x"}],"relations":[]}\n```';
    const graph = parseGraphExtraction(raw);
    expect(graph!.concepts[0].slug).toBe('moroz');
  });
});

describe('mergeExtractions (#328)', () => {
  it('дедуплицирует концепты по slug, объединяя синонимы и беря длинную фактуру', () => {
    const a: ExtractedGraph = {
      concepts: [{ slug: 'moroz', kind: 'угроза', title: 'Мороз', synonyms: ['холод'], fact: 'Опасен.' }],
      relations: [],
    };
    const b: ExtractedGraph = {
      concepts: [{ slug: 'moroz', kind: 'угроза', title: 'Мороз', synonyms: ['стужа'], fact: 'Убивает без укрытия зимой.' }],
      relations: [],
    };
    const merged = mergeExtractions([a, b]);
    expect(merged.concepts).toHaveLength(1);
    expect(merged.concepts[0].synonyms.sort()).toEqual(['стужа', 'холод']);
    expect(merged.concepts[0].fact).toBe('Убивает без укрытия зимой.');
  });

  it('дедуплицирует связи по тройке from|relation|to', () => {
    const rel = { fromSlug: 'moroz', toSlug: 'nochleg', relation: 'опасно_в' as const };
    const merged = mergeExtractions([
      { concepts: [], relations: [{ ...rel, note: 'a' }] },
      { concepts: [], relations: [{ ...rel, note: 'b' }] },
    ]);
    expect(merged.relations).toHaveLength(1);
  });
});

describe('runDocumentExtraction (#328)', () => {
  const doc = { id: 'd1', title: 'Зимовка', content: 'Мороз убивает. Ночлег спасает.' };

  it('повторяет вызов при невалидном JSON и принимает следующий валидный', async () => {
    const provider = stubProvider([
      'мусор без json',
      JSON.stringify({ entities: [{ title: 'Мороз', kind: 'угроза', fact: 'x' }], relations: [] }),
    ]);
    const { graph } = await runDocumentExtraction(provider, bomj, doc, { maxRetries: 3 });
    expect(graph.concepts.map((c) => c.slug)).toEqual(['moroz']);
  });

  it('возвращает пустой подграф, если все попытки провалились', async () => {
    const provider = stubProvider([new Error('сеть упала')]);
    const { graph } = await runDocumentExtraction(provider, bomj, doc, { maxRetries: 2 });
    expect(graph).toEqual({ concepts: [], relations: [] });
  });
});

describe('runGraphCritic (#328)', () => {
  const graph: ExtractedGraph = {
    concepts: [
      { slug: 'moroz', kind: 'угроза', title: 'Мороз', synonyms: [], fact: '' },
      { slug: 'nochleg', kind: 'место', title: 'Ночлег', synonyms: [], fact: '' },
    ],
    relations: [
      { fromSlug: 'moroz', toSlug: 'nochleg', relation: 'опасно_в' },
      { fromSlug: 'nochleg', toSlug: 'moroz', relation: 'противоречит' },
    ],
  };

  it('отбраковывает связи по вердикту критика', async () => {
    const provider = stubProvider(['{"reject":[2]}']);
    const { graph: kept, rejected } = await runGraphCritic(provider, bomj, graph);
    expect(kept.relations).toHaveLength(1);
    expect(kept.relations[0].relation).toBe('опасно_в');
    expect(rejected).toHaveLength(1);
  });

  it('при ошибке провайдера принимает все связи без отбраковки', async () => {
    const provider = stubProvider([new Error('таймаут')]);
    const { graph: kept } = await runGraphCritic(provider, bomj, graph);
    expect(kept.relations).toHaveLength(2);
  });

  it('не вызывает провайдер на пустом наборе связей', async () => {
    let called = false;
    const provider: ILLMProvider = {
      name: 'spy',
      async generateText() {
        called = true;
        return '{"reject":[]}';
      },
    };
    await runGraphCritic(provider, bomj, { concepts: graph.concepts, relations: [] });
    expect(called).toBe(false);
  });
});

describe('parseGraphCritic (#328)', () => {
  it('переводит 1-based номера в 0-based индексы в пределах total', () => {
    const rejected = parseGraphCritic('{"reject":[1,3,99]}', 3);
    expect([...rejected].sort()).toEqual([0, 2]);
  });

  it('возвращает пустое множество на мусоре', () => {
    expect(parseGraphCritic('нет json', 3).size).toBe(0);
  });
});

describe('buildGraphFromExpertise (#328)', () => {
  it('сохраняет провенанс: подграф каждого документа привязан к его id', async () => {
    const provider = stubProvider([
      JSON.stringify({
        entities: [{ title: 'Мороз', kind: 'угроза', fact: 'Убивает.' }],
        relations: [],
      }),
      JSON.stringify({
        entities: [
          { title: 'Мороз', kind: 'угроза', fact: 'Опасен зимой.' },
          { title: 'Ночлег', kind: 'место', fact: 'Спасает.' },
        ],
        relations: [{ from: 'Мороз', to: 'Ночлег', type: 'опасно_в' }],
      }),
    ]);
    const result = await buildGraphFromExpertise(provider, bomj, [
      { id: 'doc-a', title: 'A', content: 'Мороз.' },
      { id: 'doc-b', title: 'B', content: 'Мороз и ночлег.' },
    ]);
    expect(result.perDocument.map((d) => d.documentId)).toEqual(['doc-a', 'doc-b']);
    // Слитый граф дедуплицирует «Мороз» из двух документов.
    expect(result.graph.concepts.map((c) => c.slug).sort()).toEqual(['moroz', 'nochleg']);
    expect(result.graph.relations).toHaveLength(1);
  });

  it('пропускает документы без извлечённого содержимого', async () => {
    const provider = stubProvider(['пусто, не json']);
    const result = await buildGraphFromExpertise(provider, bomj, [
      { id: 'doc-empty', title: 'X', content: 'Ничего полезного.' },
    ]);
    expect(result.perDocument).toHaveLength(0);
    expect(result.graph.concepts).toHaveLength(0);
  });
});

describe('buildGraphExtractionSystemPrompt (#328)', () => {
  it('встраивает закрытый справочник видов и типов связей', () => {
    const prompt = buildGraphExtractionSystemPrompt(bomj, DEFAULT_GRAPH_VOCABULARY);
    expect(prompt).toContain('угроза');
    expect(prompt).toContain('опасно_в');
    expect(prompt).toContain(bomj.name);
  });
});
