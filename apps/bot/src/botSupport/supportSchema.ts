/**
 * Подключение схемы `support` к рантайму бота поддержки (issue #238).
 *
 * Schema engine — единственный путь исполнения консультации поддержки. Когда в
 * БД есть активная схема поддержки, консультация первой линии исполняется
 * интерпретатором схем. Legacy-пайплайн удалён: если активной схемы нет,
 * бросается {@link MissingActiveSchemaError}, и бот доставляет ошибку клиенту
 * (а не подменяет её тихим фолбэком) — см. src/botSupport/bot.ts.
 *
 * Семантический поиск экспертизы выполняется узлом `knowledge_query`, если в
 * контекст переданы `embeddingProvider` и положительный `expertiseTopK`.
 */
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { IEmbeddingProvider } from '@tg-games/core/llm/embeddings.js';
import type { ModelRouter } from '@tg-games/core/llm/router.js';
import type { LLMCallLogEntry } from '@tg-games/core/llm/trace.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';
import type { GameState } from '@tg-games/core/types.js';
import {
  describeSchemaExecutionError,
  executeSchema,
  MissingActiveSchemaError,
  type SchemaExecutionContext,
  type SchemaHistoryMessage,
} from '@tg-games/core/engine/schemaEngine.js';
import {
  getActiveSchema,
  logMissingActiveSchema,
  logSchemaExecution,
  makeSubSchemaResolver,
} from '@tg-games/core/db/repositories/schemas.js';
import {
  buildExpertiseBlock,
  compactSupportText,
  formatSupportDialog,
  parseSupportConsultation,
  type SupportConsultation,
  type SupportTurn,
} from './supportLlm.js';

/** Параметры исполнения консультации поддержки через schema engine. */
export interface SupportSchemaRequest {
  provider: ILLMProvider;
  router?: ModelRouter;
  embeddingProvider?: IEmbeddingProvider;
  /** Весь диалог обращения (от старых сообщений к новым). */
  turns: SupportTurn[];
  /** Последнее сообщение клиента. */
  lastMessage: string;
  /** Сколько документов экспертизы поддержки подтягивать узлом knowledge_query. */
  expertiseTopK?: number;
  maxRetries: number;
  /** Обращение — для аудита выполнения схемы. */
  ticketId?: string | null;
}

/** Решение консультанта, восстановленное из выполнения схемы. */
export interface SupportSchemaResult extends SupportConsultation {
  /** Скомпилированное описание проблемы для оператора (стадия 3), если есть. */
  compiledProblem: string;
  /** Технический лог всех обращений к LLM внутри схемы. */
  llmLog: LLMCallLogEntry[];
}

function supportManifest(): GameManifest {
  return {
    id: 'global',
    name: 'Глобальная схема поддержки',
    description: '',
    priceStars: 1,
    limits: { maxHp: 1, maxInventoryItems: 0 },
    worldRules: [],
    startTime: { season: 'весна', date: '', time: '00:00', time_of_day: 'утро' },
    characterPresets: [],
    locationPresets: [],
  };
}

function supportState(): GameState {
  return {
    location: '',
    narrative: '',
    character: { hp: 1, max_hp: 1, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'весна', date: '', time: '00:00', time_of_day: 'утро' },
    turn_count: 0,
  };
}

function outputString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Нормализует флаг решения консультанта (escalate/resolved) к булеву значению.
 * Модель иногда возвращает строковое "true"/"false" вместо булева, а порт `end`
 * не типизирован строго (any), поэтому приводим оба варианта; всё остальное
 * (в т.ч. отсутствующее значение) даёт undefined — вызывающий выбирает запасной
 * источник (issue #244).
 */
function outputBool(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/**
 * Восстанавливает решение консультанта (escalate/resolved/summary) из «сырого»
 * ответа узла консультации. Запасной путь для старых схем поддержки, где на `end`
 * не выведены флаги escalate/resolved (issue #244): сканирует выходы всех узлов и
 * берёт первый, чей raw парсится как ответ консультанта.
 */
function recoverConsultation(
  nodeOutputs: Map<string, Record<string, unknown>>,
): SupportConsultation | null {
  for (const outputs of nodeOutputs.values()) {
    const raw = outputs.raw;
    if (typeof raw !== 'string') continue;
    const parsed = parseSupportConsultation(raw);
    if (parsed) return parsed;
  }
  return null;
}

async function logSafely(input: Parameters<typeof logSchemaExecution>[0]): Promise<void> {
  try {
    await logSchemaExecution(input);
  } catch (err) {
    console.error(
      `[schema-engine] support: не удалось записать аудит выполнения схемы: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Исполняет консультацию поддержки через активную схему `support`.
 *
 * Schema engine — единственный путь исполнения (issue #238). Если активной
 * схемы нет, бросается {@link MissingActiveSchemaError}, и бот доставляет
 * ошибку клиенту. При ошибке выполнения схемы возвращается безопасное решение
 * escalate=true (обращение дойдёт до администратора живой поддержки).
 */
export async function runSupportViaSchema(
  request: SupportSchemaRequest,
): Promise<SupportSchemaResult> {
  // Консультация поддержки не привязана к игре — берём глобальную схему.
  const activeSchema = await getActiveSchema('support');
  if (!activeSchema) {
    // Активной support-схемы нет: фиксируем в журнале для админки (issue #255, этап F).
    // session_id ссылается на game_sessions, а ticketId — из support_tickets, поэтому
    // его не передаём (FK не пропустит); важна сама метка отсутствия схемы.
    await logMissingActiveSchema({ schemaType: 'support' });
    throw new MissingActiveSchemaError('support');
  }

  const dialog = formatSupportDialog(request.turns);
  // История переписки для узла support_history_read (issue #271): реплики тикета в
  // том же порядке, что и dialog, но как массив {role, message}. Имя оператора в
  // схемах — `operator` (в БД sender хранится как `admin`).
  const supportHistory: SchemaHistoryMessage[] = request.turns.map((turn) => ({
    role: turn.sender === 'admin' ? 'operator' : turn.sender,
    message: turn.text,
  }));
  const inputs = {
    user_query: request.lastMessage,
    dialog,
    last_message: compactSupportText(request.lastMessage),
    expertiseTopK: request.expertiseTopK ?? 0,
    // Запасное значение для старых support-схем без узла knowledge_query.
    expertise: buildExpertiseBlock([]),
  };
  const llmLog: LLMCallLogEntry[] = [];
  const ctx: SchemaExecutionContext = {
    inputs,
    nodeOutputs: new Map(),
    variables: new Map(),
    llmLog,
    provider: request.provider,
    router: request.router,
    embeddingProvider: request.embeddingProvider,
    manifest: supportManifest(),
    state: supportState(),
    supportHistory,
    maxRetries: request.maxRetries,
    // Домен экспертизы для узла knowledge_query (issue #353): support-рантайм ищет в
    // документах поддержки. Пайплайн support-схема несёт schemaType='support' сама,
    // но вложенные суб-схемы (класс common/support) его не несут — поле наследуется
    // ими через spread и направляет их knowledge_query в документы СП, а не игры.
    expertiseDomain: 'support',
    resolveSubSchema: makeSubSchemaResolver(undefined, 'support'),
  };

  const startedAt = Date.now();
  let outputs: Record<string, unknown>;
  try {
    outputs = await executeSchema(activeSchema.graphJson, ctx);
  } catch (err) {
    console.error(
      `[schema-engine] support: схема ${activeSchema.id} завершилась ошибкой: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    const errorInfo = describeSchemaExecutionError(activeSchema.graphJson, err);
    await logSafely({
      schemaSlug: activeSchema.schemaSlug,
      schemaType: 'support',
      gameId: activeSchema.gameId ?? null,
      sessionId: request.ticketId ?? null,
      status: 'error',
      inputsJson: inputs,
      outputsJson: { error: errorInfo.errorMessage },
      llmLog,
      durationMs: Date.now() - startedAt,
      errorNodeId: errorInfo.errorNodeId,
      errorNodeType: errorInfo.errorNodeType,
      errorMessage: errorInfo.errorMessage,
      errorLastRaw: errorInfo.errorLastRaw,
    });
    // Безопасный откат: передаём обращение администратору без описания.
    return { escalate: true, resolved: false, reply: '', compiledProblem: '', llmLog };
  }

  await logSafely({
    schemaSlug: activeSchema.schemaSlug,
    schemaType: 'support',
    gameId: activeSchema.gameId ?? null,
    sessionId: request.ticketId ?? null,
    status: 'ok',
    inputsJson: inputs,
    outputsJson: outputs,
    llmLog,
    durationMs: Date.now() - startedAt,
  });

  const consultation = recoverConsultation(ctx.nodeOutputs);
  // reply берём с выхода end; если его нет — из восстановленной консультации.
  const reply = outputString(outputs.reply) || consultation?.reply || '';
  // Решение консультанта читаем прямо с выходов узла end (issue #244). Для старых
  // схем без этих портов откатываемся к значению из «сырого» JSON, а если и его
  // нет — безопасно эскалируем к администратору (resolved при этом остаётся false).
  const escalate = outputBool(outputs.escalate) ?? consultation?.escalate ?? true;
  const resolved = outputBool(outputs.resolved) ?? consultation?.resolved ?? false;
  const summary = consultation?.summary;
  // Скомпилированное описание проблемы — с выхода end.summary (узел компиляции).
  const compiledProblem = outputString(outputs.summary);

  return { escalate, resolved, reply, summary, compiledProblem, llmLog };
}
