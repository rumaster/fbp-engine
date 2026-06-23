import type {
  ILLMProvider,
  LLMRequestOptions,
  LLMTextResult,
  LLMUsage,
} from './ILLMProvider.js';

export type LLMCallKind =
  | 'support_consultation'
  | 'support_expertise_detection'
  | 'support_document_filter'
  | 'support_compilation'
  | 'hint_generation'
  | 'game_expertise_detection'
  | 'game_memory_extraction'
  | 'graph_extraction'
  | 'graph_community_summary'
  | 'narrative_generation'
  | 'world_state_evaluation'
  | 'media_speech'
  | 'media_image'
  | 'media_transcription';

/** Один фактический обмен с LLM: запрос, ответ/ошибка и usage. */
export interface LLMCallLogEntry {
  /** Функциональный тип запроса: подсказка, нарратив, учёт состояния и т. п. */
  kind?: LLMCallKind;
  request: string;
  response: string;
  /** Текст ошибки, если вызов провайдера завершился исключением. */
  error?: string;
  usage?: LLMUsage;
  /** Параметры, с которыми был сделан конкретный запрос к модели. */
  modelParams?: Record<string, unknown>;
  /**
   * Документы экспертизы, подтянутые векторным поиском к данному запросу
   * (issue #147). Заполняется только для запросов бота поддержки, использующих
   * справочные материалы; пробрасывается в аудит LLM.
   */
  retrievedDocuments?: RetrievedExpertiseDocumentTrace[];
}

/**
 * Документ экспертизы в runtime-логе LLM (issue #147). Дублирует форму
 * RetrievedExpertiseDocument из репозитория аудита, но объявлен здесь, чтобы
 * слой LLM не зависел от слоя БД.
 */
export interface RetrievedExpertiseDocumentTrace {
  id: string;
  title: string;
  matchedSource: string;
  distance: number;
  similarity: number;
}

export interface LLMCallLogMeta {
  kind?: LLMCallKind;
  modelParams?: Record<string, unknown>;
}

/** Формирует читаемый текст запроса, включая system prompt, если он есть. */
export function formatLlmRequest(options: LLMRequestOptions): string {
  const parts: string[] = [];
  if (options.systemInstruction) {
    parts.push(`Системная инструкция:\n${options.systemInstruction}`);
  }
  parts.push(`Промпт:\n${options.prompt}`);
  return parts.join('\n\n');
}

/** Вызывает LLM и добавляет результат или ошибку в переданный лог. */
export async function generateTextWithLog(
  provider: ILLMProvider,
  options: LLMRequestOptions,
  log: LLMCallLogEntry[],
  meta: LLMCallLogMeta = {},
): Promise<string> {
  const request = formatLlmRequest(options);
  const modelParams = { ...requestModelParams(options), ...meta.modelParams };
  try {
    const result = await generateTextResult(provider, options);
    log.push({ kind: meta.kind, request, response: result.text, usage: result.usage, modelParams });
    return result.text;
  } catch (err) {
    const message = errorMessage(err);
    log.push({
      kind: meta.kind,
      request,
      response: `Ошибка: ${message}`,
      error: message,
      modelParams,
    });
    throw err;
  }
}

function requestModelParams(options: LLMRequestOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {
    jsonMode: Boolean(options.jsonMode),
    hasSystemInstruction: Boolean(options.systemInstruction),
  };
  if (options.cacheKey) params.cacheKey = options.cacheKey;
  return params;
}

async function generateTextResult(
  provider: ILLMProvider,
  options: LLMRequestOptions,
): Promise<LLMTextResult> {
  if (provider.generateTextResult) {
    return provider.generateTextResult(options);
  }
  return { text: await provider.generateText(options) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
