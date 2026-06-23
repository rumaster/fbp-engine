import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { topUpKeyboard, topUpStepsForBalance } from '../src/bot/menus.js';
import type { AppConfig } from '@tg-games/core/config.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES } from './fixtures/gameManifests.js';
import { mockActiveSchemasByType } from './fixtures/schemas.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import { ACTION_IN_PROGRESS_TEXT } from '../src/bot/progress.js';
import { clearDialogState } from '../src/bot/userState.js';
import * as paymentsRepo from '@tg-games/core/db/repositories/payments.js';
import * as sessionsRepo from '@tg-games/core/db/repositories/sessions.js';
import * as stepsRepo from '@tg-games/core/db/repositories/steps.js';
import * as usersRepo from '@tg-games/core/db/repositories/users.js';

// issue #238: бот исполняет ходы только через активные схемы — мокируем
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
  active_session_id: 'sess-1',
  is_tester: false,
  created_at: new Date(),
};

const tester = {
  ...user,
  id: 'tester-1',
  is_tester: true,
};

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    game_id: 'bomj',
    user_id: user.id,
    is_active: true,
    is_processing: false,
    current_state: buildInitialState(GAMES.bomj),
    allocated_millicents: 2000,
    used_credits: 0,
    token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cost_millicents: 2000,
    created_at: new Date(),
    ...overrides,
  };
}

const provider: ILLMProvider = {
  name: 'mock',
  generateText: vi.fn(),
};

const step: StepRow = {
  id: 'step-135',
  session_id: 'sess-1',
  action_text: 'идти дальше',
  llm_raw_response: null,
  changes_summary: 'Вы идёте дальше.',
  step_credits: 0,
  token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  cost_millicents: 0,
  created_at: new Date(),
};

function createMockBot() {
  const bot = createBot(config, provider);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return bot;
}

function textMessageUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: 'private', first_name: 'Bob', username: 'bob' },
      from: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      text,
    },
  } as any;
}

function callbackQueryUpdate(data: string) {
  return {
    update_id: 2,
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
        text: 'пополнение',
      },
    },
  } as any;
}

function successfulPaymentUpdate(payload: string, totalAmount: number) {
  return {
    update_id: 3,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: 'private', first_name: 'Bob' },
      from: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      successful_payment: {
        currency: 'XTR',
        total_amount: totalAmount,
        invoice_payload: payload,
        telegram_payment_charge_id: 'charge-1',
        provider_payment_charge_id: '',
      },
    },
  } as any;
}

function inlineKeyboard(markup: { reply_markup?: { inline_keyboard?: unknown[][] } } | undefined) {
  return markup?.reply_markup?.inline_keyboard ?? [];
}

function callbackData(markup: { inline_keyboard?: unknown[][] } | undefined) {
  return (markup?.inline_keyboard ?? [])
    .flat()
    .map((button) => (button as { callback_data?: string }).callback_data);
}

describe('Опции пополнения игровой сессии (#92)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
    clearDialogState(42);
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(user);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session());
    vi.mocked(sessionsRepo.getSessionById).mockResolvedValue(session());
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
    vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue(undefined);
    vi.mocked(sessionsRepo.updateSessionState).mockResolvedValue(undefined);
    vi.mocked(stepsRepo.listSteps).mockResolvedValue([]);
    vi.mocked(stepsRepo.insertStep).mockResolvedValue(step);
    vi.mocked(paymentsRepo.createPayment).mockResolvedValue({
      id: 'pay-1',
      user_id: user.id,
      session_id: null,
      amount: 3,
      status: 'pending',
      telegram_charge_id: null,
      payload: null,
      created_at: new Date(),
    });
  });

  afterEach(() => {
    clearDialogState(42);
    vi.restoreAllMocks();
  });

  it('строит кнопки x1, x3 и x10 для пополнения', () => {
    const kb = inlineKeyboard(topUpKeyboard('sess-1'));

    expect(kb).toHaveLength(3);
    expect(kb[0][0]).toMatchObject({ text: 'x1 — 1 ⭐️', callback_data: 'topup:sess-1:1' });
    expect(kb[1][0]).toMatchObject({ text: 'x3 — 3 ⭐️', callback_data: 'topup:sess-1:3' });
    expect(kb[2][0]).toMatchObject({ text: 'x10 — 10 ⭐️', callback_data: 'topup:sess-1:10' });
  });

  it('скрывает ступени, после которых игра останется недоступна', () => {
    expect(
      topUpStepsForBalance(
        session({ allocated_millicents: 2000, cost_millicents: 4500 }),
        config.millicentsPerStar,
      ),
    ).toEqual([3, 10]);
    expect(
      topUpStepsForBalance(
        session({ allocated_millicents: 2000, cost_millicents: 4000 }),
        config.millicentsPerStar,
      ),
    ).toEqual([3, 10]);
  });

  it('показывает только доступные ступени при исчерпанных кредитах', async () => {
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(
      session({ allocated_millicents: 2000, cost_millicents: 4500 }),
    );
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

    await createMockBot().handleUpdate(textMessageUpdate('идти дальше'));

    const sendMessageCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendMessage');
    const body = sendMessageCall?.[1] as { reply_markup?: { inline_keyboard?: unknown[][] } };
    expect(callbackData(body.reply_markup)).toEqual(['topup:sess-1:3', 'topup:sess-1:10']);
  });

  it('выставляет инвойс на выбранную ступень пополнения', async () => {
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

    await createMockBot().handleUpdate(callbackQueryUpdate('topup:sess-1:3'));

    expect(paymentsRepo.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 3,
        payload: { type: 'topup', sessionId: 'sess-1', amount: 3 },
      }),
    );
    const invoiceCall = callApi.mock.calls.find(([method]: [string]) => method === 'sendInvoice');
    const body = invoiceCall?.[1] as { payload?: string; prices?: Array<{ amount: number }> };
    expect(body.prices?.[0]?.amount).toBe(3);
    expect(JSON.parse(body.payload ?? '{}')).toMatchObject({
      type: 'topup',
      s: 'sess-1',
      a: 3,
    });
  });

  it('начисляет бюджет по оплаченной сумме пополнения', async () => {
    const payload = JSON.stringify({ p: 'pay-1', type: 'topup', s: 'sess-1', a: 3 });
    vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

    await createMockBot().handleUpdate(successfulPaymentUpdate(payload, 3));

    expect(sessionsRepo.addAllocatedMillicents).toHaveBeenCalledWith('sess-1', 6000);
    expect(paymentsRepo.markPaymentPaid).toHaveBeenCalledWith('pay-1', 'charge-1', 'sess-1');
  });

  it('пополняет кредиты тестеру бесплатно без инвойса', async () => {
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(tester);
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

    await createMockBot().handleUpdate(callbackQueryUpdate('topup:sess-1:3'));

    const methods = callApi.mock.calls.map(([method]: [string]) => method);
    expect(methods).not.toContain('sendInvoice');
    expect(sessionsRepo.addAllocatedMillicents).toHaveBeenCalledWith('sess-1', 6000);
    expect(paymentsRepo.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 0,
        status: 'paid',
        payload: { type: 'topup', sessionId: 'sess-1', amount: 3, tester: true },
      }),
    );
    expect(paymentsRepo.markPaymentPaid).not.toHaveBeenCalled();
  });

  it('после пополнения выполняет действие, которое упёрлось в лимит кредитов', async () => {
    const exhaustedSession = session({ allocated_millicents: 2000, cost_millicents: 4500 });
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(exhaustedSession);
    vi.mocked(sessionsRepo.getSessionById)
      .mockResolvedValueOnce(exhaustedSession)
      .mockResolvedValueOnce(exhaustedSession);
    const narrative = 'Вы идёте дальше.';
    const next = { ...exhaustedSession.current_state, narrative };
    const rawNarrative = JSON.stringify({ narrative });
    // issue #238: ответ фаз состояния удовлетворяет все типизированные узлы схемы
    // (inventory/characteristics/world_flags/updated_state).
    const rawState = JSON.stringify({
      inventory: [],
      characteristics: {},
      world_flags: {},
      updated_state: next,
    });
    let turnCall = 0;
    const turnProvider: ILLMProvider = {
      name: 'mock',
      generateText: vi.fn(),
      generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => {
        turnCall += 1;
        if (turnCall === 1) {
          return {
            text: rawNarrative,
            usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
          };
        }
        return {
          text: rawState,
          usage: { promptTokens: 60, completionTokens: 12, totalTokens: 72 },
        };
      }),
    };
    const callApi = vi
      .spyOn(Telegram.prototype as any, 'callApi')
      .mockImplementation(async (...args: unknown[]) => {
        const method = args[0] as string;
        if (method === 'sendMessage') {
          return { message_id: 777, chat: { id: 42 } };
        }
        return {};
      });
    const bot = createBot(config, turnProvider);
    bot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };

    await bot.handleUpdate(textMessageUpdate('идти дальше'));
    await bot.handleUpdate(callbackQueryUpdate('topup:sess-1:3'));
    const payload = JSON.stringify({ p: 'pay-1', type: 'topup', s: 'sess-1', a: 3 });
    await bot.handleUpdate(successfulPaymentUpdate(payload, 3));

    expect(turnProvider.generateTextResult).toHaveBeenCalledTimes(5);
    expect(stepsRepo.insertStep).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        actionText: 'идти дальше',
      }),
    );
    const progressCall = callApi.mock.calls.find(
      ([method, body]) =>
        method === 'sendMessage' && (body as { text?: string }).text === ACTION_IN_PROGRESS_TEXT,
    );
    expect(progressCall).toBeDefined();
    const editCall = callApi.mock.calls.find(([method]) => method === 'editMessageText');
    expect((editCall?.[1] as { text?: string } | undefined)?.text).toBe(narrative);
  });
});
