import type { AppConfig } from '../config.js';
import type { IMediaProvider } from './IMediaProvider.js';
import { OpenAIMediaProvider } from './providers/OpenAIMediaProvider.js';
import { GoogleMediaProvider } from './providers/GoogleMediaProvider.js';

/**
 * Фабрика провайдеров медиа (озвучка и иллюстрации), issue #71.
 *
 * Медиа — необязательная возможность: фабрика возвращает `null`, если ключ
 * не задан, все возможности выключены или провайдер не умеет в медиа
 * (OpenRouter/Azure). В этом случае бот просто не показывает кнопки «Озвучить» и
 * «Нарисовать иллюстрацию» и не распознаёт голос, а текстовая игра работает как
 * прежде.
 */
export function createMediaProvider(config: AppConfig): IMediaProvider | null {
  const { provider, apiKey, tts, image, stt } = config.media;

  if (!apiKey) {
    console.warn('🎬 Медиа отключено: не задан ключ API (MEDIA_API_KEY или ключ провайдера).');
    return null;
  }
  if (!tts.enabled && !image.enabled && !stt.enabled) {
    console.warn('🎬 Медиа отключено: озвучка, иллюстрации и распознавание речи выключены.');
    return null;
  }

  switch (provider) {
    case 'OPENAI':
      return new OpenAIMediaProvider({ apiKey, name: 'OpenAI', tts, image, stt });
    case 'GOOGLE':
      return new GoogleMediaProvider({ apiKey, tts, image, stt });
    case 'OPENROUTER':
      console.warn('🎬 Медиа отключено: OpenRouter не поддерживает озвучку и генерацию изображений. Задайте MEDIA_PROVIDER=OPENAI или GOOGLE.');
      return null;
    case 'AZURE':
      console.warn('🎬 Медиа отключено: Azure OpenAI не подключён как медиа-провайдер. Задайте MEDIA_PROVIDER=OPENAI или GOOGLE.');
      return null;
    default:
      console.warn(`🎬 Медиа отключено: неизвестный MEDIA_PROVIDER «${String(provider)}».`);
      return null;
  }
}
