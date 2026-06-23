/**
 * Минимальный упаковщик сырого PCM в WAV-контейнер.
 *
 * Gemini TTS (`generateContent` с `responseModalities: ['AUDIO']`) возвращает
 * сырые PCM-сэмплы (по умолчанию signed 16-bit little-endian, 24 кГц, моно)
 * без какого-либо заголовка. Telegram такой поток не распознаёт, поэтому
 * оборачиваем его в стандартный 44-байтный заголовок WAV (RIFF/PCM).
 */

/** Параметры формата PCM. */
export interface PcmFormat {
  /** Частота дискретизации, Гц (например, 24000). */
  sampleRate: number;
  /** Число каналов (1 — моно). */
  channels: number;
  /** Бит на сэмпл (16 для L16). */
  bitsPerSample: number;
}

/** Формат Gemini TTS по умолчанию: L16 (16-bit PCM), 24 кГц, моно. */
export const GEMINI_TTS_PCM: PcmFormat = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
};

/**
 * Разбирает частоту дискретизации из MIME-типа вида `audio/L16;rate=24000`.
 * Если параметр `rate` отсутствует, возвращает значение по умолчанию.
 */
export function parseSampleRate(mimeType: string | undefined, fallback = GEMINI_TTS_PCM.sampleRate): number {
  if (!mimeType) return fallback;
  const match = /rate=(\d+)/.exec(mimeType);
  const rate = match ? Number(match[1]) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

/**
 * Оборачивает буфер сырого PCM в WAV-контейнер.
 *
 * @param pcm    Сырые PCM-сэмплы.
 * @param format Параметры формата (частота, каналы, биты на сэмпл).
 */
export function pcmToWav(pcm: Buffer, format: PcmFormat = GEMINI_TTS_PCM): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  // RIFF-заголовок.
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4); // размер файла минус первые 8 байт
  header.write('WAVE', 8, 'ascii');
  // fmt-подчанк.
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // размер fmt-подчанка (16 для PCM)
  header.writeUInt16LE(1, 20); // аудиоформат 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  // data-подчанк.
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
