import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@tg-games/core/config.js';
import {
  mediaOptionsForProvider,
  resolveEffectiveMediaConfig,
  type UserMediaConfigValues,
} from '@tg-games/core/media/userConfig.js';

const baseMedia: AppConfig['media'] = {
  provider: 'OPENAI',
  apiKey: 'key',
  tts: { enabled: true, model: 'gpt-4o-mini-tts', voice: 'alloy' },
  image: { enabled: true, model: 'gpt-image-1', size: '1024x1024' },
};

describe('media/userConfig: каталог и эффективные настройки (#81)', () => {
  it('описывает доступные модели и параметры для текущего провайдера', () => {
    const options = mediaOptionsForProvider('OPENAI');
    const openAiTtsModels = options?.tts.models.map((m) => m.id);
    const openAiImageModels = options?.image.models.map((m) => m.id);
    const gpt4oVoices = options?.tts.models.find((m) => m.id === 'gpt-4o-mini-tts')?.voices;
    const legacyVoices = options?.tts.models.find((m) => m.id === 'tts-1')?.voices;

    expect(openAiTtsModels).toContain('gpt-4o-mini-tts');
    expect(gpt4oVoices).toContainEqual(expect.objectContaining({ id: 'alloy' }));
    expect(gpt4oVoices).toContainEqual(expect.objectContaining({ id: 'marin' }));
    expect(legacyVoices).toContainEqual(expect.objectContaining({ id: 'nova' }));
    expect(legacyVoices).not.toContainEqual(expect.objectContaining({ id: 'marin' }));
    expect(legacyVoices).not.toContainEqual(expect.objectContaining({ id: 'ballad' }));

    expect(openAiImageModels).toContain('gpt-image-1.5');
    expect(openAiImageModels).toContain('gpt-image-1');
    expect(options?.image.models.find((m) => m.id === 'gpt-image-1')?.sizes).toContainEqual(
      expect.objectContaining({ id: '1024x1024' }),
    );
    expect(options?.image.models.find((m) => m.id === 'gpt-image-1')?.sizes).toContainEqual(
      expect.objectContaining({ id: 'auto' }),
    );
  });

  it('описывает модели и параметры Google media provider', () => {
    const options = mediaOptionsForProvider('GOOGLE');
    const googleTtsModels = options?.tts.models.map((m) => m.id);
    const googleImageModels = options?.image.models.map((m) => m.id);
    const gemini25Voices = options?.tts.models.find(
      (m) => m.id === 'gemini-2.5-flash-preview-tts',
    )?.voices;
    const imagen4Sizes = options?.image.models.find(
      (m) => m.id === 'imagen-4.0-generate-001',
    )?.sizes;

    expect(googleTtsModels).toContain('gemini-3.1-flash-tts-preview');
    expect(gemini25Voices).toContainEqual(expect.objectContaining({ id: 'Sulafat' }));
    expect(googleImageModels).toContain('imagen-4.0-generate-001');
    expect(googleImageModels).toContain('imagen-3.0-generate-002');
    expect(imagen4Sizes).toContainEqual(expect.objectContaining({ id: '16:9' }));
  });

  it('без пользовательского конфига использует значения проекта из env-конфига', () => {
    expect(resolveEffectiveMediaConfig(baseMedia, null)).toEqual({
      tts: { model: 'gpt-4o-mini-tts', voice: 'alloy' },
      image: { model: 'gpt-image-1', size: '1024x1024' },
    });
  });

  it('пользовательский конфиг переопределяет модель и параметр медиа', () => {
    const userConfig: UserMediaConfigValues = {
      ttsModel: 'tts-1-hd',
      ttsVoice: 'nova',
      imageModel: 'dall-e-3',
      imageSize: '1792x1024',
    };

    expect(resolveEffectiveMediaConfig(baseMedia, userConfig)).toEqual({
      tts: { model: 'tts-1-hd', voice: 'nova' },
      image: { model: 'dall-e-3', size: '1792x1024' },
    });
  });

  it('игнорирует пользовательские значения, недоступные у текущего провайдера', () => {
    const userConfig: UserMediaConfigValues = {
      ttsModel: 'gemini-2.5-flash-preview-tts',
      ttsVoice: 'Kore',
      imageModel: 'imagen-3.0-generate-002',
      imageSize: '2048x2048',
    };

    expect(resolveEffectiveMediaConfig(baseMedia, userConfig)).toEqual({
      tts: { model: 'gpt-4o-mini-tts', voice: 'alloy' },
      image: { model: 'gpt-image-1', size: '1024x1024' },
    });
  });
});
