/**
 * Интеграционные тесты сообщения результата действия (issue #36).
 *
 * Проверяем, что при получении действия бот:
 * 1. Сразу отправляет сообщение «Действие выполняется…» (sendMessage).
 * 2. По завершении заменяет текст этого сообщения на результат (editMessageText),
 *    а не присылает отдельное новое сообщение.
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { ACTION_IN_PROGRESS_TEXT } from '../src/bot/progress.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
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

const step: StepRow = {
  id: 'step-42',
  session_id: session.id,
  action_text: 'осмотреться',
  llm_raw_response: null,
  changes_summary: 'Вы нашли монету',
  step_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-05-27T10:02:00Z'),
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

describe('сообщение результата действия (#36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
    vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue();
    vi.mocked(sessionsRepo.updateSessionState).mockResolvedValue();
    vi.mocked(stepsRepo.insertStep).mockResolvedValue(step);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('сразу шлёт «Действие выполняется…», затем заменяет его на результат', async () => {
    const narrative = 'Вы нашли монету';
    const next = { ...session.current_state, narrative };
    // issue #238: совмещённый ответ удовлетворяет все типизированные узлы action-схемы.
    const rawTurn = JSON.stringify({
      narrative,
      inventory: [],
      characteristics: {},
      world_flags: {},
      updated_state: next,
    });
    const provider: ILLMProvider = {
      name: 'mock',
      generateText: vi.fn(),
      generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
        text: rawTurn,
        usage: { promptTokens: 80, completionTokens: 19, totalTokens: 99 },
      })),
    };
    // callApi для sendMessage должен вернуть message_id, чтобы прогресс-сообщение
    // можно было отредактировать по этому id.
    const callApi = vi
      .spyOn(Telegram.prototype as any, 'callApi')
      .mockImplementation(async (...args: unknown[]) => {
        const method = args[0] as string;
        if (method === 'sendMessage') {
          return { message_id: 777, chat: { id: 123 } };
        }
        return {};
      });

    await createMockBot(provider).handleUpdate(textMessageUpdate('осмотреться'));

    const sendMessageCalls = callApi.mock.calls.filter(([m]) => m === 'sendMessage');
    const editCalls = callApi.mock.calls.filter(([m]) => m === 'editMessageText');

    // Первое отправленное сообщение — «Действие выполняется…».
    const progressPayload = sendMessageCalls[0]?.[1] as { text: string };
    expect(progressPayload.text).toBe(ACTION_IN_PROGRESS_TEXT);

    // Результат заменяет именно это сообщение (тот же message_id), а не приходит
    // отдельным sendMessage с нарративом.
    expect(editCalls).toHaveLength(1);
    const editPayload = editCalls[0]?.[1] as {
      message_id: number;
      chat_id: number;
      text: string;
    };
    expect(editPayload.message_id).toBe(777);
    expect(editPayload.chat_id).toBe(123);
    expect(editPayload.text).toBe(narrative);

    const narrativeSends = sendMessageCalls.filter(
      ([, p]) => (p as { text?: string }).text === narrative,
    );
    expect(narrativeSends).toHaveLength(0);
  });
});
