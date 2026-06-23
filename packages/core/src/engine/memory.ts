/**
 * Долговременная память игры (issue #166).
 *
 * Отдельная финальная фаза игрового хода: после принятого нарратива дешёвым
 * JSON-запросом из произошедшего выделяются НОВЫЕ важные факты о ходе игры и
 * состоянии мира. Они сохраняются ячейками памяти в БД (репозиторий
 * `memoryCells.ts`) и по необходимости подключаются обратно в промпт нарратива
 * через плейсхолдер `{{memory}}`.
 *
 * Зеркало фазы 0 экспертизы (`expertiseKeys.ts`): такой же дешёвый узкий
 * LLM-вызов с собственным бюджетом ретраев, best-effort (неуспех не валит ход),
 * все чистые билдеры и парсер вынесены сюда для юнит-тестов без обращения к LLM.
 * В отличие от экспертизы память НЕ использует эмбеддинги: ячейки отбираются
 * детерминированно по важности и свежести (семантический отбор — на будущее).
 */

import type { ILLMProvider } from '../llm/ILLMProvider.js';
import { generateTextWithLog, type LLMCallLogEntry } from '../llm/trace.js';
import { extractJson } from './validation.js';
import {
  renderPromptTemplate,
  requirePromptTemplates,
  type PromptTemplateOverrides,
} from './promptTemplates.js';
import { formatWorldTimeLine, type GameManifest } from '../games/manifests.js';
import type { GameState } from '../types.js';

/**
 * Факт, выделенный LLM в конце хода (ещё не сохранён в БД). Поля совпадают с
 * пользовательскими колонками `game_memory_cells`, кроме служебных
 * (id/session_id/step_id/turn_created/created_at), которые проставляет
 * вызывающий код при сохранении.
 */
export interface ExtractedMemoryCell {
  /** Текст факта (в третьем лице, как свершившееся). */
  content: string;
  /** Короткая категория: «мир», «персонажи», «цели», «события», «предметы»… */
  category: string;
  /** Важность факта: 1 (полезно помнить) … 3 (ключевой). */
  importance: number;
}

/** Ячейка долговременной памяти — доменная запись таблицы `game_memory_cells`. */
export interface MemoryCell {
  id: string;
  sessionId: string;
  /** Шаг, на котором факт выделен; null — для ячеек без привязки к шагу. */
  stepId: string | null;
  content: string;
  category: string;
  importance: number;
  /** Номер хода (`turn_count`), на котором ячейка создана. */
  turnCreated: number;
  createdAt: Date;
}

/**
 * Максимум новых ячеек за один ход. Системный промпт и так просит выделять лишь
 * по-настоящему важные факты (обычно 1–3), но защищаемся от «вываливания»
 * десятков ячеек дефектной моделью.
 */
const MAX_MEMORY_CELLS_PER_TURN = 6;

/** Текст блока памяти, когда фактов ещё нет (для `{{memory}}` и контекста извлечения). */
export const EMPTY_MEMORY_BLOCK = 'Важных фактов пока не накоплено.';

/**
 * Собирает блок важных фактов для плейсхолдера `{{memory}}` промпта нарратива
 * (а также для контекста «уже известные факты» в промпте извлечения). Возвращает
 * явную пометку, если фактов нет, — чтобы модель не выдумывала их.
 */
export function buildMemoryBlock(cells: MemoryCell[]): string {
  if (cells.length === 0) {
    return EMPTY_MEMORY_BLOCK;
  }
  return cells
    .map((cell, index) => {
      const category = cell.category.trim();
      const prefix = category ? `[${category}] ` : '';
      return `${index + 1}. ${prefix}${cell.content.trim()}`;
    })
    .join('\n');
}

/**
 * Детерминированно отбирает не более topK ячеек для подстановки в промпт:
 * сначала по важности (по убыванию), затем по свежести (последние ходы — выше).
 * Семантический отбор по эмбеддингам — возможное развитие (issue #166).
 */
export function selectMemoryCells(cells: MemoryCell[], topK: number): MemoryCell[] {
  if (topK <= 0) return [];
  return [...cells]
    .sort((a, b) => b.importance - a.importance || b.turnCreated - a.turnCreated)
    .slice(0, topK);
}

/** Системная инструкция фазы памяти: роль хрониста игры и схема ответа. */
export function buildMemorySystemPrompt(manifest: GameManifest, template: string): string {
  return renderPromptTemplate(template, {
    game_name: manifest.name,
    game_description: manifest.description,
  });
}

/**
 * Пользовательский промпт фазы памяти: время мира, уже известные факты (чтобы
 * не дублировать), действие игрока и принятый нарратив (что произошло).
 */
export function buildMemoryPrompt(
  state: GameState,
  action: string,
  narrative: string,
  existingMemoryBlock: string,
  template: string,
): string {
  return renderPromptTemplate(template, {
    world_time_line: formatWorldTimeLine(state.world_time),
    existing_memory: existingMemoryBlock,
    action,
    narrative,
  });
}

/** Приводит важность к целому в диапазоне 1..3 (по умолчанию 1). */
function clampImportance(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(3, Math.max(1, n));
}

/**
 * Парсит ответ фазы памяти из `{"memory":[{content,category,importance}]}`.
 *
 * Возвращает массив валидных ячеек (возможно пустой — это корректный ответ «новых
 * фактов нет»). Возвращает null только при нечитаемом JSON или отсутствии массива
 * `memory` — тогда вызов повторяется. Ячейки с пустым content отбрасываются,
 * category обрезается до 50 символов (под VARCHAR(50)), importance зажимается.
 */
export function parseMemoryExtraction(raw: string): ExtractedMemoryCell[] | null {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const memory = (json as Record<string, unknown>).memory;
  if (!Array.isArray(memory)) return null;
  const cells: ExtractedMemoryCell[] = [];
  for (const item of memory) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (content.length === 0) continue;
    const category =
      typeof record.category === 'string' ? record.category.trim().slice(0, 50) : '';
    cells.push({ content, category, importance: clampImportance(record.importance) });
  }
  return cells.slice(0, MAX_MEMORY_CELLS_PER_TURN);
}

/** Результат фазы памяти: новые ячейки и технический лог запросов к LLM. */
export interface MemoryExtractionResult {
  added: ExtractedMemoryCell[];
  llmLog: LLMCallLogEntry[];
}

/**
 * Финальная фаза хода (issue #166): по принятому нарративу и действию игрока
 * выделяет новые важные факты для долговременной памяти. Best-effort: при неуспехе
 * всех попыток возвращает пустой список — ход сохраняется без новых ячеек.
 */
export async function runMemoryExtraction(
  provider: ILLMProvider,
  manifest: GameManifest,
  state: GameState,
  action: string,
  narrative: string,
  existingCells: MemoryCell[],
  maxRetries = 3,
  promptTemplatesOverride?: PromptTemplateOverrides,
): Promise<MemoryExtractionResult> {
  const llmLog: LLMCallLogEntry[] = [];
  const promptTemplates = requirePromptTemplates(promptTemplatesOverride ?? {}, [
    'game_memory_system',
    'game_memory_prompt',
  ]);
  const systemInstruction = buildMemorySystemPrompt(
    manifest,
    promptTemplates.game_memory_system,
  );
  const prompt = buildMemoryPrompt(
    state,
    action,
    narrative,
    buildMemoryBlock(existingCells),
    promptTemplates.game_memory_prompt,
  );

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let raw: string;
    try {
      raw = await generateTextWithLog(
        provider,
        { prompt, systemInstruction, jsonMode: true },
        llmLog,
        { kind: 'game_memory_extraction' },
      );
    } catch (err) {
      console.warn(
        `[game] память: ошибка провайдера на попытке ${attempt}/${maxRetries}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseMemoryExtraction(raw);
    if (parsed) return { added: parsed, llmLog };
    console.warn(`[game] память: невалидный ответ LLM на попытке ${attempt}/${maxRetries}.`);
  }
  console.warn('[game] память: не удалось извлечь факты — ход сохранён без новых ячеек.');
  return { added: [], llmLog };
}
