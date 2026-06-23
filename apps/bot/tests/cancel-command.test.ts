/**
 * Интеграционные тесты команды /cancel (issue #116).
 *
 * Проверяем поведение команды отмены хода:
 *  1. Нет активной игры → сообщение об отсутствии игры.
 *  2. Идёт обработка другого хода (блокировка занята) → отказ.
 *  3. Отменять нечего → соответствующее сообщение.
 *  4. Успех: ход помечен отменённым, состояние восстановлено из снимка,
 *     игроку показан статус восстановленного состояния.
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';

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
  cancelLastStep: vi.fn(),
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
  current_state: { ...buildInitialState(GAMES.bomj), turn_count: 3 },
  allocated_millicents: 200,
  used_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-05-27T10:01:00Z'),
};

const stateBefore = { ...buildInitialState(GAMES.bomj), turn_count: 2 };

const cancelledStep: StepRow = {
  id: 'step-42',
  session_id: session.id,
  action_text: 'ударить стену',
  llm_raw_response: null,
  changes_summary: 'Поранили руку',
  step_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  is_cancelled: true,
  state_before: stateBefore,
  created_at: new Date('2026-05-27T10:02:00Z'),
};

/** Update с командой /cancel (с bot_command entity, как присылает Telegram). */
function cancelCommandUpdate() {
  const text = '/cancel';
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Alice', username: 'alice' },
      from: { id: 123, is_bot: false, first_name: 'Alice', username: 'alice' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    },
  } as never;
}

const noopProvider: ILLMProvider = {
  name: 'mock',
  generateText: vi.fn(),
  generateTextResult: vi.fn(),
};

function createMockBot() {
  const bot = createBot(config, noopProvider);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return bot;
}

/** Собирает все тексты, отправленные через ctx.reply (sendMessage). */
function captureReplies(): string[] {
  const texts: string[] = [];
  vi.spyOn(Telegram.prototype as never, 'callApi').mockImplementation(
    async (...args: unknown[]) => {
      const method = args[0] as string;
      const payload = args[1] as { text?: string } | undefined;
      if (method === 'sendMessage' && payload?.text) {
        texts.push(payload.text);
      }
      return { message_id: 777, chat: { id: 123 } } as never;
    },
  );
  return texts;
}

describe('команда /cancel (issue #116)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
    vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('сообщает об отсутствии активной игры', async () => {
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(null);
    const bot = createMockBot();
    const texts = captureReplies();

    await bot.handleUpdate(cancelCommandUpdate());

    expect(texts.some((t) => t.includes('нет активной игры'))).toBe(true);
    expect(stepsRepo.cancelLastStep).not.toHaveBeenCalled();
  });

  it('отказывает, когда обрабатывается другой ход (блокировка занята)', async () => {
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(false);
    const bot = createMockBot();
    const texts = captureReplies();

    await bot.handleUpdate(cancelCommandUpdate());

    expect(texts.some((t) => t.includes('ещё обрабатывается'))).toBe(true);
    expect(stepsRepo.cancelLastStep).not.toHaveBeenCalled();
  });

  it('сообщает, что отменять нечего, когда ходов нет', async () => {
    vi.mocked(stepsRepo.cancelLastStep).mockResolvedValue(null);
    const bot = createMockBot();
    const texts = captureReplies();

    await bot.handleUpdate(cancelCommandUpdate());

    expect(stepsRepo.cancelLastStep).toHaveBeenCalledWith(session.id);
    expect(texts.some((t) => t.includes('Отменять нечего'))).toBe(true);
    // Блокировка обязательно освобождается.
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith(session.id);
  });

  it('отменяет ход и восстанавливает состояние из снимка', async () => {
    vi.mocked(stepsRepo.cancelLastStep).mockResolvedValue(cancelledStep);
    const bot = createMockBot();
    const texts = captureReplies();

    await bot.handleUpdate(cancelCommandUpdate());

    expect(stepsRepo.cancelLastStep).toHaveBeenCalledWith(session.id);
    // Игроку сообщается, какой ход отменён.
    expect(texts.some((t) => t.includes('Ход отменён') && t.includes('ударить стену'))).toBe(true);
    expect(texts.some((t) => t.includes('Состояние игры восстановлено'))).toBe(true);
    // Показан статус восстановленного состояния (ход 2 из снимка state_before).
    expect(texts.some((t) => t.includes('🔢 Ход: 2'))).toBe(true);
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith(session.id);
  });

  it('помечает старый ход без снимка, но честно сообщает о невозможности отката', async () => {
    vi.mocked(stepsRepo.cancelLastStep).mockResolvedValue({
      ...cancelledStep,
      state_before: null,
    });
    const bot = createMockBot();
    const texts = captureReplies();

    await bot.handleUpdate(cancelCommandUpdate());

    expect(texts.some((t) => t.includes('Ход отменён'))).toBe(true);
    expect(texts.some((t) => t.includes('откатить не удалось'))).toBe(true);
    // Статус восстановленного состояния не показываем.
    expect(texts.some((t) => t.includes('🔢 Ход:'))).toBe(false);
  });
});
