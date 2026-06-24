import type {
  EdgeDefinition,
  NodeDefinition,
  SchemaGraph,
  SchemaType,
} from '../../engine/schemaEngine.js';
import { getPool } from '../pool.js';
import { DEFAULT_PROMPT_TEMPLATES } from './defaultPromptTemplates.js';

export type PromptTemplateMap = Record<string, string>;

interface DefaultSchema {
  graph: SchemaGraph;
  description: string;
}

/**
 * Идемпотентно сидит четыре глобальные дефолтные схемы Schema Engine
 * (action/hint/illustration/support) на чистой БД.
 *
 * Ранее тексты промптов читались из deprecated-таблицы `prompt_templates`
 * (источник для разовой миграции). После удаления таблицы (issue #261, Этап 4.2
 * gap-plan) дефолтные тексты встроены в `DEFAULT_PROMPT_TEMPLATES`. `WHERE NOT
 * EXISTS` сохраняет уже существующие активные схемы, поэтому повторный прогон не
 * создаёт дублей и не затирает правки, сделанные через редактор админки.
 */
export async function migratePromptTemplatesToSchemas(): Promise<void> {
  const pool = getPool();

  for (const schema of buildDefaultSchemas(DEFAULT_PROMPT_TEMPLATES)) {
    await pool.query(
      `INSERT INTO schemas (schema_slug, schema_type, schema_class, game_id, graph_json, is_active, description)
       SELECT $1::varchar(100), $2::schema_type, $3::schema_class, NULL::varchar(50), $4::jsonb, TRUE, $5::text
       WHERE NOT EXISTS (
         SELECT 1
         FROM schemas
         WHERE schema_slug = $1::varchar(100)
           AND game_id IS NULL
           AND is_active = TRUE
       )`,
      [
        schema.graph.slug,
        schema.graph.schemaType ?? null,
        schema.graph.subSchemaClass ?? null,
        JSON.stringify(schema.graph),
        schema.description,
      ],
    );
  }
}

export function buildDefaultSchemas(templates: PromptTemplateMap): DefaultSchema[] {
  return [
    {
      graph: buildDefaultActionSchema(templates),
      description: 'Глобальная схема обработки игрового хода (встроенный дефолт)',
    },
    {
      graph: buildDefaultHintSchema(templates),
      description: 'Глобальная схема генерации подсказок (встроенный дефолт)',
    },
    {
      graph: buildDefaultIllustrationSchema(templates),
      description: 'Глобальная схема генерации иллюстраций (встроенный дефолт)',
    },
    {
      graph: buildDefaultSupportSchema(templates),
      description: 'Глобальная схема консультации поддержки (встроенный дефолт)',
    },
  ];
}

// Каждая фаза учёта состояния (инвентарь, характеристики, флаги, остальное) описывается
// LLM-узлом, transform-узлом, который собирает из ответа модели объект формы GameState
// (опуская неопределённые поля, чтобы глубокий мерж не затирал состояние), и каноническим
// game_state_write, который мержит этот объект в ctx.state. Узлы записи — побочные эффекты
// без выходов, поэтому исполняются прямо в exec-цепочке.
const ASSEMBLE_INVENTORY = `
const out = {};
if (Array.isArray(input.inventory)) out.character = { inventory: input.inventory };
return out;
`;

const ASSEMBLE_CHARACTERISTICS = `
const out = {};
const c = (input.characteristics && typeof input.characteristics === 'object') ? input.characteristics : {};
const char = {};
if (typeof c.max_hp === 'number') char.max_hp = c.max_hp;
if (c.skills && typeof c.skills === 'object') char.skills = c.skills;
if (Object.keys(char).length > 0) out.character = char;
return out;
`;

const ASSEMBLE_FLAGS = `
const out = {};
if (input.world_flags && typeof input.world_flags === 'object') out.world_flags = input.world_flags;
return out;
`;

const ASSEMBLE_OTHER = `
const out = {};
const u = (input.updated_state && typeof input.updated_state === 'object') ? input.updated_state : {};
if (typeof u.location === 'string') out.location = u.location;
const char = {};
const uc = (u.character && typeof u.character === 'object') ? u.character : {};
if (typeof uc.hp === 'number') char.hp = uc.hp;
if (Object.keys(char).length > 0) out.character = char;
if (u.world_time && typeof u.world_time === 'object') out.world_time = u.world_time;
return out;
`;

export function buildDefaultActionSchema(templates: PromptTemplateMap): SchemaGraph {
  const nodes: NodeDefinition[] = [
    node('start', 'start', 0, 0),
    node('expertise_enabled', 'condition', 180, 0, { input: 'expertise_enabled' }, 'Экспертиза включена?'),
    llmNode(
      'expertise_detection',
      420,
      -120,
      'game_expertise_detection',
      template(templates, 'game_expertise_system'),
      template(templates, 'game_expertise_prompt'),
      undefined,
      [{ name: 'keys', jsonPath: 'keys', type: 'string_array' }],
      'Выделение ключей экспертизы',
    ),
    node('knowledge_query', 'knowledge_query', 700, -120, {}, 'Поиск экспертизы'),
    node('memory_read', 'game_memory_read', 980, 0, {}, 'Чтение памяти'),
    llmNode(
      'narrative',
      1240,
      0,
      'narrative_generation',
      template(templates, 'narrative_system'),
      template(templates, 'narrative_prompt'),
      template(templates, 'narrative_retry'),
      [{ name: 'narrative', jsonPath: 'narrative', type: 'string' }],
      'Нарратив',
    ),
    llmNode(
      'inventory',
      1500,
      0,
      'world_state_evaluation',
      template(templates, 'inventory_system'),
      template(templates, 'inventory_prompt'),
      template(templates, 'inventory_retry'),
      [{ name: 'inventory', jsonPath: 'inventory', type: 'string_array' }],
      'Инвентарь',
      { phase: 'inventory_update' },
    ),
    transformNode(
      'assemble_inventory',
      1630,
      160,
      [{ name: 'inventory', type: 'string_array' }],
      ASSEMBLE_INVENTORY,
      'Сборка инвентаря',
    ),
    node('write_inventory', 'game_state_write', 1760, 0, {}, 'Запись инвентаря'),
    llmNode(
      'characteristics',
      2020,
      0,
      'world_state_evaluation',
      template(templates, 'characteristics_system'),
      template(templates, 'characteristics_prompt'),
      template(templates, 'characteristics_retry'),
      [{ name: 'characteristics', jsonPath: 'characteristics', type: 'object' }],
      'Характеристики',
      { phase: 'characteristics_update' },
    ),
    transformNode(
      'assemble_characteristics',
      2150,
      160,
      [{ name: 'characteristics', type: 'object' }],
      ASSEMBLE_CHARACTERISTICS,
      'Сборка характеристик',
    ),
    node('write_characteristics', 'game_state_write', 2280, 0, {}, 'Запись характеристик'),
    llmNode(
      'flags',
      2540,
      0,
      'world_state_evaluation',
      template(templates, 'flags_system'),
      template(templates, 'flags_prompt'),
      template(templates, 'flags_retry'),
      [{ name: 'world_flags', jsonPath: 'world_flags', type: 'object' }],
      'Флаги',
      { phase: 'world_flags_update' },
    ),
    transformNode(
      'assemble_flags',
      2670,
      160,
      [{ name: 'world_flags', type: 'object' }],
      ASSEMBLE_FLAGS,
      'Сборка флагов',
    ),
    node('write_flags', 'game_state_write', 2800, 0, {}, 'Запись флагов'),
    llmNode(
      'other_state',
      3060,
      0,
      'world_state_evaluation',
      template(templates, 'other_state_system'),
      template(templates, 'other_state_prompt'),
      template(templates, 'other_state_retry'),
      [{ name: 'updated_state', jsonPath: 'updated_state', type: 'object' }],
      'Остальные данные',
      { phase: 'other_state_update' },
    ),
    transformNode(
      'assemble_other',
      3190,
      160,
      [{ name: 'updated_state', type: 'object' }],
      ASSEMBLE_OTHER,
      'Сборка состояния',
    ),
    node('write_other', 'game_state_write', 3320, 0, {}, 'Запись состояния'),
    node('memory_enabled', 'condition', 3580, 0, { input: 'memory_enabled' }, 'Память включена?'),
    node(
      'memory_write',
      'game_memory_write',
      3840,
      -120,
      {
        systemPrompt: template(templates, 'game_memory_system'),
        userPrompt: template(templates, 'game_memory_prompt'),
      },
      'Извлечение памяти',
    ),
    node('end', 'end', 4100, 0),
  ];

  // Узлы записи состояния включены в exec-цепочку: каждый исполняется после своего LLM-узла,
  // подтягивает собранный transform-ом объект на вход state и мержит его в ctx.state.
  const edges: EdgeDefinition[] = [
    exec('start', 'expertise_enabled'),
    exec('expertise_enabled', 'expertise_detection', 'true'),
    exec('expertise_enabled', 'narrative', 'false'),
    exec('expertise_detection', 'knowledge_query'),
    exec('knowledge_query', 'narrative'),
    exec('narrative', 'inventory'),
    exec('inventory', 'write_inventory'),
    exec('write_inventory', 'characteristics'),
    exec('characteristics', 'write_characteristics'),
    exec('write_characteristics', 'flags'),
    exec('flags', 'write_flags'),
    exec('write_flags', 'other_state'),
    exec('other_state', 'write_other'),
    exec('write_other', 'memory_enabled'),
    exec('memory_enabled', 'end', 'true'),
    exec('memory_enabled', 'end', 'false'),
    data('expertise_detection', 'keys', 'knowledge_query', 'keys'),
    data('knowledge_query', 'expertise', 'narrative', 'expertise'),
    data('memory_read', 'memory', 'narrative', 'memory'),
    data('narrative', 'narrative', 'inventory', 'narrative'),
    data('narrative', 'narrative', 'characteristics', 'narrative'),
    data('narrative', 'narrative', 'flags', 'narrative'),
    data('narrative', 'narrative', 'other_state', 'narrative'),
    data('narrative', 'narrative', 'memory_write', 'narrative'),
    data('memory_enabled', 'condition', 'memory_write', 'enabled'),
    data('inventory', 'inventory', 'assemble_inventory', 'inventory'),
    data('assemble_inventory', 'state', 'write_inventory', 'state'),
    data('characteristics', 'characteristics', 'assemble_characteristics', 'characteristics'),
    data('assemble_characteristics', 'state', 'write_characteristics', 'state'),
    data('flags', 'world_flags', 'assemble_flags', 'world_flags'),
    data('assemble_flags', 'state', 'write_flags', 'state'),
    data('other_state', 'updated_state', 'assemble_other', 'updated_state'),
    data('assemble_other', 'state', 'write_other', 'state'),
    data('narrative', 'narrative', 'end', 'narrative'),
    data('memory_write', 'memoryUpdate', 'end', 'memoryUpdate'),
    data('narrative', 'raw', 'end', 'rawNarrative'),
    data('inventory', 'raw', 'end', 'rawInventory'),
    data('characteristics', 'raw', 'end', 'rawCharacteristics'),
    data('flags', 'raw', 'end', 'rawFlags'),
    data('other_state', 'raw', 'end', 'rawOtherState'),
  ];

  return graph('action', 'action', nodes, edges);
}

export function buildDefaultHintSchema(templates: PromptTemplateMap): SchemaGraph {
  const nodes: NodeDefinition[] = [
    node('start', 'start', 0, 0),
    llmNode(
      'hints',
      260,
      0,
      'hint_generation',
      '',
      template(templates, 'hints_prompt'),
      undefined,
      [],
      'Подсказки',
    ),
    node('end', 'end', 520, 0),
  ];
  return graph('hint', 'hint', nodes, [
    exec('start', 'hints'),
    exec('hints', 'end'),
    data('hints', 'hints', 'end', 'hints'),
    data('hints', 'raw', 'end', 'rawHints'),
  ]);
}

export function buildDefaultIllustrationSchema(templates: PromptTemplateMap): SchemaGraph {
  const nodes: NodeDefinition[] = [
    node('start', 'start', 0, 0),
    node(
      'illustration_prompt',
      'media_generate',
      260,
      0,
      // media_generate (issue #225): настраиваемые входы (config.inputs) как у llm_request,
      // предопределённые narrative/state убраны. Единственный выход — image_url.
      { prompt: template(templates, 'image_generation'), inputs: [] },
      'Промпт иллюстрации',
    ),
    node('end', 'end', 520, 0),
  ];
  return graph('illustration', 'illustration', [
    ...nodes,
  ], [
    exec('start', 'illustration_prompt'),
    exec('illustration_prompt', 'end'),
    data('illustration_prompt', 'image_url', 'end', 'image_url'),
  ]);
}

export function buildDefaultSupportSchema(templates: PromptTemplateMap): SchemaGraph {
  const nodes: NodeDefinition[] = [
    node('start', 'start', 0, 0),
    llmNode(
      'support_expertise',
      260,
      -120,
      'support_expertise_detection',
      template(templates, 'support_expertise_system'),
      template(templates, 'support_expertise_prompt'),
      undefined,
      [{ name: 'problems', jsonPath: 'problems', type: 'string_array' }],
      'Проблемы клиента',
    ),
    llmNode(
      'support_reply',
      520,
      0,
      'support_consultation',
      template(templates, 'support_system'),
      template(templates, 'support_prompt'),
      undefined,
      // escalate/resolved оставляем без явного типа (any): модель может опустить
      // их или вернуть строку "true"/"false", а строгий boolean уронил бы весь
      // граф. Нормализацию в булево делает runSupportViaSchema (issue #244).
      [
        { name: 'reply', jsonPath: 'reply', type: 'string' },
        { name: 'escalate', jsonPath: 'escalate' },
        { name: 'resolved', jsonPath: 'resolved' },
      ],
      'Ответ поддержки',
    ),
    llmNode(
      'support_compilation',
      780,
      120,
      'support_compilation',
      template(templates, 'support_compilation_system'),
      template(templates, 'support_compilation_prompt'),
      undefined,
      // Шаблон компиляции возвращает {"problem": "..."} — берём именно это поле
      // (issue #238: раньше jsonPath ошибочно указывал на отсутствующий summary).
      [{ name: 'summary', jsonPath: 'problem', type: 'string' }],
      'Компиляция обращения',
    ),
    node('end', 'end', 1040, 0),
  ];
  return graph('support', 'support', nodes, [
    exec('start', 'support_expertise'),
    exec('support_expertise', 'support_reply'),
    exec('support_reply', 'support_compilation'),
    exec('support_compilation', 'end'),
    data('support_reply', 'reply', 'end', 'reply'),
    // Флаги решения консультанта тянем на end явными рёбрами (issue #244): теперь
    // эскалация и закрытие обращения после графа читаются из выходов узла end, а
    // не восстанавливаются из «сырого» JSON узлов.
    data('support_reply', 'escalate', 'end', 'escalate'),
    data('support_reply', 'resolved', 'end', 'resolved'),
    data('support_compilation', 'summary', 'end', 'summary'),
  ]);
}

function graph(
  slug: string,
  schemaType: SchemaType,
  nodes: NodeDefinition[],
  edges: EdgeDefinition[],
): SchemaGraph {
  return { version: 1, slug, schemaType, nodes, edges, variables: {} };
}

function node(
  id: string,
  type: NodeDefinition['type'],
  x: number,
  y: number,
  config: Record<string, unknown> = {},
  label?: string,
): NodeDefinition {
  return { id, type, position: { x, y }, config, ...(label ? { label } : {}) };
}

function llmNode(
  id: string,
  x: number,
  y: number,
  kind: string,
  systemPrompt: string,
  userPrompt: string,
  retryPrompt: string | undefined,
  outputs: Array<Record<string, unknown>>,
  label: string,
  modelParams?: Record<string, unknown>,
): NodeDefinition {
  return node(
    id,
    'llm_request',
    x,
    y,
    {
      kind,
      systemPrompt,
      userPrompt,
      ...(retryPrompt ? { retryPrompt } : {}),
      outputs,
      jsonMode: true,
      ...(modelParams ? { modelParams } : {}),
    },
    label,
  );
}

function transformNode(
  id: string,
  x: number,
  y: number,
  inputs: Array<Record<string, unknown>>,
  code: string,
  label: string,
): NodeDefinition {
  return node(id, 'transform', x, y, { inputs, output: 'state', code }, label);
}

function exec(from: string, to: string, fromPort = 'exec'): EdgeDefinition {
  return {
    id: `${from}:${fromPort}->${to}:exec`,
    from,
    fromPort,
    to,
    toPort: 'exec',
  };
}

function data(from: string, fromPort: string, to: string, toPort: string): EdgeDefinition {
  return {
    id: `${from}:${fromPort}->${to}:${toPort}`,
    from,
    fromPort,
    to,
    toPort,
  };
}

function template(templates: PromptTemplateMap, key: string): string {
  return templates[key] ?? '';
}
