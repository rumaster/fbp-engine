/**
 * Конфигурация одного запроса к LLM.
 */
export interface LLMRequestOptions {
  /** Пользовательский промпт (контекст + действие). */
  prompt: string;
  /** Системная инструкция (правила мира, роль ведущего). */
  systemInstruction?: string;
  /**
   * Включить гарантированный возврат JSON (JSON Mode).
   * Для каждого провайдера настраивается своим способом.
   */
  jsonMode?: boolean;
  /**
   * Стабильный идентификатор для маршрутизации запросов с общим префиксом
   * в один и тот же бекенд, повышая вероятность попадания в кеш промпта.
   *
   * Для OpenAI/OpenRouter передаётся как `prompt_cache_key`. В нашем боте
   * используется ID игровой сессии — внутри одной сессии запросы делят
   * системный промпт (правила мира) и контекст состояния, поэтому маршрутизация
   * в один бэкенд резко повышает hit rate кеша.
   */
  cacheKey?: string;
}

/** Расход токенов на один запрос к LLM. */
export interface LLMUsage {
  /** Токены входного запроса. */
  promptTokens?: number;
  /** Токены ответа модели. */
  completionTokens?: number;
  /** Суммарный расход токенов. */
  totalTokens?: number;
  /** Токены, прочитанные из кеша (дешевле обычных входных). */
  cacheReadTokens?: number;
  /** Токены, записанные в кеш (дороже обычных входных). */
  cacheCreationTokens?: number;
}

/** Текстовый ответ LLM вместе с технической метаинформацией. */
export interface LLMTextResult {
  text: string;
  usage?: LLMUsage;
}

/**
 * Общий интерфейс провайдера LLM.
 *
 * Бот общается только с этим интерфейсом и ничего не знает об особенностях
 * SDK конкретного вендора (паттерн «Стратегия»).
 */
export interface ILLMProvider {
  /** Человекочитаемое имя провайдера (для логов). */
  readonly name: string;
  /** Генерирует текстовый ответ по заданным опциям. */
  generateText(options: LLMRequestOptions): Promise<string>;
  /** Генерирует текстовый ответ и возвращает usage для отладочных логов. */
  generateTextResult?(options: LLMRequestOptions): Promise<LLMTextResult>;
}
