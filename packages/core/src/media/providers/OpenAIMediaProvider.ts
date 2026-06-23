import OpenAI, { toFile } from 'openai';
import type {
  IMediaProvider,
  ImageRequest,
  ImageResult,
  SpeechRequest,
  SpeechResult,
  TranscriptionRequest,
  TranscriptionResult,
} from '../IMediaProvider.js';
import { MediaGenerationError, MediaUnsupportedError } from '../IMediaProvider.js';
import { clipForReport, mediaErrorMessage, normalizeUsage } from '../trace.js';
import type { LLMUsage } from '../../llm/ILLMProvider.js';

/** Размеры, поддерживаемые image-моделями OpenAI. */
type OpenAIImageSize =
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | 'auto'
  | '256x256'
  | '512x512'
  | '1792x1024'
  | '1024x1792';

/** Лимит длины текста для OpenAI TTS — 4096 символов. */
const TTS_INPUT_LIMIT = 4096;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIMediaProviderConfig {
  apiKey: string;
  /** Базовый URL API (на случай совместимого прокси). */
  baseURL?: string;
  /** Имя провайдера для логов. */
  name?: string;
  tts: { enabled: boolean; model: string; voice: string };
  image: { enabled: boolean; model: string; size: string };
  stt: { enabled: boolean; model: string };
}

/**
 * Медиа-провайдер OpenAI: озвучка через `audio.speech` (Ogg/Opus —
 * голосовое сообщение) и иллюстрации через `images.generate`.
 */
export class OpenAIMediaProvider implements IMediaProvider {
  public readonly name: string;
  public readonly canSpeak: boolean;
  public readonly canDraw: boolean;
  public readonly canTranscribe: boolean;
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly ttsModel: string;
  private readonly ttsVoice: string;
  private readonly imageModel: string;
  private readonly imageSize: OpenAIImageSize;
  private readonly sttModel: string;

  constructor(config: OpenAIMediaProviderConfig) {
    this.name = config.name ?? 'OpenAI';
    this.canSpeak = config.tts.enabled;
    this.canDraw = config.image.enabled;
    this.canTranscribe = config.stt.enabled;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? OPENAI_BASE_URL;
    this.ttsModel = config.tts.model;
    this.ttsVoice = config.tts.voice;
    this.imageModel = config.image.model;
    this.imageSize = config.image.size as OpenAIImageSize;
    this.sttModel = config.stt.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async generateSpeech({ text, model, voice }: SpeechRequest): Promise<SpeechResult> {
    if (!this.canSpeak) throw new MediaUnsupportedError(`${this.name}: озвучка отключена`);
    const ttsModel = model ?? this.ttsModel;
    const ttsVoice = voice ?? this.ttsVoice;
    const input = text.slice(0, TTS_INPUT_LIMIT);
    const request = [
      `Провайдер: ${this.name} (озвучка)`,
      `Модель: ${ttsModel}`,
      `Голос: ${ttsVoice}`,
      `Формат: opus`,
      `Текст (${input.length} симв.): ${clipForReport(input)}`,
    ].join('\n');
    try {
      if (supportsSpeechSse(ttsModel)) {
        const { audio, usage } = await this.generateSpeechSse(ttsModel, ttsVoice, input);
        return {
          audio,
          extension: 'ogg',
          voiceNote: true,
          meta: { request, response: `Аудио ogg, ${audio.length} байт.`, usage },
        };
      }
      const response = await this.client.audio.speech.create({
        model: ttsModel,
        voice: ttsVoice,
        input,
        // Формат opus упаковывается в Ogg/Opus — его Telegram принимает как голосовое.
        response_format: 'opus',
      });
      const audio = Buffer.from(await response.arrayBuffer());
      return {
        audio,
        extension: 'ogg',
        voiceNote: true,
        meta: { request, response: `Аудио ogg, ${audio.length} байт.` },
      };
    } catch (err) {
      throw new MediaGenerationError(mediaErrorMessage(err), request);
    }
  }

  private async generateSpeechSse(
    model: string,
    voice: string,
    input: string,
  ): Promise<{ audio: Buffer; usage?: LLMUsage }> {
    const response = await fetch(openAiEndpoint(this.baseURL, '/audio/speech'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input,
        response_format: 'opus',
        stream_format: 'sse',
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(openAiErrorMessage(response, body));
    }
    return parseSpeechSse(body, this.name);
  }

  async generateImage({ prompt, model, size }: ImageRequest): Promise<ImageResult> {
    if (!this.canDraw) throw new MediaUnsupportedError(`${this.name}: генерация изображений отключена`);
    const imageModel = model ?? this.imageModel;
    const imageSize = (size ?? this.imageSize) as OpenAIImageSize;
    const request = [
      `Провайдер: ${this.name} (иллюстрация)`,
      `Модель: ${imageModel}`,
      `Размер: ${imageSize}`,
      `Промпт (${prompt.length} симв.): ${clipForReport(prompt)}`,
    ].join('\n');
    try {
      const response = await this.client.images.generate({
        model: imageModel,
        prompt,
        size: imageSize,
        n: 1,
      });
      // gpt-image-1 возвращает usage с токенами; dall-e — нет.
      const usage = normalizeUsage(response.usage);
      const first = response.data?.[0];
      // gpt-image-1 всегда отдаёт base64; dall-e-2/3 по умолчанию — URL.
      if (first?.b64_json) {
        const image = Buffer.from(first.b64_json, 'base64');
        return {
          image,
          extension: 'png',
          meta: { request, response: `Изображение png, ${image.length} байт (base64).`, usage },
        };
      }
      if (first?.url) {
        const res = await fetch(first.url);
        const image = Buffer.from(await res.arrayBuffer());
        return {
          image,
          extension: 'png',
          meta: { request, response: `Изображение png, ${image.length} байт (по URL).`, usage },
        };
      }
      throw new Error(`${this.name}: пустой ответ генерации изображения`);
    } catch (err) {
      throw new MediaGenerationError(mediaErrorMessage(err), request);
    }
  }

  async transcribe({
    audio,
    mimeType,
    filename,
    model,
  }: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.canTranscribe) {
      throw new MediaUnsupportedError(`${this.name}: распознавание речи отключено`);
    }
    const sttModel = model ?? this.sttModel;
    const name = filename ?? 'voice.ogg';
    const request = [
      `Провайдер: ${this.name} (распознавание речи)`,
      `Модель: ${sttModel}`,
      `Аудио: ${name}, ${audio.length} байт${mimeType ? ` (${mimeType})` : ''}`,
    ].join('\n');
    try {
      const file = await toFile(audio, name, mimeType ? { type: mimeType } : undefined);
      const response = await this.client.audio.transcriptions.create({
        file,
        model: sttModel,
      });
      const text = (response.text ?? '').trim();
      // Токены сообщают только модели gpt-4o-transcribe; whisper-1 — нет.
      const usage = normalizeUsage((response as { usage?: unknown }).usage);
      return {
        text,
        meta: {
          request,
          response: `Текст (${text.length} симв.): ${clipForReport(text)}`,
          usage,
        },
      };
    } catch (err) {
      throw new MediaGenerationError(mediaErrorMessage(err), request);
    }
  }
}

function supportsSpeechSse(model: string): boolean {
  return model === 'gpt-4o-mini-tts' || model.startsWith('gpt-4o-mini-tts-');
}

function openAiEndpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`;
}

function openAiErrorMessage(response: Response, body: string): string {
  const fallback = `${response.status} ${response.statusText}`.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ? `${fallback}: ${parsed.error.message}` : fallback;
  } catch {
    const text = body.trim();
    return text ? `${fallback}: ${text}` : fallback;
  }
}

function parseSpeechSse(body: string, providerName: string): { audio: Buffer; usage?: LLMUsage } {
  const chunks: Buffer[] = [];
  let usage: LLMUsage | undefined;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const audio = stringValue(record.audio) ?? stringValue(record.delta);
    if (audio) chunks.push(Buffer.from(audio, 'base64'));
    const eventUsage = normalizeUsage(record.usage);
    if (eventUsage) usage = eventUsage;
  }
  if (chunks.length === 0) {
    throw new Error(`${providerName}: пустой SSE-ответ озвучки`);
  }
  return { audio: Buffer.concat(chunks), usage };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
