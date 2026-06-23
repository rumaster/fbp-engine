import type { ILLMProvider } from '../llm/ILLMProvider.js';
import type { ModelRouter } from '../llm/router.js';
import type { LLMCallLogEntry } from '../llm/trace.js';
import type { GameManifest } from '../games/manifests.js';
import type { GameState } from '../types.js';
import {
  describeSchemaExecutionError,
  executeSchema,
  MissingActiveSchemaError,
  SchemaNodeExecutionError,
  type SchemaExecutionContext,
} from '../engine/schemaEngine.js';
import {
  getActiveSchema,
  logMissingActiveSchema,
  logSchemaExecution,
  makeSubSchemaResolver,
} from '../db/repositories/schemas.js';
import type { IMediaProvider, MediaCallMeta } from './IMediaProvider.js';

/** Параметры генерации иллюстрации через schema engine (issue #238). */
export interface IllustrationSchemaRequest {
  /** Текст сцены, по которому рисуется изображение. */
  sceneText: string;
  /** Игра сессии — для выбора схемы (game → global fallback). */
  gameId?: string | null;
  /** Провайдер медиа, реально рисующий изображение. */
  mediaProvider: IMediaProvider;
  /** Модель/размер иллюстрации для конкретного пользователя. */
  image?: { model?: string; size?: string };
  /**
   * LLM-провайдер для контекста выполнения схемы. Базовая схема иллюстрации его
   * не использует, но интерпретатору он нужен формально (на случай llm-узлов).
   */
  provider?: ILLMProvider;
  router?: ModelRouter;
  /** Сессия — для аудита выполнения схемы. */
  sessionId?: string | null;
  maxRetries?: number;
}

/** Готовая иллюстрация, полученная через schema engine. */
export interface IllustrationSchemaResult {
  /** Промпт, фактически ушедший провайдеру (для отчёта тестировщику). */
  prompt: string;
  /** Бинарные данные изображения. */
  image: Buffer;
  /** Расширение файла (обычно `png`). */
  extension: string;
  /** Технические детали обращения к провайдеру (issue #75). */
  meta?: MediaCallMeta;
}

/** LLM-провайдер-заглушка: базовая схема иллюстрации к LLM не обращается. */
const NOOP_PROVIDER: ILLMProvider = {
  name: 'illustration-schema-noop',
  generateText: async () => {
    throw new Error('Схема иллюстрации не должна вызывать LLM');
  },
};

/** Длина обрезки текста сцены — совпадает с buildImagePrompt в боте. */
const SCENE_LIMIT = 900;

function illustrationManifest(): GameManifest {
  return {
    id: 'global',
    name: 'Глобальная схема иллюстраций',
    description: '',
    priceStars: 1,
    limits: { maxHp: 1, maxInventoryItems: 0 },
    worldRules: [],
    startTime: { season: 'весна', date: '', time: '00:00', time_of_day: 'утро' },
    characterPresets: [],
    locationPresets: [],
  };
}

function illustrationState(): GameState {
  return {
    location: '',
    narrative: '',
    character: { hp: 1, max_hp: 1, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'весна', date: '', time: '00:00', time_of_day: 'утро' },
    turn_count: 0,
  };
}

/** Достаёт бинарный результат media_generate из выходов узлов схемы. */
function extractGeneratedImage(
  nodeOutputs: Map<string, Record<string, unknown>>,
): { image: Buffer; extension: string; meta?: MediaCallMeta } | null {
  for (const outputs of nodeOutputs.values()) {
    const image = outputs.image;
    if (Buffer.isBuffer(image)) {
      const extension = typeof outputs.extension === 'string' ? outputs.extension : 'png';
      const meta = (outputs.mediaMeta as MediaCallMeta | undefined) ?? undefined;
      return { image, extension, meta };
    }
  }
  return null;
}

async function logSafely(input: Parameters<typeof logSchemaExecution>[0]): Promise<void> {
  try {
    await logSchemaExecution(input);
  } catch (err) {
    console.error(
      `[schema-engine] illustration: не удалось записать аудит выполнения схемы: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Рисует иллюстрацию сцены через активную схему `illustration` (issue #238).
 *
 * Schema engine — единственный путь исполнения, legacy удалён. Если активной
 * схемы нет, бросается {@link MissingActiveSchemaError}, и ошибка доставляется
 * игроку (а не подменяется тихим фолбэком). Ошибки генерации провайдера
 * пробрасываются как есть (с распознаваемым cause), чтобы бот показал кнопку
 * повторной попытки и корректный отчёт тестировщику.
 */
export async function generateIllustrationViaSchema(
  request: IllustrationSchemaRequest,
): Promise<IllustrationSchemaResult> {
  const activeSchema = await getActiveSchema('illustration', request.gameId ?? undefined);
  if (!activeSchema) {
    // Активной illustration-схемы нет: фиксируем в журнале для админки (issue #255, этап F).
    await logMissingActiveSchema({
      schemaType: 'illustration',
      gameId: request.gameId ?? null,
      sessionId: request.sessionId ?? null,
    });
    throw new MissingActiveSchemaError('illustration', request.gameId ?? null);
  }

  const sceneText = request.sceneText.trim().slice(0, SCENE_LIMIT);
  const inputs = { scene_text: sceneText };
  const llmLog: LLMCallLogEntry[] = [];
  const ctx: SchemaExecutionContext = {
    inputs,
    nodeOutputs: new Map(),
    variables: new Map(),
    llmLog,
    provider: request.provider ?? NOOP_PROVIDER,
    router: request.router,
    mediaProvider: request.mediaProvider,
    mediaImage: request.image,
    manifest: illustrationManifest(),
    state: illustrationState(),
    maxRetries: request.maxRetries ?? 1,
    resolveSubSchema: makeSubSchemaResolver(request.gameId ?? undefined, 'illustration'),
  };

  const startedAt = Date.now();
  let outputs: Record<string, unknown>;
  try {
    outputs = await executeSchema(activeSchema.graphJson, ctx);
  } catch (err) {
    const errorInfo = describeSchemaExecutionError(activeSchema.graphJson, err);
    await logSafely({
      schemaSlug: activeSchema.schemaSlug,
      schemaType: 'illustration',
      gameId: activeSchema.gameId ?? null,
      sessionId: request.sessionId ?? null,
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
    // Распознаваемая ошибка провайдера медиа лежит в cause — пробрасываем её,
    // чтобы бот обработал MediaGenerationError и показал кнопку повтора.
    if (err instanceof SchemaNodeExecutionError && err.cause instanceof Error) {
      throw err.cause;
    }
    throw err;
  }

  const generated = extractGeneratedImage(ctx.nodeOutputs);
  await logSafely({
    schemaSlug: activeSchema.schemaSlug,
    schemaType: 'illustration',
    gameId: activeSchema.gameId ?? null,
    sessionId: request.sessionId ?? null,
    status: 'ok',
    inputsJson: inputs,
    outputsJson: outputs,
    llmLog,
    durationMs: Date.now() - startedAt,
  });

  if (!generated) {
    // Схема отработала, но не вернула бинарных данных (например, узел
    // media_generate не выполнился). Legacy-фолбэка больше нет — доставляем
    // ошибку игроку.
    throw new Error(
      `Схема иллюстрации «${activeSchema.schemaSlug}» не вернула изображение ` +
        '(issue #238: legacy-путь генерации удалён).',
    );
  }

  const prompt = typeof outputs.image_url === 'string' ? outputs.image_url : sceneText;
  return { prompt, image: generated.image, extension: generated.extension, meta: generated.meta };
}
