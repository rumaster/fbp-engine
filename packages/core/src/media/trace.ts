import type { LLMUsage } from '../llm/ILLMProvider.js';

/**
 * Утилиты трассировки медиа-обращений для отчёта тестировщику (issue #75).
 * Помогают провайдерам единообразно описывать запрос/ответ и аккуратно
 * вытаскивать usage из разнородных ответов вендоров.
 */

/** Обрезает длинный текст для отчёта, добавляя пометку с исходной длиной. */
export function clipForReport(text: string, limit = 800): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}… (всего ${trimmed.length} симв.)`;
}

/** Достаёт человекочитаемое сообщение из произвольной ошибки. */
export function mediaErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Нормализует usage-блок вендора (разные имена полей: `promptTokenCount`,
 * `input_tokens` и т. п.) в общий {@link LLMUsage}. Возвращает `undefined`,
 * если ни одного значения нет.
 */
export function normalizeUsage(raw: unknown): LLMUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const promptTokens = num('promptTokens', 'promptTokenCount', 'input_tokens', 'inputTokens');
  const completionTokens = num(
    'completionTokens',
    'candidatesTokenCount',
    'output_tokens',
    'outputTokens',
  );
  const totalTokens = num('totalTokens', 'totalTokenCount', 'total_tokens');
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}
