import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { validateSchemaGraphContract } from '@tg-games/schema-contract';
import type {
  SchemaExecutionContext,
  SchemaGraph,
} from '@tg-games/core/engine/schemaEngine.js';
import { executeSchema } from '@tg-games/core/engine/schemaEngine.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import type { GameState } from '@tg-games/core/types.js';

/**
 * Рантайм-тест примера рассуждающей суб-схемы генерации нарратива (issue #317):
 * доказывает, что цикл «черновик <-> критик» собирается из существующих узлов движка
 * (llm_request + loop + variable_write/variable_read) и реально исполняется —
 * критика прошлой итерации возвращается в черновик следующей, а выход из цикла
 * управляется не счётчиком, а оценкой соответствия духу мира (exitExpression).
 */

interface SchemaBundle {
  items: Array<{ schemaSlug: string; schemaClass: string; graphJson: SchemaGraph }>;
}

function loadExampleGraph(): SchemaGraph {
  const path = fileURLToPath(
    new URL('../../../examples/narrative-reasoning-subschema.json', import.meta.url),
  );
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as SchemaBundle;
  expect(bundle.items).toHaveLength(1);
  expect(bundle.items[0]).toMatchObject({
    schemaSlug: 'narrative_reasoning',
    schemaClass: 'game',
  });
  return bundle.items[0].graphJson;
}

function loopBodyGraph(graph: SchemaGraph): SchemaGraph {
  const loop = graph.nodes.find((node) => node.type === 'loop');
  return loop?.config.bodyGraph as SchemaGraph;
}

function mockProvider(responses: string[]): ILLMProvider {
  let i = 0;
  return {
    name: 'MockNarrative',
    generateText: vi.fn(async (_opts: LLMRequestOptions) => {
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    }),
  };
}

function gameManifest(): GameManifest {
  return {
    id: 'bomj',
    name: 'Бомж',
    description: 'Суровый реалистичный город',
    priceStars: 1,
    limits: { maxHp: 10, maxInventoryItems: 8 },
    worldRules: ['Магии не существует.', 'Мир суров и не подыгрывает игроку.'],
    startTime: { season: 'осень', date: '', time: '08:00', time_of_day: 'утро' },
    characterPresets: [],
    locationPresets: [],
  };
}

function gameState(): GameState {
  return {
    location: 'Заброшенный вокзал',
    narrative: '',
    character: { hp: 6, max_hp: 10, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'осень', date: '', time: '08:00', time_of_day: 'утро' },
    turn_count: 3,
  };
}

function context(
  graph: SchemaGraph,
  provider: ILLMProvider,
  extraInputs: Record<string, unknown> = {},
): SchemaExecutionContext {
  return {
    inputs: {
      action: 'Достаю из кармана базуку и взрываю мэрию',
      expertise: 'В этом городе нет оружия военного класса у бездомных.',
      memory: 'Игрок уже неделю ночует на вокзале.',
      ...extraInputs,
    },
    nodeOutputs: new Map(),
    variables: new Map(Object.entries(graph.variables ?? {})),
    llmLog: [],
    provider,
    manifest: gameManifest(),
    state: gameState(),
    maxRetries: 1,
  };
}

describe('пример рассуждающей суб-схемы генерации нарратива (issue #317)', () => {
  it('импортируемый JSON проходит контракт — и внешний граф, и тело цикла', () => {
    const graph = loadExampleGraph();
    expect(() => validateSchemaGraphContract(graph)).not.toThrow();
    expect(() => validateSchemaGraphContract(loopBodyGraph(graph))).not.toThrow();
  });

  it('цикл «черновик ↔ критик» крутится до соответствия духу мира и возвращает нарратив', async () => {
    const graph = loadExampleGraph();
    // Сценарий: анализ -> черновик1 (слабый, score 5) -> черновик2 (исправленный, score 9).
    // Выход из цикла — по оценке критика (>= 8), а не по исчерпанию итераций.
    const provider = mockProvider([
      JSON.stringify({ criteria: 'Базука у бомжа невозможна; мир должен жёстко отказать.', severity: 8 }),
      JSON.stringify({ draft: 'Ты шаришь по карманам, но там лишь крошки хлеба.' }),
      JSON.stringify({ score: 5, critique: 'Слишком мягко: нет реакции прохожих на безумие.' }),
      JSON.stringify({ draft: 'Карманы пусты. Прохожие шарахаются от твоего бреда про базуку.' }),
      JSON.stringify({ score: 9, critique: 'Хорошо: мир жёстко отверг невозможное.' }),
    ]);
    const execContext = context(graph, provider);

    const outputs = await executeSchema(graph, execContext);

    expect(outputs).toMatchObject({
      narrative: 'Карманы пусты. Прохожие шарахаются от твоего бреда про базуку.',
      severity: 8,
      critique: 'Хорошо: мир жёстко отверг невозможное.',
    });

    // Ровно 5 вызовов: анализ + 2 итерации (черновик+критик). Третья итерация не
    // запускается — exitExpression остановил цикл после score 9.
    expect(provider.generateText).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(provider.generateText).mock.calls;

    // Анализ опирается на правила мира и экспертизу, а не на точные цифры.
    expect(calls[0][0].prompt).toContain('Магии не существует.');
    expect(calls[0][0].prompt).toContain('В этом городе нет оружия военного класса');

    // Критика первой итерации возвращается в системную инструкцию второго черновика —
    // это и есть рефлексивная обратная связь.
    expect(calls[3][0].systemInstruction).toContain('Слишком мягко');

    // Кинды LLM-вызовов: анализ/критик — оценка мира, черновик — генерация нарратива.
    expect(execContext.llmLog.map((entry) => entry.kind)).toEqual([
      'world_state_evaluation',
      'narrative_generation',
      'world_state_evaluation',
      'narrative_generation',
      'world_state_evaluation',
    ]);
  });

  it('граф-контекст подаётся в анализ и критика — абсурдное действие ловится по связи/сводке графа (issue #334)', async () => {
    const graph = loadExampleGraph();
    // Graph RAG (issue #334, этап 7): выход graph_context узла ontology_query
    // (локальный подграф + обзор сообществ) подаётся входом graph_context в фазы
    // анализа и критика суб-схемы. Здесь «убийственный» закон мира живёт ТОЛЬКО в
    // графе, а expertise намеренно нейтральна — так тест доказывает, что абсурдное
    // действие ловится именно по связи/сводке графа, а не по векторной экспертизе.
    const graphContext = [
      'Локальный контекст (подграф сцены):',
      'Связи: военное оружие — недоступно — бездомный (закон мира, безусловно).',
      '',
      'Глобальный обзор (сводки сообществ):',
      '- Насилие и оружие: у бездомных в этом мире нет доступа к военному оружию; попытку «достать базуку из кармана» мир встречает как невозможный бред.',
    ].join('\n');

    // Сценарий: анализ выводит критерий из связи графа -> черновик1 подыгрывает
    // (базука!), критик ловит нарушение связи (score 3) -> черновик2 исправлен ->
    // критик принимает (score 9). Выход — по оценке критика.
    const provider = mockProvider([
      JSON.stringify({
        criteria: 'Граф объявляет военное оружие недоступным бездомному — действие невозможно, мир обязан отказать.',
        severity: 9,
      }),
      JSON.stringify({ draft: 'Ты суёшь руку в карман — и достаёшь базуку.' }),
      JSON.stringify({
        score: 3,
        critique: 'Нарушена связь графа «военное оружие — недоступно — бездомный»: базуки у бомжа быть не может.',
      }),
      JSON.stringify({ draft: 'В кармане лишь мокрый окурок. Никакой базуки в этом мире у тебя быть не может.' }),
      JSON.stringify({ score: 9, critique: 'Хорошо: мир соблюл связь графа и отверг невозможное.' }),
    ]);
    const execContext = context(graph, provider, {
      // expertise НЕ упоминает оружие — «закон» приходит только из графа.
      expertise: 'Рядом заброшенный вокзал и ночлежка.',
      graph_context: graphContext,
    });

    const outputs = await executeSchema(graph, execContext);

    // Итог — исправленный черновик, прошедший проверку по связи графа.
    expect(outputs).toMatchObject({
      narrative: 'В кармане лишь мокрый окурок. Никакой базуки в этом мире у тебя быть не может.',
      severity: 9,
    });

    const calls = vi.mocked(provider.generateText).mock.calls;

    // Фаза анализа получает И локальный подграф, И обзор сообществ из graph_context.
    expect(calls[0][0].prompt).toContain('военное оружие — недоступно — бездомный');
    expect(calls[0][0].prompt).toContain('невозможный бред');
    // «Убийственный» факт пришёл из графа, а не из векторной экспертизы.
    expect(calls[0][0].prompt).not.toContain('нет оружия военного класса');

    // Фаза критика (первая итерация цикла) тоже видит граф-контекст — именно по нему
    // критик заворачивает абсурдный черновик.
    expect(calls[2][0].prompt).toContain('военное оружие — недоступно — бездомный');
    expect(calls[2][0].prompt).toContain('невозможный бред');

    // Абсурд пойман: первый черновик отвергнут (score 3 < 8), цикл сделал второй
    // заход и вышел по оценке — ровно 5 вызовов (анализ + 2 итерации). Критика по
    // связи графа возвращается в системную инструкцию исправляющего черновика.
    expect(provider.generateText).toHaveBeenCalledTimes(5);
    expect(calls[3][0].systemInstruction).toContain('Нарушена связь графа');
  });
});
