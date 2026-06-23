import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchemaRecord } from '@tg-games/core/db/repositories/schemas.js';
import type { IMediaProvider } from '@tg-games/core/media/IMediaProvider.js';
import { MissingActiveSchemaError } from '@tg-games/core/engine/schemaEngine.js';
import { buildDefaultIllustrationSchema } from '@tg-games/core/db/migrations/M001_prompt_templates_to_schemas.js';
import { TEST_PROMPT_TEMPLATES } from './fixtures/gameManifests.js';

const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

import { generateIllustrationViaSchema } from '@tg-games/core/media/illustrationSchema.js';

function activeIllustrationSchema(): SchemaRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000bb',
    schemaSlug: 'illustration',
    schemaType: 'illustration',
    gameId: null,
    graphJson: buildDefaultIllustrationSchema(TEST_PROMPT_TEMPLATES),
    isActive: true,
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function mediaProvider(generateImage: IMediaProvider['generateImage']): IMediaProvider {
  return {
    name: 'MockMedia',
    canSpeak: false,
    canDraw: true,
    canTranscribe: false,
    generateSpeech: vi.fn(),
    generateImage,
    transcribe: vi.fn(),
  };
}

describe('generateIllustrationViaSchema (issue #238)', () => {
  beforeEach(() => {
    schemaRepositoryMock.getActiveSchema.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
  });

  it('бросает MissingActiveSchemaError, когда активной схемы нет (issue #238: legacy удалён)', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(null);
    await expect(
      generateIllustrationViaSchema({
        sceneText: 'Тёмный подвал',
        gameId: 'game-1',
        mediaProvider: mediaProvider(vi.fn()),
      }),
    ).rejects.toBeInstanceOf(MissingActiveSchemaError);
    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('illustration', 'game-1');
  });

  it('рисует иллюстрацию через провайдера медиа и возвращает бинарные данные', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeIllustrationSchema());
    const generateImage = vi.fn(async (req: { prompt: string; model?: string; size?: string }) => ({
      image: Buffer.from(`png:${req.prompt}`),
      extension: 'png',
      meta: { request: req.prompt, response: 'ok' },
    }));

    const result = await generateIllustrationViaSchema({
      sceneText: 'Тёмный подвал, капает вода.',
      gameId: 'game-1',
      mediaProvider: mediaProvider(generateImage),
      image: { model: 'dall-e-3', size: '1024x1024' },
    });

    expect(result).not.toBeNull();
    expect(Buffer.isBuffer(result!.image)).toBe(true);
    expect(result!.extension).toBe('png');
    expect(typeof result!.prompt).toBe('string');
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage.mock.calls[0][0]).toMatchObject({ model: 'dall-e-3', size: '1024x1024' });
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalledTimes(1);
  });

  it('пробрасывает ошибку провайдера медиа (для кнопки повтора в боте)', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeIllustrationSchema());
    const generateImage = vi.fn(async () => {
      throw new Error('Провайдер медиа недоступен');
    });

    await expect(
      generateIllustrationViaSchema({
        sceneText: 'Сцена',
        mediaProvider: mediaProvider(generateImage),
      }),
    ).rejects.toThrow('Провайдер медиа недоступен');
  });

  it('бросает ошибку, когда провайдер не отдал бинарных данных (issue #238: legacy удалён)', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeIllustrationSchema());
    // Провайдер не умеет рисовать → media_generate вернёт только промпт-строку.
    const provider = mediaProvider(vi.fn());
    provider.canDraw = false;

    await expect(
      generateIllustrationViaSchema({
        sceneText: 'Сцена',
        mediaProvider: provider,
      }),
    ).rejects.toThrow('не вернула изображение');
  });
});
