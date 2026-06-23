import type { PromptTemplateSet } from '@tg-games/core/engine/promptTemplates.js';
import type { GameManifest } from '@tg-games/core/games/manifests.js';

export const TEST_GAMES: Record<string, GameManifest> = {
  bomj: {
    id: 'bomj',
    name: 'Выживание бомжа',
    description: 'Тестовый сценарий выживания.',
    priceStars: 1,
    limits: { maxHp: 100, maxInventoryItems: 10 },
    worldRules: [
      'Действие происходит в реалистичном городе.',
      'Если HP падает до 0, игра завершается поражением.',
    ],
    startTime: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    characterPresets: [
      {
        name: 'Игорь — бывший инженер',
        description: 'Смекалистый герой с инженерным прошлым.',
        character: {
          hp: 75,
          max_hp: 100,
          skills: { смекалка: 3, выживание: 1 },
          inventory: ['треснутые очки', 'блокнот'],
        },
      },
      {
        name: 'Витёк — пройдоха',
        description: 'Опытный уличный выживальщик.',
        character: {
          hp: 70,
          max_hp: 100,
          skills: { попрошайничество: 3, выживание: 2 },
          inventory: ['мятая шапка', 'перочинный нож'],
        },
      },
      {
        name: 'Клава — добрая душа',
        description: 'Умеет договариваться и готовить из найденного.',
        character: {
          hp: 80,
          max_hp: 100,
          skills: { общение: 3, готовка: 2 },
          inventory: ['котелок', 'щепотка соли'],
        },
      },
    ],
    locationPresets: [
      {
        location: 'Теплотрасса на окраине города',
        narrative: 'Вы просыпаетесь на тёплых трубах. Что будете делать?',
      },
      {
        location: 'Под мостом у дорожной развязки',
        narrative: 'Над головой шумят машины, рядом тлеет чужой костёр. Что будете делать?',
      },
      {
        location: 'В подвале заброшенного дома',
        narrative: 'Сырой подвал пахнет плесенью, наверху скрипят половицы. Что будете делать?',
      },
    ],
  },
  red_hood: {
    id: 'red_hood',
    name: 'Приключения Красной Шапочки',
    description: 'Тестовый сказочный сценарий.',
    priceStars: 1,
    limits: { maxHp: 100, maxInventoryItems: 10 },
    worldRules: [
      'Действие происходит в сказочном лесу.',
      'Если HP падает до 0, игра завершается поражением.',
    ],
    startTime: { season: 'лето', date: '7 июля', time: '07:00', time_of_day: 'утро' },
    characterPresets: [
      {
        name: 'Красная Шапочка — смелая',
        description: 'Готова идти напролом.',
        character: {
          hp: 95,
          max_hp: 100,
          skills: { храбрость: 3 },
          inventory: ['корзинка с пирожками'],
        },
      },
      {
        name: 'Красная Шапочка — осторожная',
        description: 'Замечает следы и шорохи.',
        character: {
          hp: 85,
          max_hp: 100,
          skills: { осторожность: 3 },
          inventory: ['оберег от бабушки'],
        },
      },
      {
        name: 'Красная Шапочка — всезнайка',
        description: 'Знает лесные сказки и травы.',
        character: {
          hp: 80,
          max_hp: 100,
          skills: { эрудиция: 3 },
          inventory: ['книга сказок'],
        },
      },
    ],
    locationPresets: [
      {
        location: 'Опушка сказочного леса',
        narrative: 'Тропинка уходит в тёмный лес. Что будешь делать?',
      },
      {
        location: 'Развилка трёх лесных тропинок',
        narrative: 'Три тропинки ведут в разные стороны. Что будешь делать?',
      },
    ],
  },
  private_detective: {
    id: 'private_detective',
    name: 'Частный детектив',
    description: 'Тестовый детективный сценарий.',
    priceStars: 1,
    limits: { maxHp: 100, maxInventoryItems: 10 },
    worldRules: [
      'Расследование строится на уликах и версиях.',
      'Если HP падает до 0, игра завершается поражением.',
    ],
    startTime: { season: 'осень', date: '21 октября', time: '18:30', time_of_day: 'вечер' },
    characterPresets: [
      {
        name: 'Артём Волков — бывший опер',
        description: 'Умеет читать протоколы и держать удар.',
        character: {
          hp: 90,
          max_hp: 100,
          skills: { допрос: 3 },
          inventory: ['удостоверение частного детектива'],
        },
      },
      {
        name: 'Лиза Орлова — журналистка',
        description: 'Умеет разговорить человека.',
        character: {
          hp: 85,
          max_hp: 100,
          skills: { общение: 3 },
          inventory: ['диктофон'],
        },
      },
      {
        name: 'Семён Крайнов — криминалист',
        description: 'Замечает мелкие несостыковки.',
        character: {
          hp: 80,
          max_hp: 100,
          skills: { криминалистика: 3 },
          inventory: ['лупа'],
        },
      },
    ],
    locationPresets: [
      {
        location: 'Офис над типографией',
        narrative: 'На столе лежит конверт с авансом и фотография пропавшего.',
      },
      {
        location: 'Двор за театром',
        narrative: 'В луже блестит сломанная запонка.',
      },
      {
        location: 'Камера хранения вокзала',
        narrative: 'Нужная ячейка поцарапана свежим ключом.',
      },
    ],
  },
};

export function listTestGames(gameIds?: readonly string[]): GameManifest[] {
  const games = Object.values(TEST_GAMES);
  if (gameIds === undefined) return games;
  const allowed = new Set(gameIds);
  return games.filter((game) => allowed.has(game.id));
}

export function testGameTitleMap(gameIds: readonly string[]): Map<string, string> {
  return new Map(listTestGames(gameIds).map((game) => [game.id, game.name]));
}

export const TEST_PROMPT_TEMPLATES: PromptTemplateSet = {
  game_expertise_system: [
    'Ты аналитик игры «{{game_name}}». {{game_description}}',
    'Выдели темы быта для семантического поиска. Верни JSON {"keys":[...]}.',
  ].join('\n'),
  game_expertise_prompt: [
    'Текущая локация: {{location}}',
    'Краткое состояние: {{state_summary}}',
    'Последний нарратив: "{{last_narrative}}"',
    'Действие игрока: "{{action}}"',
    'Выдели темы для поиска по базе знаний.',
  ].join('\n'),
  game_memory_system: [
    'Ты хронист игры «{{game_name}}». {{game_description}}',
    'Выдели новые важные факты. Верни JSON {"memory":[{"content","category","importance"}]}.',
  ].join('\n'),
  game_memory_prompt: [
    'Текущее время мира: {{world_time_line}}.',
    'Уже известные факты: {{existing_memory}}',
    'Действие игрока: "{{action}}"',
    'Что произошло: "{{narrative}}"',
    'Выдели новые важные факты для долговременной памяти.',
  ].join('\n'),
  narrative_system: [
    'Ты рассказчик игры «{{game_name}}».',
    '{{game_description}}',
    'Учитывай world_time и не допускай читерство.',
    '{{world_rules}}',
    'Верни JSON с narrative.',
  ].join('\n'),
  narrative_prompt: [
    '{{history_block}}',
    'Учитывай накопленный опыт.',
    'Справочные материалы по миру игры:',
    '{{expertise}}',
    'Важные факты, накопленные за эту игру:',
    '{{memory}}',
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Действие игрока: "{{action}}"',
    'Опиши художественно, что произошло.',
  ].join('\n'),
  narrative_retry: [
    '{{base_prompt}}',
    'Ты вернул невалидный JSON: {{error_text}}. Исправься и верни narrative.',
  ].join('\n'),
  state_system: [
    'Ты учётчик игры «{{game_name}}». Источник истины — принятый нарратив.',
    'Лимиты: {{limits_json}}.',
    'Время world_time в формате ЧЧ:ММ, сдвигай его на минуты действия и календарную дату.',
    'Время суток: {{times_of_day}}; сезоны: {{seasons}}.',
    'Сохраняй world_flags.',
    'Верни JSON с updated_state.',
  ].join('\n'),
  state_prompt: [
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Действие игрока: "{{action}}"',
    'Принятый нарратив (что произошло):',
    '"{{narrative}}"',
    'Верни updated_state.',
  ].join('\n'),
  state_retry: [
    '{{base_prompt}}',
    'Ты вернул невалидный JSON: {{error_text}}. Исправься и верни updated_state.',
  ].join('\n'),
  inventory_system: [
    'Ты учётчик инвентаря игры «{{game_name}}».',
    'Обновляй только инвентарь по принятому нарративу.',
    'Лимиты: {{limits_json}}.',
    'Верни JSON с inventory.',
  ].join('\n'),
  inventory_prompt: [
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Действие игрока: "{{action}}"',
    'Принятый нарратив:',
    '"{{narrative}}"',
    'Верни полный inventory.',
  ].join('\n'),
  inventory_retry: [
    '{{base_prompt}}',
    'Ты вернул невалидный JSON: {{error_text}}. Исправься и верни inventory.',
  ].join('\n'),
  characteristics_system: [
    'Ты учётчик характеристик игры «{{game_name}}».',
    'Обновляй только характеристики персонажа: skills и max_hp. HP не меняй.',
    'Лимиты: {{limits_json}}.',
    'Верни JSON с characteristics.',
  ].join('\n'),
  characteristics_prompt: [
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Действие игрока: "{{action}}"',
    'Принятый нарратив:',
    '"{{narrative}}"',
    'Верни characteristics.',
  ].join('\n'),
  characteristics_retry: [
    '{{base_prompt}}',
    'Ты вернул невалидный JSON: {{error_text}}. Исправься и верни characteristics.',
  ].join('\n'),
  flags_system: [
    'Ты учётчик флагов игры «{{game_name}}».',
    'Обновляй только устойчивые world_flags.',
    'Верни JSON с флаги world_flags.',
  ].join('\n'),
  flags_prompt: [
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Действие игрока: "{{action}}"',
    'Принятый нарратив:',
    '"{{narrative}}"',
    'Верни полный world_flags.',
  ].join('\n'),
  flags_retry: [
    '{{base_prompt}}',
    'Ты вернул невалидный JSON: {{error_text}}. Исправься и верни world_flags.',
  ].join('\n'),
  other_state_system: [
    'Ты учётчик остальные данные игры «{{game_name}}».',
    'Обновляй location, world_time, character.hp и прочее, кроме inventory, skills, max_hp и world_flags.',
    'Лимиты: {{limits_json}}.',
    'Время суток: {{times_of_day}}; сезоны: {{seasons}}.',
    'Верни JSON с updated_state.',
  ].join('\n'),
  other_state_prompt: [
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Действие игрока: "{{action}}"',
    'Принятый нарратив:',
    '"{{narrative}}"',
    'Верни updated_state только с остальными данными.',
  ].join('\n'),
  other_state_retry: [
    '{{base_prompt}}',
    'Ты вернул невалидный JSON: {{error_text}}. Исправься и верни updated_state.',
  ].join('\n'),
  hints_prompt: [
    '{{history_block}}',
    'Текущее состояние игры:',
    '{{state_json}}',
    'Текущее время мира: {{world_time_line}}.',
    'Предложи 3 коротких варианта и верни JSON.',
  ].join('\n'),
  support_system: 'Ты Бот СП. Верни JSON с escalate, reply и summary.',
  support_prompt: ['Диалог обращения:', '{{dialog}}', 'Сформируй ответ Бота СП.'].join('\n'),
  image_generation: ['Иллюстрация сцены без текста.', '{{scene_text}}'].join('\n'),
};
