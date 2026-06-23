/**
 * Юнит-тесты медиа-возможностей (issue #71):
 *  - клавиатура сцены sceneActionsKeyboard (какие кнопки показывать);
 *  - упаковка PCM → WAV (pcmToWav) и разбор частоты (parseSampleRate);
 *  - фабрика createMediaProvider (когда медиа включается, а когда — null).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sceneActionsKeyboard, TTS_PREFIX, DRAW_PREFIX } from '../src/bot/menus.js';
import { pcmToWav, parseSampleRate, GEMINI_TTS_PCM } from '@tg-games/core/media/wav.js';
import { createMediaProvider } from '@tg-games/core/media/factory.js';
import { OpenAIMediaProvider } from '@tg-games/core/media/providers/OpenAIMediaProvider.js';
import { GoogleMediaProvider } from '@tg-games/core/media/providers/GoogleMediaProvider.js';
import type { AppConfig } from '@tg-games/core/config.js';

/** Достаёт inline_keyboard из результата Markup-хелпера (или []). */
function inlineKeyboard(markup?: { reply_markup?: { inline_keyboard?: unknown[][] } }) {
  return markup?.reply_markup?.inline_keyboard ?? [];
}

describe('sceneActionsKeyboard (#71)', () => {
  it('обе кнопки, когда доступны и озвучка, и иллюстрация', () => {
    const kb = inlineKeyboard(sceneActionsKeyboard('step-1', { canSpeak: true, canDraw: true }));
    expect(kb).toHaveLength(2); // каждая кнопка в своём ряду
    expect(kb[0][0]).toMatchObject({ callback_data: `${TTS_PREFIX}step-1` });
    expect(String((kb[0][0] as { text: string }).text)).toContain('Озвучить');
    expect(kb[1][0]).toMatchObject({ callback_data: `${DRAW_PREFIX}step-1` });
    expect(String((kb[1][0] as { text: string }).text)).toContain('иллюстрацию');
  });

  it('только «Озвучить», когда доступна лишь озвучка', () => {
    const kb = inlineKeyboard(sceneActionsKeyboard('s', { canSpeak: true, canDraw: false }));
    expect(kb).toHaveLength(1);
    expect(kb[0][0]).toMatchObject({ callback_data: `${TTS_PREFIX}s` });
  });

  it('только «Нарисовать иллюстрацию», когда доступна лишь иллюстрация', () => {
    const kb = inlineKeyboard(sceneActionsKeyboard('s', { canSpeak: false, canDraw: true }));
    expect(kb).toHaveLength(1);
    expect(kb[0][0]).toMatchObject({ callback_data: `${DRAW_PREFIX}s` });
  });

  it('undefined, когда обе возможности выключены (кнопок нет)', () => {
    expect(sceneActionsKeyboard('s', { canSpeak: false, canDraw: false })).toBeUndefined();
  });
});

describe('pcmToWav / parseSampleRate (#71)', () => {
  it('оборачивает PCM в корректный 44-байтный WAV-заголовок', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = pcmToWav(pcm, GEMINI_TTS_PCM);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');

    // размер файла минус первые 8 байт
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    // размер fmt-подчанка = 16 (PCM) и аудиоформат = 1 (PCM)
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    // каналы / частота / биты
    expect(wav.readUInt16LE(22)).toBe(GEMINI_TTS_PCM.channels);
    expect(wav.readUInt32LE(24)).toBe(GEMINI_TTS_PCM.sampleRate);
    expect(wav.readUInt16LE(34)).toBe(GEMINI_TTS_PCM.bitsPerSample);
    // byteRate = sampleRate * channels * bitsPerSample / 8
    const byteRate = (GEMINI_TTS_PCM.sampleRate * GEMINI_TTS_PCM.channels * GEMINI_TTS_PCM.bitsPerSample) / 8;
    expect(wav.readUInt32LE(28)).toBe(byteRate);
    // размер данных
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    // сами сэмплы идут сразу после заголовка без изменений
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('берёт частоту из mime-типа audio/L16;rate=16000', () => {
    expect(parseSampleRate('audio/L16;rate=16000')).toBe(16000);
  });

  it('возвращает значение по умолчанию без параметра rate', () => {
    expect(parseSampleRate('audio/L16')).toBe(GEMINI_TTS_PCM.sampleRate);
    expect(parseSampleRate(undefined)).toBe(GEMINI_TTS_PCM.sampleRate);
  });
});

/** Собирает AppConfig с заданной секцией media (остальное — заглушки). */
function mediaConfig(media: Partial<AppConfig['media']> = {}): AppConfig {
  return {
    telegramBotToken: 't',
    llm: { provider: 'GOOGLE', apiKey: 'k', modelName: 'm', temperature: 0.5, maxRetries: 3 },
    db: { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' },
    millicentsPerStar: 2000,
    support: {
      clientBotToken: '',
      adminBotToken: '',
      botUsername: '',
      adminIds: [],
      llmConsultation: true,
    },
    media: {
      provider: 'GOOGLE',
      apiKey: 'mkey',
      tts: { enabled: true, model: 'tts-model', voice: 'voice' },
      image: { enabled: true, model: 'img-model', size: '1024x1024' },
      stt: { enabled: true, model: 'stt-model' },
      ...media,
    },
  } as AppConfig;
}

describe('createMediaProvider (#71)', () => {
  beforeEach(() => {
    // Фабрика логирует причину отключения — гасим, чтобы не засорять вывод.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('OPENAI → OpenAIMediaProvider c возможностями из конфига', () => {
    const p = createMediaProvider(mediaConfig({ provider: 'OPENAI' }));
    expect(p).toBeInstanceOf(OpenAIMediaProvider);
    expect(p?.canSpeak).toBe(true);
    expect(p?.canDraw).toBe(true);
  });

  it('GOOGLE → GoogleMediaProvider', () => {
    const p = createMediaProvider(mediaConfig({ provider: 'GOOGLE' }));
    expect(p).toBeInstanceOf(GoogleMediaProvider);
    expect(p?.name).toBe('Google');
  });

  it('OPENROUTER → null (медиа не поддерживается)', () => {
    expect(createMediaProvider(mediaConfig({ provider: 'OPENROUTER' }))).toBeNull();
  });

  it('пустой ключ → null (медиа отключено)', () => {
    expect(createMediaProvider(mediaConfig({ apiKey: '' }))).toBeNull();
  });

  it('все возможности выключены → null', () => {
    const p = createMediaProvider(
      mediaConfig({
        tts: { enabled: false, model: 'm', voice: 'v' },
        image: { enabled: false, model: 'm', size: '1024x1024' },
        stt: { enabled: false, model: 'm' },
      }),
    );
    expect(p).toBeNull();
  });

  it('только STT включён → провайдер создаётся (#118)', () => {
    const p = createMediaProvider(
      mediaConfig({
        provider: 'OPENAI',
        tts: { enabled: false, model: 'm', voice: 'v' },
        image: { enabled: false, model: 'm', size: '1024x1024' },
        stt: { enabled: true, model: 'whisper-1' },
      }),
    );
    expect(p).toBeInstanceOf(OpenAIMediaProvider);
    expect(p?.canSpeak).toBe(false);
    expect(p?.canDraw).toBe(false);
    expect(p?.canTranscribe).toBe(true);
  });

  it('отражает частичные возможности (только озвучка)', () => {
    const p = createMediaProvider(
      mediaConfig({
        provider: 'OPENAI',
        image: { enabled: false, model: 'm', size: '1024x1024' },
      }),
    );
    expect(p?.canSpeak).toBe(true);
    expect(p?.canDraw).toBe(false);
  });
});

describe('OpenAIMediaProvider TTS usage (#84)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('читает аудио и usage из SSE-ответа gpt-4o-mini-tts', async () => {
    const encodedAudio = Buffer.from('voice-bytes').toString('base64');
    const body = [
      'event: speech.audio.delta',
      `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: encodedAudio })}`,
      '',
      'event: speech.audio.done',
      `data: ${JSON.stringify({
        type: 'speech.audio.done',
        usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 },
      })}`,
      '',
    ].join('\n');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const provider = new OpenAIMediaProvider({
      apiKey: 'test-key',
      tts: { enabled: true, model: 'gpt-4o-mini-tts', voice: 'alloy' },
      image: { enabled: false, model: 'gpt-image-1', size: '1024x1024' },
      stt: { enabled: false, model: 'whisper-1' },
    });

    const result = await provider.generateSpeech({ text: 'сцена' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result.audio).toEqual(Buffer.from('voice-bytes'));
    expect(result.meta?.usage).toEqual({ promptTokens: 12, completionTokens: 20, totalTokens: 32 });
  });
});
