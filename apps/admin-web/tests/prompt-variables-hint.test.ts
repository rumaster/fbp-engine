import { describe, expect, it } from 'vitest';

import { PROMPT_TEMPLATE_KEYS } from '@tg-games/core/engine/promptTemplates.js';
import { DEFAULT_PROMPT_TEMPLATES } from '@tg-games/core/db/migrations/defaultPromptTemplates.js';
import { promptVariablesFor } from '../src/promptVariables.js';

// Извлекает имена подстановок {{...}} из текста шаблона так же, как это делает
// renderPromptTemplate в src/engine/promptTemplates.ts.
function extractPlaceholders(text: string): Set<string> {
  const names = new Set<string>();
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    names.add(match[1]);
  }
  return names;
}

// Загружает дефолтные тексты шаблонов из встроенного источника, на который
// опирается миграция M001 после удаления таблицы prompt_templates (issue #261).
function loadSeedTemplates(): Map<string, string> {
  return new Map(Object.entries(DEFAULT_PROMPT_TEMPLATES));
}

describe('справочник подстановок шаблонов промптов (issue #142)', () => {
  const seeds = loadSeedTemplates();

  it('описывает подстановки для каждого ключа шаблона', () => {
    for (const key of PROMPT_TEMPLATE_KEYS) {
      // У всех ключей, кроме support_system, есть хотя бы одна подстановка.
      const variables = promptVariablesFor(key);
      expect(Array.isArray(variables)).toBe(true);
      for (const variable of variables) {
        expect(variable.name).toMatch(/^[A-Za-z0-9_]+$/);
        expect(variable.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('не содержит дублей в списке подстановок', () => {
    for (const key of PROMPT_TEMPLATE_KEYS) {
      const names = promptVariablesFor(key).map((v) => v.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('совпадает с подстановками во встроенных дефолтных шаблонах', () => {
    for (const key of PROMPT_TEMPLATE_KEYS) {
      const text = seeds.get(key);
      expect(text, `нет seed-шаблона для ключа ${key}`).toBeDefined();
      const declared = new Set(promptVariablesFor(key).map((v) => v.name));
      const actual = extractPlaceholders(text as string);
      expect([...declared].sort(), `подстановки для ${key} разошлись с шаблоном`).toEqual(
        [...actual].sort(),
      );
    }
  });

  it('возвращает пустой список для неизвестного ключа', () => {
    expect(promptVariablesFor('does_not_exist')).toEqual([]);
  });
});
