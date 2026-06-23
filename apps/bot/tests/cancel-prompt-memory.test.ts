/**
 * Интеграционный тест исключения отменённых ходов из промпта (issue #116).
 *
 * Требование issue: «В промт отменённые ходы писать не надо». Проверяем, что
 * история, передаваемая в processTurn (память для LLM), не содержит отменённых
 * ходов, а оставшиеся ходы перенумерованы подряд.
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
import type { TurnHistoryEntry } from '@tg-games/core/types.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as reducer from '@tg-games/core/engine/reducer.js';

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

vi.mock('@tg-games/core/engine/reducer.js', () => ({
  calcLLMCost: vi.fn().mockReturnValue(0),
  getHintsWithLog: vi.fn(),
  processTurn: vi.fn(),
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

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function makeStep(overrides: Partial<StepRow>): StepRow {
  return {
    id: 'step',
    session_id: session.id,
    action_text: '—',
    llm_raw_response: null,
    changes_summary: 'итог',
    step_credits: 0,
    token_usage: EMPTY_USAGE,
    cost_millicents: 0,
    is_cancelled: false,
    state_before: null,
    created_at: new Date('2026-05-27T10:02:00Z'),
    ...overrides,
  };
}

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
  } as never;
}

const noopProvider: ILLMProvider = {
  name: 'mock',
  generateText: vi.fn(),
  generateTextResult: vi.fn(),
};

describe('исключение отменённых ходов из промпта (issue #116)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(player);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
    vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue();
    vi.mocked(sessionsRepo.updateSessionState).mockResolvedValue();
    vi.mocked(stepsRepo.insertStep).mockResolvedValue(makeStep({ id: 'new-step' }));
    vi.mocked(stepsRepo.listSteps).mockResolvedValue([
      makeStep({ id: 's1', action_text: 'осмотреться', changes_summary: 'нашли монету' }),
      makeStep({
        id: 's2',
        action_text: 'ударить стену',
        changes_summary: 'поранились',
        is_cancelled: true,
      }),
      makeStep({ id: 's3', action_text: 'идти на север', changes_summary: 'пришли в парк' }),
    ]);
    vi.mocked(reducer.processTurn).mockResolvedValue({
      ok: true,
      gameOver: false,
      narrative: 'результат хода',
      newState: { ...session.current_state, turn_count: 4 },
      rawResponse: '{}',
      creditsUsed: 0,
      tokenUsage: EMPTY_USAGE,
      costMillicents: 0,
      llmLog: [],
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('передаёт в processTurn историю без отменённых ходов с перенумерацией', async () => {
    const bot = createBot(config, noopProvider);
    bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
    vi.spyOn(Telegram.prototype as never, 'callApi').mockResolvedValue({
      message_id: 777,
      chat: { id: 123 },
    } as never);

    await bot.handleUpdate(textMessageUpdate('сделать новый ход'));

    expect(reducer.processTurn).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(reducer.processTurn).mock.calls[0][0] as { history: TurnHistoryEntry[] };
    const actions = arg.history.map((h) => h.action);

    // Отменённый ход «ударить стену» исключён из памяти промпта.
    expect(actions).toEqual(['осмотреться', 'идти на север']);
    // Оставшиеся ходы перенумерованы подряд (1, 2), без пропуска номера.
    expect(arg.history.map((h) => h.turn)).toEqual([1, 2]);
  });
});
