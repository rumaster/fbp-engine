/**
 * Абстракция провайдера медиа (озвучка и иллюстрации сцены), issue #71.
 *
 * Бот общается только с этим интерфейсом и ничего не знает об особенностях
 * SDK конкретного вендора (паттерн «Стратегия», как и {@link ILLMProvider}).
 * Озвучка и генерация изображений вынесены в ОТДЕЛЬНУЮ абстракцию (а не в
 * `ILLMProvider`), потому что у них своя модель, свои настройки и своя
 * (необязательная) доступность: текстовая игра работает и без медиа.
 */

import type { LLMUsage } from '../llm/ILLMProvider.js';

/**
 * Техническая метаинформация одного обращения к медиа-провайдеру — для отчёта
 * тестировщику (issue #75): что отправили, что получили и сколько токенов ушло.
 */
export interface MediaCallMeta {
  /** Человекочитаемое описание переданного запроса (модель, параметры, вход). */
  request: string;
  /** Человекочитаемое описание полученного ответа (формат, размер и т. п.). */
  response: string;
  /** Расход токенов, если провайдер его сообщает (TTS/картинки не всегда). */
  usage?: LLMUsage;
}

/** Запрос на озвучку текста сцены. */
export interface SpeechRequest {
  /** Текст для озвучки (нарратив текущей сцены). */
  text: string;
  /** Модель TTS для конкретного пользователя; по умолчанию модель провайдера. */
  model?: string;
  /** Голос TTS для конкретного пользователя; по умолчанию голос провайдера. */
  voice?: string;
}

/** Результат озвучки — готовый к отправке в Telegram аудиобуфер. */
export interface SpeechResult {
  /** Бинарные данные аудио. */
  audio: Buffer;
  /** Расширение файла (`ogg`, `mp3`, `wav`) — нужно Telegram для имени. */
  extension: string;
  /**
   * Отправлять как голосовое сообщение (`replyWithVoice`, true) или как
   * аудиофайл (`replyWithAudio`, false). Голосовыми Telegram считает только
   * Ogg/Opus; прочие форматы (например, WAV от Gemini) шлём как аудио.
   */
  voiceNote: boolean;
  /** Технические детали обращения для отчёта тестировщику (issue #75). */
  meta?: MediaCallMeta;
}

/** Запрос на иллюстрацию сцены. */
export interface ImageRequest {
  /** Текстовое описание сцены, по которому рисуется изображение. */
  prompt: string;
  /** Модель генерации изображения для конкретного пользователя. */
  model?: string;
  /** Размер/соотношение изображения для конкретного пользователя. */
  size?: string;
}

/** Результат генерации изображения — готовый к отправке буфер. */
export interface ImageResult {
  /** Бинарные данные изображения. */
  image: Buffer;
  /** Расширение файла (обычно `png`). */
  extension: string;
  /** Технические детали обращения для отчёта тестировщику (issue #75). */
  meta?: MediaCallMeta;
}

/** Запрос на распознавание речи из голосового сообщения игрока (issue #118). */
export interface TranscriptionRequest {
  /** Бинарные данные аудио ровно в том виде, как пришли из Telegram. */
  audio: Buffer;
  /** MIME-тип исходного аудио (например, `audio/ogg`); помогает некоторым SDK. */
  mimeType?: string;
  /** Имя файла с расширением (`voice.ogg`) — нужно SDK, требующим File-объект. */
  filename?: string;
  /** Модель STT для конкретного запроса; по умолчанию модель провайдера. */
  model?: string;
}

/** Результат распознавания речи — текст игрового действия. */
export interface TranscriptionResult {
  /** Распознанный текст (пустая строка, если речь не распознана). */
  text: string;
  /** Технические детали обращения для отчёта тестировщику (issue #75). */
  meta?: MediaCallMeta;
}

/**
 * Общий интерфейс провайдера медиа.
 *
 * Флаги {@link canSpeak}/{@link canDraw}/{@link canTranscribe} сообщают, какие
 * возможности реально включены: бот по ним решает, показывать ли кнопки
 * «Озвучить»/«Нарисовать иллюстрацию» и распознавать ли голосовые сообщения.
 * Вызов выключенной возможности бросает {@link MediaUnsupportedError}.
 */
export interface IMediaProvider {
  /** Человекочитаемое имя провайдера (для логов). */
  readonly name: string;
  /** Доступна ли озвучка (TTS). */
  readonly canSpeak: boolean;
  /** Доступна ли генерация изображений. */
  readonly canDraw: boolean;
  /** Доступно ли распознавание речи (STT, issue #118). */
  readonly canTranscribe: boolean;
  /** Озвучивает текст сцены. */
  generateSpeech(request: SpeechRequest): Promise<SpeechResult>;
  /** Рисует иллюстрацию сцены по текстовому описанию. */
  generateImage(request: ImageRequest): Promise<ImageResult>;
  /** Распознаёт речь из голосового сообщения игрока (issue #118). */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Бросается, когда у провайдера запрошена выключенная/неподдерживаемая возможность. */
export class MediaUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUnsupportedError';
  }
}

/**
 * Ошибка генерации медиа, несущая описание уже сформированного запроса
 * (а иногда и частичный usage) — чтобы отчёт тестировщику (issue #75) показал,
 * ЧТО именно отправлялось провайдеру, даже когда сам вызов API упал.
 */
export class MediaGenerationError extends Error {
  constructor(
    message: string,
    /** Описание переданного запроса (как в {@link MediaCallMeta.request}). */
    public readonly request: string,
    /** Частичный расход токенов, если провайдер успел его вернуть. */
    public readonly usage?: LLMUsage,
  ) {
    super(message);
    this.name = 'MediaGenerationError';
  }
}
