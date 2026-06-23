/**
 * Интеграционные тесты доставки ошибки при отсутствии активной схемы (issue #238).
 *
 * Schema engine — единственный путь исполнения, legacy удалён. Если активной
 * схемы нет, бот не должен «молча» зависать на прогресс-сообщении: вместо этого
 * прогресс-сообщение заменяется честной ошибкой (SCHEMA_UNAVAILABLE_TEXT) —
 * и для игрового хода (action), и для подсказки (hint).
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import {
  ACTION_IN_PROGRESS_TEXT,
  HINT_IN_PROGRESS_TEXT,
  SCHEMA_UNAVAILABLE_TEXT,
} from '../src/bot/progress.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';

// issue #238: бот исполняет ходы/подсказки только через активные схемы. Здесь
// getActiveSchema ВСЕГДА возвращает null — то есть активной схемы нет вовсе.
const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

vi.mock('@tg-games/core/db/repositories/users.js', () => ({
  getUserByTelegramId: vi.fn(),
  setActiveSession: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/sessions.js', () => ({
  acquireProcessingLock: vi.fn().mockResolvedValue(true),
  addAllocatedMillicents: vi.fn().mockResolvedValue(undefined),
  addUsedCredits: vi.fn().mockResolvedValue(undefined),
  addTokenUsageAndCost: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn(),
  finishSession: vi.fn(),
  getActiveSession: vi.fn(),
  getSessionById: vi.fn(),
  listUserSessions: vi.fn(),
  releaseProcessingLock: vi.fn().mockResolvedValue(undefined),
  updateSessionState: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/steps.js', () => ({
  insertStep: vi.fn(),
  listSteps: vi.fn(),
}));

vi.mock('@tg-games/core/db/repositories/payments.js', () => ({
  createPayment: vi.fn(),
  markPaymentPaid: vi.fn(),
}));

const config: AppConfig = {
  telegramBotToken: '000:test',
  llm: {
    provider: 'GOOGLE',
    apiKey: 'key',
    modelName: 'model',
    temperature: 0.5,
    maxRetries: 3,
  },
  db: {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres_password',
    database: 'tg_rpg_db',
  },
  millicentsPerStar: 200,
};

const player = {
  id: 'user-1',
  telegram_id: '123',
  username: 'alice',
  active_session_id: 'sess-1',
  is_tester: false,
  created_at: new Date('2026-05-27T10:00:00Z'),
};

const session: SessionRow = {
  id: 'sess-1',
  game_id: 'bomj',
  user_id: player.id,
  is_active: true,
  is_processing: false,
  current_state: { ...buildInitialState(GAMES.bomj), turn_count: 2 },
  allocated_millicents: 200,
  used_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-05-27T10:01:00Z'),
};

function textMessageUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      text,
    },
  } as any;
}

function createMockBot(provider: ILLMProvider) {
  const bot = createBot(config, provider);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return bot;
}

/** Провайдер, который никогда не должен быть вызван при отсутствии схемы. */
function noopProvider(): ILLMProvider {
  return {
    name: 'mock',
    generateText: vi.fn(),
    generateTextResult: vi.fn(),
  };
}

function mockTelegram() {
  return vi
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === 'sendMessage') {
        return { message_id: 555, chat: { id: 123 } };
      }
      return {};
    });
}

describe('ошибка при отсутствии активной схемы (#238)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ключевая настройка теста: активной схемы НЕТ ни для одного типа.
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(null);
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
    vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue();
    vi.mocked(stepsRepo.listSteps).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('игровой ход без action-схемы заменяет прогресс-сообщение на ошибку', async () => {
    const provider = noopProvider();
    const callApi = mockTelegram();

    await createMockBot(provider).handleUpdate(textMessageUpdate('осмотреться'));

    const sendMessageCalls = callApi.mock.calls.filter(([m]) => m === 'sendMessage');
    const editCalls = callApi.mock.calls.filter(([m]) => m === 'editMessageText');

    // Прогресс-сообщение «Действие выполняется…» всё-таки появляется первым.
    expect((sendMessageCalls[0]?.[1] as { text: string }).text).toBe(ACTION_IN_PROGRESS_TEXT);

    // …но затем оно заменяется на ошибку, а не зависает.
    expect(editCalls).toHaveLength(1);
    expect((editCalls[0]?.[1] as { text: string }).text).toBe(SCHEMA_UNAVAILABLE_TEXT);

    // Блокировка обработки снимается (finally), и LLM не дергался.
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith(session.id);
    expect(provider.generateTextResult).not.toHaveBeenCalled();
  });

  it('подсказка без hint-схемы заменяет прогресс-сообщение на ошибку', async () => {
    const provider = noopProvider();
    const callApi = mockTelegram();

    await createMockBot(provider).handleUpdate(textMessageUpdate('Подсказка'));

    const sendMessageCalls = callApi.mock.calls.filter(([m]) => m === 'sendMessage');
    const editCalls = callApi.mock.calls.filter(([m]) => m === 'editMessageText');

    // Прогресс-сообщение «Поиск возможных действий…» появляется первым.
    expect((sendMessageCalls[0]?.[1] as { text: string }).text).toBe(HINT_IN_PROGRESS_TEXT);

    // …и заменяется на ошибку.
    expect(editCalls).toHaveLength(1);
    expect((editCalls[0]?.[1] as { text: string }).text).toBe(SCHEMA_UNAVAILABLE_TEXT);

    expect(provider.generateTextResult).not.toHaveBeenCalled();
  });
});
