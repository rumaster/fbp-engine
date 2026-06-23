import { getPool } from '../pool.js';
import type { TokenUsage } from '../../llm/pricing.js';
import type { GameState } from '../../types.js';

export interface StepInput {
  sessionId: string;
  actionText: string;
  llmRawResponse: string | null;
  changesSummary: string;
  /** Токены, израсходованные на запросы к LLM в этом шаге. */
  stepCredits?: number;
  /** Детализация расхода токенов по категориям для этого шага. */
  tokenUsage?: TokenUsage;
  /** Оценка стоимости шага в тысячных долях цента (миллицентах). */
  costMillicents?: number;
  /**
   * Снимок состояния сессии ДО применения этого хода (issue #116).
   * Позволяет команде /cancel откатывать ходы по одному. Может быть null
   * для совместимости со старыми вызовами без снимка.
   */
  stateBefore?: GameState | null;
}

export interface StepRow {
  id: string;
  session_id: string;
  action_text: string | null;
  llm_raw_response: string | null;
  changes_summary: string | null;
  step_credits: number;
  /** Детализация расхода токенов по категориям (JSONB). */
  token_usage: TokenUsage;
  /** Оценка стоимости шага в тысячных долях цента (миллицентах). */
  cost_millicents: number;
  /** Ход отменён командой /cancel (issue #116). */
  is_cancelled: boolean;
  /** Снимок состояния сессии ДО применения хода (issue #116). */
  state_before: GameState | null;
  created_at: Date;
}

/** Пустой TokenUsage для подстановки по умолчанию. */
const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Записывает один игровой шаг в game_steps.
 */
export async function insertStep(input: StepInput): Promise<StepRow> {
  const pool = getPool();
  const tokenUsage = input.tokenUsage ?? EMPTY_USAGE;
  const stateBefore = input.stateBefore != null ? JSON.stringify(input.stateBefore) : null;
  const { rows } = await pool.query<StepRow>(
    `INSERT INTO game_steps (session_id, action_text, llm_raw_response, changes_summary, step_credits, token_usage, cost_millicents, state_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.sessionId,
      input.actionText,
      input.llmRawResponse,
      input.changesSummary,
      input.stepCredits ?? 0,
      JSON.stringify(tokenUsage),
      input.costMillicents ?? 0,
      stateBefore,
    ],
  );
  return rows[0];
}

/** Шаг вместе с владельцем сессии (для проверки прав на медиа). */
export interface StepWithOwner extends StepRow {
  /** Идентификатор владельца сессии (game_sessions.user_id). */
  user_id: string;
  /** Игра сессии (game_sessions.game_id) — нужна для выбора схемы иллюстрации (issue #238). */
  game_id: string;
}

/**
 * Возвращает шаг вместе с владельцем сессии (через JOIN game_sessions).
 *
 * Нужен для проверки прав при озвучке/иллюстрации сцены (issue #71): медиа
 * по кнопке доступно только автору хода. Возвращает null, если шаг не найден.
 */
export async function getStepWithOwner(stepId: string): Promise<StepWithOwner | null> {
  const pool = getPool();
  const { rows } = await pool.query<StepWithOwner>(
    `SELECT s.*, gs.user_id, gs.game_id
       FROM game_steps s
       JOIN game_sessions gs ON gs.id = s.session_id
      WHERE s.id = $1`,
    [stepId],
  );
  return rows[0] ?? null;
}

/** Возвращает ходы сессии в хронологическом порядке (для истории игры). */
export async function listSteps(sessionId: string): Promise<StepRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<StepRow>(
    'SELECT * FROM game_steps WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId],
  );
  return rows;
}

/**
 * Отменяет последний неотменённый ход сессии (issue #116).
 *
 * В одной транзакции:
 *  1. Находит самый свежий неотменённый ход (FOR UPDATE — защита от гонок).
 *  2. Помечает его is_cancelled = TRUE (ход остаётся в истории как отменённый).
 *  3. Удаляет ячейки долговременной памяти, выделенные на этом ходе (issue #166):
 *     ход помечается отменённым, а не удаляется, поэтому каскад по step_id не
 *     срабатывает — чистим явно, чтобы откат хода не оставлял «фантомных» фактов.
 *  4. Восстанавливает current_state сессии из снимка state_before, если он есть,
 *     откатывая состояние мира к моменту до этого хода.
 *
 * Команду можно вызывать многократно, отменяя ходы по одному. Возвращает
 * отменённый ход (с уже выставленным is_cancelled) или null, если отменять
 * нечего.
 */
export async function cancelLastStep(sessionId: string): Promise<StepRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<StepRow>(
      `SELECT * FROM game_steps
        WHERE session_id = $1 AND is_cancelled = FALSE
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [sessionId],
    );
    const step = rows[0];
    if (!step) {
      await client.query('COMMIT');
      return null;
    }
    await client.query('UPDATE game_steps SET is_cancelled = TRUE WHERE id = $1', [step.id]);
    // Откатываем долговременную память (issue #166): факты этого хода больше не
    // должны влиять на мир. step_id у этих ячеек — отменяемый ход.
    await client.query('DELETE FROM game_memory_cells WHERE step_id = $1', [step.id]);
    if (step.state_before != null) {
      await client.query('UPDATE game_sessions SET current_state = $2 WHERE id = $1', [
        sessionId,
        JSON.stringify(step.state_before),
      ]);
    }
    await client.query('COMMIT');
    return { ...step, is_cancelled: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
