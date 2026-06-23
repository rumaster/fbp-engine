/**
 * Общие фикстуры активных схем для тестов (issue #238).
 *
 * Schema engine — единственный путь исполнения, legacy удалён. Любой тест,
 * прогоняющий ход (`processTurn`), подсказки (`getHintsWithLog`), иллюстрацию
 * или поддержку через бота, должен замокать репозиторий схем и вернуть активную
 * схему — иначе рантайм бросит `MissingActiveSchemaError`.
 *
 * Базовые схемы строятся теми же билдерами, что и продакшен-миграция
 * (`buildDefault*Schema`), поэтому `action`-схема повторяет прежний 5-фазный
 * пайплайн (нарратив + 4 фазы учёта состояния) — счётчики LLM-вызовов в тестах
 * остаются валидными.
 */
import { vi } from 'vitest';
import type { SchemaRecord } from '@tg-games/core/db/repositories/schemas.js';
import {
  buildDefaultActionSchema,
  buildDefaultHintSchema,
  buildDefaultIllustrationSchema,
  buildDefaultSupportSchema,
} from '@tg-games/core/db/migrations/M001_prompt_templates_to_schemas.js';
import { TEST_PROMPT_TEMPLATES } from './gameManifests.js';

/** Граф продакшен-схемы хода (нарратив + 4 фазы учёта состояния). */
export const ACTION_SCHEMA_GRAPH = buildDefaultActionSchema(TEST_PROMPT_TEMPLATES);
/** Граф продакшен-схемы подсказок. */
export const HINT_SCHEMA_GRAPH = buildDefaultHintSchema(TEST_PROMPT_TEMPLATES);
/** Граф продакшен-схемы иллюстрации. */
export const ILLUSTRATION_SCHEMA_GRAPH = buildDefaultIllustrationSchema(TEST_PROMPT_TEMPLATES);
/** Граф продакшен-схемы поддержки. */
export const SUPPORT_SCHEMA_GRAPH = buildDefaultSupportSchema(TEST_PROMPT_TEMPLATES);

function record(
  idSuffix: string,
  slug: string,
  type: SchemaRecord['schemaType'],
  graph: SchemaRecord['graphJson'],
  gameId: string | null = null,
): SchemaRecord {
  return {
    id: `00000000-0000-4000-8000-0000000000${idSuffix}`,
    schemaSlug: slug,
    schemaType: type,
    gameId,
    graphJson: graph,
    isActive: true,
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/** Активная `action`-схема (по умолчанию глобальная). */
export function activeActionSchema(gameId: string | null = null): SchemaRecord {
  return record('01', 'action', 'action', ACTION_SCHEMA_GRAPH, gameId);
}

/** Активная `hint`-схема (по умолчанию глобальная). */
export function activeHintSchema(gameId: string | null = null): SchemaRecord {
  return record('02', 'hint', 'hint', HINT_SCHEMA_GRAPH, gameId);
}

/** Активная `illustration`-схема (по умолчанию глобальная). */
export function activeIllustrationSchema(gameId: string | null = null): SchemaRecord {
  return record('03', 'illustration', 'illustration', ILLUSTRATION_SCHEMA_GRAPH, gameId);
}

/** Активная `support`-схема (глобальная). */
export function activeSupportSchema(): SchemaRecord {
  return record('04', 'support', 'support', SUPPORT_SCHEMA_GRAPH, null);
}

/**
 * Настраивает мок `getActiveSchema` так, чтобы он отдавал активную схему по её
 * типу (`action`/`hint`/`illustration`/`support`) и `null` для остальных. Удобно
 * для интеграционных тестов бота, где за один прогон запрашиваются разные схемы.
 */
export function mockActiveSchemasByType(
  getActiveSchema: ReturnType<typeof vi.fn>,
): void {
  getActiveSchema.mockImplementation(async (slug: string) => {
    switch (slug) {
      case 'action':
        return activeActionSchema();
      case 'hint':
        return activeHintSchema();
      case 'illustration':
        return activeIllustrationSchema();
      case 'support':
        return activeSupportSchema();
      default:
        return null;
    }
  });
}
