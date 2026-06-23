/**
 * Единый runtime-smoke всех четырёх типов схем (issue #247, этап C плана
 * docs/schema-engine-gap-plan.md).
 *
 * Schema engine — единственный путь исполнения для `action`, `hint`, `support`
 * и `illustration` (legacy удалён в issue #238). Этот тест прогоняет именно
 * ПРОДАКШЕН-графы (`buildDefault*Schema`, те же билдеры, что и в seed-миграции
 * M001) через боевые runtime-обёртки в ОДНОМ прогоне:
 *
 *   - `action`       → processTurn          → executeSchema(defaultActionSchema)
 *   - `hint`         → getHintsWithLog       → executeSchema(defaultHintSchema)
 *   - `support`      → runSupportViaSchema   → executeSchema(defaultSupportSchema)
 *   - `illustration` → generateIllustrationViaSchema → executeSchema(defaultIllustrationSchema)
 *
 * На фиксированных mock-ответах LLM/медиа это контрактный тест семантики узлов
 * дефолтных графов: проверяем, что каждый тип доходит до осмысленного результата
 * (нарратив + новое состояние, массив подсказок, ответ поддержки, бинарная
 * иллюстрация) и что аудит выполнения (`logSchemaExecution`) пишется.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import type { IMediaProvider } from '@tg-games/core/media/IMediaProvider.js';
import type { GameState } from '@tg-games/core/types.js';
import { TEST_GAMES } from './fixtures/gameManifests.js';

const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

import { processTurn, getHintsWithLog } from '@tg-games/core/engine/reducer.js';
import { runSupportViaSchema } from '../src/botSupport/supportSchema.js';
import { generateIllustrationViaSchema } from '@tg-games/core/media/illustrationSchema.js';
import { mockActiveSchemasByType } from './fixtures/schemas.js';

function gameState(): GameState {
  return {
    location: 'Теплотрасса',
    narrative: 'старт',
    character: { hp: 80, max_hp: 100, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    turn_count: 1,
  };
}

/**
 * LLM-провайдер для action-схемы: один совмещённый JSON удовлетворяет все
 * типизированные узлы (narrative/inventory/characteristics/world_flags/
 * updated_state) — каждый узел берёт своё поле по jsonPath.
 */
function actionProvider(narrative: string): ILLMProvider {
  const text = JSON.stringify({
    narrative,
    inventory: ['монета'],
    characteristics: {},
    world_flags: { found_coin: true },
    updated_state: { location: 'Теплотрасса', narrative },
  });
  return {
    name: 'MockAction',
    generateText: vi.fn(async () => text),
    generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
      text,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    })),
  };
}

/** LLM-провайдер для hint-схемы: возвращает готовый JSON с подсказками. */
function hintProvider(hints: string[]): ILLMProvider {
  return {
    name: 'MockHint',
    generateText: vi.fn(async () => JSON.stringify({ hints })),
  };
}

/** Провайдер для support-схемы (по порядку узлов: детекция → ответ → компиляция). */
function supportProvider(responses: string[]): ILLMProvider {
  let i = 0;
  return {
    name: 'MockSupport',
    generateText: vi.fn(async () => {
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    }),
  };
}

/** Медиа-провайдер для illustration-схемы. */
function drawingMedia(): IMediaProvider {
  return {
    name: 'MockMedia',
    canSpeak: false,
    canDraw: true,
    canTranscribe: false,
    generateSpeech: vi.fn(),
    generateImage: vi.fn(async (req: { prompt: string }) => ({
      image: Buffer.from(`png:${req.prompt}`),
      extension: 'png',
      meta: { request: req.prompt, response: 'ok' },
    })),
    transcribe: vi.fn(),
  };
}

describe('runtime-smoke: все 4 типа схем через executeSchema (issue #247, этап C)', () => {
  beforeEach(() => {
    schemaRepositoryMock.getActiveSchema.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    // Все четыре типа резолвятся в свой продакшен-граф buildDefault*Schema.
    mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
  });

  it('action: продакшен-граф даёт нарратив и новое состояние', async () => {
    const result = await processTurn({
      provider: actionProvider('Вы нашли монету у стены.'),
      manifest: TEST_GAMES.bomj,
      state: gameState(),
      action: 'осмотреться',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('action: ожидался успешный ход');
    expect(result.narrative).toContain('Вы нашли монету');
    // Узлы записи состояния отработали: собранные фазы смержены в новое состояние.
    expect(result.newState.world_flags.found_coin).toBe(true);
    expect(result.newState.character.inventory).toContain('монета');
    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('action', 'bomj');
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalled();
  });

  it('hint: продакшен-граф возвращает массив подсказок', async () => {
    const result = await getHintsWithLog(
      hintProvider(['Осмотреться', 'Обыскать карманы', 'Идти дальше']),
      gameState(),
      1,
      [],
      null,
      undefined,
      'bomj',
    );

    expect(result.hints.length).toBeGreaterThan(0);
    expect(result.hints).toContain('Осмотреться');
    // Бот показывает максимум 3 подсказки.
    expect(result.hints.length).toBeLessThanOrEqual(3);
    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('hint', 'bomj');
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalled();
  });

  it('support: продакшен-граф восстанавливает reply/escalate/resolved/compiledProblem', async () => {
    const result = await runSupportViaSchema({
      provider: supportProvider([
        JSON.stringify({ problems: ['оплата'] }),
        JSON.stringify({ escalate: false, resolved: true, reply: 'Проверьте баланс звёзд.' }),
        JSON.stringify({ problem: 'Клиент не понимает, как пополнить звёзды.' }),
      ]),
      turns: [{ sender: 'user', text: 'Как пополнить звёзды?' }],
      lastMessage: 'Как пополнить звёзды?',
      maxRetries: 1,
      ticketId: 'ticket-smoke',
    });

    expect(result.reply).toBe('Проверьте баланс звёзд.');
    expect(result.escalate).toBe(false);
    expect(result.resolved).toBe(true);
    expect(result.compiledProblem).toBe('Клиент не понимает, как пополнить звёзды.');
    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('support');
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalled();
  });

  it('illustration: продакшен-граф рисует изображение через медиа-провайдер', async () => {
    const media = drawingMedia();
    const result = await generateIllustrationViaSchema({
      sceneText: 'Тёмный подвал, капает вода.',
      gameId: 'bomj',
      mediaProvider: media,
      image: { model: 'dall-e-3', size: '1024x1024' },
    });

    expect(Buffer.isBuffer(result.image)).toBe(true);
    expect(result.extension).toBe('png');
    expect(typeof result.prompt).toBe('string');
    expect(media.generateImage).toHaveBeenCalledTimes(1);
    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('illustration', 'bomj');
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalled();
  });
});
