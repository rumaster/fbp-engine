import { GoogleGenAI } from '@google/genai';
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
import { GEMINI_TTS_PCM, parseSampleRate, pcmToWav } from '../wav.js';

/** Инструкция модели Gemini для чистого распознавания речи (issue #118). */
const STT_INSTRUCTION =
  'Расшифруй речь из этого аудио. Верни только распознанный текст без комментариев, ' +
  'пояснений и кавычек. Если речи нет — верни пустую строку.';

export interface GoogleMediaProviderConfig {
  apiKey: string;
  tts: { enabled: boolean; model: string; voice: string };
  image: { enabled: boolean; model: string; size: string };
  stt: { enabled: boolean; model: string };
}

/**
 * Медиа-провайдер Google: озвучка через Gemini TTS (`generateContent` с
 * модальностью AUDIO — возвращает сырой PCM, оборачиваем в WAV) и иллюстрации
 * через Imagen (`generateImages`).
 */
export class GoogleMediaProvider implements IMediaProvider {
  public readonly name = 'Google';
  public readonly canSpeak: boolean;
  public readonly canDraw: boolean;
  public readonly canTranscribe: boolean;
  private readonly client: GoogleGenAI;
  private readonly ttsModel: string;
  private readonly ttsVoice: string;
  private readonly imageModel: string;
  private readonly imageSize: string;
  private readonly sttModel: string;

  constructor(config: GoogleMediaProviderConfig) {
    this.canSpeak = config.tts.enabled;
    this.canDraw = config.image.enabled;
    this.canTranscribe = config.stt.enabled;
    this.ttsModel = config.tts.model;
    this.ttsVoice = config.tts.voice;
    this.imageModel = config.image.model;
    this.imageSize = config.image.size;
    this.sttModel = config.stt.model;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generateSpeech({ text, model, voice }: SpeechRequest): Promise<SpeechResult> {
    if (!this.canSpeak) throw new MediaUnsupportedError('Google: озвучка отключена');
    const ttsModel = model ?? this.ttsModel;
    const ttsVoice = voice ?? this.ttsVoice;
    const request = [
      `Провайдер: ${this.name} (озвучка)`,
      `Модель: ${ttsModel}`,
      `Голос: ${ttsVoice}`,
      `Текст (${text.length} симв.): ${clipForReport(text)}`,
    ].join('\n');
    try {
      const response = await this.client.models.generateContent({
        model: ttsModel,
        contents: text,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: ttsVoice } },
          },
        },
      });
      const usage = normalizeUsage(response.usageMetadata);
      const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const data = part?.inlineData?.data;
      if (!data) throw new Error('Google: пустой ответ озвучки');
      // Gemini TTS отдаёт сырой PCM (L16 24кГц моно). Оборачиваем в WAV.
      const pcm = Buffer.from(data, 'base64');
      const sampleRate = parseSampleRate(part?.inlineData?.mimeType);
      const wav = pcmToWav(pcm, { ...GEMINI_TTS_PCM, sampleRate });
      return {
        audio: wav,
        extension: 'wav',
        voiceNote: false,
        meta: { request, response: `Аудио wav, ${wav.length} байт (${sampleRate} Гц).`, usage },
      };
    } catch (err) {
      throw new MediaGenerationError(mediaErrorMessage(err), request);
    }
  }

  async generateImage({ prompt, model, size }: ImageRequest): Promise<ImageResult> {
    if (!this.canDraw) throw new MediaUnsupportedError('Google: генерация изображений отключена');
    const imageModel = model ?? this.imageModel;
    const imageSize = size ?? this.imageSize;
    const aspectRatio = googleAspectRatio(imageSize);
    const request = [
      `Провайдер: ${this.name} (иллюстрация)`,
      `Модель: ${imageModel}`,
      `Размер: ${imageSize}`,
      `Промпт (${prompt.length} симв.): ${clipForReport(prompt)}`,
    ].join('\n');
    try {
      const response = await this.client.models.generateImages({
        model: imageModel,
        prompt,
        config: { numberOfImages: 1, ...(aspectRatio ? { aspectRatio } : {}) },
      });
      const data = response.generatedImages?.[0]?.image?.imageBytes;
      if (!data) throw new Error('Google: пустой ответ генерации изображения');
      const image = Buffer.from(data, 'base64');
      return {
        image,
        extension: 'png',
        meta: { request, response: `Изображение png, ${image.length} байт.` },
      };
    } catch (err) {
      throw new MediaGenerationError(mediaErrorMessage(err), request);
    }
  }

  async transcribe({ audio, mimeType, model }: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.canTranscribe) throw new MediaUnsupportedError('Google: распознавание речи отключено');
    const sttModel = model ?? this.sttModel;
    const audioMime = mimeType ?? 'audio/ogg';
    const request = [
      `Провайдер: ${this.name} (распознавание речи)`,
      `Модель: ${sttModel}`,
      `Аудио: ${audio.length} байт (${audioMime})`,
    ].join('\n');
    try {
      // Gemini принимает аудио как inlineData; просим вернуть только текст речи.
      const response = await this.client.models.generateContent({
        model: sttModel,
        contents: [
          {
            role: 'user',
            parts: [
              { text: STT_INSTRUCTION },
              { inlineData: { mimeType: audioMime, data: audio.toString('base64') } },
            ],
          },
        ],
      });
      const usage = normalizeUsage(response.usageMetadata);
      const text = (response.text ?? '').trim();
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

function googleAspectRatio(size: string): string | undefined {
  if (['1:1', '3:4', '4:3', '9:16', '16:9'].includes(size)) {
    return size;
  }
  if (size === '1024x1024') return '1:1';
  return undefined;
}
