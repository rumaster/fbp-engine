import type { ILLMProvider } from '../llm/ILLMProvider.js';
import type {
  LLMCallKind,
  LLMCallLogEntry,
} from '../llm/trace.js';
import type { ModelRouter } from '../llm/router.js';
import type { IEmbeddingProvider } from '../llm/embeddings.js';
import type { GameManifest } from '../games/manifests.js';
import { ensureWorldTime } from '../games/manifests.js';
import type { GameState, TurnHistoryEntry } from '../types.js';
import {
  describeSchemaExecutionError,
  executeSchema,
  MissingActiveSchemaError,
  SchemaNodeExecutionError,
  type SchemaExecutionContext,
} from './schemaEngine.js';
import type { MemoryCell, ExtractedMemoryCell } from './memory.js';
import {
  getActiveSchema,
  logMissingActiveSchema,
  logSchemaExecution,
  makeSubSchemaResolver,
  type SchemaExecutionLogInput,
} from '../db/repositories/schemas.js';
import { extractHints, extractJson, sanitizeState } from './validation.js';
import {
  type TokenUsage,
  type ModelPricing,
  calcCostMillicents,
  emptyTokenUsage,
  usageToTokenUsage,
} from '../llm/pricing.js';

/** Сообщение игроку, когда LLM не смогла вернуть валидный JSON. */
export const UNSTABLE_WORLD_MESSAGE =
  'Мир игры временно нестабилен. Попробуйте повторить действие позже.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Переводит суммарный расход токенов из лога LLM в игровые кредиты.
 * 1 кредит = 1 токен (целочисленно, минимум 0).
 * Используется как резервный подсчёт, когда цена модели неизвестна.
 */
export function tokensToCredits(log: LLMCallLogEntry[]): number {
  let total = 0;
  for (const entry of log) {
    total += entry.usage?.totalTokens ?? 0;
  }
  return Math.max(0, Math.ceil(total));
}

/**
 * Агрегирует детализированный расход токенов из всего лога LLM-запросов.
 * Суммирует inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens
 * по всем записям лога.
 */
export function aggregateTokenUsage(log: LLMCallLogEntry[]): TokenUsage {
  const result = emptyTokenUsage();
  for (const entry of log) {
    const usage = usageToTokenUsage(entry.usage);
    result.inputTokens += usage.inputTokens;
    result.outputTokens += usage.outputTokens;
    result.cacheReadTokens += usage.cacheReadTokens;
    result.cacheCreationTokens += usage.cacheCreationTokens;
  }
  return result;
}

/**
 * Вычисляет стоимость в миллицентах и кредиты (≈ токены) для лога запросов.
 * Если цена модели известна — использует точный расчёт по ценам.
 * Иначе — возвращает costMillicents = 0 (стоимость неизвестна).
 */
export function calcLLMCost(
  log: LLMCallLogEntry[],
  pricing: ModelPricing | null,
): { tokenUsage: TokenUsage; creditsUsed: number; costMillicents: number } {
  const tokenUsage = aggregateTokenUsage(log);
  const creditsUsed = tokensToCredits(log);
  const costMillicents = pricing ? calcCostMillicents(tokenUsage, pricing) : 0;
  return { tokenUsage, creditsUsed, costMillicents };
}

/**
 * Считает стоимость лога через resolver цены по kind. Сейчас все текстовые
 * запросы обычно получают одну глобальную default-модель, но формат оставлен
 * покиндовым, чтобы корректно считать уже сгруппированный аудит схем.
 */
export function calcLLMCostByKind(
  log: LLMCallLogEntry[],
  pricingForKind: (kind: LLMCallKind | undefined) => ModelPricing | null,
): { tokenUsage: TokenUsage; creditsUsed: number; costMillicents: number } {
  const tokenUsage = aggregateTokenUsage(log);
  const creditsUsed = tokensToCredits(log);
  let costMillicents = 0;
  for (const entry of log) {
    const pricing = pricingForKind(entry.kind);
    if (pricing) {
      costMillicents += calcCostMillicents(usageToTokenUsage(entry.usage), pricing);
    }
  }
  return { tokenUsage, creditsUsed, costMillicents };
}

/** Результат обработки игрового хода. */
export type TurnResult =
  | {
      ok: true;
      /** Текст исхода для игрока (narrative + заметки санитизации). */
      narrative: string;
      /** Новое (санитизированное) состояние для записи в БД. */
      newState: GameState;
      /** Сырой ответ LLM (для отладки промптов, поле llm_raw_response). */
      rawResponse: string;
      /** Игра завершена (HP <= 0). */
      gameOver: boolean;
      /** Лог всех фактических запросов к LLM в рамках хода. */
      llmLog: LLMCallLogEntry[];
      /** Кредиты, израсходованные на запросы к LLM в этом ходе. */
      creditsUsed: number;
      /** Детализация расхода токенов по категориям. */
      tokenUsage: TokenUsage;
      /** Оценка стоимости хода в тысячных долях цента (миллицентах, 0 если модель не в справочнике). */
      costMillicents: number;
      /**
       * Новые ячейки долговременной памяти, выделенные финальной фазой хода
       * (issue #166). Заполняется только при включённой памяти и непустом
       * результате; сохранение в БД выполняет вызывающий код (bot.ts).
       */
      memoryUpdate?: { added: ExtractedMemoryCell[] };
    }
  | {
      ok: false;
      /** Сообщение об ошибке для игрока. Состояние НЕ меняется. */
      narrative: string;
      /** Последний сырой ответ LLM (если был получен). */
      rawResponse?: string;
      /** Лог всех фактических запросов к LLM в рамках хода. */
      llmLog: LLMCallLogEntry[];
      /** Кредиты, израсходованные на запросы к LLM в этом ходе (даже при ошибке). */
      creditsUsed: number;
      /** Детализация расхода токенов по категориям. */
      tokenUsage: TokenUsage;
      /** Оценка стоимости хода в тысячных долях цента (миллицентах, 0 если модель не в справочнике). */
      costMillicents: number;
    };

export interface ProcessTurnOptions {
  provider: ILLMProvider;
  manifest: GameManifest;
  state: GameState;
  action: string;
  /** Компактная история прошлых ходов для памяти LLM. */
  history?: TurnHistoryEntry[];
  /** Максимум попыток получить валидный JSON. По умолчанию 3. */
  maxRetries?: number;
  /** Цены текущей LLM-модели для подсчёта стоимости. null — стоимость не считается. */
  pricing?: ModelPricing | null;
  /**
   * Маршрутизатор моделей (issue #345). Если задан, каждая фаза хода берёт
   * провайдера, глобальную default-модель и цену из него; иначе используется
   * `provider`/`pricing`, как раньше.
   */
  router?: ModelRouter;
  /**
   * Стабильный идентификатор для маршрутизации запросов в общий кеш промпта
   * (для OpenAI — `prompt_cache_key`). Обычно — ID игровой сессии.
   */
  cacheKey?: string;
  /**
   * Провайдер эмбеддингов для подтягивания экспертизы игры (issue #154, фаза 0).
   * Если не задан — фаза 0 пропускается, ход идёт без справочных материалов,
   * как раньше.
   */
  embeddingProvider?: IEmbeddingProvider;
  /** Сколько документов базы знаний игры подтягивать в нарратив (issue #154). */
  expertiseTopK?: number;
  /**
   * Ячейки долговременной памяти игры, заранее загруженные из БД (issue #166).
   * Из них детерминированно отбирается верхушка (по важности и свежести) и
   * подставляется в промпт нарратива. Также служат контекстом «уже известные
   * факты» для финальной фазы извлечения, чтобы не дублировать ячейки.
   */
  memoryCells?: MemoryCell[];
  /**
   * Сколько ячеек памяти максимум подставлять в нарратив (issue #166). Один
   * рубильник: `> 0` включает И подстановку памяти, И финальную фазу извлечения
   * новых фактов; `0` (по умолчанию) — память отключена, ход идёт как раньше.
   */
  memoryTopK?: number;
}

function outputString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function outputStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function outputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeMemoryUpdate(value: unknown): { added: ExtractedMemoryCell[] } | undefined {
  const record = outputRecord(value);
  const added = Array.isArray(record.added)
    ? record.added.filter((item): item is ExtractedMemoryCell => {
        const candidate = outputRecord(item);
        return (
          typeof candidate.content === 'string' &&
          typeof candidate.category === 'string' &&
          typeof candidate.importance === 'number'
        );
      })
    : [];
  return added.length > 0 ? { added } : undefined;
}

function schemaSessionId(cacheKey: string | undefined): string | null {
  return cacheKey && UUID_RE.test(cacheKey) ? cacheKey : null;
}

async function logSchemaExecutionSafely(input: SchemaExecutionLogInput): Promise<void> {
  try {
    await logSchemaExecution(input);
  } catch (err) {
    console.warn(
      `[schema-engine] не удалось записать журнал схемы ${input.schemaSlug}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function calcSchemaLLMCost(
  log: LLMCallLogEntry[],
  pricing: ModelPricing | null,
  router?: ModelRouter,
): Promise<{ tokenUsage: TokenUsage; creditsUsed: number; costMillicents: number }> {
  if (!router) return calcLLMCost(log, pricing);

  const pricingByKind = new Map<LLMCallKind, ModelPricing | null>();
  for (const entry of log) {
    if (!entry.kind || pricingByKind.has(entry.kind)) continue;
    try {
      const route = await router.resolve(entry.kind);
      pricingByKind.set(entry.kind, route.pricing);
    } catch (err) {
      console.warn(
        `[schema-engine] не удалось получить цену модели для ${entry.kind}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      pricingByKind.set(entry.kind, null);
    }
  }

  return calcLLMCostByKind(log, (kind) => (kind ? (pricingByKind.get(kind) ?? null) : null));
}

async function processViaSchema(options: ProcessTurnOptions): Promise<TurnResult | null> {
  const activeSchema = await getActiveSchema('action', options.manifest.id);
  if (!activeSchema) return null;

  const { provider, manifest, action } = options;
  const history = options.history ?? [];
  const maxRetries = options.maxRetries ?? 3;
  const pricing = options.pricing ?? null;
  const expertiseTopK = options.expertiseTopK ?? 0;
  const memoryTopK = options.memoryTopK ?? 0;
  const inputs = {
    action,
    history,
    expertiseTopK,
    memoryTopK,
    expertise_enabled: Boolean(options.embeddingProvider && expertiseTopK > 0),
    memory_enabled: memoryTopK > 0,
  };
  const llmLog: LLMCallLogEntry[] = [];
  const ctx: SchemaExecutionContext = {
    inputs,
    nodeOutputs: new Map(),
    variables: new Map(),
    llmLog,
    provider,
    ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
    ...(options.router ? { router: options.router } : {}),
    manifest,
    state: {
      ...options.state,
      world_time: ensureWorldTime(options.state.world_time, manifest.startTime),
    },
    memoryCells: options.memoryCells ?? [],
    cacheKey: options.cacheKey,
    maxRetries,
    resolveSubSchema: makeSubSchemaResolver(options.manifest.id, 'action'),
  };
  const startedAt = Date.now();
  let outputs: Record<string, unknown> = {};

  try {
    outputs = await executeSchema(activeSchema.graphJson, ctx);
  } catch (err) {
    const rawResponse = err instanceof SchemaNodeExecutionError ? err.lastRaw : undefined;
    console.error(
      `[schema-engine] action: схема ${activeSchema.id} завершилась ошибкой: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    const { tokenUsage, creditsUsed, costMillicents } = await calcSchemaLLMCost(
      llmLog,
      pricing,
      options.router,
    );
    const errorInfo = describeSchemaExecutionError(activeSchema.graphJson, err);
    await logSchemaExecutionSafely({
      schemaSlug: activeSchema.schemaSlug,
      schemaType: 'action',
      gameId: manifest.id,
      sessionId: schemaSessionId(options.cacheKey),
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
    return {
      ok: false,
      narrative: UNSTABLE_WORLD_MESSAGE,
      rawResponse,
      llmLog,
      creditsUsed,
      tokenUsage,
      costMillicents,
    };
  }

  const narrative = outputString(outputs.narrative) ?? ctx.state.narrative;
  const { state: sanitized, notes, gameOver } = sanitizeState(ctx.state, manifest);
  const outcome = notes.length ? `${narrative}\n\n${notes.join(' ')}` : narrative;
  const rawResponse = JSON.stringify({
    narrative: outputString(outputs.rawNarrative) ?? '',
    inventory: outputString(outputs.rawInventory) ?? '',
    characteristics: outputString(outputs.rawCharacteristics) ?? '',
    flags: outputString(outputs.rawFlags) ?? '',
    other_state: outputString(outputs.rawOtherState) ?? '',
  });
  const memoryUpdate =
    normalizeMemoryUpdate(outputs.memoryUpdate) ??
    normalizeMemoryUpdate(ctx.variables.get('memoryUpdate'));
  const { tokenUsage, creditsUsed, costMillicents } = await calcSchemaLLMCost(
    llmLog,
    pricing,
    options.router,
  );
  const result: TurnResult = {
    ok: true,
    narrative: outcome,
    newState: { ...sanitized, turn_count: ctx.state.turn_count + 1 },
    rawResponse,
    gameOver,
    llmLog,
    creditsUsed,
    tokenUsage,
    costMillicents,
    ...(memoryUpdate ? { memoryUpdate } : {}),
  };

  await logSchemaExecutionSafely({
    schemaSlug: activeSchema.schemaSlug,
    schemaType: 'action',
    gameId: manifest.id,
    sessionId: schemaSessionId(options.cacheKey),
    status: 'ok',
    inputsJson: inputs,
    outputsJson: outputs,
    llmLog,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

function hintSchemaManifest(state: GameState): GameManifest {
  return {
    id: 'global',
    name: 'Глобальная схема подсказок',
    description: '',
    priceStars: 1,
    limits: {
      maxHp: Math.max(1, state.character.max_hp),
      maxInventoryItems: Math.max(0, state.character.inventory.length),
    },
    worldRules: [],
    startTime: state.world_time,
    characterPresets: [],
    locationPresets: [],
  };
}

async function getHintsViaSchema(
  provider: ILLMProvider,
  state: GameState,
  maxRetries: number,
  history: TurnHistoryEntry[],
  pricing: ModelPricing | null,
  cacheKey: string | undefined,
  gameId: string | null,
): Promise<HintsResult | null> {
  // issue #238: подсказки выбирают схему с учётом игры (game → global fallback),
  // чтобы каждая игра могла переопределить генерацию подсказок собственной схемой.
  const activeSchema = await getActiveSchema('hint', gameId ?? undefined);
  if (!activeSchema) return null;

  const normalizedState: GameState = {
    ...state,
    world_time: ensureWorldTime(state.world_time),
  };
  const inputs = { history };
  const llmLog: LLMCallLogEntry[] = [];
  const ctx: SchemaExecutionContext = {
    inputs,
    nodeOutputs: new Map(),
    variables: new Map(),
    llmLog,
    provider,
    manifest: hintSchemaManifest(normalizedState),
    state: normalizedState,
    cacheKey,
    maxRetries,
    resolveSubSchema: makeSubSchemaResolver(gameId, 'hint'),
  };
  const startedAt = Date.now();
  let outputs: Record<string, unknown> = {};

  try {
    outputs = await executeSchema(activeSchema.graphJson, ctx);
  } catch (err) {
    console.error(
      `[schema-engine] hint: схема ${activeSchema.id} завершилась ошибкой: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    const { tokenUsage, creditsUsed, costMillicents } = calcLLMCost(llmLog, pricing);
    const errorInfo = describeSchemaExecutionError(activeSchema.graphJson, err);
    await logSchemaExecutionSafely({
      schemaSlug: activeSchema.schemaSlug,
      schemaType: 'hint',
      gameId: activeSchema.gameId ?? null,
      sessionId: schemaSessionId(cacheKey),
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
    return { hints: [], llmLog, creditsUsed, tokenUsage, costMillicents };
  }

  let hints = outputStringArray(outputs.hints);
  if (hints.length === 0) {
    const raw = outputString(outputs.rawHints);
    if (raw) {
      try {
        hints = extractHints(extractJson(raw));
      } catch {
        hints = [];
      }
    }
  }

  const { tokenUsage, creditsUsed, costMillicents } = calcLLMCost(llmLog, pricing);
  await logSchemaExecutionSafely({
    schemaSlug: activeSchema.schemaSlug,
    schemaType: 'hint',
    gameId: activeSchema.gameId ?? null,
    sessionId: schemaSessionId(cacheKey),
    status: 'ok',
    inputsJson: inputs,
    outputsJson: outputs,
    llmLog,
    durationMs: Date.now() - startedAt,
  });
  return { hints: hints.slice(0, 3), llmLog, creditsUsed, tokenUsage, costMillicents };
}

/**
 * Движок-редуктор: [действие] + [текущее состояние] → [новое состояние].
 *
 * Исполнение идёт ТОЛЬКО через активную `action`-схему (issue #238). Legacy
 * 5-фазный пайплайн удалён: если активной схемы нет, бросается
 * {@link MissingActiveSchemaError} — вызывающий код доставляет ошибку игроку и
 * фиксирует её в логе ошибок выполнения админки. Сама схема выполняет фазы
 * нарратива/состояния, санитизацию и подсчёт стоимости (см. processViaSchema).
 */
export async function processTurn(options: ProcessTurnOptions): Promise<TurnResult> {
  const schemaResult = await processViaSchema(options);
  if (schemaResult) return schemaResult;
  // Активной action-схемы нет: фиксируем в журнале, чтобы оператор увидел
  // отсутствие схемы в админке (issue #255, этап F), и доставляем ошибку игроку.
  await logMissingActiveSchema({
    schemaType: 'action',
    gameId: options.manifest.id,
    sessionId: schemaSessionId(options.cacheKey),
  });
  throw new MissingActiveSchemaError('action', options.manifest.id);
}

export interface HintsResult {
  hints: string[];
  llmLog: LLMCallLogEntry[];
  /** Кредиты, израсходованные на запросы к LLM при генерации подсказок. */
  creditsUsed: number;
  /** Детализация расхода токенов по категориям. */
  tokenUsage: TokenUsage;
  /** Оценка стоимости в тысячных долях цента (миллицентах, 0 если модель не в справочнике). */
  costMillicents: number;
}

/**
 * Запрашивает у LLM 3 коротких варианта действий (подсказки).
 * Возвращает массив строк; при сбое — пустой массив (бот покажет заглушку).
 */
export async function getHints(
  provider: ILLMProvider,
  state: GameState,
  maxRetries = 3,
  history: TurnHistoryEntry[] = [],
): Promise<string[]> {
  const result = await getHintsWithLog(provider, state, maxRetries, history);
  return result.hints;
}

/**
 * Запрашивает подсказки и возвращает технический лог всех LLM-попыток.
 *
 * Исполнение идёт ТОЛЬКО через активную `hint`-схему (issue #238). Legacy-путь
 * генерации подсказок удалён: если активной схемы нет, бросается
 * {@link MissingActiveSchemaError} — вызывающий код доставляет ошибку игроку и
 * фиксирует её в логе ошибок выполнения админки.
 */
export async function getHintsWithLog(
  provider: ILLMProvider,
  state: GameState,
  maxRetries = 3,
  history: TurnHistoryEntry[] = [],
  pricing: ModelPricing | null = null,
  cacheKey?: string,
  gameId: string | null = null,
): Promise<HintsResult> {
  const schemaResult = await getHintsViaSchema(
    provider,
    state,
    maxRetries,
    history,
    pricing,
    cacheKey,
    gameId,
  );
  if (schemaResult) return schemaResult;
  // Активной hint-схемы нет: фиксируем в журнале для админки (issue #255, этап F).
  await logMissingActiveSchema({
    schemaType: 'hint',
    gameId,
    sessionId: schemaSessionId(cacheKey),
  });
  throw new MissingActiveSchemaError('hint', gameId);
}
