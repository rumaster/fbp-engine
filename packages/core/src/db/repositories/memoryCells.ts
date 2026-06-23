import type { MemoryCell, ExtractedMemoryCell } from '../../engine/memory.js';
import { getPool } from '../pool.js';

/**
 * Репозиторий ячеек долговременной памяти игры (issue #166).
 *
 * Ячейка хранит свободный текст важного факта (content), короткую категорию,
 * важность (1–3) и номер хода создания (turn_created). Привязка к сессии и шагу
 * каскадная: при удалении сессии/шага ячейки уходят автоматически, что и
 * используется при отмене хода командой /cancel (см. `steps.cancelLastStep`).
 *
 * Память v1 — append-only без эмбеддингов: отбор в промпт детерминированный
 * (по важности и свежести, см. `engine/memory.selectMemoryCells`).
 */

/** Строка таблицы `game_memory_cells`. */
interface MemoryCellRow {
  id: string;
  session_id: string;
  step_id: string | null;
  content: string;
  category: string;
  importance: number;
  turn_created: number;
  created_at: Date;
}

/**
 * Данные для вставки новой ячейки: выделенный LLM факт плюс идентификаторы
 * сохранения (сессия, шаг, номер хода), которые проставляет вызывающий код.
 */
export interface NewMemoryCellInput extends ExtractedMemoryCell {
  sessionId: string;
  stepId: string | null;
  turnCreated: number;
}

function mapRow(row: MemoryCellRow): MemoryCell {
  return {
    id: row.id,
    sessionId: row.session_id,
    stepId: row.step_id ?? null,
    content: row.content,
    category: row.category,
    importance: Number(row.importance),
    turnCreated: Number(row.turn_created),
    createdAt: row.created_at,
  };
}

/**
 * Возвращает все ячейки памяти сессии, важные — сверху (по важности, затем по
 * свежести). Ячейки отменённых ходов уже удалены каскадом, поэтому отдельного
 * фильтра не требуется.
 */
export async function listActiveMemoryCells(sessionId: string): Promise<MemoryCell[]> {
  const pool = getPool();
  const result = await pool.query<MemoryCellRow>(
    `SELECT id, session_id, step_id, content, category, importance, turn_created, created_at
       FROM game_memory_cells
      WHERE session_id = $1
      ORDER BY importance DESC, turn_created DESC`,
    [sessionId],
  );
  return result.rows.map(mapRow);
}

/**
 * Вставляет ячейки памяти одним запросом (атомарно) и возвращает сохранённые
 * записи. Пустой вход — пустой результат без обращения к БД.
 */
export async function insertMemoryCells(cells: NewMemoryCellInput[]): Promise<MemoryCell[]> {
  if (cells.length === 0) return [];
  const pool = getPool();
  const values: string[] = [];
  const params: unknown[] = [];
  cells.forEach((cell, index) => {
    const base = index * 6;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
    params.push(
      cell.sessionId,
      cell.stepId ?? null,
      cell.content,
      cell.category,
      cell.importance,
      cell.turnCreated,
    );
  });
  const result = await pool.query<MemoryCellRow>(
    `INSERT INTO game_memory_cells (session_id, step_id, content, category, importance, turn_created)
     VALUES ${values.join(', ')}
     RETURNING id, session_id, step_id, content, category, importance, turn_created, created_at`,
    params,
  );
  return result.rows.map(mapRow);
}

/**
 * Best-effort сохранение ячеек: сбой записи памяти не должен ронять уже принятый
 * игровой ход (аналогично аудиту LLM и журналу поиска экспертизы).
 */
export async function insertMemoryCellsSafely(
  cells: NewMemoryCellInput[],
): Promise<MemoryCell[]> {
  try {
    return await insertMemoryCells(cells);
  } catch (err) {
    console.error('[game-memory] не удалось сохранить ячейки памяти:', err);
    return [];
  }
}
