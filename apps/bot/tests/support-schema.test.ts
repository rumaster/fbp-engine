import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchemaRecord } from '@tg-games/core/db/repositories/schemas.js';
import type { SchemaGraph } from '@tg-games/schema-contract';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import { MissingActiveSchemaError } from '@tg-games/core/engine/schemaEngine.js';
import { buildDefaultSupportSchema } from '@tg-games/core/db/migrations/M001_prompt_templates_to_schemas.js';
import { TEST_PROMPT_TEMPLATES } from './fixtures/gameManifests.js';

const schemaRepositoryMock = vi.hoisted(() => ({
  getActiveSchema: vi.fn(),
  logSchemaExecution: vi.fn(),
  logMissingActiveSchema: vi.fn(),
  makeSubSchemaResolver: vi.fn(() => async () => null),
}));

vi.mock('@tg-games/core/db/repositories/schemas.js', () => schemaRepositoryMock);

import { runSupportViaSchema } from '../src/botSupport/supportSchema.js';

function activeSupportSchema(): SchemaRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    schemaSlug: 'support',
    schemaType: 'support',
    gameId: null,
    graphJson: buildDefaultSupportSchema(TEST_PROMPT_TEMPLATES),
    isActive: true,
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * Провайдер, отвечающий по порядку исполнения узлов support-схемы:
 * 1) детекция проблем, 2) консультация, 3) компиляция обращения.
 */
function sequenceProvider(responses: string[]): ILLMProvider {
  let i = 0;
  return {
    name: 'MockSupport',
    generateText: vi.fn(async (_opts: LLMRequestOptions) => {
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    }),
  };
}

describe('runSupportViaSchema (issue #238)', () => {
  beforeEach(() => {
    schemaRepositoryMock.getActiveSchema.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockReset();
    schemaRepositoryMock.logSchemaExecution.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('бросает MissingActiveSchemaError, когда активной схемы поддержки нет (issue #238: legacy удалён)', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(null);
    await expect(
      runSupportViaSchema({
        provider: sequenceProvider([]),
        turns: [{ sender: 'user', text: 'Не приходит ответ от бота' }],
        lastMessage: 'Не приходит ответ от бота',
        maxRetries: 1,
      }),
    ).rejects.toBeInstanceOf(MissingActiveSchemaError);
    expect(schemaRepositoryMock.getActiveSchema).toHaveBeenCalledWith('support');
  });

  it('исполняет схему и восстанавливает reply/escalate/resolved/compiledProblem', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeSupportSchema());
    const provider = sequenceProvider([
      JSON.stringify({ problems: ['оплата'] }),
      JSON.stringify({
        escalate: false,
        resolved: true,
        reply: 'Проверьте баланс звёзд в профиле.',
      }),
      JSON.stringify({ problem: 'Клиент не понимает, как пополнить звёзды.' }),
    ]);

    const result = await runSupportViaSchema({
      provider,
      turns: [{ sender: 'user', text: 'Как пополнить звёзды?' }],
      lastMessage: 'Как пополнить звёзды?',
      maxRetries: 1,
      ticketId: 'ticket-1',
    });

    expect(result).not.toBeNull();
    expect(result!.reply).toBe('Проверьте баланс звёзд в профиле.');
    expect(result!.escalate).toBe(false);
    expect(result!.resolved).toBe(true);
    expect(result!.compiledProblem).toBe('Клиент не понимает, как пополнить звёзды.');
    expect(schemaRepositoryMock.logSchemaExecution).toHaveBeenCalledTimes(1);
  });

  it('читает escalate/resolved с выхода узла end и нормализует строковые флаги (issue #244)', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeSupportSchema());
    // Модель иногда отдаёт булевы флаги строками — порт end не типизирован строго,
    // поэтому значение проходит по data-ребру до end как строка и нормализуется.
    const provider = sequenceProvider([
      JSON.stringify({ problems: ['оплата'] }),
      JSON.stringify({
        escalate: 'true',
        resolved: 'false',
        reply: 'Передаю обращение администратору.',
      }),
      JSON.stringify({ problem: 'Не проходит оплата звёздами.' }),
    ]);

    const result = await runSupportViaSchema({
      provider,
      turns: [{ sender: 'user', text: 'Оплата не проходит' }],
      lastMessage: 'Оплата не проходит',
      maxRetries: 1,
      ticketId: 'ticket-2',
    });

    expect(result.escalate).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.reply).toBe('Передаю обращение администратору.');
    expect(result.compiledProblem).toBe('Не проходит оплата звёздами.');
  });

  it('безопасно эскалирует при ошибке выполнения схемы', async () => {
    schemaRepositoryMock.getActiveSchema.mockResolvedValue(activeSupportSchema());
    const provider: ILLMProvider = {
      name: 'Broken',
      generateText: vi.fn(async () => {
        throw new Error('LLM недоступна');
      }),
    };

    const result = await runSupportViaSchema({
      provider,
      turns: [{ sender: 'user', text: 'Проблема' }],
      lastMessage: 'Проблема',
      maxRetries: 1,
    });

    expect(result).not.toBeNull();
    expect(result!.escalate).toBe(true);
    expect(result!.resolved).toBe(false);
    expect(result!.reply).toBe('');
    expect(result!.compiledProblem).toBe('');
  });

  it('узел support_history_read получает переписку тикета с ролью operator для admin (issue #271)', async () => {
    // Кастомная схема: support_history_read → transform (сериализация) → end.reply.
    // Проверяем, что турны тикета прокинуты в supportHistory и sender=admin
    // отображается как роль operator (в БД оператор хранится как admin).
    const historyGraph: SchemaGraph = {
      version: 1,
      schemaType: 'support',
      slug: 'support',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'history', type: 'support_history_read', position: { x: 120, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 280, y: 0 },
          config: { code: 'return JSON.stringify(input.messages);', inputs: [{ name: 'messages', type: 'object_array' }] },
        },
        { id: 'end', type: 'end', position: { x: 440, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'messages', from: 'history', fromPort: 'messages', to: 'transform', toPort: 'messages' },
        { id: 'reply', from: 'transform', fromPort: 'result', to: 'end', toPort: 'reply' },
      ],
    };
    schemaRepositoryMock.getActiveSchema.mockResolvedValue({ ...activeSupportSchema(), graphJson: historyGraph });

    const result = await runSupportViaSchema({
      provider: sequenceProvider([]),
      turns: [
        { sender: 'user', text: 'Не пришли звёзды' },
        { sender: 'admin', text: 'Проверяю платёж' },
        { sender: 'bot', text: 'Платёж найден' },
      ],
      lastMessage: 'Не пришли звёзды',
      maxRetries: 1,
    });

    expect(JSON.parse(result.reply)).toEqual([
      { role: 'user', message: 'Не пришли звёзды' },
      { role: 'operator', message: 'Проверяю платёж' },
      { role: 'bot', message: 'Платёж найден' },
    ]);
  });
});
