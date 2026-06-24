/**
 * Фаза 0 игрового хода — выделение ключей ситуации для экспертизы (issue #154).
 *
 * Зеркало стадии 1 бота поддержки (`src/botSupport/supportLlm.ts`): отдельным
 * дешёвым JSON-запросом по действию игрока и текущей сцене формулируются
 * короткие поисковые фразы (ключи), по которым из базы знаний игры
 * подтягиваются справочные документы. Все чистые билдеры и парсер вынесены сюда,
 * чтобы покрывать их юнит-тестами без обращения к LLM.
 */

import type { ILLMProvider } from '../llm/ILLMProvider.js';
import { generateTextWithLog, type LLMCallLogEntry } from '../llm/trace.js';
import { extractJson } from './validation.js';
import {
  renderPromptTemplate,
  requirePromptTemplates,
  type PromptTemplateOverrides,
} from './promptTemplates.js';
import { formatWorldTimeLine, type GameManifest } from '../games/manifests.js';
import type { GameState } from '../types.js';

/** Документ экспертизы для подстановки в промпт нарратива (issue #154). */
export interface GameExpertiseDoc {
  title: string;
  content: string;
}

/**
 * Собирает блок справочных материалов для плейсхолдера `{{expertise}}` промпта
 * нарратива. Возвращает явную пометку, если документов нет, — чтобы модель не
 * выдумывала факты (форма совпадает с buildExpertiseBlock бота поддержки).
 */
export function buildGameExpertiseBlock(docs: GameExpertiseDoc[]): string {
  if (docs.length === 0) {
    return 'Подходящих справочных материалов не найдено.';
  }
  return docs
    .map((doc, index) => `${index + 1}. ${doc.title}\n${doc.content.trim()}`)
    .join('\n\n');
}

/** Системная инструкция фазы 0: роль аналитика игры и схема ответа. */
export function buildExpertiseKeysSystemPrompt(
  manifest: GameManifest,
  template: string,
): string {
  return renderPromptTemplate(template, {
    game_name: manifest.name,
    game_description: manifest.description,
  });
}

/** Короткая сводка состояния игры для промпта фазы 0 (без громоздкого JSON). */
function buildStateSummary(state: GameState): string {
  const { character } = state;
  const skills = Object.keys(character.skills ?? {});
  const parts = [
    `HP ${character.hp}/${character.max_hp}`,
    `время мира ${formatWorldTimeLine(state.world_time)}`,
  ];
  if (character.inventory && character.inventory.length > 0) {
    parts.push(`инвентарь: ${character.inventory.join(', ')}`);
  }
  if (skills.length > 0) {
    parts.push(`навыки: ${skills.join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * Пользовательский промпт фазы 0: локация, краткое состояние, последний
 * нарратив и действие игрока.
 */
export function buildExpertiseKeysPrompt(
  state: GameState,
  action: string,
  lastNarrative: string,
  template: string,
): string {
  return renderPromptTemplate(template, {
    location: state.location,
    state_summary: buildStateSummary(state),
    last_narrative: lastNarrative,
    action,
  });
}

/** Парсит ответ фазы 0 в массив ключей-фраз из `{"keys":[...]}`. */
export function parseExpertiseKeys(raw: string): string[] | null {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const keys = (json as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) return null;
  return keys
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Результат фазы 0: ключи ситуации и технический лог запросов к LLM. */
export interface GameExpertiseDetection {
  keys: string[];
  llmLog: LLMCallLogEntry[];
}

/**
 * Фаза 0 (issue #154): по состоянию игры и действию игрока формулирует ключи
 * ситуации для семантического поиска экспертизы. При неуспехе всех попыток
 * возвращает пустой массив — ход пойдёт без справочных материалов.
 */
export async function runGameExpertiseDetection(
  provider: ILLMProvider,
  manifest: GameManifest,
  state: GameState,
  action: string,
  lastNarrative: string,
  maxRetries = 3,
  promptTemplatesOverride?: PromptTemplateOverrides,
): Promise<GameExpertiseDetection> {
  const llmLog: LLMCallLogEntry[] = [];
  const promptTemplates = requirePromptTemplates(promptTemplatesOverride ?? {}, [
    'game_expertise_system',
    'game_expertise_prompt',
  ]);
  const systemInstruction = buildExpertiseKeysSystemPrompt(
    manifest,
    promptTemplates.game_expertise_system,
  );
  const prompt = buildExpertiseKeysPrompt(
    state,
    action,
    lastNarrative,
    promptTemplates.game_expertise_prompt,
  );

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let raw: string;
    try {
      raw = await generateTextWithLog(
        provider,
        { prompt, systemInstruction, jsonMode: true },
        llmLog,
      );
    } catch (err) {
      console.warn(
        `[game] экспертиза(0): ошибка провайдера на попытке ${attempt}/${maxRetries}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseExpertiseKeys(raw);
    if (parsed) return { keys: parsed, llmLog };
    console.warn(`[game] экспертиза(0): невалидный ответ LLM на попытке ${attempt}/${maxRetries}.`);
  }
  console.warn('[game] экспертиза(0): не удалось выделить ключи — продолжаю без экспертизы.');
  return { keys: [], llmLog };
}
