import { z } from 'zod';
import type { GameManifest } from '../games/manifests.js';
import { ensureWorldTime } from '../games/manifests.js';
import type {
  GameState,
  LLMCharacteristicsResponse,
  LLMInventoryResponse,
  LLMNarrativeResponse,
  LLMOtherStateResponse,
  LLMStateResponse,
  LLMWorldFlagsResponse,
} from '../types.js';

/**
 * Zod-схема характеристик персонажа.
 */
const characterSchema = z.object({
  hp: z.number(),
  max_hp: z.number(),
  skills: z.record(z.string(), z.number()),
  inventory: z.array(z.string()),
});

/**
 * Zod-схема времени мира (issue #65): сезон, дата, время суток.
 *
 * Поле `time` (issue #67) — точные часы ЧЧ:ММ; `time_of_day` оставлено для
 * совместимости и выводится из точных часов при санитизации (см. ensureWorldTime).
 */
export const worldTimeSchema = z.object({
  season: z.string(),
  date: z.string(),
  time: z.string(),
  time_of_day: z.string(),
});

/**
 * Zod-схема игрового состояния (полная, со всеми обязательными полями).
 * Используется для проверки стартового состояния манифестов.
 */
export const gameStateSchema = z.object({
  location: z.string(),
  narrative: z.string(),
  character: characterSchema,
  world_flags: z.record(z.string(), z.boolean()),
  world_time: worldTimeSchema,
  turn_count: z.number(),
});

const manifestCharacterSchema = characterSchema.passthrough();
const manifestWorldTimeSchema = worldTimeSchema.passthrough();

const characterPresetSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  character: manifestCharacterSchema,
}).passthrough();

const locationPresetSchema = z.object({
  location: z.string().min(1),
  narrative: z.string().min(1),
}).passthrough();

/** Runtime-схема манифеста сценария для админского редактирования. */
export const gameManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  priceStars: z.number().positive(),
  limits: z.object({
    maxHp: z.number().positive(),
    maxInventoryItems: z.number().nonnegative(),
  }).passthrough(),
  worldRules: z.array(z.string().min(1)).min(1),
  startTime: manifestWorldTimeSchema.optional(),
  characterPresets: z.array(characterPresetSchema).min(1),
  locationPresets: z.array(locationPresetSchema).min(1),
}).passthrough();

/**
 * Схема состояния, которое LLM возвращает в поле `updated_state`.
 *
 * Отличается от {@link gameStateSchema} тем, что часть полей необязательна —
 * это устраняет ложные отказы из issue #12, когда валидный ход отклонялся:
 *
 *  - `narrative` модель кладёт на верхний уровень ответа и, как правило, НЕ
 *    дублирует внутрь состояния. Редуктор всё равно перезаписывает narrative
 *    текстом текущего хода, поэтому требовать его здесь нельзя.
 *  - `world_flags` и `turn_count` модель иногда опускает; редуктор сохранит
 *    прежние флаги и подставит безопасные значения (turn_count он и так
 *    пересчитывает самостоятельно).
 *
 * `character` остаётся обязательным — без него состояние бессмысленно.
 *
 * `world_time` (issue #65) необязательно: модель учётного шага иногда опускает
 * его, и редуктор сохранит прежнее время мира (см. mergeWorldTime).
 */
export const updatedStateSchema = z.object({
  location: z.string(),
  narrative: z.string().optional().default(''),
  character: characterSchema,
  world_flags: z.record(z.string(), z.boolean()).optional().default({}),
  world_time: worldTimeSchema.partial().optional(),
  turn_count: z.number().optional().default(0),
});

/**
 * Zod-схема ответа LLM на первом шаге оркестратора — генерация нарратива
 * (issue #65). Модель обязана вернуть поле `narrative`.
 */
export const narrativeResponseSchema = z.object({
  narrative: z.string(),
});

/**
 * Zod-схема старого полного ответа LLM на учёт состояния (issue #65).
 * Новые фазовые парсеры используют её как совместимый fallback.
 */
export const stateResponseSchema = z.object({
  updated_state: updatedStateSchema,
});

/**
 * Zod-схема ответа LLM на фазе обновления инвентаря (issue #137).
 * Для устойчивости также допускается старый полный `updated_state`: парсер
 * извлечёт из него `character.inventory`.
 */
export const inventoryResponseSchema = z.object({
  inventory: z.array(z.string()),
});

/**
 * Zod-схема ответа LLM на фазе обновления характеристик (issue #137).
 * HP намеренно не входит в эту фазу: он считается в `other_state`.
 */
export const characteristicsResponseSchema = z.object({
  characteristics: z.object({
    max_hp: z.number().optional(),
    skills: z.record(z.string(), z.number()).optional(),
  }),
});

/**
 * Zod-схема ответа LLM на фазе обновления флагов мира (issue #137).
 */
export const worldFlagsResponseSchema = z.object({
  world_flags: z.record(z.string(), z.boolean()),
});

const otherCharacterSchema = z.object({
  hp: z.number().optional(),
  skills: z.record(z.string(), z.number()).optional(),
  inventory: z.array(z.string()).optional(),
});

/**
 * Zod-схема ответа LLM на фазе обновления остальных данных (issue #137).
 *
 * Все поля частичные: редуктор сливает их с состоянием, уже обновлённым
 * предыдущими фазами, и не даёт этой фазе перетереть инвентарь, навыки и флаги.
 */
export const otherStateResponseSchema = z.object({
  updated_state: z.object({
    location: z.string().optional(),
    narrative: z.string().optional(),
    character: otherCharacterSchema.optional(),
    world_flags: z.record(z.string(), z.boolean()).optional(),
    world_time: worldTimeSchema.partial().optional(),
    turn_count: z.number().optional(),
  }),
});

/**
 * Приводит один элемент ответа с подсказками к строке.
 *
 * Модель иногда возвращает не просто строки, а объекты вида
 * `{ "action": "идти на север" }` или `{ "text": "..." }`. В этом случае
 * берём первое строковое значение объекта.
 */
function coerceHint(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const firstString = Object.values(item as Record<string, unknown>).find(
      (v) => typeof v === 'string',
    );
    if (typeof firstString === 'string') return firstString;
  }
  return null;
}

/**
 * Извлекает список подсказок из распарсенного JSON ответа LLM.
 *
 * В JSON Mode у OpenAI/OpenRouter верхний уровень обязан быть объектом, поэтому
 * модель оборачивает массив в поле с произвольным именем (`hints`, `actions`,
 * `options`, `варианты`, …). Чтобы не падать на конкретном имени ключа, ищем
 * первое поле, значение которого — непустой массив, и приводим его элементы к
 * строкам. Поддерживается и «голый» массив строк.
 *
 * Возвращает пустой массив, если подходящих данных нет.
 */
export function extractHints(json: unknown): string[] {
  const fromArray = (arr: unknown[]): string[] =>
    arr.map(coerceHint).filter((h): h is string => h !== null && h.trim() !== '');

  if (Array.isArray(json)) {
    return fromArray(json);
  }

  if (json && typeof json === 'object') {
    for (const value of Object.values(json as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const hints = fromArray(value);
        if (hints.length > 0) return hints;
      }
    }
  }

  return [];
}

/** Ошибка парсинга/валидации ответа LLM. */
export class LLMValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMValidationError';
  }
}

/**
 * Извлекает JSON-объект из текста ответа LLM.
 *
 * Даже в JSON Mode модель иногда оборачивает ответ в ```json ... ```
 * или добавляет пояснения. Сначала пробуем распарсить как есть, затем
 * вырезаем первый сбалансированный JSON-объект/массив.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Падаем в извлечение фрагмента ниже.
  }

  // Убираем markdown-ограждение ```json ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // продолжаем
    }
  }

  // Ищем первый сбалансированный объект или массив.
  const start = trimmed.search(/[[{]/);
  if (start !== -1) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          return JSON.parse(candidate);
        }
      }
    }
  }

  throw new LLMValidationError('Не удалось извлечь JSON из ответа модели');
}

/** Извлекает JSON из ответа модели, оборачивая ошибку в LLMValidationError. */
function extractJsonOrThrow(raw: string): unknown {
  try {
    return extractJson(raw);
  } catch (err) {
    throw new LLMValidationError(
      err instanceof Error ? err.message : 'Невалидный JSON',
    );
  }
}

/** Собирает человекочитаемое описание ошибок zod-схемы. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

/** Парсит и валидирует JSON-манифест сценария из админского ввода. */
export function parseGameManifestInput(raw: string): GameManifest {
  const json = extractJsonOrThrow(raw);
  const result = gameManifestSchema.safeParse(json);
  if (!result.success) {
    throw new LLMValidationError(
      `Манифест не соответствует схеме: ${describeIssues(result.error)}`,
    );
  }
  return result.data as GameManifest;
}

/**
 * Парсит и валидирует ответ LLM на первом шаге оркестратора — нарратив
 * (issue #65). Бросает {@link LLMValidationError} при любой проблеме.
 */
export function parseNarrativeResponse(raw: string): LLMNarrativeResponse {
  const json = extractJsonOrThrow(raw);
  const result = narrativeResponseSchema.safeParse(json);
  if (!result.success) {
    throw new LLMValidationError(
      `Ответ нарратива не соответствует схеме: ${describeIssues(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Парсит и валидирует старый полный ответ LLM на учёт состояния (issue #65).
 * Оставлен для совместимости и тестов старого формата.
 */
export function parseStateResponse(raw: string): LLMStateResponse {
  const json = extractJsonOrThrow(raw);
  const result = stateResponseSchema.safeParse(json);
  if (!result.success) {
    throw new LLMValidationError(
      `Ответ состояния не соответствует схеме: ${describeIssues(result.error)}`,
    );
  }
  return result.data as LLMStateResponse;
}

/**
 * Парсит ответ фазы обновления инвентаря (issue #137).
 * Если модель по старой привычке вернула полный `updated_state`, берём
 * `updated_state.character.inventory`.
 */
export function parseInventoryResponse(raw: string): LLMInventoryResponse {
  const json = extractJsonOrThrow(raw);
  const result = inventoryResponseSchema.safeParse(json);
  if (result.success) return result.data;

  const fullState = stateResponseSchema.safeParse(json);
  if (fullState.success) {
    return { inventory: fullState.data.updated_state.character.inventory };
  }

  throw new LLMValidationError(
    `Ответ инвентаря не соответствует схеме: ${describeIssues(result.error)}`,
  );
}

/**
 * Парсит ответ фазы обновления характеристик (issue #137).
 * Старый полный `updated_state` используется как источник skills/max_hp.
 */
export function parseCharacteristicsResponse(raw: string): LLMCharacteristicsResponse {
  const json = extractJsonOrThrow(raw);
  const result = characteristicsResponseSchema.safeParse(json);
  if (result.success) return result.data;

  const fullState = stateResponseSchema.safeParse(json);
  if (fullState.success) {
    const { max_hp, skills } = fullState.data.updated_state.character;
    return { characteristics: { max_hp, skills } };
  }

  throw new LLMValidationError(
    `Ответ характеристик не соответствует схеме: ${describeIssues(result.error)}`,
  );
}

/**
 * Парсит ответ фазы обновления флагов мира (issue #137).
 * Старый полный `updated_state` используется как источник `world_flags`.
 */
export function parseWorldFlagsResponse(raw: string): LLMWorldFlagsResponse {
  const json = extractJsonOrThrow(raw);
  const result = worldFlagsResponseSchema.safeParse(json);
  if (result.success) return result.data;

  const fullState = stateResponseSchema.safeParse(json);
  if (fullState.success) {
    return { world_flags: fullState.data.updated_state.world_flags };
  }

  throw new LLMValidationError(
    `Ответ флагов не соответствует схеме: ${describeIssues(result.error)}`,
  );
}

/**
 * Парсит ответ фазы обновления остальных данных (issue #137).
 */
export function parseOtherStateResponse(raw: string): LLMOtherStateResponse {
  const json = extractJsonOrThrow(raw);
  const result = otherStateResponseSchema.safeParse(json);
  if (!result.success) {
    throw new LLMValidationError(
      `Ответ остальных данных не соответствует схеме: ${describeIssues(result.error)}`,
    );
  }
  return result.data;
}

/** Результат «жёсткой» санитизации состояния. */
export interface SanitizeResult {
  state: GameState;
  /** Дополнительные заметки игроку (например, об обрезке инвентаря). */
  notes: string[];
  /** Игра окончена (HP <= 0). */
  gameOver: boolean;
}

/**
 * «Жёсткая» проверка и нормализация состояния на стороне Node.js
 * (Hard Validation / Sanitization). Выполняется даже если LLM
 * проигнорировала промпт и вернула завышенные показатели.
 *
 *  - HP обрезается до диапазона [0, maxHp].
 *  - max_hp выравнивается по лимиту манифеста.
 *  - Инвентарь обрезается до maxInventoryItems с заметкой игроку.
 *  - Время мира (world_time) дополняется до полного: пустые/отсутствующие поля
 *    берутся из значения по умолчанию (issue #65).
 *  - Если HP <= 0 — флаг gameOver.
 */
export function sanitizeState(
  state: GameState,
  manifest: GameManifest,
): SanitizeResult {
  const notes: string[] = [];
  const { maxHp, maxInventoryItems } = manifest.limits;

  // max_hp не может превышать лимит сценария.
  const max_hp = Math.min(state.character.max_hp, maxHp);

  // HP не может быть выше max_hp и ниже 0.
  let hp = state.character.hp;
  if (hp > max_hp) hp = max_hp;
  if (hp < 0) hp = 0;

  // Инвентарь обрезается до лимита.
  let inventory = state.character.inventory;
  if (inventory.length > maxInventoryItems) {
    inventory = inventory.slice(0, maxInventoryItems);
    notes.push('(Часть предметов не поместилась в ваш карман)');
  }

  const sanitized: GameState = {
    ...state,
    character: {
      ...state.character,
      hp,
      max_hp,
      inventory,
    },
    // Гарантируем валидное время мира даже если модель его испортила/опустила.
    world_time: ensureWorldTime(state.world_time, manifest.startTime),
  };

  return {
    state: sanitized,
    notes,
    gameOver: hp <= 0,
  };
}
