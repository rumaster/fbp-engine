/**
 * Тесты для issue #60 — пресеты персонажа и стартовой локации.
 *
 * Новый flow начала игры:
 *   game:<id>                   → выбор персонажа (кнопки char:<id>:<i>)
 *   char:<id>:<i>               → выбор локации (кнопки loc:<id>:<i>:<j>)
 *   loc:<id>:<i>:<j>            → триал (первая игра) или инвойс (остальные)
 * После оплаты successful_payment собирает стартовое состояние из выбранных
 * пресетов по индексам c/l из payload счёта.
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
      from: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 5,
        date: 0,
        chat: { id: 42, type: 'private', first_name: 'Bob' },
        from: { id: 999, is_bot: true, first_name: 'Bot' },
        text: 'шаг выбора',
      },
    },
  } as any;
}

function successfulPaymentUpdate(payload: string) {
  return {
    update_id: 2,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: 'private', first_name: 'Bob' },
      from: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      successful_payment: {
        currency: 'XTR',
        total_amount: 1,
        invoice_payload: payload,
        telegram_payment_charge_id: 'charge-1',
        provider_payment_charge_id: '',
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

describe('Пресеты персонажа и локации (issue #60)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(user);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(null);
    vi.mocked(sessionsRepo.createSession).mockResolvedValue(trialSession);
    vi.mocked(sessionsRepo.getSessionById).mockResolvedValue(trialSession);
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

  it('выбор игры показывает кнопки персонажей (char:<id>:<i>) и их описания', async () => {
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });

    await createMockBot().handleUpdate(callbackQueryUpdate('game:bomj'));

    const sendMessageCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendMessage');
    expect(sendMessageCall).toBeDefined();
    const body = sendMessageCall?.[1] as { text?: string; reply_markup?: any };
    // Текст содержит имена и описания пресетов персонажей.
    for (const preset of GAMES.bomj.characterPresets) {
      expect(body.text).toContain(preset.name);
    }
    // Кнопки выбора персонажа.
    const serialized = JSON.stringify(body.reply_markup);
    for (let i = 0; i < GAMES.bomj.characterPresets.length; i++) {
      expect(serialized).toContain(`char:bomj:${i}`);
    }
    // На этом шаге сессия ещё не создаётся.
    expect(sessionsRepo.createSession).not.toHaveBeenCalled();
  });

  it('выбор персонажа показывает кнопки локаций (loc:<id>:<charIndex>:<j>)', async () => {
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });

    await createMockBot().handleUpdate(callbackQueryUpdate('char:bomj:2'));

    const sendMessageCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendMessage');
    expect(sendMessageCall).toBeDefined();
    const body = sendMessageCall?.[1] as { text?: string; reply_markup?: any };
    for (const preset of GAMES.bomj.locationPresets) {
      expect(body.text).toContain(preset.location);
    }
    const serialized = JSON.stringify(body.reply_markup);
    for (let j = 0; j < GAMES.bomj.locationPresets.length; j++) {
      expect(serialized).toContain(`loc:bomj:2:${j}`);
    }
    expect(sessionsRepo.createSession).not.toHaveBeenCalled();
  });

  it('триал создаёт сессию со стартовым состоянием из выбранных персонажа и локации', async () => {
    vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(0);
    vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });

    await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:1:2'));

    expect(sessionsRepo.createSession).toHaveBeenCalledWith(
      user.id,
      'bomj',
      buildInitialState(GAMES.bomj, 1, 2),
      config.millicentsPerStar,
    );
  });

  it('инвойс платной игры переносит выбранные пресеты в payload (c/l)', async () => {
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

    await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:1:2'));

    const invoiceCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendInvoice');
    expect(invoiceCall).toBeDefined();
    const body = invoiceCall?.[1] as { payload?: string };
    const parsed = JSON.parse(body.payload ?? '{}');
    expect(parsed).toMatchObject({ g: 'bomj', c: 1, l: 2 });
  });

  it('successful_payment собирает состояние из пресетов по индексам payload', async () => {
    const created: SessionRow = { ...trialSession, game_id: 'bomj' };
    vi.mocked(sessionsRepo.createSession).mockResolvedValue(created);
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 11 });

    const payload = JSON.stringify({ p: 'pay-2', g: 'bomj', c: 1, l: 2 });
    await createMockBot().handleUpdate(successfulPaymentUpdate(payload));

    expect(sessionsRepo.createSession).toHaveBeenCalledWith(
      user.id,
      'bomj',
      buildInitialState(GAMES.bomj, 1, 2),
      config.millicentsPerStar * GAMES.bomj.priceStars,
    );
    // Стартовое сообщение содержит нарратив выбранной локации.
    const sendMessageCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendMessage');
    const body = sendMessageCall?.[1] as { text?: string };
    expect(body.text).toContain(GAMES.bomj.locationPresets[2].narrative);
  });

  it('successful_payment без индексов пресетов использует первый персонаж и локацию', async () => {
    vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 11 });

    const payload = JSON.stringify({ p: 'pay-2', g: 'bomj' });
    await createMockBot().handleUpdate(successfulPaymentUpdate(payload));

    expect(sessionsRepo.createSession).toHaveBeenCalledWith(
      user.id,
      'bomj',
      buildInitialState(GAMES.bomj, 0, 0),
      config.millicentsPerStar * GAMES.bomj.priceStars,
    );
  });

  it('устаревший выбор локации (индекс вне диапазона) не создаёт сессию', async () => {
    vi.mocked(sessionsRepo.countUserSessions).mockResolvedValue(0);
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });

    await createMockBot().handleUpdate(callbackQueryUpdate('loc:bomj:0:99'));

    expect(sessionsRepo.createSession).not.toHaveBeenCalled();
    const methods = callApi.mock.calls.map(([method]: [string]) => method);
    expect(methods).not.toContain('sendInvoice');
  });

  it('сценарий Красной Шапочки тоже имеет шаг выбора персонажа', async () => {
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({ message_id: 10 });

    await createMockBot().handleUpdate(callbackQueryUpdate('game:red_hood'));

    const sendMessageCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendMessage');
    const body = sendMessageCall?.[1] as { reply_markup?: any };
    const serialized = JSON.stringify(body.reply_markup);
    for (let i = 0; i < GAMES.red_hood.characterPresets.length; i++) {
      expect(serialized).toContain(`char:red_hood:${i}`);
    }
  });
});
