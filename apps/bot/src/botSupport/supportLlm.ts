/**
 * Чистые помощники бота-консультанта первой линии службы поддержки (issue #59).
 *
 * Оркестрация консультации перенесена в schema engine (issue #238), а здесь
 * остались только переиспользуемые им чистые функции: форматирование диалога,
 * блок справочных материалов и парсер ответа консультанта. Они покрываются
 * юнит-тестами без обращения к LLM.
 */

import { extractJson } from '@tg-games/core/engine/validation.js';
import type { SupportSender } from '@tg-games/core/db/repositories/support.js';

/** Одно сообщение диалога обращения для построения промпта консультации. */
export interface SupportTurn {
  sender: SupportSender;
  text: string;
}

/** Документ экспертизы для подстановки в промпт консультанта (issue #147). */
export interface SupportExpertiseDoc {
  title: string;
  content: string;
}

/**
 * Собирает блок справочных материалов экспертизы для плейсхолдера
 * `{{expertise}}` промпта консультанта. Возвращает явную пометку, если
 * подходящих документов не нашлось, — чтобы модель не выдумывала факты.
 */
export function buildExpertiseBlock(docs: SupportExpertiseDoc[]): string {
  if (docs.length === 0) {
    return 'Подходящих справочных материалов не найдено.';
  }
  return docs
    .map((doc, index) => `${index + 1}. ${doc.title}\n${doc.content.trim()}`)
    .join('\n\n');
}

/** Решение бота-консультанта по обращению. */
export interface SupportConsultation {
  /** Передать ли обращение администратору (собрано достаточно сведений). */
  escalate: boolean;
  /**
   * Закрыть ли обращение автоматически: клиент явно подтвердил, что проблема
   * решена (issue #149). Имеет приоритет над escalate.
   */
  resolved: boolean;
  /** Текст ответа клиенту от лица «Бота СП». */
  reply: string;
  /** Скомпилированное описание проблемы для администратора (при escalate=true). */
  summary?: string;
}

/** Максимальная длина одного сообщения диалога в промпте. */
const MAX_TURN_LENGTH = 1200;

/** Уплотняет сообщение, чтобы промпт диалога не разрастался бесконечно. */
function compact(text: string, limit = MAX_TURN_LENGTH): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** Человекочитаемая роль автора сообщения для промпта. */
function roleLabel(sender: SupportSender): string {
  switch (sender) {
    case 'user':
      return 'Пользователь';
    case 'admin':
      return 'Администратор';
    case 'bot':
      return 'Бот СП';
    default:
      return sender;
  }
}

/** Форматирует диалог обращения (от старых сообщений к новым) для промпта. */
function formatDialog(turns: SupportTurn[]): string {
  return turns.map((t) => `${roleLabel(t.sender)}: ${compact(t.text)}`).join('\n');
}

/**
 * Публичная обёртка над форматированием диалога — нужна schema-пути поддержки
 * (issue #238), чтобы передать `{{dialog}}` во входы схемы тем же способом, что
 * и legacy-промпты.
 */
export function formatSupportDialog(turns: SupportTurn[]): string {
  return formatDialog(turns);
}

/** Публичная обёртка над уплотнением текста сообщения (issue #238). */
export function compactSupportText(text: string): string {
  return compact(text);
}

/**
 * Парсит ответ LLM в решение консультанта.
 *
 * Возвращает null, если ответ непригоден (не JSON или нет ни reply, ни summary) —
 * оркестратор тогда повторит запрос либо передаст обращение администратору.
 */
export function parseSupportConsultation(raw: string): SupportConsultation | null {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const obj = json as Record<string, unknown>;
  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  // Модель иногда возвращает строковое "true"/"false" вместо булева значения.
  const escalate = obj.escalate === true || obj.escalate === 'true';
  const resolved = obj.resolved === true || obj.resolved === 'true';

  if (!reply && !summary) return null;
  return { escalate, resolved, reply, summary: summary || undefined };
}

