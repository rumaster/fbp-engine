export const PROMPT_TEMPLATE_KEYS = [
  'game_expertise_system',
  'game_expertise_prompt',
  'game_memory_system',
  'game_memory_prompt',
  'narrative_system',
  'narrative_prompt',
  'narrative_retry',
  'state_system',
  'state_prompt',
  'state_retry',
  'inventory_system',
  'inventory_prompt',
  'inventory_retry',
  'characteristics_system',
  'characteristics_prompt',
  'characteristics_retry',
  'flags_system',
  'flags_prompt',
  'flags_retry',
  'other_state_system',
  'other_state_prompt',
  'other_state_retry',
  'hints_prompt',
  'support_expertise_system',
  'support_expertise_prompt',
  'support_system',
  'support_prompt',
  'support_compilation_system',
  'support_compilation_prompt',
  'image_generation',
] as const;

export type PromptTemplateKey = (typeof PROMPT_TEMPLATE_KEYS)[number];
export type PromptTemplateSet = Record<PromptTemplateKey, string>;
export type PromptTemplateOverrides = Partial<PromptTemplateSet>;

export function isPromptTemplateKey(value: string): value is PromptTemplateKey {
  return (PROMPT_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export class MissingPromptTemplateError extends Error {
  readonly missingKeys: PromptTemplateKey[];

  constructor(keys: readonly PromptTemplateKey[]) {
    super(`Не найдены шаблоны промптов в БД: ${keys.join(', ')}`);
    this.name = 'MissingPromptTemplateError';
    this.missingKeys = [...keys];
  }
}

export function requirePromptTemplates(
  templates: PromptTemplateOverrides,
  keys: readonly PromptTemplateKey[] = PROMPT_TEMPLATE_KEYS,
): PromptTemplateSet {
  const missing = keys.filter((key) => templates[key] === undefined);
  if (missing.length > 0) {
    throw new MissingPromptTemplateError(missing);
  }
  return templates as PromptTemplateSet;
}

export function renderPromptTemplate(
  template: string,
  values: Record<string, string | number | boolean | null | undefined>,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return match;
    const value = values[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
