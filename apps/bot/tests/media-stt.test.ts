/**
 * Юнит-тесты распознавания речи (STT, issue #118):
 *  - OpenAIMediaProvider.transcribe (whisper-1 через audio.transcriptions);
 *  - GoogleMediaProvider.transcribe (Gemini через generateContent + inlineData);
 *  - флаг canTranscribe и ошибка при выключенном STT.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpenAIMediaProvider } from '@tg-games/core/media/providers/OpenAIMediaProvider.js';
import { GoogleMediaProvider } from '@tg-games/core/media/providers/GoogleMediaProvider.js';
import { MediaUnsupportedError, MediaGenerationError } from '@tg-games/core/media/IMediaProvider.js';

/** Конфиг OpenAI-провайдера с включённым только STT. */
function openAiSttProvider(over: Partial<{ enabled: boolean; model: string }> = {}) {
  return new OpenAIMediaProvider({
    apiKey: 'k',
    tts: { enabled: false, model: 'gpt-4o-mini-tts', voice: 'alloy' },
    image: { enabled: false, model: 'gpt-image-1', size: '1024x1024' },
    stt: { enabled: true, model: 'whisper-1', ...over },
  });
}

/** Конфиг Google-провайдера с включённым только STT. */
function googleSttProvider(over: Partial<{ enabled: boolean; model: string }> = {}) {
  return new GoogleMediaProvider({
    apiKey: 'k',
    tts: { enabled: false, model: 'tts', voice: 'Kore' },
    image: { enabled: false, model: 'img', size: '1024x1024' },
    stt: { enabled: true, model: 'gemini-2.5-flash', ...over },
  });
}

describe('OpenAIMediaProvider.transcribe (#118)', () => {
  it('распознаёт речь и обрезает пробелы по краям', async () => {
    const provider = openAiSttProvider();
    const create = vi.fn(async () => ({ text: '  иди налево  ' }));
    (provider as unknown as { client: unknown }).client = {
      audio: { transcriptions: { create } },
    };

    const result = await provider.transcribe({
      audio: Buffer.from('voice-bytes'),
      mimeType: 'audio/ogg',
      filename: 'voice.ogg',
    });

    expect(result.text).toBe('иди налево');
    // Модель и файл переданы провайдеру.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'whisper-1', file: expect.anything() }),
    );
    expect(result.meta?.request).toContain('whisper-1');
  });

  it('бросает MediaUnsupportedError, когда STT выключен', async () => {
    const provider = openAiSttProvider({ enabled: false });
    await expect(provider.transcribe({ audio: Buffer.from('x') })).rejects.toBeInstanceOf(
      MediaUnsupportedError,
    );
    expect(provider.canTranscribe).toBe(false);
  });

  it('оборачивает ошибку API в MediaGenerationError', async () => {
    const provider = openAiSttProvider();
    (provider as unknown as { client: unknown }).client = {
      audio: {
        transcriptions: {
          create: vi.fn(async () => {
            throw new Error('API упал');
          }),
        },
      },
    };
    await expect(
      provider.transcribe({ audio: Buffer.from('x'), mimeType: 'audio/ogg' }),
    ).rejects.toBeInstanceOf(MediaGenerationError);
  });
});

describe('GoogleMediaProvider.transcribe (#118)', () => {
  it('распознаёт речь через generateContent c inlineData', async () => {
    const provider = googleSttProvider();
    const generateContent = vi.fn(async () => ({ text: 'осмотреться' }));
    (provider as unknown as { client: unknown }).client = {
      models: { generateContent },
    };

    const audio = Buffer.from('voice-bytes');
    const result = await provider.transcribe({ audio, mimeType: 'audio/ogg' });

    expect(result.text).toBe('осмотреться');
    const call = generateContent.mock.calls[0][0] as {
      model: string;
      contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
    };
    expect(call.model).toBe('gemini-2.5-flash');
    const inline = call.contents[0].parts.find((p) => p.inlineData)?.inlineData;
    expect(inline?.mimeType).toBe('audio/ogg');
    expect(inline?.data).toBe(audio.toString('base64'));
  });

  it('бросает MediaUnsupportedError, когда STT выключен', async () => {
    const provider = googleSttProvider({ enabled: false });
    await expect(provider.transcribe({ audio: Buffer.from('x') })).rejects.toBeInstanceOf(
      MediaUnsupportedError,
    );
  });
});
