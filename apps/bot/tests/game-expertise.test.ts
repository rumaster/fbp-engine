import { describe, it, expect, vi } from 'vitest';
import {
  buildGameExpertiseBlock,
  buildExpertiseKeysSystemPrompt,
  buildExpertiseKeysPrompt,
  parseExpertiseKeys,
  runGameExpertiseDetection,
} from '@tg-games/core/engine/expertiseKeys.js';
import { TEST_GAMES, TEST_PROMPT_TEMPLATES } from './fixtures/gameManifests.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { GameState } from '@tg-games/core/types.js';

const manifest = TEST_GAMES.bomj;

function state(): GameState {
  return {
    location: 'Теплотрасса на окраине города',
    narrative: 'старт',
    character: { hp: 75, max_hp: 100, skills: { смекалка: 3 }, inventory: ['блокнот'] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    turn_count: 1,
  };
}

/** Провайдер-заглушка: отдаёт заранее заданные ответы по очереди. */
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

// Шаблоны фазы 0 для оверрайда — берём те же, что в тестовой фикстуре.
const EXPERTISE_TEMPLATES = {
  game_expertise_system: TEST_PROMPT_TEMPLATES.game_expertise_system,
  game_expertise_prompt: TEST_PROMPT_TEMPLATES.game_expertise_prompt,
};

describe('buildGameExpertiseBlock (#154)', () => {
  it('возвращает явную пометку, если документов нет', () => {
    expect(buildGameExpertiseBlock([])).toContain('не найдено');
  });

  it('нумерует документы и включает заголовок и контент', () => {
    const block = buildGameExpertiseBlock([
      { title: 'Ночлежки', content: 'Тёплые трубы спасают от холода.' },
      { title: 'Попрошайничество', content: 'У вокзала больше прохожих.' },
    ]);
    expect(block).toContain('1. Ночлежки');
    expect(block).toContain('Тёплые трубы');
    expect(block).toContain('2. Попрошайничество');
    expect(block.indexOf('Ночлежки')).toBeLessThan(block.indexOf('Попрошайничество'));
  });
});

describe('buildExpertiseKeysSystemPrompt (#154)', () => {
  it('подставляет название и описание игры', () => {
    const sys = buildExpertiseKeysSystemPrompt(manifest, TEST_PROMPT_TEMPLATES.game_expertise_system);
    expect(sys).toContain(manifest.name);
    expect(sys).toContain(manifest.description);
  });
});

describe('buildExpertiseKeysPrompt (#154)', () => {
  it('подставляет локацию, краткое состояние, нарратив и действие', () => {
    const prompt = buildExpertiseKeysPrompt(
      state(),
      'поискать еду',
      'Вы просыпаетесь на трубах.',
      TEST_PROMPT_TEMPLATES.game_expertise_prompt,
    );
    expect(prompt).toContain('Теплотрасса на окраине города');
    expect(prompt).toContain('поискать еду');
    expect(prompt).toContain('Вы просыпаетесь на трубах.');
    expect(prompt).toContain('HP 75/100');
  });
});

describe('parseExpertiseKeys (#154)', () => {
  it('извлекает массив строк из {"keys":[...]}', () => {
    expect(parseExpertiseKeys('{"keys":["ночлег","еда"]}')).toEqual(['ночлег', 'еда']);
  });

  it('обрезает пробелы и отбрасывает пустые и нестроковые значения', () => {
    expect(parseExpertiseKeys('{"keys":["  тепло  ","",2]}')).toEqual(['тепло']);
  });

  it('извлекает JSON из markdown-ограждения', () => {
    expect(parseExpertiseKeys('```json\n{"keys":["x"]}\n```')).toEqual(['x']);
  });

  it('возвращает null, если keys не массив или ответ не JSON', () => {
    expect(parseExpertiseKeys('{"keys":"строка"}')).toBeNull();
    expect(parseExpertiseKeys('не json')).toBeNull();
  });
});

describe('runGameExpertiseDetection (#154)', () => {
  it('возвращает ключи и лог при валидном ответе', async () => {
    const provider = stubProvider(['{"keys":["где переночевать","где найти еду"]}']);
    const r = await runGameExpertiseDetection(
      provider,
      manifest,
      state(),
      'поискать еду',
      'Вы просыпаетесь на трубах.',
      3,
      EXPERTISE_TEMPLATES,
    );
    expect(r.keys).toEqual(['где переночевать', 'где найти еду']);
    expect(r.llmLog).toHaveLength(1);
    expect(r.llmLog[0].request).toBeTruthy();
    expect(r.llmLog[0]).not.toHaveProperty('kind');
  });

  it('повторяет запрос при невалидном ответе', async () => {
    const provider = stubProvider(['мусор', '{"keys":["тепло"]}']);
    const r = await runGameExpertiseDetection(
      provider,
      manifest,
      state(),
      'погреться',
      'нарратив',
      3,
      EXPERTISE_TEMPLATES,
    );
    expect(r.keys).toEqual(['тепло']);
    expect(r.llmLog).toHaveLength(2);
  });

  it('возвращает пустой массив, если все попытки неудачны', async () => {
    const provider = stubProvider([new Error('сеть упала')]);
    const r = await runGameExpertiseDetection(
      provider,
      manifest,
      state(),
      'x',
      'y',
      1,
      EXPERTISE_TEMPLATES,
    );
    expect(r.keys).toEqual([]);
  });
});

describe('retrieveGameExpertise (#154)', () => {
  it('считает эмбеддинги, ограничивает поиск областью игры и берёт topK', async () => {
    vi.resetModules();
    const search = vi.fn(async () => []);
    vi.doMock('@tg-games/core/db/repositories/expertise.js', () => ({
      searchExpertiseDocuments: search,
      recordExpertiseSearchQuerySafely: vi.fn(),
    }));
    const { retrieveGameExpertise } = await import('@tg-games/core/engine/expertiseRetrieval.js');

    search
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', content: 'ca', matchedSource: 's1', distance: 0.4, similarity: 0.6 },
      ] as never)
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', content: 'ca', matchedSource: 's2', distance: 0.1, similarity: 0.9 },
        { id: 'b', title: 'B', content: 'cb', matchedSource: 's3', distance: 0.5, similarity: 0.5 },
      ] as never);

    const provider = {
      model: 'text-embedding-3-small',
      async embed(inputs: string[]) {
        return {
          embeddings: inputs.map(() => [0.1, 0.2]),
          model: 'text-embedding-3-small',
          tokens: 0,
        };
      },
    };

    const docs = await retrieveGameExpertise(provider as never, ['ключ1', 'ключ2'], 2, 'bomj');
    expect(docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(docs[0].distance).toBe(0.1);
    expect(search).toHaveBeenCalledTimes(2);
    // Область поиска — конкретная игра; тэги не заданы (issue #321).
    expect(search).toHaveBeenCalledWith([0.1, 0.2], 2, { gameId: 'bomj' }, []);
    vi.doUnmock('@tg-games/core/db/repositories/expertise.js');
  });

  it('не обращается к поиску при пустом списке ключей', async () => {
    vi.resetModules();
    const search = vi.fn();
    vi.doMock('@tg-games/core/db/repositories/expertise.js', () => ({ searchExpertiseDocuments: search, recordExpertiseSearchQuerySafely: vi.fn() }));
    const { retrieveGameExpertise } = await import('@tg-games/core/engine/expertiseRetrieval.js');
    const provider = { model: 'm', embed: vi.fn() };
    const docs = await retrieveGameExpertise(provider as never, [], 3, 'bomj');
    expect(docs).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    vi.doUnmock('@tg-games/core/db/repositories/expertise.js');
  });
});
