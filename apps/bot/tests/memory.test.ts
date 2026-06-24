import { describe, it, expect } from 'vitest';
import {
  buildMemoryBlock,
  buildMemoryPrompt,
  buildMemorySystemPrompt,
  selectMemoryCells,
  parseMemoryExtraction,
  runMemoryExtraction,
  EMPTY_MEMORY_BLOCK,
  type MemoryCell,
} from '@tg-games/core/engine/memory.js';
import { TEST_GAMES, TEST_PROMPT_TEMPLATES } from './fixtures/gameManifests.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameState } from '@tg-games/core/types.js';

const manifest = TEST_GAMES.bomj;

function state(): GameState {
  return {
    location: 'Теплотрасса',
    narrative: 'старт',
    character: { hp: 75, max_hp: 100, skills: { смекалка: 3 }, inventory: ['блокнот'] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    turn_count: 4,
  };
}

/** Удобный конструктор доменной ячейки памяти для тестов. */
function cell(overrides: Partial<MemoryCell> = {}): MemoryCell {
  return {
    id: 'c1',
    sessionId: 'sess-1',
    stepId: 'step-1',
    content: 'Игрок пообещал старьёвщику принести медную проволоку.',
    category: 'цели',
    importance: 2,
    turnCreated: 1,
    createdAt: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

/** Провайдер-заглушка: отдаёт заранее заданные ответы (или ошибки) по очереди. */
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

// Шаблоны фазы памяти для оверрайда — те же, что в тестовой фикстуре.
const MEMORY_TEMPLATES = {
  game_memory_system: TEST_PROMPT_TEMPLATES.game_memory_system,
  game_memory_prompt: TEST_PROMPT_TEMPLATES.game_memory_prompt,
};

describe('buildMemoryBlock (#166)', () => {
  it('возвращает явную пометку, если фактов нет', () => {
    expect(buildMemoryBlock([])).toBe(EMPTY_MEMORY_BLOCK);
  });

  it('нумерует факты и помечает их категорией', () => {
    const block = buildMemoryBlock([
      cell({ content: 'Мост через реку сожжён.', category: 'мир' }),
      cell({ content: 'Старьёвщик ждёт проволоку.', category: 'цели' }),
    ]);
    expect(block).toContain('1. [мир] Мост через реку сожжён.');
    expect(block).toContain('2. [цели] Старьёвщик ждёт проволоку.');
  });

  it('не добавляет скобки категории, если она пустая', () => {
    const block = buildMemoryBlock([cell({ content: 'Факт без категории.', category: '' })]);
    expect(block).toBe('1. Факт без категории.');
  });
});

describe('selectMemoryCells (#166)', () => {
  it('возвращает пустой список при topK <= 0', () => {
    expect(selectMemoryCells([cell()], 0)).toEqual([]);
    expect(selectMemoryCells([cell()], -3)).toEqual([]);
  });

  it('сортирует по важности, затем по свежести и обрезает до topK', () => {
    const cells = [
      cell({ id: 'a', importance: 1, turnCreated: 5 }),
      cell({ id: 'b', importance: 3, turnCreated: 1 }),
      cell({ id: 'c', importance: 3, turnCreated: 7 }),
      cell({ id: 'd', importance: 2, turnCreated: 2 }),
    ];
    const selected = selectMemoryCells(cells, 3);
    // Сначала важность 3 (свежее — выше: c=7 раньше b=1), затем важность 2.
    expect(selected.map((c) => c.id)).toEqual(['c', 'b', 'd']);
  });

  it('не мутирует исходный массив', () => {
    const cells = [cell({ id: 'a', importance: 1 }), cell({ id: 'b', importance: 3 })];
    selectMemoryCells(cells, 2);
    expect(cells.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('buildMemorySystemPrompt (#166)', () => {
  it('подставляет название и описание игры', () => {
    const sys = buildMemorySystemPrompt(manifest, TEST_PROMPT_TEMPLATES.game_memory_system);
    expect(sys).toContain(manifest.name);
    expect(sys).toContain(manifest.description);
  });
});

describe('buildMemoryPrompt (#166)', () => {
  it('подставляет время мира, известные факты, действие и нарратив', () => {
    const prompt = buildMemoryPrompt(
      state(),
      'починить рацию',
      'Рация ожила и поймала чужой сигнал.',
      buildMemoryBlock([cell({ content: 'Известный факт.' })]),
      TEST_PROMPT_TEMPLATES.game_memory_prompt,
    );
    expect(prompt).toContain('08:00');
    expect(prompt).toContain('Известный факт.');
    expect(prompt).toContain('починить рацию');
    expect(prompt).toContain('Рация ожила и поймала чужой сигнал.');
  });
});

describe('parseMemoryExtraction (#166)', () => {
  it('извлекает ячейки из {"memory":[...]}', () => {
    const cells = parseMemoryExtraction(
      '{"memory":[{"content":"Мост сожжён.","category":"мир","importance":3}]}',
    );
    expect(cells).toEqual([{ content: 'Мост сожжён.', category: 'мир', importance: 3 }]);
  });

  it('возвращает пустой массив на корректный ответ «новых фактов нет»', () => {
    expect(parseMemoryExtraction('{"memory":[]}')).toEqual([]);
  });

  it('извлекает JSON из markdown-ограждения', () => {
    const cells = parseMemoryExtraction('```json\n{"memory":[{"content":"X"}]}\n```');
    expect(cells).toEqual([{ content: 'X', category: '', importance: 1 }]);
  });

  it('отбрасывает факты с пустым content и нестроковые элементы', () => {
    const cells = parseMemoryExtraction(
      '{"memory":[{"content":"  "},{"content":"Y"},42,null]}',
    );
    expect(cells).toEqual([{ content: 'Y', category: '', importance: 1 }]);
  });

  it('зажимает importance в диапазон 1..3 и округляет', () => {
    const cells = parseMemoryExtraction(
      '{"memory":[{"content":"a","importance":9},{"content":"b","importance":0},{"content":"c","importance":2.6}]}',
    );
    expect(cells?.map((c) => c.importance)).toEqual([3, 1, 3]);
  });

  it('обрезает категорию до 50 символов', () => {
    const long = 'к'.repeat(80);
    const cells = parseMemoryExtraction(`{"memory":[{"content":"a","category":"${long}"}]}`);
    expect(cells?.[0].category).toHaveLength(50);
  });

  it('ограничивает число ячеек за ход', () => {
    const items = Array.from({ length: 20 }, (_, i) => `{"content":"факт ${i}"}`).join(',');
    const cells = parseMemoryExtraction(`{"memory":[${items}]}`);
    expect(cells?.length).toBe(6);
  });

  it('возвращает null при нечитаемом JSON или отсутствии массива memory', () => {
    expect(parseMemoryExtraction('не json')).toBeNull();
    expect(parseMemoryExtraction('{"memory":"строка"}')).toBeNull();
    expect(parseMemoryExtraction('[1,2,3]')).toBeNull();
  });
});

describe('runMemoryExtraction (#166)', () => {
  it('возвращает новые факты и лог при валидном ответе', async () => {
    const provider = stubProvider([
      '{"memory":[{"content":"Мост сожжён.","category":"мир","importance":3}]}',
    ]);
    const r = await runMemoryExtraction(
      provider,
      manifest,
      state(),
      'поджечь мост',
      'Мост вспыхнул и рухнул в реку.',
      [],
      3,
      MEMORY_TEMPLATES,
    );
    expect(r.added).toEqual([{ content: 'Мост сожжён.', category: 'мир', importance: 3 }]);
    expect(r.llmLog).toHaveLength(1);
    expect(r.llmLog[0].request).toBeTruthy();
    expect(r.llmLog[0]).not.toHaveProperty('kind');
  });

  it('повторяет запрос при невалидном ответе', async () => {
    const provider = stubProvider(['мусор', '{"memory":[{"content":"Факт."}]}']);
    const r = await runMemoryExtraction(
      provider,
      manifest,
      state(),
      'осмотреться',
      'нарратив',
      [],
      3,
      MEMORY_TEMPLATES,
    );
    expect(r.added).toEqual([{ content: 'Факт.', category: '', importance: 1 }]);
    expect(r.llmLog).toHaveLength(2);
  });

  it('возвращает пустой список, если все попытки неудачны (best-effort)', async () => {
    const provider = stubProvider([new Error('сеть упала')]);
    const r = await runMemoryExtraction(
      provider,
      manifest,
      state(),
      'x',
      'y',
      [],
      1,
      MEMORY_TEMPLATES,
    );
    expect(r.added).toEqual([]);
  });
});
