import { describe, it, expect } from 'vitest';
import {
  buildInitialState,
  clockToMinutes,
  ensureWorldTime,
  formatWorldTimeLine,
  mergeWorldTime,
  minutesToClock,
  normalizeClock,
  timeOfDayFromClock,
} from '@tg-games/core/games/manifests.js';
import { gameStateSchema } from '@tg-games/core/engine/validation.js';
import { TEST_GAMES as GAMES, listTestGames } from './fixtures/gameManifests.js';

const getGameManifest = (gameId: string) => GAMES[gameId];
const listGames = () => listTestGames();

describe('GAMES манифесты', () => {
  it('содержит сценарий bomj', () => {
    expect(getGameManifest('bomj')).toBeDefined();
    expect(getGameManifest('bomj')?.name).toBe('Выживание бомжа');
  });

  it('содержит сценарий red_hood', () => {
    expect(getGameManifest('red_hood')).toBeDefined();
    expect(getGameManifest('red_hood')?.name).toBe('Приключения Красной Шапочки');
  });

  it('содержит сценарий private_detective', () => {
    const game = getGameManifest('private_detective');
    expect(game).toBeDefined();
    expect(game?.name).toBe('Частный детектив');
    expect(game?.characterPresets.length).toBeGreaterThanOrEqual(3);
    expect(game?.locationPresets.length).toBeGreaterThanOrEqual(3);
  });

  it('содержит не менее трёх сценариев', () => {
    expect(listGames().length).toBeGreaterThanOrEqual(3);
  });

  it('возвращает undefined для неизвестной игры', () => {
    expect(getGameManifest('not-exists')).toBeUndefined();
  });

  it('listGames возвращает все сценарии', () => {
    expect(listGames()).toHaveLength(Object.keys(GAMES).length);
  });

  it('у каждого манифеста положительная цена и лимиты', () => {
    for (const game of listGames()) {
      expect(game.priceStars).toBeGreaterThan(0);
      expect(game.limits.maxHp).toBeGreaterThan(0);
      expect(game.limits.maxInventoryItems).toBeGreaterThan(0);
      expect(game.worldRules.length).toBeGreaterThan(0);
    }
  });

  it('у каждого манифеста есть пресеты персонажей и локаций (issue #60)', () => {
    for (const game of listGames()) {
      expect(game.characterPresets.length).toBeGreaterThan(0);
      expect(game.locationPresets.length).toBeGreaterThan(0);
    }
  });

  it('каждый пресет персонажа имеет имя, описание и непустой инвентарь', () => {
    for (const game of listGames()) {
      for (const preset of game.characterPresets) {
        expect(preset.name.trim()).not.toBe('');
        expect(preset.description.trim()).not.toBe('');
        expect(preset.character.inventory.length).toBeGreaterThan(0);
        expect(Object.keys(preset.character.skills).length).toBeGreaterThan(0);
      }
    }
  });

  it('каждый пресет локации имеет название и вводный нарратив', () => {
    for (const game of listGames()) {
      for (const preset of game.locationPresets) {
        expect(preset.location.trim()).not.toBe('');
        expect(preset.narrative.trim()).not.toBe('');
      }
    }
  });

  it('стартовое состояние из любой комбинации пресетов валидно по схеме', () => {
    for (const game of listGames()) {
      for (let c = 0; c < game.characterPresets.length; c++) {
        for (let l = 0; l < game.locationPresets.length; l++) {
          const result = gameStateSchema.safeParse(buildInitialState(game, c, l));
          expect(result.success).toBe(true);
        }
      }
    }
  });

  it('стартовый HP каждого пресета не превышает лимит сценария', () => {
    for (const game of listGames()) {
      for (const preset of game.characterPresets) {
        expect(preset.character.hp).toBeLessThanOrEqual(game.limits.maxHp);
        expect(preset.character.max_hp).toBeLessThanOrEqual(game.limits.maxHp);
      }
    }
  });

  it('buildInitialState берёт локацию и нарратив из выбранного пресета', () => {
    const game = GAMES.bomj;
    const state = buildInitialState(game, 0, 1);
    expect(state.location).toBe(game.locationPresets[1].location);
    expect(state.narrative).toBe(game.locationPresets[1].narrative);
    expect(state.character.inventory).toEqual(game.characterPresets[0].character.inventory);
    expect(state.turn_count).toBe(0);
  });

  it('buildInitialState сводит индексы вне диапазона к первому пресету', () => {
    const game = GAMES.bomj;
    const fallback = buildInitialState(game, 0, 0);
    expect(buildInitialState(game, 99, 99)).toEqual(fallback);
  });

  it('buildInitialState возвращает независимые копии инвентаря и навыков', () => {
    const game = GAMES.bomj;
    const state = buildInitialState(game, 0, 0);
    state.character.inventory.push('лишний предмет');
    state.character.skills.новый = 5;
    expect(game.characterPresets[0].character.inventory).not.toContain('лишний предмет');
    expect(game.characterPresets[0].character.skills.новый).toBeUndefined();
  });

  it('у каждого манифеста задано стартовое точное время мира (issue #67)', () => {
    for (const game of listGames()) {
      expect(game.startTime?.time).toBeDefined();
      expect(normalizeClock(game.startTime?.time)).not.toBeNull();
    }
  });
});

// Точные часы времени мира (issue #67).
describe('точные часы (issue #67)', () => {
  it('normalizeClock приводит часы к ЧЧ:ММ', () => {
    expect(normalizeClock('8:05')).toBe('08:05');
    expect(normalizeClock('08:05')).toBe('08:05');
    expect(normalizeClock('23:59')).toBe('23:59');
    expect(normalizeClock('00:00')).toBe('00:00');
    expect(normalizeClock(' 7:30 ')).toBe('07:30');
  });

  it('normalizeClock отклоняет невалидные значения', () => {
    expect(normalizeClock('25:00')).toBeNull();
    expect(normalizeClock('12:60')).toBeNull();
    expect(normalizeClock('вечер')).toBeNull();
    expect(normalizeClock('')).toBeNull();
    expect(normalizeClock(undefined)).toBeNull();
  });

  it('clockToMinutes и minutesToClock — взаимно обратные', () => {
    expect(clockToMinutes('00:00')).toBe(0);
    expect(clockToMinutes('08:30')).toBe(8 * 60 + 30);
    expect(clockToMinutes('23:59')).toBe(23 * 60 + 59);
    expect(minutesToClock(0)).toBe('00:00');
    expect(minutesToClock(8 * 60 + 30)).toBe('08:30');
    // Перенос за сутки.
    expect(minutesToClock(24 * 60 + 15)).toBe('00:15');
  });

  it('timeOfDayFromClock выводит время суток из часов', () => {
    expect(timeOfDayFromClock('05:00')).toBe('утро');
    expect(timeOfDayFromClock('08:30')).toBe('утро');
    expect(timeOfDayFromClock('12:00')).toBe('день');
    expect(timeOfDayFromClock('16:59')).toBe('день');
    expect(timeOfDayFromClock('17:00')).toBe('вечер');
    expect(timeOfDayFromClock('21:59')).toBe('вечер');
    expect(timeOfDayFromClock('22:00')).toBe('ночь');
    expect(timeOfDayFromClock('02:00')).toBe('ночь');
    expect(timeOfDayFromClock('04:59')).toBe('ночь');
  });

  it('ensureWorldTime согласует time_of_day с точными часами', () => {
    const wt = ensureWorldTime({
      season: 'лето',
      date: '7 июля',
      time: '13:00',
      time_of_day: 'утро', // модель ошиблась
    });
    expect(wt.time).toBe('13:00');
    expect(wt.time_of_day).toBe('день');
  });

  it('ensureWorldTime восстанавливает точные часы для старых сессий (только time_of_day)', () => {
    const wt = ensureWorldTime({ season: 'осень', date: '14 октября', time_of_day: 'вечер' });
    expect(normalizeClock(wt.time)).toBe('19:00');
    expect(wt.time_of_day).toBe('вечер');
  });

  it('mergeWorldTime берёт обновлённые часы, но согласует время суток', () => {
    const prev = ensureWorldTime({
      season: 'лето',
      date: '7 июля',
      time: '10:00',
      time_of_day: 'утро',
    });
    const merged = mergeWorldTime(prev, { time: '23:30' });
    expect(merged.time).toBe('23:30');
    expect(merged.time_of_day).toBe('ночь');
  });
});

describe('formatWorldTimeLine (issue #67)', () => {
  it('форматирует время как «ЧЧ:ММ (время суток), дата, сезон»', () => {
    expect(
      formatWorldTimeLine({ season: 'лето', date: '7 июля', time: '14:30', time_of_day: 'день' }),
    ).toBe('14:30 (день), 7 июля, лето');
  });

  it('согласует time_of_day с точными часами, даже если модель ошиблась', () => {
    // Модель ушла в 22:15, но осталась со старым time_of_day = «утро» —
    // formatter обязан взять время суток из часов.
    expect(
      formatWorldTimeLine({
        season: 'осень',
        date: '14 октября',
        time: '22:15',
        time_of_day: 'утро',
      }),
    ).toBe('22:15 (ночь), 14 октября, осень');
  });

  it('добирает отсутствующие поля до значений по умолчанию', () => {
    expect(formatWorldTimeLine(undefined)).toBe('08:00 (утро), 14 октября, осень');
  });
});
