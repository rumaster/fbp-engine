import { calcCostMillicents, type ModelPricing, type TokenUsage, usageToTokenUsage } from '../../llm/pricing.js';
import type { LLMCallKind, LLMCallLogEntry } from '../../llm/trace.js';
import { getPool } from '../pool.js';

export interface LlmRequestLogInput {
  userId?: string | null;
  sessionId?: string | null;
  stepId?: string | null;
  supportTicketId?: string | null;
  requestKind: LLMCallKind;
  provider: string;
  model: string;
  modelParams?: Record<string, unknown>;
  requestText: string;
  responseText?: string | null;
  errorText?: string | null;
  tokenUsage?: TokenUsage;
  costMillicents?: number;
  /** Документы экспертизы, подтянутые векторным поиском к запросу (issue #147). */
  retrievedDocuments?: RetrievedExpertiseDocument[] | null;
}

/**
 * Документ экспертизы, найденный векторным поиском для запроса бота поддержки
 * (issue #147). Сохраняется в аудите, чтобы в админке было видно, какие
 * справочные материалы подтянулись на конкретном шаге.
 */
export interface RetrievedExpertiseDocument {
  id: string;
  title: string;
  /** Фраза-источник эмбеддинга, которая дала наилучшее совпадение. */
  matchedSource: string;
  /** Косинусное расстояние (меньше — ближе). */
  distance: number;
  /** Косинусная близость 1 - distance (больше — релевантнее). */
  similarity: number;
}

export interface LlmRequestLogContext {
  userId?: string | null;
  sessionId?: string | null;
  stepId?: string | null;
  supportTicketId?: string | null;
  requestKind?: LLMCallKind;
  provider: string;
  model: string;
  modelParams?: Record<string, unknown>;
  pricing?: ModelPricing | null;
}

export interface LlmRequestLogRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  step_id: string | null;
  support_ticket_id: string | null;
  request_kind: LLMCallKind;
  provider: string;
  model: string;
  model_params: Record<string, unknown>;
  request_text: string;
  response_text: string | null;
  error_text: string | null;
  token_usage: TokenUsage;
  cost_millicents: number;
  retrieved_documents: RetrievedExpertiseDocument[] | null;
  created_at: Date;
}

/**
 * Строит строки аудита из технического runtime-лога LLM. Стоимость считается
 * отдельно для каждой попытки, чтобы таблица была пригодна для разбора дорогих
 * ретраев, а не только итоговой суммы хода.
 */
export function buildLlmRequestLogInputs(
  entries: LLMCallLogEntry[],
  context: LlmRequestLogContext,
): LlmRequestLogInput[] {
  return entries.map((entry) => {
    const requestKind = entry.kind ?? context.requestKind;
    if (!requestKind) {
      throw new Error('Не задан requestKind для строки аудита LLM');
    }
    const tokenUsage = usageToTokenUsage(entry.usage);
    const costMillicents = context.pricing
      ? calcCostMillicents(tokenUsage, context.pricing)
      : 0;
    return {
      userId: context.userId,
      sessionId: context.sessionId,
      stepId: context.stepId,
      supportTicketId: context.supportTicketId,
      requestKind,
      provider: context.provider,
      model: context.model,
      modelParams: {
        ...context.modelParams,
        ...entry.modelParams,
      },
      requestText: entry.request,
      responseText: entry.error ? null : entry.response,
      errorText: entry.error ?? null,
      tokenUsage,
      costMillicents,
      retrievedDocuments: entry.retrievedDocuments ?? null,
    };
  });
}

/** Записывает подготовленные строки аудита в БД. */
export async function insertLlmRequestLogs(
  inputs: LlmRequestLogInput[],
): Promise<LlmRequestLogRow[]> {
  if (inputs.length === 0) return [];

  const pool = getPool();
  const client = await pool.connect();
  const rows: LlmRequestLogRow[] = [];
  try {
    await client.query('BEGIN');
    for (const input of inputs) {
      const tokenUsage = input.tokenUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      const inserted = await client.query<LlmRequestLogRow>(
        `INSERT INTO llm_request_logs (
           user_id, session_id, step_id, support_ticket_id, request_kind,
           provider, model, model_params, request_text, response_text, error_text,
           token_usage, cost_millicents, retrieved_documents
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          input.userId ?? null,
          input.sessionId ?? null,
          input.stepId ?? null,
          input.supportTicketId ?? null,
          input.requestKind,
          input.provider,
          input.model,
          JSON.stringify(input.modelParams ?? {}),
          input.requestText,
          input.responseText ?? null,
          input.errorText ?? null,
          JSON.stringify(tokenUsage),
          input.costMillicents ?? 0,
          input.retrievedDocuments ? JSON.stringify(input.retrievedDocuments) : null,
        ],
      );
      rows.push(inserted.rows[0]);
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Best-effort запись аудита. Ошибка логирования не должна ломать игровой ход,
 * консультацию поддержки или отправку медиа пользователю.
 */
export async function insertLlmRequestLogsSafely(
  inputs: LlmRequestLogInput[],
  label: string,
): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await insertLlmRequestLogs(inputs);
  } catch (err) {
    console.error(`[llm-logs] не удалось сохранить аудит LLM (${label}):`, err);
  }
}
