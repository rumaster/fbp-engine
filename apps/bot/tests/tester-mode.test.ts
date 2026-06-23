import { Telegram } from 'telegraf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { BTN } from '../src/bot/menus.js';
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

const tester = {
  id: 'user-1',
  telegram_id: '123',
  username: 'alice',
  active_session_id: 'sess-1',
  is_tester: true,
  created_at: new Date('2026-05-27T10:00:00Z'),
};

const session: SessionRow = {
  id: 'sess-1',
  game_id: 'bomj',
  user_id: tester.id,
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
      chat: {
        id: 123,
        type: 'private',
        first_name: 'Alice',
        username: 'alice',
      },
      from: {
        id: 123,
        is_bot: false,
        first_name: 'Alice',
        username: 'alice',
      },
      text,
    },
  } as any;
}

function createMockBot(provider: ILLMProvider) {
  const bot = createBot(config, provider);
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: 'Test Bot',
    username: 'test_bot',
  };
  return bot;
}

function documentPayload(callApi: ReturnType<typeof vi.spyOn>) {
  const sendDocumentCall = callApi.mock.calls.find(([method]) => method === 'sendDocument');
  expect(sendDocumentCall).toBeDefined();
  return sendDocumentCall?.[1] as {
    chat_id: number;
    document: { source: Buffer; filename?: string };
  };
}

describe('tester mode (#17)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
    mockActiveSchemasByType(schemaRepositoryMock.getActiveSchema);
    vi.mocked(usersRepo.upsertUser).mockResolvedValue(tester);
    vi.mocked(sessionsRepo.getActiveSession).mockResolvedValue(session);
    vi.mocked(sessionsRepo.acquireProcessingLock).mockResolvedValue(true);
    vi.mocked(sessionsRepo.releaseProcessingLock).mockResolvedValue();
    vi.mocked(sessionsRepo.updateSessionState).mockResolvedValue();
    vi.mocked(stepsRepo.insertStep).mockResolvedValue(step);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('после подсказки отправляет тестеру файл с логом LLM-запроса', async () => {
    const rawHints = JSON.stringify(['идти', 'искать', 'ждать']);
    const provider: ILLMProvider = {
      name: 'mock',
      generateText: vi.fn(),
      generateTextResult: vi.fn(async (_opts: LLMRequestOptions) => ({
        text: rawHints,
        usage: {
          promptTokens: 35,
          completionTokens: 12,
          totalTokens: 50,
          cacheReadTokens: 5,
          cacheCreationTokens: 3,
        },
      })),
    };
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

    await createMockBot(provider).handleUpdate(textMessageUpdate(BTN.hint));

    const methods = callApi.mock.calls.map(([method]) => method);
    expect(methods).toContain('sendMessage');
    expect(methods).toContain('sendDocument');

    const payload = documentPayload(callApi);
    expect(payload.chat_id).toBe(123);
    expect(payload.document.filename).toBe('подсказка.txt');
    const content = payload.document.source.toString('utf8');
    expect(content).toContain('Запрос:');
    expect(content).toContain('Текущее состояние игры:');
    expect(content).toContain('Ответ:');
    expect(content).toContain(rawHints);
    expect(content).toContain('Затраты:');
    expect(content).toContain('inputTokens: 30');
    expect(content).toContain('outputTokens: 12');
    expect(content).toContain('cacheReadTokens: 5');
    expect(content).toContain('cacheCreationTokens: 3');
    expect(content).toContain('cost_millicents:');
    expect(content).not.toContain('50 (запрос: 35, ответ: 12)');
  });

  it('после игрового шага отправляет тестеру файл с логом и именем по id шага', async () => {
    const next = { ...session.current_state, narrative: 'Вы нашли монету' };
    // issue #238: один совмещённый ответ удовлетворяет все типизированные узлы
    // action-схемы (narrative/inventory/characteristics/world_flags/updated_state),
    // поэтому raw каждого узла равен этому тексту.
    const rawTurn = JSON.stringify({
      narrative: 'Вы нашли монету',
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
        usage: {
          promptTokens: 90,
          completionTokens: 19,
          totalTokens: 111,
          cacheReadTokens: 10,
          cacheCreationTokens: 2,
        },
      })),
    };
    const callApi = vi.spyOn(Telegram.prototype as any, 'callApi').mockResolvedValue({});

    await createMockBot(provider).handleUpdate(textMessageUpdate('осмотреться'));

    const insertInput = vi.mocked(stepsRepo.insertStep).mock.calls[0]?.[0];
    expect(insertInput).toEqual(
      expect.objectContaining({
        sessionId: session.id,
        actionText: 'осмотреться',
      }),
    );
    const rawResponse = JSON.parse(insertInput?.llmRawResponse ?? '{}') as Record<string, string>;
    expect(rawResponse).toMatchObject({
      narrative: rawTurn,
      inventory: rawTurn,
      characteristics: rawTurn,
      flags: rawTurn,
      other_state: rawTurn,
    });
    expect(sessionsRepo.updateSessionState).toHaveBeenCalled();

    const payload = documentPayload(callApi);
    expect(payload.chat_id).toBe(123);
    expect(payload.document.filename).toBe('step-42.txt');
    const content = payload.document.source.toString('utf8');
    expect(content).toContain('Запрос:');
    expect(content).toContain('Действие игрока: "осмотреться"');
    expect(content).toContain('Ответ:');
    expect(content).toContain(rawTurn);
    expect(content).toContain('Затраты:');
    expect(content).toContain('inputTokens: 80');
    expect(content).toContain('outputTokens: 19');
    expect(content).toContain('cacheReadTokens: 10');
    expect(content).toContain('cacheCreationTokens: 2');
    expect(content).toContain('cost_millicents:');
    expect(content).not.toContain('111 (запрос: 90, ответ: 19)');
  });
});
