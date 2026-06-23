/**
 * Тесты для issue #49 — убрать лишний шаг при начале игры.
 *
 * До фикса: выбор сценария (game:id) → экран с кнопкой "Купить" → start/invoice.
 * После фикса: выбор сценария (game:id) → сразу start (триал) или invoice (не первая).
 */
import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';
import * as paymentsRepo from '@tg-games/core/db/repositories/payments.js';

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
  countUserSessions: vi.fn(),
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
  millicentsPerStar: 2000,
};

const user = {
  id: 'user-1',
  telegram_id: '42',
  username: 'bob',
  active_session_id: null,
  is_tester: false,
  is_admin: false,
  groups: ['default'],
  game_ids: Object.keys(GAMES),
  active_support_ticket_id: null,
  created_at: new Date(),
};

const trialSession: SessionRow = {
  id: 'sess-trial',
  game_id: 'bomj',
  user_id: user.id,
  is_active: true,
  is_processing: false,
  current_state: buildInitialState(GAMES.bomj),
  allocated_millicents: 2000,
  used_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date(),
};

function callbackQueryUpdate(data: string) {
  return {
    update_id: 1,
    callback_query: {
      id: 'cq1',
      from: {
        id: 42,
        is_bot: false,
        first_name: 'Bob',
        username: 'bob',
      },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 5,
        date: 0,
        chat: { id: 42, type: 'private', first_name: 'Bob' },
        from: { id: 999, is_bot: true, first_name: 'Bot' },
        text: 'список игр',
      },
    },
  } as any;
}

const provider: ILLMProvider = {
  name: 'mock',
  generateText: vi.fn(),
};

function createMockBot() {
  const bot = createBot(config, provider);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return bot;
}

describe('Начало игры (issue #49) — убрать лишний шаг', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(user);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(null);
    vi.mocked(sessionsRepo.createSession).mockResolvedValue(trialSession);
    vi.mocked(paymentsRepo.createPayment).mockResolvedValue({
      id: 'pay-1',
      user_id: user.id,
      session_id: null,
      amount: 0,
      status: 'paid',
      telegram_charge_id: null,
      payload: null,
      created_at: new Date(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Первая игра (триал)', () => {
    it('после выбора персонажа и локации сразу запускает игру (без экрана "Купить")', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(0);
      const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({
        message_id: 10,
      });

      await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      const sendMessageCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendMessage');
      expect(sendMessageCall).toBeDefined();
      const body = sendMessageCall?.[1] as { text?: string };
      // Должен содержать нарратив стартового состояния — игра началась
      expect(body?.text).toContain(buildInitialState(GAMES.bomj, 0, 0).narrative);
    });

    it('ни на одном шаге выбора не показывает кнопку "Купить" для первой игры', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(0);
      const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({
        message_id: 10,
      });

      const bot = createMockBot();
      await bot.handleUpdate(callbackQueryUpdate('game:bomj'));
      await bot.handleUpdate(callbackQueryUpdate('char:bomj:0'));
      await bot.handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      // Не должно быть кнопки buy: в ответах
      const allData = callApi.mock.calls.map(([, body]: [string, unknown]) => JSON.stringify(body));
      const hasBuyButton = allData.some((d) => d.includes('"buy:'));
      expect(hasBuyButton).toBe(false);
    });

    it('после выбора локации создаёт триальную сессию из выбранных пресетов', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(0);
      vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });

      await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      expect(sessionsRepo.createSession).toHaveBeenCalledWith(
        user.id,
        'bomj',
        buildInitialState(GAMES.bomj, 0, 0),
        config.millicentsPerStar,
      );
    });

    it('не выставляет инвойс для первой игры', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(0);
      const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

      await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      const methods = callApi.mock.calls.map(([method]: [string]) => method);
      expect(methods).not.toContain('sendInvoice');
    });
  });

  describe('Не первая игра (платная)', () => {
    it('после выбора локации сразу выставляет инвойс', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(1);
      vi.mocked(paymentsRepo.createPayment).mockResolvedValue({
        id: 'pay-2',
        user_id: user.id,
        session_id: null,
        amount: GAMES.bomj.priceStars,
        status: 'pending',
        telegram_charge_id: null,
        payload: null,
        created_at: new Date(),
      });
      const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

      await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      const methods = callApi.mock.calls.map(([method]: [string]) => method);
      expect(methods).toContain('sendInvoice');
    });

    it('не создаёт сессию до оплаты для платной игры', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(1);
      vi.mocked(paymentsRepo.createPayment).mockResolvedValue({
        id: 'pay-2',
        user_id: user.id,
        session_id: null,
        amount: GAMES.bomj.priceStars,
        status: 'pending',
        telegram_charge_id: null,
        payload: null,
        created_at: new Date(),
      });
      vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

      await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      expect(sessionsRepo.createSession).not.toHaveBeenCalled();
    });

    it('ни на одном шаге выбора не показывает кнопку "Купить" для не первой игры', async () => {
      vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(2);
      vi.mocked(paymentsRepo.createPayment).mockResolvedValue({
        id: 'pay-3',
        user_id: user.id,
        session_id: null,
        amount: GAMES.bomj.priceStars,
        status: 'pending',
        telegram_charge_id: null,
        payload: null,
        created_at: new Date(),
      });
      const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

      const bot = createMockBot();
      await bot.handleUpdate(callbackQueryUpdate('game:bomj'));
      await bot.handleUpdate(callbackQueryUpdate('char:bomj:0'));
      await bot.handleUpdate(callbackQueryUpdate('loc:bomj:0:0'));

      const allData = callApi.mock.calls.map(([, body]: [string, unknown]) => JSON.stringify(body));
      const hasBuyButton = allData.some((d) => d.includes('"buy:'));
      expect(hasBuyButton).toBe(false);
    });
  });
});
