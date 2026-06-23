import { describe, it, expect } from 'vitest';
import {
  LLMValidationError,
  extractHints,
  extractJson,
  parseNarrativeResponse,
  parseStateResponse,
  sanitizeState,
} from '@tg-games/core/engine/validation.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import type { GameState } from '@tg-games/core/types.js';

const manifest = GAMES.bomj;

function baseState(overrides: Partial<GameState> = {}): GameState {
  return {
    location: 'тест',
    narrative: 'текст',
    character: {
      hp: 50,
      max_hp: 100,
      skills: { взлом: 3 },
      inventory: ['отмычка'],
    },
    world_flags: { door_locked: true },
    world_time: { season: 'осень', date: '14 октября', time_of_day: 'утро' },
    turn_count: 1,
    ...overrides,
  };
}

describe('extractJson', () => {
  it('парсит чистый JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('извлекает JSON из markdown-ограждения', () => {
    const raw = 'Вот результат:\n```json\n{"a":1}\n```\nготово';
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it('извлекает первый сбалансированный объект из текста с пояснениями', () => {
    const raw = 'Конечно! {"narrative":"ок","x":{"y":2}} — это всё.';
    expect(extractJson(raw)).toEqual({ narrative: 'ок', x: { y: 2 } });
  });

  it('не путается со скобками внутри строк', () => {
    const raw = '{"text":"тут } внутри строки"}';
    expect(extractJson(raw)).toEqual({ text: 'тут } внутри строки' });
  });

  it('бросает ошибку, если JSON не найден', () => {
    expect(() => extractJson('просто текст')).toThrow(LLMValidationError);
  });
});

// Шаг 1 оркестратора — генерация нарратива (issue #65).
describe('parseNarrativeResponse', () => {
  it('валидирует корректный ответ нарратива', () => {
    const raw = JSON.stringify({ narrative: 'Дверь поддалась' });
    const parsed = parseNarrativeResponse(raw);
    expect(parsed.narrative).toBe('Дверь поддалась');
  });

  it('извлекает нарратив из ответа с лишними полями', () => {
    const raw = JSON.stringify({ narrative: 'Ты идёшь дальше', mood: 'тревожно' });
    expect(parseNarrativeResponse(raw).narrative).toBe('Ты идёшь дальше');
  });

  it('бросает LLMValidationError при отсутствии narrative', () => {
    const raw = JSON.stringify({ updated_state: baseState() });
    expect(() => parseNarrativeResponse(raw)).toThrow(LLMValidationError);
  });

  it('бросает LLMValidationError на невалидном JSON', () => {
    expect(() => parseNarrativeResponse('{ не json')).toThrow(LLMValidationError);
  });
});

// Шаг 2 оркестратора — учёт изменений состояния (issue #65).
describe('parseStateResponse', () => {
  it('валидирует корректный ответ состояния по схеме', () => {
    const raw = JSON.stringify({ updated_state: baseState() });
    const parsed = parseStateResponse(raw);
    expect(parsed.updated_state.character.hp).toBe(50);
    expect(parsed.updated_state.world_time?.date).toBe('14 октября');
  });

  it('бросает LLMValidationError при отсутствии updated_state', () => {
    const raw = JSON.stringify({ narrative: 'нет состояния' });
    expect(() => parseStateResponse(raw)).toThrow(LLMValidationError);
  });

  it('бросает LLMValidationError при неверном типе hp', () => {
    const bad = { updated_state: baseState() } as any;
    bad.updated_state.character.hp = 'много';
    expect(() => parseStateResponse(JSON.stringify(bad))).toThrow(LLMValidationError);
  });

  it('бросает LLMValidationError на невалидном JSON', () => {
    expect(() => parseStateResponse('{ не json')).toThrow(LLMValidationError);
  });

  // Регрессия issue #12: модель не дублирует narrative внутрь updated_state.
  it('принимает состояние без narrative внутри updated_state (issue #12)', () => {
    const raw = JSON.stringify({
      updated_state: {
        location: 'Фонтан у рынка',
        character: {
          hp: 22,
          max_hp: 100,
          skills: { выживание: 1, попрошайничество: 1 },
          inventory: ['рваный пакет', 'вода в бутылке'],
        },
        turn_count: 7,
        world_flags: {},
      },
    });
    const parsed = parseStateResponse(raw);
    expect(parsed.updated_state.location).toBe('Фонтан у рынка');
    expect(parsed.updated_state.character.hp).toBe(22);
    // narrative внутри состояния отсутствовал — схема подставляет пустую строку.
    expect(parsed.updated_state.narrative).toBe('');
  });

  it('принимает состояние без world_flags и turn_count в updated_state', () => {
    const raw = JSON.stringify({
      updated_state: {
        location: 'Улица',
        character: { hp: 30, max_hp: 100, skills: {}, inventory: [] },
      },
    });
    const parsed = parseStateResponse(raw);
    expect(parsed.updated_state.world_flags).toEqual({});
    expect(parsed.updated_state.turn_count).toBe(0);
  });

  // issue #65: учётная фаза может опустить world_time — это допустимо,
  // редуктор сохранит прежнее время через mergeWorldTime.
  it('принимает состояние без world_time в updated_state (issue #65)', () => {
    const raw = JSON.stringify({
      updated_state: {
        location: 'Улица',
        character: { hp: 30, max_hp: 100, skills: {}, inventory: [] },
      },
    });
    const parsed = parseStateResponse(raw);
    expect(parsed.updated_state.world_time).toBeUndefined();
  });

  it('принимает частичное world_time в updated_state (issue #65)', () => {
    const raw = JSON.stringify({
      updated_state: {
        location: 'Улица',
        character: { hp: 30, max_hp: 100, skills: {}, inventory: [] },
        world_time: { time_of_day: 'вечер' },
      },
    });
    const parsed = parseStateResponse(raw);
    expect(parsed.updated_state.world_time).toEqual({ time_of_day: 'вечер' });
  });

  it('по-прежнему требует character в updated_state', () => {
    const raw = JSON.stringify({
      updated_state: { location: 'Улица', world_flags: {}, turn_count: 1 },
    });
    expect(() => parseStateResponse(raw)).toThrow(LLMValidationError);
  });
});

describe('extractHints', () => {
  it('принимает «голый» массив строк', () => {
    expect(extractHints(['идти', 'искать', 'спать'])).toEqual(['идти', 'искать', 'спать']);
  });

  it('извлекает массив из объекта с произвольным ключом', () => {
    expect(extractHints({ options: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(extractHints({ варианты: ['север', 'юг'] })).toEqual(['север', 'юг']);
  });

  it('поддерживает ключи hints и actions', () => {
    expect(extractHints({ hints: ['x'] })).toEqual(['x']);
    expect(extractHints({ actions: ['y'] })).toEqual(['y']);
  });

  it('приводит массив объектов к строкам (берёт первое строковое поле)', () => {
    const json = [{ action: 'идти на север' }, { text: 'обыскать мусорку' }];
    expect(extractHints(json)).toEqual(['идти на север', 'обыскать мусорку']);
  });

  it('отбрасывает пустые строки и не-строки', () => {
    expect(extractHints(['ок', '', '   ', 42, null])).toEqual(['ок']);
  });

  it('возвращает пустой массив, если подходящих данных нет', () => {
    expect(extractHints({ count: 3 })).toEqual([]);
    expect(extractHints('не объект')).toEqual([]);
    expect(extractHints(null)).toEqual([]);
  });
});

describe('sanitizeState (жёсткая валидация)', () => {
  it('обрезает HP до максимума сценария', () => {
    const state = baseState({
      character: { hp: 999, max_hp: 100, skills: {}, inventory: [] },
    });
    const { state: sanitized } = sanitizeState(state, manifest);
    expect(sanitized.character.hp).toBe(100);
  });

  it('обрезает max_hp до лимита манифеста', () => {
    const state = baseState({
      character: { hp: 50, max_hp: 500, skills: {}, inventory: [] },
    });
    const { state: sanitized } = sanitizeState(state, manifest);
    expect(sanitized.character.max_hp).toBe(manifest.limits.maxHp);
  });

  it('не допускает отрицательный HP и помечает gameOver', () => {
    const state = baseState({
      character: { hp: -10, max_hp: 100, skills: {}, inventory: [] },
    });
    const { state: sanitized, gameOver } = sanitizeState(state, manifest);
    expect(sanitized.character.hp).toBe(0);
    expect(gameOver).toBe(true);
  });

  it('помечает gameOver при HP = 0', () => {
    const state = baseState({
      character: { hp: 0, max_hp: 100, skills: {}, inventory: [] },
    });
    expect(sanitizeState(state, manifest).gameOver).toBe(true);
  });

  it('обрезает инвентарь до maxInventoryItems и добавляет заметку', () => {
    const items = Array.from({ length: 15 }, (_, i) => `предмет${i}`);
    const state = baseState({
      character: { hp: 50, max_hp: 100, skills: {}, inventory: items },
    });
    const { state: sanitized, notes } = sanitizeState(state, manifest);
    expect(sanitized.character.inventory).toHaveLength(manifest.limits.maxInventoryItems);
    expect(notes.join(' ')).toContain('не поместил');
  });

  it('не трогает корректное состояние', () => {
    const state = baseState();
    const { state: sanitized, notes, gameOver } = sanitizeState(state, manifest);
    expect(sanitized.character.hp).toBe(50);
    expect(notes).toHaveLength(0);
    expect(gameOver).toBe(false);
  });

  it('добирает отсутствующее время мира из стартового времени сценария (issue #65)', () => {
    const state = baseState();
    delete (state as Partial<GameState>).world_time;
    const { state: sanitized } = sanitizeState(state, manifest);
    expect(sanitized.world_time).toEqual(manifest.startTime);
  });

  it('дополняет частичное время мира, сохраняя заданные поля (issue #65)', () => {
    const state = baseState({
      world_time: { season: 'зима', date: '', time_of_day: '' } as GameState['world_time'],
    });
    const { state: sanitized } = sanitizeState(state, manifest);
    expect(sanitized.world_time.season).toBe('зима');
    // Пустые поля добираются из стартового времени сценария.
    expect(sanitized.world_time.date).toBe(manifest.startTime?.date);
    expect(sanitized.world_time.time_of_day).toBe(manifest.startTime?.time_of_day);
  });
});
