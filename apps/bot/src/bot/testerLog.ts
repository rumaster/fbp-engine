import type { LLMUsage } from '@tg-games/core/llm/ILLMProvider.js';
import { calcCostMillicents, findModelPricing, usageToTokenUsage } from '@tg-games/core/llm/pricing.js';

/**
 * Отчёт по одному обращению к медиа-провайдеру (озвучка/иллюстрация) для
 * тестировщика (issue #75): что отправили, что получили, что упало и сколько
 * токенов ушло.
 */
export interface MediaTesterReport {
  /** Вид операции: озвучка (`tts`), иллюстрация (`draw`) или распознавание речи (`stt`). */
  kind: 'tts' | 'draw' | 'stt';
  /** Описание переданного запроса (модель, параметры, вход). */
  request: string;
  /** Описание полученного ответа (формат, размер) — если запрос удался. */
  response?: string;
  /** Текст ошибки API — если запрос упал. */
  error?: string;
  /** Расход токенов, если провайдер его сообщил. */
  usage?: LLMUsage;
}

/**
 * Форматирует отчёт тестировщику по медиа-обращению (issue #75). Включает все
 * четыре раздела из условия: запрос, ответ, ошибку и расход токенов.
 */
export function formatMediaTesterReport(report: MediaTesterReport): string {
  const title =
    report.kind === 'tts'
      ? 'Озвучка сцены'
      : report.kind === 'draw'
        ? 'Иллюстрация сцены'
        : 'Распознавание речи';
  return [
    `🧪 Отчёт тестировщику · ${title}`,
    '',
    'Запрос:',
    report.request,
    '',
    'Ответ:',
    report.response ?? '—',
    '',
    'Ошибка:',
    report.error ?? 'нет',
    '',
    'Затраты:',
    formatUsage(report.usage),
  ].join('\n');
}

function formatUsage(usage: LLMUsage | undefined): string {
  if (!usage) return 'неизвестно';

  const tokenUsage = usageToTokenUsage(usage);
  const pricing = findModelPricing('gpt-4o-mini') ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };
  const costMillicents = calcCostMillicents(tokenUsage, pricing);

  return [
    `inputTokens: ${tokenUsage.inputTokens}`,
    `outputTokens: ${tokenUsage.outputTokens}`,
    `cacheReadTokens: ${tokenUsage.cacheReadTokens}`,
    `cacheCreationTokens: ${tokenUsage.cacheCreationTokens}`,
    `cost_millicents: ${costMillicents}`,
  ].join('\n');
}
