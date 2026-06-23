/**
 * Интеграционные тесты сообщения поиска подсказок (issue #43).
 *
 * Проверяем, что при нажатии кнопки «Подсказка» бот:
 * 1. Сразу отправляет сообщение «Поиск возможных действий…» (sendMessage).
 * 2. По завершении заменяет текст этого сообщения на список подсказок
 *    (editMessageText), а не присылает отдельное новое сообщение.
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { HINT_IN_PROGRESS_TEXT } from '../src/bot/progress.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import { mockActiveSchemasByType } from './fixtures/schemas.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';

// issue #238: бот исполняет ходы/подсказки только через активные схемы — мокируем
// репозиторий схем (action повторяет прежний 5-фазный пайплайн).
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

function hintButtonUpdate() {
  return {
    update_id: 2,
    message: {
      message_id: 20,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      text: 'Подсказка',
    },
  } as any;
}

function createMockBot(provider: ILLMProvider) {
  const bot = createBot(config, provider);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return bot;
}

describe('сообщение поиска подсказок (#43)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(stepsRepo.listSteps).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('сразу шлёт «Поиск возможных действий…», затем заменяет его на список подсказок', async () => {
    const hints = ['осмотреться', 'идти на север', 'обыскать мусорку'];
    const rawHints = JSON.stringify(hints);
    const provider: ILLMProvider = {
      name: 'mock',
      generateText: vi.fn(),
      generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
        text: rawHints,
        usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
      })),
    };

    const callApi = vi
      .spyOn(Telegram.prototype as any, 'callApi')
      .mockImplementation(async (...args: unknown[]) => {
        const method = args[0] as string;
        if (method === 'sendMessage') {
          return { message_id: 888, chat: { id: 123 } };
        }
        return {};
      });

    await createMockBot(provider).handleUpdate(hintButtonUpdate());

    const sendMessageCalls = callApi.mock.calls.filter(([m]) => m === 'sendMessage');
    const editCalls = callApi.mock.calls.filter(([m]) => m === 'editMessageText');

    // Первое отправленное сообщение — «Поиск возможных действий…».
    const progressPayload = sendMessageCalls[0]?.[1] as { text: string };
    expect(progressPayload.text).toBe(HINT_IN_PROGRESS_TEXT);

    // Результат заменяет именно это сообщение (тот же message_id), а не приходит
    // отдельным sendMessage.
    expect(editCalls).toHaveLength(1);
    const editPayload = editCalls[0]?.[1] as {
      message_id: number;
      chat_id: number;
      text: string;
    };
    expect(editPayload.message_id).toBe(888);
    expect(editPayload.chat_id).toBe(123);
    expect(editPayload.text).toContain('осмотреться');

    // Список подсказок не приходит отдельным sendMessage.
    const hintSends = sendMessageCalls.filter(
      ([, p]) => (p as { text?: string }).text?.includes('осмотреться'),
    );
    expect(hintSends).toHaveLength(0);
  });
});
