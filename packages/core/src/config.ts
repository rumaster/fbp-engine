/**
 * Загрузка и валидация переменных окружения.
 * Все настройки приложения читаются здесь один раз при старте.
 */

export type LLMProviderName = 'OPENAI' | 'GOOGLE' | 'OPENROUTER' | 'AZURE';
export type EmbeddingProviderName = 'OPENAI' | 'AZURE';

export interface AppConfig {
  telegramBotToken: string;
  llm: {
    provider: LLMProviderName;
    apiKey: string;
    modelName: string;
    temperature: number;
    maxRetries: number;
    /**
     * Ключи API провайдеров LLM. Ключ активного провайдера всегда совпадает с
     * `apiKey` и нужен runtime-роутеру, когда админка переопределяет только имя
     * модели поверх текущего `LLM_PROVIDER`.
     */
    providerKeys: Record<LLMProviderName, string>;
    /** Дополнительные настройки Azure OpenAI, нужны только при LLM_PROVIDER=AZURE. */
    azure?: {
      endpoint: string;
      apiVersion: string;
      /**
       * Карта алиасов deployment → каноническая модель (issue #120).
       * В Azure `model` в запросе — это имя deployment, поэтому для подсчёта
       * стоимости его нужно сопоставить реальной модели из справочника цен.
       * Сидируется в таблицу azure_models на старте (без перезатирания правок БД).
       */
      models: Record<string, string>;
    };
  };
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  neo4j: {
    uri: string;
    user: string;
    password: string;
    database: string;
  };
  /**
   * Стоимость 1 Telegram Star в тысячных долях цента (миллицентах).
   * Используется для подсчёта кредитного лимита на основе реальных цен LLM.
   * 1 USD ≈ 50 Stars → 1 Star ≈ 2 цента = 2 000 миллицентов.
   * Значение по умолчанию: 2000 (0.02 USD за звезду).
   */
  millicentsPerStar: number;
  /**
   * Эмбеддинги для семантического поиска экспертизы службы поддержки (issue #147).
   *
   * По умолчанию используются OpenAI embeddings. Для Azure OpenAI задайте
   * EMBEDDING_PROVIDER=AZURE и AZURE_OPENAI_EMBEDDING_DEPLOYMENT; deployment
   * должен возвращать векторы той же размерности, что и сохранённые в БД.
   */
  embedding: {
    /** Провайдер эмбеддингов (EMBEDDING_PROVIDER). По умолчанию OPENAI. */
    provider: EmbeddingProviderName;
    /** Ключ API провайдера эмбеддингов. Пустая строка → экспертиза отключена. */
    apiKey: string;
    /** Модель эмбеддингов (EMBEDDING_MODEL). По умолчанию text-embedding-3-small. */
    model: string;
    /** Настройки Azure OpenAI для эмбеддингов, нужны при EMBEDDING_PROVIDER=AZURE. */
    azure?: {
      endpoint: string;
      apiVersion: string;
      deploymentName: string;
    };
    /** Сколько документов экспертизы подтягивать на одну проблему. */
    topK: number;
    /**
     * Сколько документов базы знаний игры подтягивать в нарратив на ходе
     * (issue #154, фаза 0). 0 — экспертиза игры в ходе отключена.
     */
    gameTopK: number;
  };
  /**
   * Долговременная память игры (issue #166). В отличие от экспертизы память НЕ
   * использует эмбеддинги, поэтому вынесена в отдельную секцию.
   */
  memory: {
    /**
     * Сколько ячеек памяти максимум подставлять в нарратив (GAME_MEMORY_TOP_K).
     * Один рубильник: `> 0` включает И подстановку памяти, И финальную фазу
     * извлечения новых фактов; `0` — память отключена. По умолчанию 12.
     */
    topK: number;
  };
  /**
   * Graph RAG — автоизвлечённый граф знаний из документов экспертизы (issue #328).
   * Индексация дорогая (LLM-проход на документ + на сообщество), поэтому вне
   * горячего пути хода и по умолчанию выключена.
   */
  graphRag: {
    /**
     * Перестраивать граф знаний игр при старте бота (GRAPH_RAG_REINDEX_ON_START).
     * Best-effort, идемпотентно (как сид экспертизы): извлекает граф из документов
     * базы знаний, апсёртит с origin='extracted' (ручную онтологию #323 не
     * перетирает) и перестраивает сводки сообществ. По умолчанию false — построение
     * графа запускается осознанно (дорогой LLM-проход). Требует провайдера
     * эмбеддингов (документы базы знаний) и LLM.
     */
    reindexOnStart: boolean;
  };
  /**
   * Настройки службы поддержки (issue #57).
   *
   * Все поля необязательны: игровой бот работает и без них. Значения нужны
   * только для запуска ботов поддержки (`botSupport`, `botSupportAdmin`)
   * и для кнопки-редиректа «Служба поддержки» в сообщении «Помощь».
   */
  support: {
    /** Токен бота поддержки для клиентов (SUPPORT_BOT_TOKEN). */
    clientBotToken: string;
    /** Токен бота поддержки для администраторов (SUPPORT_ADMIN_BOT_TOKEN). */
    adminBotToken: string;
    /** Username клиентского бота для кнопки-редиректа (SUPPORT_BOT_USERNAME). */
    botUsername: string;
    /**
     * Telegram-идентификаторы стартовых администраторов (SUPPORT_ADMIN_IDS,
     * через запятую). На старте бота администраторов им проставляется is_admin.
     */
    adminIds: number[];
    /**
     * Включён ли LLM-бот-консультант первой линии (issue #59,
     * SUPPORT_LLM_CONSULTATION). При false обращение сразу передаётся
     * администратору, как до появления консультанта. По умолчанию true.
     */
    llmConsultation: boolean;
  };
  /**
   * Настройки медиа: озвучка сцены и генерация иллюстраций (issue #71).
   *
   * Возможность необязательна. Если `apiKey` пуст или обе под-возможности
   * выключены, фабрика {@link createMediaProvider} вернёт `null`, и бот не
   * покажет кнопки «Озвучить»/«Нарисовать иллюстрацию» — текстовая игра при
   * этом работает как прежде.
   */
  media: {
    /** Провайдер медиа (MEDIA_PROVIDER). По умолчанию совпадает с LLM-провайдером. */
    provider: LLMProviderName;
    /** Ключ API для медиа. Пустая строка → медиа отключено. */
    apiKey: string;
    /** Озвучка (TTS). */
    tts: { enabled: boolean; model: string; voice: string };
    /** Генерация иллюстраций. */
    image: { enabled: boolean; model: string; size: string };
    /** Распознавание речи из голосовых сообщений (STT, issue #118). */
    stt: { enabled: boolean; model: string };
  };
}

/**
 * Значения по умолчанию для медиа-моделей по каждому провайдеру.
 * OpenRouter не поддерживает медиа — наследует значения OpenAI как заглушку
 * (фабрика всё равно вернёт `null`).
 */
const MEDIA_DEFAULTS: Record<
  LLMProviderName,
  { ttsModel: string; ttsVoice: string; imageModel: string; sttModel: string }
> = {
  OPENAI: { ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy', imageModel: 'gpt-image-1', sttModel: 'whisper-1' },
  GOOGLE: { ttsModel: 'gemini-2.5-flash-preview-tts', ttsVoice: 'Kore', imageModel: 'imagen-3.0-generate-002', sttModel: 'gemini-2.5-flash' },
  OPENROUTER: { ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy', imageModel: 'gpt-image-1', sttModel: 'whisper-1' },
  AZURE: { ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy', imageModel: 'gpt-image-1', sttModel: 'whisper-1' },
};

const AZURE_OPENAI_DEFAULT_API_VERSION = '2024-10-21';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  // Пустую строку трактуем как отсутствие значения и берём дефолт. Это важно
  // для docker-compose: переменные вида `${MEDIA_TTS_MODEL:-}` приходят в
  // контейнер пустой строкой, если их нет в .env, и без этой проверки пустое
  // значение перетёрло бы осмысленный дефолт (issue #78).
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Возвращает ключ API для выбранного провайдера LLM.
 */
function resolveLlmApiKey(provider: LLMProviderName): string {
  switch (provider) {
    case 'OPENAI':
      return required('OPENAI_API_KEY');
    case 'GOOGLE':
      return required('GOOGLE_API_KEY');
    case 'OPENROUTER':
      return required('OPENROUTER_API_KEY');
    case 'AZURE':
      return required('AZURE_OPENAI_API_KEY');
    default:
      throw new Error(`Неизвестный LLM_PROVIDER: ${provider}`);
  }
}

function resolveLlmModelName(provider: LLMProviderName): string {
  if (provider === 'AZURE' && !process.env.LLM_MODEL_NAME) {
    throw new Error('Не задана обязательная переменная окружения: LLM_MODEL_NAME (deployment Azure OpenAI)');
  }
  return optional('LLM_MODEL_NAME', 'gemini-1.5-flash');
}

function resolveAzureConfig(provider: LLMProviderName): AppConfig['llm']['azure'] {
  // При активном провайдере Azure endpoint обязателен. Иначе конфиг Azure нужен
  // только для алиасов deployment → модель, поэтому подхватываем его «мягко».
  if (provider !== 'AZURE') {
    const endpoint = optional('AZURE_OPENAI_ENDPOINT', '');
    if (!endpoint) return undefined;
    return {
      endpoint,
      apiVersion: optional('AZURE_OPENAI_API_VERSION', AZURE_OPENAI_DEFAULT_API_VERSION),
      models: parseAzureModels(optional('AZURE_MODELS', '')),
    };
  }
  return {
    endpoint: required('AZURE_OPENAI_ENDPOINT'),
    apiVersion: optional('AZURE_OPENAI_API_VERSION', AZURE_OPENAI_DEFAULT_API_VERSION),
    models: parseAzureModels(optional('AZURE_MODELS', '')),
  };
}

/**
 * Считывает ключи API провайдеров «мягко». Активный провайдер уже проверен через
 * resolveLlmApiKey (бросает при отсутствии ключа), поэтому здесь пустая строка
 * означает только незаполненный ключ неактивного провайдера.
 */
function resolveProviderKeys(): Record<LLMProviderName, string> {
  return {
    OPENAI: optional('OPENAI_API_KEY', ''),
    GOOGLE: optional('GOOGLE_API_KEY', ''),
    OPENROUTER: optional('OPENROUTER_API_KEY', ''),
    AZURE: optional('AZURE_OPENAI_API_KEY', ''),
  };
}

/**
 * Мягко разрешает ключ API для медиа: сначала отдельный MEDIA_API_KEY, иначе
 * переиспользует ключ выбранного провайдера. В отличие от LLM-ключа НЕ бросает
 * ошибку при отсутствии — медиа необязательно, пустой ключ просто выключает его.
 */
function resolveMediaApiKey(provider: LLMProviderName): string {
  const explicit = process.env.MEDIA_API_KEY;
  if (explicit) return explicit;
  switch (provider) {
    case 'OPENAI':
      return optional('OPENAI_API_KEY', '');
    case 'GOOGLE':
      return optional('GOOGLE_API_KEY', '');
    case 'OPENROUTER':
      return optional('OPENROUTER_API_KEY', '');
    case 'AZURE':
      return optional('AZURE_OPENAI_API_KEY', '');
    default:
      return '';
  }
}

function resolveEmbeddingProvider(): EmbeddingProviderName {
  const provider = optional('EMBEDDING_PROVIDER', 'OPENAI').toUpperCase() as EmbeddingProviderName;
  if (!['OPENAI', 'AZURE'].includes(provider)) {
    throw new Error(`Недопустимое значение EMBEDDING_PROVIDER: ${provider}. Ожидается OPENAI | AZURE`);
  }
  return provider;
}

function resolveEmbeddingApiKey(provider: EmbeddingProviderName): string {
  switch (provider) {
    case 'OPENAI':
      return optional('OPENAI_API_KEY', '');
    case 'AZURE':
      return optional('AZURE_OPENAI_API_KEY', '');
    default:
      return '';
  }
}

function resolveEmbeddingAzureConfig(provider: EmbeddingProviderName): AppConfig['embedding']['azure'] {
  if (provider !== 'AZURE') return undefined;
  const endpoint = optional('AZURE_OPENAI_ENDPOINT', '');
  const deploymentName = optional('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', '');
  if (!endpoint || !deploymentName) return undefined;
  return {
    endpoint,
    apiVersion: optional('AZURE_OPENAI_API_VERSION', AZURE_OPENAI_DEFAULT_API_VERSION),
    deploymentName,
  };
}

let cached: AppConfig | null = null;

/**
 * Считывает конфигурацию из process.env. Результат кешируется.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const provider = optional('LLM_PROVIDER', 'GOOGLE').toUpperCase() as LLMProviderName;
  if (!['OPENAI', 'GOOGLE', 'OPENROUTER', 'AZURE'].includes(provider)) {
    throw new Error(`Недопустимое значение LLM_PROVIDER: ${provider}. Ожидается OPENAI | GOOGLE | OPENROUTER | AZURE`);
  }

  // Медиа-провайдер по умолчанию совпадает с LLM-провайдером (issue #71).
  const mediaProvider = optional('MEDIA_PROVIDER', provider).toUpperCase() as LLMProviderName;
  if (!['OPENAI', 'GOOGLE', 'OPENROUTER', 'AZURE'].includes(mediaProvider)) {
    throw new Error(`Недопустимое значение MEDIA_PROVIDER: ${mediaProvider}. Ожидается OPENAI | GOOGLE | OPENROUTER | AZURE`);
  }
  const mediaEnabled = optional('MEDIA_ENABLED', 'true').toLowerCase() !== 'false';
  const mediaDefaults = MEDIA_DEFAULTS[mediaProvider];
  const embeddingProvider = resolveEmbeddingProvider();
  const embeddingAzure = resolveEmbeddingAzureConfig(embeddingProvider);
  const azure = resolveAzureConfig(provider);

  cached = {
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    llm: {
      provider,
      apiKey: resolveLlmApiKey(provider),
      modelName: resolveLlmModelName(provider),
      temperature: Number(optional('LLM_TEMPERATURE', '0.7')),
      maxRetries: Number(optional('LLM_MAX_RETRIES', '3')),
      providerKeys: resolveProviderKeys(),
      ...(azure ? { azure } : {}),
    },
    db: {
      host: optional('DB_HOST', 'localhost'),
      port: Number(optional('DB_PORT', '5432')),
      user: optional('DB_USER', 'postgres'),
      password: optional('DB_PASSWORD', 'postgres_password'),
      database: optional('DB_NAME', 'tg_rpg_db'),
    },
    neo4j: {
      uri: optional('NEO4J_URI', 'bolt://localhost:7687'),
      user: optional('NEO4J_USER', 'neo4j'),
      password: optional('NEO4J_PASSWORD', 'neo4j_password'),
      database: optional('NEO4J_DATABASE', 'neo4j'),
    },
    millicentsPerStar: Number(optional('MILLICENTS_PER_STAR', '2000')),
    embedding: {
      provider: embeddingProvider,
      apiKey: resolveEmbeddingApiKey(embeddingProvider),
      model: optional('EMBEDDING_MODEL', 'text-embedding-3-small'),
      ...(embeddingAzure ? { azure: embeddingAzure } : {}),
      topK: Number(optional('SUPPORT_EXPERTISE_TOP_K', '3')),
      gameTopK: Number(optional('GAME_EXPERTISE_TOP_K', '2')),
    },
    memory: {
      topK: Number(optional('GAME_MEMORY_TOP_K', '12')),
    },
    graphRag: {
      reindexOnStart: optional('GRAPH_RAG_REINDEX_ON_START', 'false').toLowerCase() === 'true',
    },
    support: {
      clientBotToken: optional('SUPPORT_BOT_TOKEN', ''),
      adminBotToken: optional('SUPPORT_ADMIN_BOT_TOKEN', ''),
      botUsername: optional('SUPPORT_BOT_USERNAME', ''),
      adminIds: parseAdminIds(optional('SUPPORT_ADMIN_IDS', '')),
      llmConsultation: optional('SUPPORT_LLM_CONSULTATION', 'true').toLowerCase() !== 'false',
    },
    media: {
      provider: mediaProvider,
      apiKey: resolveMediaApiKey(mediaProvider),
      tts: {
        enabled: mediaEnabled && optional('MEDIA_TTS_ENABLED', 'true').toLowerCase() !== 'false',
        model: optional('MEDIA_TTS_MODEL', mediaDefaults.ttsModel),
        voice: optional('MEDIA_TTS_VOICE', mediaDefaults.ttsVoice),
      },
      image: {
        enabled: mediaEnabled && optional('MEDIA_IMAGE_ENABLED', 'true').toLowerCase() !== 'false',
        model: optional('MEDIA_IMAGE_MODEL', mediaDefaults.imageModel),
        size: optional('MEDIA_IMAGE_SIZE', '1024x1024'),
      },
      stt: {
        enabled: mediaEnabled && optional('MEDIA_STT_ENABLED', 'true').toLowerCase() !== 'false',
        model: optional('MEDIA_STT_MODEL', mediaDefaults.sttModel),
      },
    },
  };

  return cached;
}

/**
 * Разбирает список Telegram-идентификаторов администраторов из строки,
 * разделённой запятыми. Нечисловые и пустые значения отбрасываются.
 */
export function parseAdminIds(raw: string): number[] {
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/**
 * Разбирает карту алиасов моделей Azure из строки `AZURE_MODELS` (issue #120).
 * Формат: пары `alias=model`, разделённые запятыми, например:
 *   `my-gpt4o=gpt-4o,my-mini=gpt-4o-mini`
 * Алиас — это имя deployment в Azure, model — каноническое имя из справочника
 * цен. Пустые и некорректные пары (без `=` или с пустыми частями) отбрасываются.
 */
export function parseAzureModels(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const alias = trimmed.slice(0, eq).trim();
    const model = trimmed.slice(eq + 1).trim();
    if (alias && model) result[alias] = model;
  }
  return result;
}

/** Сбрасывает кеш конфигурации (используется в тестах). */
export function resetConfigCache(): void {
  cached = null;
}
