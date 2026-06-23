import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
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

const provider: ILLMProvider = {
  name: 'mock',
  generateText: vi.fn(),
};

const user = {
  id: 'user-1',
  telegram_id: '123',
  username: 'alice',
  active_session_id: null,
  is_tester: false,
  created_at: new Date('2026-05-27T10:00:00Z'),
};

const session: SessionRow = {
  id: 'sess-1',
  game_id: 'bomj',
  user_id: user.id,
  is_active: false,
  is_processing: false,
  current_state: { ...buildInitialState(GAMES.bomj), turn_count: 2 },
  allocated_millicents: 200,
  used_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date('2026-05-27T10:01:00Z'),
};

const steps: StepRow[] = [
  {
    id: 'step-1',
    session_id: session.id,
    action_text: 'осмотреться',
    llm_raw_response: null,
    changes_summary: 'Вы нашли монету ₽',
    step_credits: 0,
    token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cost_millicents: 0,
    created_at: new Date('2026-05-27T10:02:00Z'),
  },
];

function historyCallbackUpdate(sessionId: string) {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      from: {
        id: 123,
        is_bot: false,
        first_name: 'Alice',
        username: 'alice',
      },
      message: {
        message_id: 10,
        date: 0,
        chat: {
          id: 123,
          type: 'private',
          first_name: 'Alice',
          username: 'alice',
        },
        text: 'Завершённые игры',
      },
      chat_instance: 'chat-instance',
      data: `history:${sessionId}`,
    },
  } as any;
}

describe('history callback (#11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(user);
    vi.mocked(sessionsRepo.getSessionById).mockResolvedValue(session);
    vi.mocked(stepsRepo.listSteps).mockResolvedValue(steps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('отправляет историю завершённой игры UTF-8 файлом с ожидаемым именем', async () => {
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});
    const bot = createBot(config, provider);
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: 'Test Bot',
      username: 'test_bot',
    };

    await bot.handleUpdate(historyCallbackUpdate(session.id));

    const methods = callApi.mock.calls.map(([method]) => method);
    expect(methods).toContain('answerCallbackQuery');
    expect(methods).toContain('sendDocument');
    expect(methods).not.toContain('sendMessage');
    expect(sessionsRepo.getSessionById).toHaveBeenCalledWith(session.id, user.id);
    expect(stepsRepo.listSteps).toHaveBeenCalledWith(session.id);

    const sendDocumentCall = callApi.mock.calls.find(([method]) => method === 'sendDocument');
    expect(sendDocumentCall).toBeDefined();
    const payload = sendDocumentCall?.[1] as {
      chat_id: number;
      document: { source: Buffer; filename?: string };
    };
    expect(payload.chat_id).toBe(123);
    expect(payload.document.filename).toBe('bomj_sess-1_history.txt');
    expect(Buffer.isBuffer(payload.document.source)).toBe(true);
    expect(payload.document.source.toString('utf8')).toContain('Вы нашли монету ₽');
  });
});
