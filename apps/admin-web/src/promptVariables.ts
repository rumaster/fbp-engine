// Справочник подстановок (плейсхолдеров) шаблонов промптов (issue #142).
//
// В тексте шаблона переменные записываются как {{имя}} и заменяются движком при
// сборке промпта (см. renderPromptTemplate в src/engine/promptTemplates.ts,
// src/botSupport/supportLlm.ts, src/bot/bot.ts). Здесь, в TS, описано, какие
// переменные доступны для каждого ключа шаблона — редактор показывает этот
// список под полем текста промпта, чтобы автор знал, что можно подставить.

export interface PromptVariable {
  /** Имя переменной без скобок, например «game_name» (в тексте — {{game_name}}). */
  name: string;
  /** Человекочитаемое пояснение, что подставляется вместо переменной. */
  description: string;
}

// Единый словарь пояснений: одна и та же переменная означает одно и то же в
// любом шаблоне, поэтому описания не дублируются.
const VARIABLE_DESCRIPTIONS: Record<string, string> = {
  game_name: 'Название игры из манифеста сценария.',
  game_description: 'Описание игры из манифеста сценария.',
  world_rules: 'Пронумерованный список законов мира (worldRules) сценария.',
  history_block: 'Блок памяти предыдущих ходов: действия игрока и их итоги.',
  state_json: 'Текущее состояние игры в формате JSON.',
  world_time_line: 'Время мира строкой, например «08:00 (утро), 14 октября, осень».',
  action: 'Текст действия игрока на этом ходу.',
  narrative: 'Уже принятый нарратив — описание того, что произошло в этом ходу.',
  base_prompt: 'Полный текст исходного промпта этой фазы (для повторного запроса).',
  error_text: 'Текст ошибки валидации предыдущего ответа LLM.',
  limits_json: 'Лимиты сценария (limits) в формате JSON.',
  seasons: 'Список допустимых времён года через запятую.',
  times_of_day: 'Список значений времени суток по порядку.',
  dialog: 'Диалог обращения в поддержку — от старых сообщений к новым.',
  scene_text: 'Текст сцены, по которому генерируется иллюстрация.',
  expertise: 'Подтянутые поиском справочные материалы экспертизы (заголовок + контент документов).',
  memory: 'Блок важных фактов долговременной памяти игры, отобранных для подстановки в нарратив (issue #166).',
  existing_memory: 'Уже накопленные важные факты игры — контекст для извлечения, чтобы не дублировать (issue #166).',
  last_message: 'Последнее сообщение клиента в обращении.',
  location: 'Текущая локация персонажа из состояния игры.',
  state_summary: 'Краткая сводка состояния игры (локация, HP, ключевые поля).',
  last_narrative: 'Текст нарратива предыдущего хода.',
};

// Какие переменные доступны для каждого ключа шаблона. Порядок и состав взяты
// из builder'ов промптов на стороне сервера — держите их синхронными.
const TEMPLATE_VARIABLE_NAMES: Record<string, readonly string[]> = {
  narrative_system: ['game_name', 'game_description', 'world_rules'],
  narrative_prompt: [
    'history_block',
    'expertise',
    'memory',
    'state_json',
    'world_time_line',
    'action',
  ],
  narrative_retry: ['base_prompt', 'error_text'],
  state_system: ['game_name', 'limits_json', 'seasons', 'times_of_day'],
  state_prompt: ['state_json', 'world_time_line', 'action', 'narrative'],
  state_retry: ['base_prompt', 'error_text'],
  inventory_system: ['game_name', 'limits_json'],
  inventory_prompt: ['state_json', 'world_time_line', 'action', 'narrative'],
  inventory_retry: ['base_prompt', 'error_text'],
  characteristics_system: ['game_name', 'limits_json'],
  characteristics_prompt: ['state_json', 'world_time_line', 'action', 'narrative'],
  characteristics_retry: ['base_prompt', 'error_text'],
  flags_system: ['game_name'],
  flags_prompt: ['state_json', 'world_time_line', 'action', 'narrative'],
  flags_retry: ['base_prompt', 'error_text'],
  other_state_system: ['game_name', 'limits_json', 'seasons', 'times_of_day'],
  other_state_prompt: ['state_json', 'world_time_line', 'action', 'narrative'],
  other_state_retry: ['base_prompt', 'error_text'],
  hints_prompt: ['history_block', 'state_json', 'world_time_line'],
  game_expertise_system: ['game_name', 'game_description'],
  game_expertise_prompt: ['location', 'state_summary', 'last_narrative', 'action'],
  game_memory_system: ['game_name', 'game_description'],
  game_memory_prompt: ['world_time_line', 'existing_memory', 'action', 'narrative'],
  support_expertise_system: [],
  support_expertise_prompt: ['dialog', 'last_message'],
  support_system: [],
  support_prompt: ['dialog', 'expertise'],
  support_compilation_system: [],
  support_compilation_prompt: ['dialog'],
  image_generation: ['scene_text'],
};

/**
 * Возвращает список доступных подстановок для шаблона с указанным ключом.
 *
 * Если ключ неизвестен (или у шаблона нет переменных) — вернёт пустой массив.
 */
export function promptVariablesFor(templateKey: string): PromptVariable[] {
  const names = TEMPLATE_VARIABLE_NAMES[templateKey] ?? [];
  return names.map((name) => ({
    name,
    description: VARIABLE_DESCRIPTIONS[name] ?? '',
  }));
}
