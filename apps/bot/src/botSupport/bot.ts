import { Telegraf, type Telegram } from 'telegraf';
import { message } from 'telegraf/filters';
import type { AppConfig } from '@tg-games/core/config.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { IEmbeddingProvider } from '@tg-games/core/llm/embeddings.js';
import type { LLMCallKind, LLMCallLogEntry } from '@tg-games/core/llm/trace.js';
import {
  buildLlmRequestLogInputs,
  insertLlmRequestLogsSafely,
} from '@tg-games/core/db/repositories/llmLogs.js';
import { createModelRouter } from '@tg-games/core/llm/router.js';
import { MissingActiveSchemaError } from '@tg-games/core/engine/schemaEngine.js';
import { runSupportViaSchema, type SupportSchemaResult } from './supportSchema.js';
import { listAdmins, upsertUser } from '@tg-games/core/db/repositories/users.js';
import {
  addSupportMessage,
  autoCloseTicket,
  getOrCreateActiveTicket,
  listTicketMessages,
  markTicketEscalated,
} from '@tg-games/core/db/repositories/support.js';
import { type SupportTurn } from './supportLlm.js';
import {
  SUPPORT_DEFAULT_REPLY,
  SUPPORT_ERROR_REPLY,
  SUPPORT_ESCALATION_REPLY,
  SUPPORT_START_TEXT,
  adminNotificationMessage,
  botSupportMessage,
  clientReplyMessage,
  compiledProblemMessage,
  formatUserLabel,
  messageAcceptedMessage,
  ticketAutoClosedMessage,
  ticketCreatedMessage,
  ticketEscalatedMessage,
} from './messages.js';

/** Зависимости клиентского бота поддержки. */
export interface ClientSupportDeps {
  /**
   * Клиент Telegram API бота администраторов — через него рассылаются
   * уведомления о новых обращениях всем пользователям с is_admin.
   */
  adminNotifier: Pick<Telegram, 'sendMessage'>;
  /**
   * LLM-провайдер для бота-консультанта первой линии (issue #59). Если не задан
   * или консультация отключена в конфиге, обращение сразу передаётся админам.
   */
  provider?: ILLMProvider;
  /**
   * Провайдер эмбеддингов для поиска экспертизы (issue #147). Если не задан
   * или выбранный провайдер не настроен, консультант работает без справочных
   * материалов.
   */
  embeddingProvider?: IEmbeddingProvider;
  /**
   * Ленивая фабрика эмбеддингов: читает глобальный default перед обращением к
   * схеме, чтобы смена модели в админке применялась без рестарта бота.
   */
  embeddingProviderFactory?: () => Promise<IEmbeddingProvider | undefined>;
}

/** Короткий предпросмотр текста сообщения для уведомления администраторов. */
function preview(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/**
 * Рассылает уведомление о новом обращении всем администраторам.
 * Ошибка доставки одному администратору (например, он не нажимал /start
 * в боте администраторов) не прерывает рассылку остальным.
 */
async function notifyAdmins(
  deps: ClientSupportDeps,
  ticketNumber: string,
  userLabel: string,
  text: string,
): Promise<void> {
  const admins = await listAdmins();
  const body = adminNotificationMessage({ ticketNumber, userLabel, preview: preview(text) });
  await Promise.all(
    admins.map(async (admin) => {
      try {
        await deps.adminNotifier.sendMessage(Number(admin.telegram_id), body);
      } catch (err) {
        console.error(`Не удалось уведомить администратора ${admin.telegram_id}:`, err);
      }
    }),
  );
}

/**
 * Создаёт клиентский бот службы поддержки.
 *
 * Любое текстовое сообщение клиента попадает в его открытое обращение
 * (создаётся при отсутствии) и сохраняется в БД. Дальше логика зависит от
 * стадии обращения (issue #59):
 *
 *  - обращение ещё не передано администратору и включён LLM-консультант —
 *    «Бот СП» консультирует клиента/собирает детали и при готовности передаёт
 *    обращение администратору со скомпилированным описанием;
 *  - LLM-консультант отключён — обращение сразу передаётся администраторам
 *    (поведение до появления консультанта);
 *  - обращение уже передано администратору — сообщение просто подшивается,
 *    клиент получает подтверждение, дальше отвечает живой администратор.
 */
export function createClientSupportBot(config: AppConfig, deps: ClientSupportDeps): Telegraf {
  const bot = new Telegraf(config.support.clientBotToken);
  const consultationEnabled = config.support.llmConsultation && Boolean(deps.provider);

  bot.start(async (ctx) => {
    await upsertUser(ctx.from.id, ctx.from.username);
    await ctx.reply(SUPPORT_START_TEXT);
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text;
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { ticket } = await getOrCreateActiveTicket(user.id);
    await addSupportMessage({
      ticketId: ticket.id,
      sender: 'user',
      senderId: user.id,
      text,
    });
    const userLabel = formatUserLabel(user.username, user.telegram_id);

    // Обращение уже передано администратору — консультант не вмешивается.
    if (ticket.escalated_at) {
      await ctx.reply(messageAcceptedMessage(ticket.number));
      return;
    }

    // Консультант отключён — сразу передаём обращение администраторам.
    if (!consultationEnabled || !deps.provider) {
      await markTicketEscalated(ticket.id);
      await ctx.reply(ticketCreatedMessage(ticket.number));
      await notifyAdmins(deps, ticket.number, userLabel, text);
      return;
    }

    // Консультация LLM по всему диалогу обращения.
    const history = await listTicketMessages(ticket.id);
    const turns: SupportTurn[] = history.map((m) => ({ sender: m.sender, text: m.text }));
    // Маршрутизатор моделей (issue #345): все LLM-узлы поддержки используют
    // глобальную default-модель поверх активного провайдера.
    const router = createModelRouter(config, deps.provider);
    const embeddingProvider = deps.embeddingProvider ?? await deps.embeddingProviderFactory?.();

    // Базовый контекст аудита LLM для текущего обращения.
    const logContext = (route: Awaited<ReturnType<typeof router.resolve>>) => ({
      userId: user.id,
      supportTicketId: ticket.id,
      provider: route.provider.name,
      model: route.model,
      modelParams: {
        provider: route.providerName,
        temperature: config.llm.temperature,
        maxRetries: config.llm.maxRetries,
      },
      pricing: route.pricing,
    });

    // Записывает лог обращений к LLM, сделанных внутри схемы, маршрутизируя
    // каждую запись по её kind (issue #238).
    const logSchemaSupportLlm = async (entries: LLMCallLogEntry[]): Promise<void> => {
      const byKind = new Map<LLMCallKind, LLMCallLogEntry[]>();
      for (const entry of entries) {
        if (!entry.kind) continue;
        const list = byKind.get(entry.kind) ?? [];
        list.push(entry);
        byKind.set(entry.kind, list);
      }
      const logs = [];
      for (const [, list] of byKind) {
        const route = await router.resolve(list[0].kind ?? 'support_consultation');
        logs.push(...buildLlmRequestLogInputs(list, logContext(route)));
      }
      await insertLlmRequestLogsSafely(logs, 'консультация поддержки (схема)');
    };

    // issue #238: консультацию ведёт ТОЛЬКО активная схема support. Legacy-
    // пайплайн удалён — если активной схемы нет, runSupportViaSchema бросает
    // MissingActiveSchemaError, и мы доставляем клиенту ошибку (а не подменяем
    // её тихим фолбэком).
    let schemaResult: SupportSchemaResult;
    try {
      schemaResult = await runSupportViaSchema({
      provider: deps.provider,
      router,
      embeddingProvider,
        turns,
        lastMessage: text,
        expertiseTopK: config.embedding?.topK ?? 0,
        maxRetries: config.llm.maxRetries,
        ticketId: ticket.id,
      });
    } catch (err) {
      if (err instanceof MissingActiveSchemaError) {
        console.error(`[schema-engine] support: ${err.message}`);
        await ctx.reply(SUPPORT_ERROR_REPLY);
        return;
      }
      throw err;
    }

    await logSchemaSupportLlm(schemaResult.llmLog);
    // Унифицированное решение консультанта и ленивая компиляция описания
    // проблемы (стадия 3): описание схема компилирует заранее (узел компиляции).
    const result: { reply: string; escalate: boolean; resolved: boolean; summary?: string } = {
      reply: schemaResult.reply,
      escalate: schemaResult.escalate,
      resolved: schemaResult.resolved,
      summary: schemaResult.summary,
    };
    const runCompilation = async (): Promise<string> => schemaResult.compiledProblem;

    // Автоматическое закрытие: клиент явно подтвердил, что проблема решена (issue #149).
    if (result.resolved) {
      const reply = result.reply || SUPPORT_DEFAULT_REPLY;
      await addSupportMessage({ ticketId: ticket.id, sender: 'bot', senderId: null, text: reply });
      await ctx.reply(botSupportMessage(reply));
      await autoCloseTicket(ticket.id);
      await ctx.reply(ticketAutoClosedMessage(ticket.number));
      return;
    }

    if (!result.escalate) {
      // Бот продолжает консультировать — сохраняем его реплику и отвечаем клиенту.
      const reply = result.reply || SUPPORT_DEFAULT_REPLY;
      await addSupportMessage({ ticketId: ticket.id, sender: 'bot', senderId: null, text: reply });
      await ctx.reply(botSupportMessage(reply));
      return;
    }

    // Стадия 3 (issue #147): компилируем итоговую формулировку проблемы для
    // специалистов. При неуспехе — откат к summary стадии 2, затем к превью.
    const compiledProblem = await runCompilation();

    // Передаём обращение администратору с готовым описанием проблемы.
    const summary = compiledProblem || result.summary?.trim() || preview(text);
    const reply = result.reply || SUPPORT_ESCALATION_REPLY;
    await addSupportMessage({ ticketId: ticket.id, sender: 'bot', senderId: null, text: reply });
    // Скомпилированную формулировку проблемы (стадия 3, issue #147) подшиваем в
    // обращение отдельным сообщением — чтобы она осталась в истории и попала к
    // специалистам СП. Клиенту её не отправляем (доставка только через ctx.reply).
    if (compiledProblem) {
      await addSupportMessage({
        ticketId: ticket.id,
        sender: 'bot',
        senderId: null,
        text: compiledProblemMessage(compiledProblem),
      });
    }
    await markTicketEscalated(ticket.id);
    await ctx.reply(botSupportMessage(reply));
    await ctx.reply(ticketEscalatedMessage(ticket.number));
    await notifyAdmins(deps, ticket.number, userLabel, summary);
  });

  return bot;
}

/**
 * Отправляет клиенту ответ администратора. Используется ботом администраторов
 * через общий Telegram-клиент клиентского бота.
 */
export async function sendReplyToClient(
  clientNotifier: Pick<Telegram, 'sendMessage'>,
  clientTelegramId: string | number,
  text: string,
): Promise<void> {
  await clientNotifier.sendMessage(Number(clientTelegramId), clientReplyMessage(text));
}
