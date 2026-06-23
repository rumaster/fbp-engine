/**
 * Сериализация подграфа онтологии в блок промпта (фаза C, issue #323).
 *
 * Чистые билдеры превращают извлечённый подграф (вершины + рёбра) в плотный
 * текстовый блок для плейсхолдера `{{expertise}}` — того же, куда RAG кладёт
 * найденные документы. Сперва идут ключевые концепты с короткой фактурой, затем
 * причинно-следственные цепочки словами. При пустом подграфе возвращается явная
 * пометка, чтобы модель не выдумывала факты (совместимо с buildGameExpertiseBlock).
 */

import type { OntologySubgraph } from './ontologyRetrieval.js';

/** Пометка пустого результата — единая форма с RAG (issue #154/#321). */
export const ONTOLOGY_EMPTY_BLOCK = 'Подходящих знаний о мире не найдено.';

/**
 * Человекочитаемые формулировки типов связей для сериализации цепочек.
 * Ключи совпадают с полем relation в БД (значения по умолчанию плана §2).
 */
const RELATION_PHRASES: Record<string, string> = {
  требует: 'требует',
  даёт: 'даёт',
  тратит: 'тратит',
  вызывает: 'вызывает',
  опасно_в: 'опасно в',
  ускоряет: 'ускоряет',
  конфликтует_с: 'конфликтует с',
  находится_в: 'находится в',
  часть_чего: 'часть',
  альтернатива: 'альтернатива',
  противоречит: 'противоречит',
  риск: 'грозит',
  занято: 'занято',
};

/** Формулировка типа связи словами (fallback — сам тип с заменой подчёркиваний). */
function relationPhrase(relation: string): string {
  return RELATION_PHRASES[relation] ?? relation.replace(/_/g, ' ');
}

/**
 * Собирает блок `{{expertise}}` из подграфа онтологии.
 *
 * Формат: нумерованный список ключевых концептов (заголовок + фактура), затем —
 * блок «Связи», где каждая связь выражена фразой «A <тип> B[ — note]». Концепты
 * без фактуры и связи учитываются по порядку их веса (он уже задан обходом).
 */
export function buildOntologyBlock(subgraph: OntologySubgraph): string {
  const conceptsWithFact = subgraph.concepts.filter((c) => c.concept.fact.trim().length > 0);
  if (conceptsWithFact.length === 0 && subgraph.relations.length === 0) {
    return ONTOLOGY_EMPTY_BLOCK;
  }

  const parts: string[] = [];

  if (conceptsWithFact.length > 0) {
    const lines = conceptsWithFact.map(
      (c, index) => `${index + 1}. ${c.concept.title}: ${c.concept.fact.trim()}`,
    );
    parts.push(lines.join('\n'));
  }

  if (subgraph.relations.length > 0) {
    const lines = subgraph.relations.map((rel) => {
      const base = `${rel.fromTitle} ${relationPhrase(rel.relation)} ${rel.toTitle}`;
      const note = rel.note.trim();
      return note.length > 0 ? `- ${base} — ${note}` : `- ${base}`;
    });
    parts.push(`Связи:\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}
