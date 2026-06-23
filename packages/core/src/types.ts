/**
 * Общие типы предметной области игры.
 */

/** Характеристики персонажа. */
export interface Character {
  hp: number;
  max_hp: number;
  skills: Record<string, number>;
  inventory: string[];
}

/**
 * Игровое время мира (issue #65, уточнено в issue #67).
 *
 * Хранится в составе {@link GameState} и учитывается при генерации нарратива
 * (погода, освещённость, доступность людей и ресурсов) и тщательно
 * контролируется при учёте изменений состояния (время идёт вперёд согласно
 * принятому нарративу).
 *
 * Точное время суток хранится в поле {@link WorldTime.time} в формате ЧЧ:ММ
 * (issue #67): учётная фаза оценивает длительность действия в минутах и
 * сдвигает часы вперёд. Текстовое {@link WorldTime.time_of_day} —
 * производное от точных часов и всегда согласовано с ними.
 */
export interface WorldTime {
  /** Время года: «зима», «весна», «лето», «осень». */
  season: string;
  /** Календарная дата, например «14 октября». */
  date: string;
  /** Точное время суток в формате ЧЧ:ММ (24 часа), например «08:30» (issue #67). */
  time: string;
  /**
   * Время суток: «утро», «день», «вечер», «ночь». Производное от {@link WorldTime.time}
   * (issue #67) — выводится из точных часов и всегда им соответствует.
   */
  time_of_day: string;
}

/**
 * Стандартизированное JSON-состояние игры, хранится в
 * `game_sessions.current_state` (JSONB).
 */
export interface GameState {
  location: string;
  narrative: string;
  character: Character;
  world_flags: Record<string, boolean>;
  /** Время мира: сезон, дата, время суток (issue #65). */
  world_time: WorldTime;
  turn_count: number;
}

/** Компактная запись прошлого хода для памяти LLM. */
export interface TurnHistoryEntry {
  turn: number;
  action: string;
  outcome: string;
}

/**
 * Ответ LLM на первом шаге оркестратора — генерация нарратива (issue #65).
 * Модель описывает, ЧТО произошло, не пересчитывая состояние.
 */
export interface LLMNarrativeResponse {
  narrative: string;
}

/**
 * Старый полный ответ LLM для учёта изменений состояния (issue #65).
 * Сохраняется как совместимый формат: новые фазовые парсеры умеют извлекать
 * из него нужные части состояния, если модель вернула прежний `updated_state`.
 */
export interface LLMStateResponse {
  updated_state: GameState;
}

/**
 * Ответ LLM на втором шаге оркестратора — обновление инвентаря (issue #137).
 * Модель возвращает только полный актуальный список предметов.
 */
export interface LLMInventoryResponse {
  inventory: string[];
}

/**
 * Ответ LLM на третьем шаге оркестратора — обновление характеристик (issue #137).
 * HP считается отдельно в финальной фазе, здесь обновляются устойчивые параметры
 * персонажа: навыки и максимум здоровья.
 */
export interface LLMCharacteristicsResponse {
  characteristics: {
    max_hp?: number;
    skills?: Record<string, number>;
  };
}

/**
 * Ответ LLM на четвёртом шаге оркестратора — обновление флагов мира (issue #137).
 */
export interface LLMWorldFlagsResponse {
  world_flags: Record<string, boolean>;
}

/**
 * Частичное состояние для пятого шага оркестратора — все данные, не выделенные
 * в отдельные фазы: location, world_time, character.hp и прочее (issue #137).
 */
export interface LLMOtherStateUpdate {
  location?: string;
  narrative?: string;
  character?: Partial<Pick<Character, 'hp'>>;
  world_flags?: Record<string, boolean>;
  world_time?: Partial<WorldTime>;
  turn_count?: number;
}

/**
 * Ответ LLM на пятом шаге оркестратора — обновление остальных данных (issue #137).
 */
export interface LLMOtherStateResponse {
  updated_state: LLMOtherStateUpdate;
}
