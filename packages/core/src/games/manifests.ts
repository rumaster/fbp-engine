import type { Character, GameState, WorldTime } from '../types.js';

/**
 * Канонические времена года и времена суток (issue #65).
 *
 * Используются как подсказка модели в промптах и как «якорь» при нормализации
 * времени мира: значение вне списка не отвергается жёстко, но список задаёт
 * ожидаемый словарь и порядок (для времени суток — естественный ход дня).
 */
export const SEASONS = ['зима', 'весна', 'лето', 'осень'] as const;
export const TIMES_OF_DAY = ['утро', 'день', 'вечер', 'ночь'] as const;

/**
 * Границы времён суток по точным часам (issue #67).
 *
 * Время суток выводится из точных часов ЧЧ:ММ детерминированно, поэтому
 * текстовое поле `time_of_day` всегда согласовано с `time` и не «дрейфует».
 *
 *  - ночь:  22:00–04:59
 *  - утро:  05:00–11:59
 *  - день:  12:00–16:59
 *  - вечер: 17:00–21:59
 */
const TIME_OF_DAY_BOUNDS: ReadonlyArray<{ from: number; to: number; name: string }> = [
  { from: 5 * 60, to: 12 * 60, name: 'утро' },
  { from: 12 * 60, to: 17 * 60, name: 'день' },
  { from: 17 * 60, to: 22 * 60, name: 'вечер' },
  // ночь — всё остальное (22:00–04:59), обрабатывается как значение по умолчанию.
];

/** Представительные часы для каждого времени суток — для миграции старых сессий. */
const CLOCK_BY_TIME_OF_DAY: Readonly<Record<string, string>> = {
  утро: '08:00',
  день: '14:00',
  вечер: '19:00',
  ночь: '23:00',
};

/**
 * Нормализует строку времени к формату ЧЧ:ММ (24-часовой).
 *
 * Принимает «8:5», «08:05», «8.30» и т.п., возвращает «08:05»/«08:30».
 * Возвращает null, если значение не похоже на корректное время суток.
 */
export function normalizeClock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2})[:.\s]?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Переводит валидное ЧЧ:ММ в число минут от полуночи. */
export function clockToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Переводит число минут от полуночи (с переносом за сутки) обратно в ЧЧ:ММ. */
export function minutesToClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Выводит время суток («утро»/«день»/«вечер»/«ночь») из точных часов ЧЧ:ММ
 * (issue #67). Невалидное время трактуется как ночь.
 */
export function timeOfDayFromClock(time: string): string {
  const normalized = normalizeClock(time);
  if (!normalized) return 'ночь';
  const minutes = clockToMinutes(normalized);
  const match = TIME_OF_DAY_BOUNDS.find((b) => minutes >= b.from && minutes < b.to);
  return match?.name ?? 'ночь';
}

/**
 * Время мира по умолчанию — используется как резервное значение для старых
 * сессий, сохранённых до появления world_time, и как fallback при нормализации.
 */
export const DEFAULT_WORLD_TIME: WorldTime = {
  season: 'осень',
  date: '14 октября',
  time: '08:00',
  time_of_day: 'утро',
};

/**
 * Дополняет частичное/повреждённое время мира до полного: пустые или
 * отсутствующие поля берутся из fallback (по умолчанию — {@link DEFAULT_WORLD_TIME}).
 *
 * Точное время (issue #67) берётся из валидного `time`; если его нет, но задано
 * текстовое `time_of_day` (старые сессии до issue #67) — подставляются
 * представительные часы этого времени суток; иначе берётся `time` из fallback.
 * Текстовое `time_of_day` всегда выводится из итоговых часов, поэтому два поля
 * никогда не расходятся.
 */
export function ensureWorldTime(
  value: Partial<WorldTime> | null | undefined,
  fallback: WorldTime = DEFAULT_WORLD_TIME,
): WorldTime {
  const pick = (v: unknown, fb: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : fb;

  const fallbackTime = normalizeClock(fallback.time) ?? DEFAULT_WORLD_TIME.time;
  const timeOfDayHint =
    typeof value?.time_of_day === 'string' ? CLOCK_BY_TIME_OF_DAY[value.time_of_day.trim()] : undefined;
  const time = normalizeClock(value?.time) ?? timeOfDayHint ?? fallbackTime;

  return {
    season: pick(value?.season, fallback.season),
    date: pick(value?.date, fallback.date),
    time,
    // Время суток — производное от точных часов, чтобы поля не расходились.
    time_of_day: timeOfDayFromClock(time),
  };
}

/**
 * Человекочитаемая строка времени мира: «08:00 (утро), 14 октября, осень»
 * (issue #65; точные часы — issue #67).
 */
export function formatWorldTimeLine(worldTime?: Partial<WorldTime>): string {
  const { season, date, time, time_of_day } = ensureWorldTime(worldTime);
  return `${time} (${time_of_day}), ${date}, ${season}`;
}

/**
 * Сливает предыдущее время мира с обновлением от модели: непустые поля из
 * `next` имеют приоритет, отсутствующие сохраняются из `prev`, а всё, чего нет
 * ни там, ни там, добирается из {@link DEFAULT_WORLD_TIME}. Так время мира
 * никогда не теряется между ходами (по аналогии с world_flags).
 */
export function mergeWorldTime(
  prev: Partial<WorldTime> | null | undefined,
  next: Partial<WorldTime> | null | undefined,
): WorldTime {
  const base = ensureWorldTime(prev);
  return ensureWorldTime(next, base);
}

/**
 * Пресет персонажа: вариант героя со своими характеристиками и инвентарём,
 * который игрок выбирает в начале игры (issue #60).
 */
export interface CharacterPreset {
  /** Короткая подпись для кнопки выбора (например, «Игорь — бывший инженер»). */
  name: string;
  /** Развёрнутое описание характера и предыстории. */
  description: string;
  /** Стартовые характеристики и инвентарь этого персонажа. */
  character: Character;
}

/**
 * Пресет стартовой локации: место, с которого начинается игра, со своим
 * вводным нарративом (issue #60).
 */
export interface LocationPreset {
  /** Название локации, попадает в `state.location`. */
  location: string;
  /** Вводный нарратив, попадает в `state.narrative` первого хода. */
  narrative: string;
}

/**
 * Манифест игрового сценария.
 *
 * Манифест задаёт неизменные правила мира (worldRules), лимиты характеристик
 * и стартовое состояние. LLM не имеет права придумывать глобальные правила —
 * она действует строго в рамках манифеста.
 */
export interface GameManifest {
  id: string;
  name: string;
  description: string;
  /** Цена входа в игру в Telegram Stars. */
  priceStars: number;
  /** Минимальные и максимальные значения характеристик. */
  limits: {
    maxHp: number;
    maxInventoryItems: number;
  };
  /** Константные правила мира, всегда передаются в System Prompt. */
  worldRules: string[];
  /**
   * Стартовое время мира сценария (issue #65): сезон, дата, время суток.
   * Если не задано — используется {@link DEFAULT_WORLD_TIME}.
   */
  startTime?: WorldTime;
  /** Пресеты персонажей — игрок выбирает одного в начале игры. */
  characterPresets: CharacterPreset[];
  /** Пресеты стартовых локаций — игрок выбирает одну в начале игры. */
  locationPresets: LocationPreset[];
}

/**
 * Собирает стартовое состояние новой сессии из выбранных пресетов.
 *
 * Индексы вне диапазона безопасно сводятся к первому пресету — это защищает
 * от устаревших callback-данных и повреждённых payload счёта.
 */
export function buildInitialState(
  manifest: GameManifest,
  characterIndex = 0,
  locationIndex = 0,
): GameState {
  const character =
    manifest.characterPresets[characterIndex] ?? manifest.characterPresets[0];
  const location =
    manifest.locationPresets[locationIndex] ?? manifest.locationPresets[0];

  return {
    location: location.location,
    narrative: location.narrative,
    character: {
      ...character.character,
      skills: { ...character.character.skills },
      inventory: [...character.character.inventory],
    },
    world_flags: {},
    world_time: ensureWorldTime(manifest.startTime),
    turn_count: 0,
  };
}
