import { describe, expect, it, vi } from 'vitest';
import {
  executeSchema,
  type SchemaExecutionContext,
  type SchemaGraph,
  type SchemaNodeTraceEntry,
} from '@tg-games/core/engine/schemaEngine.js';
import {
  buildDefaultActionSchema,
  buildDefaultIllustrationSchema,
  buildDefaultSchemas,
} from '@tg-games/core/db/migrations/M001_prompt_templates_to_schemas.js';
import { emptyTokenUsage } from '@tg-games/core/llm/pricing.js';
import type { ILLMProvider, LLMRequestOptions } from '@tg-games/core/llm/ILLMProvider.js';
import type { MemoryCell } from '@tg-games/core/engine/memory.js';
import type { GameState } from '@tg-games/core/types.js';
import { TEST_GAMES, TEST_PROMPT_TEMPLATES } from './fixtures/gameManifests.js';

const manifest = TEST_GAMES.bomj;

function state(): GameState {
  return {
    location: 'Теплотрасса',
    narrative: 'старт',
    character: { hp: 80, max_hp: 100, skills: { взлом: 3 }, inventory: ['отмычка'] },
    world_flags: { door_locked: true },
    world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
    turn_count: 5,
  };
}

function memoryCell(overrides: Partial<MemoryCell> = {}): MemoryCell {
  return {
    id: 'memory-1',
    sessionId: 'session-1',
    stepId: 'step-1',
    content: 'Игрок договорился со старьёвщиком о медной проволоке.',
    category: 'цели',
    importance: 3,
    turnCreated: 4,
    createdAt: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

function mockProvider(responses: string[]): ILLMProvider {
  let i = 0;
  return {
    name: 'Mock',
    generateText: vi.fn(async (_opts: LLMRequestOptions) => {
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    }),
  };
}

function ctx(
  graph: SchemaGraph,
  provider: ILLMProvider,
  inputs: Record<string, unknown>,
  currentState = state(),
): SchemaExecutionContext {
  return {
    inputs,
    nodeOutputs: new Map(),
    variables: new Map(Object.entries(graph.variables)),
    llmLog: [],
    provider,
    manifest,
    state: currentState,
    maxRetries: 1,
  };
}

function transformGraph(code: string): SchemaGraph {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'transform_test',
    variables: { bonus: 3 },
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'transform',
        type: 'transform',
        position: { x: 200, y: 0 },
        config: { code, output: 'result' },
      },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      // transform — data-only узел (issue #201): exec идёт напрямую start → end,
      // а transform исполняется по требованию, когда end забирает его выход result.
      { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'value', from: 'start', fromPort: 'value', to: 'transform', toPort: 'value' },
      { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

describe('schemaEngine', () => {
  it('выполняет безопасный transform и блокирует доступ к окружению', async () => {
    const safeGraph = transformGraph('return Number(input.value) + Number(variables.bonus);');
    const safeCtx = ctx(safeGraph, mockProvider([]), { value: 2 });

    await expect(executeSchema(safeGraph, safeCtx)).resolves.toMatchObject({ result: 5 });

    const unsafeGraph = transformGraph('return process.env.SECRET;');
    await expect(executeSchema(unsafeGraph, ctx(unsafeGraph, mockProvider([]), { value: 2 })))
      .rejects.toThrow('запрещённый доступ');
  });

  it('наполняет nodeTrace по узлам потока и pure-зависимостям (issue #347)', async () => {
    // transformGraph: exec-поток start → end, transform — pure-узел, который
    // подтягивается по запросу данных. Отчёт должен покрыть и поток, и pure-зависимость.
    const graph = transformGraph('return Number(input.value) + Number(variables.bonus);');
    const context = ctx(graph, mockProvider([]), { value: 2 });
    const nodeTrace: SchemaNodeTraceEntry[] = [];
    context.nodeTrace = nodeTrace;

    await executeSchema(graph, context);

    const byNode = new Map(nodeTrace.map((entry) => [entry.nodeId, entry]));
    expect([...byNode.keys()].sort()).toEqual(['end', 'start', 'transform']);
    expect(byNode.get('start')?.via).toBe('flow');
    expect(byNode.get('end')?.via).toBe('flow');
    // transform не имеет exec-входа — он подтянут как зависимость данных узла end.
    expect(byNode.get('transform')?.via).toBe('data');
    expect(byNode.get('transform')).toMatchObject({
      nodeType: 'transform',
      depth: 0,
      failed: false,
      schemaSlug: 'transform_test',
    });
    expect(byNode.get('transform')?.outputKeys).toContain('result');
  });

  it('помечает упавший узел в nodeTrace как failed (issue #347)', async () => {
    const graph = transformGraph('return process.env.SECRET;');
    const context = ctx(graph, mockProvider([]), { value: 2 });
    const nodeTrace: SchemaNodeTraceEntry[] = [];
    context.nodeTrace = nodeTrace;

    await expect(executeSchema(graph, context)).rejects.toThrow('запрещённый доступ');
    const failed = nodeTrace.find((entry) => entry.failed);
    expect(failed?.nodeId).toBe('transform');
    expect(failed?.outputs).toMatchObject({ error: expect.any(String) });
  });

  it('nodeTrace вложенной sub_schema получает глубину depth=1 (issue #347)', async () => {
    const child: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'child_trace',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'tenx',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return Number(input.value) * 10;', output: 'value' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'c-exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'c-in', from: 'start', fromPort: 'value', to: 'tenx', toPort: 'value' },
        { id: 'c-out', from: 'tenx', fromPort: 'value', to: 'end', toPort: 'value' },
      ],
    };
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'parent_trace',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub', type: 'sub_schema', position: { x: 200, y: 0 }, config: { schemaSlug: 'child' } },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
        { id: 'exec2', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'val-in', from: 'start', fromPort: 'value', to: 'sub', toPort: 'value' },
        { id: 'val-out', from: 'sub', fromPort: 'value', to: 'end', toPort: 'value' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { value: 5 });
    context.resolveSubSchema = async (slug) => (slug === 'child' ? child : null);
    const nodeTrace: SchemaNodeTraceEntry[] = [];
    context.nodeTrace = nodeTrace;

    await executeSchema(graph, context);

    // Узлы родителя — depth 0, узлы суб-схемы — depth 1 (общий nodeTrace).
    const parent = nodeTrace.filter((entry) => entry.schemaSlug === 'parent_trace');
    const nested = nodeTrace.filter((entry) => entry.schemaSlug === 'child_trace');
    expect(parent.every((entry) => entry.depth === 0)).toBe(true);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((entry) => entry.depth === 1)).toBe(true);
    expect(nested.map((entry) => entry.nodeId)).toContain('tenx');
  });

  it('transform с JS-кодом, именованными входами и несколькими выходами (issue #204)', async () => {
    // JS-код получает переменную input (object с полями входов) и возвращает result.
    // Выходы извлекаются по путям: result — весь возврат, result.<field> — вложенные поля.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'transform_outputs',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: {
            code: 'return { narrative: "Ты решил " + input.action, delta: { acted: true } };',
            inputs: [{ name: 'action', type: 'string' }],
            outputs: [
              { name: 'narrative', type: 'string', path: 'result.narrative' },
              { name: 'delta', type: 'object', path: 'result.delta' },
            ],
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'action', from: 'start', fromPort: 'action', to: 'transform', toPort: 'action' },
        { id: 'narrative', from: 'transform', fromPort: 'narrative', to: 'end', toPort: 'narrative' },
        { id: 'delta', from: 'transform', fromPort: 'delta', to: 'end', toPort: 'state_delta' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { action: 'открыть дверь' });
    await expect(executeSchema(graph, context)).resolves.toEqual({
      narrative: 'Ты решил открыть дверь',
      state_delta: { acted: true },
    });
  });

  it('transform по умолчанию отдаёт весь результат в выход result (issue #204)', async () => {
    // Без config.outputs действует выход по умолчанию name=result, path=result, type=any.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'transform_default_output',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return input.action.toUpperCase();', inputs: [{ name: 'action', type: 'string' }] },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'action', from: 'start', fromPort: 'action', to: 'transform', toPort: 'action' },
        { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'narrative' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { action: 'бежать' });
    await expect(executeSchema(graph, context)).resolves.toEqual({ narrative: 'БЕЖАТЬ' });
  });

  it('transform: именованный выход без явного пути читает весь result (issue #266)', async () => {
    // Регрессия issue #266: выход назван location, тип string, путь не задан. Раньше путь
    // по умолчанию брался из имени выхода (location), а не из result, поэтому readPath
    // возвращал undefined и проверка типа ложно падала «Выход location не соответствует
    // типу string», хотя transform возвращал строку.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'transform_named_output_default_path',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: {
            code: 'return input.action;',
            inputs: [{ name: 'action', type: 'string' }],
            outputs: [{ name: 'location', type: 'string' }],
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'action', from: 'start', fromPort: 'action', to: 'transform', toPort: 'action' },
        { id: 'location', from: 'transform', fromPort: 'location', to: 'end', toPort: 'narrative' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { action: 'Теплотрасса' });
    await expect(executeSchema(graph, context)).resolves.toEqual({ narrative: 'Теплотрасса' });
  });

  it('transform: ошибка несоответствия типа называет узел, путь и фактический тип (issue #266)', async () => {
    // Сообщение должно подсказывать оператору, какой выход/путь и что именно пришло, а
    // не только ожидаемый тип (issue #266, требование 1).
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'transform_type_mismatch_message',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: {
            code: 'return { location: 42 };',
            outputs: [{ name: 'location', type: 'string', path: 'result.location' }],
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'location', from: 'transform', fromPort: 'location', to: 'end', toPort: 'narrative' },
      ],
    };

    const context = ctx(graph, mockProvider([]), {});
    await expect(executeSchema(graph, context)).rejects.toThrow(
      'Выход location (путь «result.location») не соответствует типу string (получено: number)',
    );
  });

  it('маршрутизирует condition по true/false exec-портам', async () => {
    // Ветки — exec-узлы log: только пройденная ветка исполняется и оставляет след в
    // executionLog. transform теперь data-only (issue #201) и не годится для exec-ветвления.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'condition_test',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'condition',
          type: 'condition',
          position: { x: 200, y: 0 },
          config: { input: 'allowed' },
        },
        { id: 'true_node', type: 'log', position: { x: 400, y: -80 }, config: {} },
        { id: 'false_node', type: 'log', position: { x: 400, y: 80 }, config: {} },
        { id: 'end', type: 'end', position: { x: 600, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->condition', from: 'start', fromPort: 'exec', to: 'condition', toPort: 'exec' },
        { id: 'condition->true', from: 'condition', fromPort: 'true', to: 'true_node', toPort: 'exec' },
        { id: 'condition->false', from: 'condition', fromPort: 'false', to: 'false_node', toPort: 'exec' },
        { id: 'true->end', from: 'true_node', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'false->end', from: 'false_node', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
    };

    const takenBranch = async (allowed: boolean): Promise<string[]> => {
      const context = ctx(graph, mockProvider([]), { allowed });
      await executeSchema(graph, context);
      const log = context.variables.get('executionLog');
      return Array.isArray(log) ? log.map((entry) => (entry as { nodeId: string }).nodeId) : [];
    };

    expect(await takenBranch(true)).toEqual(['true_node']);
    expect(await takenBranch(false)).toEqual(['false_node']);
  });

  it('блок merge дожидается всех потоков и исполняется один раз (issue #203)', async () => {
    // Два параллельных потока start → a и start → b сходятся в merge по разным
    // exec-входам. merge должен подождать оба и продолжить ровно один раз.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'merge_test',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'log', position: { x: 200, y: -80 }, config: {} },
        { id: 'b', type: 'log', position: { x: 200, y: 80 }, config: {} },
        { id: 'merge', type: 'merge', position: { x: 400, y: 0 }, config: {} },
        { id: 'after', type: 'log', position: { x: 600, y: 0 }, config: {} },
        { id: 'end', type: 'end', position: { x: 800, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->a', from: 'start', fromPort: 'exec', to: 'a', toPort: 'exec' },
        { id: 'start->b', from: 'start', fromPort: 'exec', to: 'b', toPort: 'exec' },
        { id: 'a->merge', from: 'a', fromPort: 'exec', to: 'merge', toPort: 'exec_1' },
        { id: 'b->merge', from: 'b', fromPort: 'exec', to: 'merge', toPort: 'exec_2' },
        { id: 'merge->after', from: 'merge', fromPort: 'exec', to: 'after', toPort: 'exec' },
        { id: 'after->end', from: 'after', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
    };

    const context = ctx(graph, mockProvider([]), {});
    await executeSchema(graph, context);
    const log = context.variables.get('executionLog');
    const visited = Array.isArray(log) ? log.map((entry) => (entry as { nodeId: string }).nodeId) : [];

    // Оба потока исполнились, а узел после merge — ровно один раз и после обоих веток.
    expect(visited.filter((nodeId) => nodeId === 'a')).toHaveLength(1);
    expect(visited.filter((nodeId) => nodeId === 'b')).toHaveLength(1);
    expect(visited.filter((nodeId) => nodeId === 'after')).toHaveLength(1);
    expect(visited.indexOf('after')).toBeGreaterThan(visited.indexOf('a'));
    expect(visited.indexOf('after')).toBeGreaterThan(visited.indexOf('b'));
  });

  it('game_state_read отдаёт весь объект состояния на единственный выход state (issue #208)', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'state_read_object',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'state_read', type: 'game_state_read', position: { x: 160, y: 0 }, config: {} },
        {
          id: 'llm',
          type: 'llm_request',
          position: { x: 320, y: 0 },
          config: {
            userPrompt: 'Состояние: {{state}}.',
            inputs: [{ name: 'state', type: 'object' }],
            outputs: [{ name: 'value', jsonPath: 'value', type: 'string' }],
          },
        },
        { id: 'end', type: 'end', position: { x: 480, y: 0 }, config: {} },
      ],
      edges: [
        // game_state_read — data-only (issue #201): exec идёт start → llm → end, а state_read
        // подтягивается, когда llm запрашивает свой вход state.
        { id: 'start->llm', from: 'start', fromPort: 'exec', to: 'llm', toPort: 'exec' },
        { id: 'llm->end', from: 'llm', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'state-data', from: 'state_read', fromPort: 'state', to: 'llm', toPort: 'state' },
        { id: 'value-end', from: 'llm', fromPort: 'value', to: 'end', toPort: 'narrative' },
      ],
    };

    const provider = mockProvider([JSON.stringify({ value: 'ок' })]);
    await executeSchema(graph, ctx(graph, provider, {}));

    const generateText = provider.generateText as unknown as ReturnType<typeof vi.fn>;
    const prompt = generateText.mock.calls[0][0].prompt as string;
    // На выход state отдаётся весь объект состояния игры целиком.
    expect(prompt).toContain('"location": "Теплотрасса"');
    expect(prompt).toContain('"narrative": "старт"');
  });

  it('game_state_write мержит переданный state с текущим (issue #208)', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'state_write_merge',
      variables: { patch: { turn_count: 6, character: { hp: 50 } } },
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'patch', type: 'variable_read', position: { x: 120, y: 0 }, config: { outputs: [{ name: 'patch', type: 'object' }] } },
        { id: 'state_write', type: 'game_state_write', position: { x: 280, y: 0 }, config: {} },
        { id: 'end', type: 'end', position: { x: 440, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->write', from: 'start', fromPort: 'exec', to: 'state_write', toPort: 'exec' },
        { id: 'write->end', from: 'state_write', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'patch->write', from: 'patch', fromPort: 'patch', to: 'state_write', toPort: 'state' },
      ],
    };

    const context = ctx(graph, mockProvider([]), {});
    await executeSchema(graph, context);

    // Мерж глубокий: turn_count обновлён, character.hp заменён, остальные поля сохранены.
    expect(context.state.turn_count).toBe(6);
    expect(context.state.character.hp).toBe(50);
    expect(context.state.character.max_hp).toBe(100);
    expect(context.state.location).toBe('Теплотрасса');
  });

  it('game_history_read разворачивает ходы в реплики master/player (issue #271)', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'game_history',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'history', type: 'game_history_read', position: { x: 120, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 280, y: 0 },
          config: { code: 'return JSON.stringify(input.messages);', inputs: [{ name: 'messages', type: 'object_array' }] },
        },
        { id: 'end', type: 'end', position: { x: 440, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'messages', from: 'history', fromPort: 'messages', to: 'transform', toPort: 'messages' },
        { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'narrative' },
      ],
    };

    const context = ctx(graph, mockProvider([]), {
      history: [
        { turn: 1, action: 'идти на север', outcome: 'Ты выходишь к реке.' },
        { turn: 2, action: '', outcome: 'Налетает ветер.' },
      ],
    });
    const outputs = await executeSchema(graph, context);
    // Каждый ход разворачивается в реплику игрока (action) и нарратора (outcome);
    // пустые поля пропускаются — у хода 2 нет действия игрока.
    expect(JSON.parse(outputs.narrative as string)).toEqual([
      { role: 'player', message: 'идти на север' },
      { role: 'master', message: 'Ты выходишь к реке.' },
      { role: 'master', message: 'Налетает ветер.' },
    ]);
  });

  it('support_history_read отдаёт переписку тикета из supportHistory (issue #271)', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'support',
      slug: 'support_history',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'history', type: 'support_history_read', position: { x: 120, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 280, y: 0 },
          config: { code: 'return JSON.stringify(input.messages);', inputs: [{ name: 'messages', type: 'object_array' }] },
        },
        { id: 'end', type: 'end', position: { x: 440, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'messages', from: 'history', fromPort: 'messages', to: 'transform', toPort: 'messages' },
        { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'reply' },
      ],
    };

    const context: SchemaExecutionContext = {
      ...ctx(graph, mockProvider([]), {}),
      supportHistory: [
        { role: 'user', message: 'Не пришли звёзды' },
        { role: 'operator', message: 'Сейчас проверим' },
        { role: 'bot', message: 'Платёж найден' },
      ],
    };
    const outputs = await executeSchema(graph, context);
    expect(JSON.parse(outputs.reply as string)).toEqual([
      { role: 'user', message: 'Не пришли звёзды' },
      { role: 'operator', message: 'Сейчас проверим' },
      { role: 'bot', message: 'Платёж найден' },
    ]);
  });

  it('variable_write и variable_read работают с именованными портами (issue #208)', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'variable_named_ports',
      variables: { src_gold: 42, src_name: 'Бомж' },
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'read_src', type: 'variable_read', position: { x: 120, y: 0 }, config: { outputs: [{ name: 'src_gold', type: 'number' }, { name: 'src_name', type: 'string' }] } },
        { id: 'write', type: 'variable_write', position: { x: 280, y: 0 }, config: { inputs: [{ name: 'gold', type: 'number' }, { name: 'name', type: 'string' }] } },
        { id: 'end', type: 'end', position: { x: 440, y: 0 }, config: {} },
      ],
      edges: [
        // variable_write — exec-узел: пишет переменные при прохождении потока.
        { id: 'start->write', from: 'start', fromPort: 'exec', to: 'write', toPort: 'exec' },
        { id: 'write->end', from: 'write', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'gold', from: 'read_src', fromPort: 'src_gold', to: 'write', toPort: 'gold' },
        { id: 'name', from: 'read_src', fromPort: 'src_name', to: 'write', toPort: 'name' },
      ],
    };

    const context = ctx(graph, mockProvider([]), {});
    await executeSchema(graph, context);

    expect(context.variables.get('gold')).toBe(42);
    expect(context.variables.get('name')).toBe('Бомж');
  });

  it('variable_write исполняется без config.name (issue #232)', async () => {
    // Регрессия issue #232: до перехода на именованные порты (issue #208) узел
    // variable_write требовал config.name и без него падал с ошибкой
    // «variable_write-узлу нужен config.name». Сейчас пустая конфигурация даёт
    // единственный порт value, а legacy config.name больше не поддерживается —
    // запуск теста схемы не должен выдавать эту ошибку ни в одном из случаев.
    const buildGraph = (config: Record<string, unknown>): SchemaGraph => ({
      version: 1,
      schemaType: 'action',
      slug: 'variable_write_no_name',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'write', type: 'variable_write', position: { x: 200, y: 0 }, config },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->write', from: 'start', fromPort: 'exec', to: 'write', toPort: 'exec' },
        { id: 'write->end', from: 'write', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
    });

    // Пустая конфигурация: дефолтный порт value, без ошибок.
    const emptyGraph = buildGraph({});
    const emptyCtx = ctx(emptyGraph, mockProvider([]), {});
    await expect(executeSchema(emptyGraph, emptyCtx)).resolves.toBeDefined();
    expect(emptyCtx.variables.has('value')).toBe(true);

    // Legacy config.name больше не поддерживается (issue #232): порт value, а не gold.
    // config.value пишется в единственный порт value; одноимённой переменной gold нет.
    const legacyGraph = buildGraph({ name: 'gold', value: 7 });
    const legacyCtx = ctx(legacyGraph, mockProvider([]), {});
    await executeSchema(legacyGraph, legacyCtx);
    expect(legacyCtx.variables.has('gold')).toBe(false);
    expect(legacyCtx.variables.get('value')).toBe(7);
  });

  it('валидирует порты графа до production-исполнения', async () => {
    const graph = transformGraph('return Number(input.value) + 1;');
    graph.edges.push({
      id: 'mixed-port',
      from: 'start',
      fromPort: 'value',
      to: 'transform',
      toPort: 'exec',
    });

    await expect(executeSchema(graph, ctx(graph, mockProvider([]), { value: 2 })))
      .rejects.toThrow('смешивает exec-порт и data-порт');
  });

  it('запрещает несколько data-рёбер в один input до production-исполнения', async () => {
    const graph = transformGraph('return Number(input.value) + 1;');
    graph.edges.push({
      id: 'duplicate-input',
      from: 'start',
      fromPort: 'inputs',
      to: 'transform',
      toPort: 'value',
    });

    await expect(executeSchema(graph, ctx(graph, mockProvider([]), { value: 2 })))
      .rejects.toThrow('уже подключён');
  });

  it('исполняет блоки памяти через data-зависимости без exec-рёбер', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'memory_data_only',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'memory_read', type: 'game_memory_read', position: { x: 180, y: 120 }, config: {} },
        {
          id: 'narrative',
          type: 'llm_request',
          position: { x: 360, y: 0 },
          config: {
            kind: 'narrative_generation',
            userPrompt: 'Память: {{memory}}',
            outputs: [{ name: 'narrative', jsonPath: 'narrative', type: 'string' }],
          },
        },
        {
          id: 'memory_enabled',
          type: 'condition',
          position: { x: 560, y: 0 },
          config: { input: 'memory_enabled' },
        },
        {
          id: 'memory_write',
          type: 'game_memory_write',
          position: { x: 760, y: 120 },
          config: {
            systemPrompt: 'Игра {{game_name}}',
            userPrompt: 'Нарратив: {{narrative}}\nПамять: {{existing_memory}}',
          },
        },
        { id: 'end', type: 'end', position: { x: 960, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->narrative', from: 'start', fromPort: 'exec', to: 'narrative', toPort: 'exec' },
        { id: 'narrative->memory-enabled', from: 'narrative', fromPort: 'exec', to: 'memory_enabled', toPort: 'exec' },
        { id: 'memory-enabled-true', from: 'memory_enabled', fromPort: 'true', to: 'end', toPort: 'exec' },
        { id: 'memory-enabled-false', from: 'memory_enabled', fromPort: 'false', to: 'end', toPort: 'exec' },
        { id: 'memory-read-data', from: 'memory_read', fromPort: 'memory', to: 'narrative', toPort: 'memory' },
        { id: 'narrative-data', from: 'narrative', fromPort: 'narrative', to: 'memory_write', toPort: 'narrative' },
        { id: 'memory-enabled-data', from: 'memory_enabled', fromPort: 'condition', to: 'memory_write', toPort: 'enabled' },
        { id: 'narrative-end', from: 'narrative', fromPort: 'narrative', to: 'end', toPort: 'narrative' },
        { id: 'memory-write-end', from: 'memory_write', fromPort: 'memoryUpdate', to: 'end', toPort: 'memoryUpdate' },
      ],
    };
    const provider = mockProvider([
      JSON.stringify({ narrative: 'Игрок дошёл до рынка.' }),
      '{"memory":[{"content":"Игрок нашёл старьёвщика на рынке.","category":"события","importance":2}]}',
    ]);
    const context = ctx(graph, provider, {
      action: 'дойти до рынка',
      memory_enabled: true,
      memoryTopK: 1,
    });
    context.memoryCells = [memoryCell()];

    const outputs = await executeSchema(graph, context);

    expect(provider.generateText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.generateText).mock.calls[0][0].prompt).toContain(
      'Игрок договорился со старьёвщиком о медной проволоке.',
    );
    expect(outputs).toMatchObject({
      narrative: 'Игрок дошёл до рынка.',
      memoryUpdate: {
        added: [{ content: 'Игрок нашёл старьёвщика на рынке.', category: 'события', importance: 2 }],
      },
    });
  });

  it('исполняет полный action-граф с мок-провайдером и обновляет состояние по фазам', async () => {
    const graph = buildDefaultActionSchema(TEST_PROMPT_TEMPLATES);
    const provider = mockProvider([
      JSON.stringify({ narrative: 'Ты вскрываешь замок и входишь в подъезд.' }),
      JSON.stringify({ inventory: ['отмычка', 'ключ'] }),
      JSON.stringify({ characteristics: { max_hp: 95, skills: { взлом: 4 } } }),
      JSON.stringify({ world_flags: { door_locked: false } }),
      JSON.stringify({
        updated_state: {
          location: 'Подъезд',
          character: { hp: 70 },
          world_time: { season: 'осень', date: '14 октября', time: '08:10', time_of_day: 'утро' },
        },
      }),
    ]);
    const context = ctx(graph, provider, {
      action: 'взломать дверь',
      expertise_enabled: false,
      memory_enabled: false,
      expertiseTopK: 0,
      memoryTopK: 0,
    });

    const outputs = await executeSchema(graph, context);

    expect(provider.generateText).toHaveBeenCalledTimes(5);
    expect(outputs.narrative).toBe('Ты вскрываешь замок и входишь в подъезд.');
    expect(context.state.character.inventory).toEqual(['отмычка', 'ключ']);
    expect(context.state.character.skills.взлом).toBe(4);
    expect(context.state.character.max_hp).toBe(95);
    expect(context.state.world_flags.door_locked).toBe(false);
    expect(context.state.location).toBe('Подъезд');
    expect(context.state.character.hp).toBe(70);
    expect(context.state.world_time.time).toBe('08:10');
  });

  it('миграционный action-граф возвращает данные, достаточные для формы TurnResult', async () => {
    const action = buildDefaultSchemas(TEST_PROMPT_TEMPLATES).find(
      (schema) => schema.graph.slug === 'action',
    );
    expect(action).toBeDefined();
    if (!action) return;

    const provider = mockProvider([
      JSON.stringify({ narrative: 'Ход принят.' }),
      JSON.stringify({ inventory: ['отмычка'] }),
      JSON.stringify({ characteristics: { max_hp: 100, skills: { взлом: 3 } } }),
      JSON.stringify({ world_flags: { door_locked: true } }),
      JSON.stringify({ updated_state: { location: 'Теплотрасса', character: { hp: 80 } } }),
    ]);
    const context = ctx(action.graph, provider, {
      action: 'осмотреться',
      expertise_enabled: false,
      memory_enabled: false,
      expertiseTopK: 0,
      memoryTopK: 0,
    });
    const outputs = await executeSchema(action.graph, context);

    const turnLike = {
      ok: true,
      narrative: outputs.narrative,
      // Канонические game_state_write мутируют ctx.state прямо в exec-цепочке, поэтому
      // итоговое состояние берётся из context.state (как в processViaSchema), а не из выхода end.
      newState: context.state,
      rawResponse: JSON.stringify({
        narrative: outputs.rawNarrative,
        inventory: outputs.rawInventory,
        characteristics: outputs.rawCharacteristics,
        flags: outputs.rawFlags,
        other_state: outputs.rawOtherState,
      }),
      gameOver: false,
      llmLog: context.llmLog,
      creditsUsed: 0,
      tokenUsage: emptyTokenUsage(),
      costMillicents: 0,
    };

    expect(Object.keys(turnLike)).toEqual([
      'ok',
      'narrative',
      'newState',
      'rawResponse',
      'gameOver',
      'llmLog',
      'creditsUsed',
      'tokenUsage',
      'costMillicents',
    ]);
    expect(turnLike.narrative).toBe('Ход принят.');
    expect(turnLike.newState).toMatchObject({ location: 'Теплотрасса' });
  });

  it('миграционный illustration-граф отдаёт image_url через media_generate (issue #225)', async () => {
    const graph = buildDefaultIllustrationSchema(TEST_PROMPT_TEMPLATES);
    const mediaNode = graph.nodes.find((node) => node.type === 'media_generate');
    expect(mediaNode).toBeDefined();
    // media_generate: настраиваемые входы (config.inputs) и шаблон промпта, без narrative/state.
    expect(mediaNode?.config).toMatchObject({ inputs: [] });
    expect(typeof mediaNode?.config.prompt).toBe('string');
    // Выход image_url узла подключён к одноимённому входу end.
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromPort: 'image_url', to: 'end', toPort: 'image_url' }),
      ]),
    );

    const outputs = await executeSchema(graph, ctx(graph, mockProvider([]), {}));
    expect(typeof outputs.image_url).toBe('string');
  });

  it('media_generate реально рисует через провайдера медиа (issue #238)', async () => {
    const graph = buildDefaultIllustrationSchema(TEST_PROMPT_TEMPLATES);
    const generateImage = vi.fn(async (req: { prompt: string; model?: string; size?: string }) => ({
      image: Buffer.from(`png:${req.prompt}`),
      extension: 'png',
      meta: { request: req.prompt, response: 'ok' },
    }));
    const mediaProvider = {
      name: 'MockMedia',
      canSpeak: false,
      canDraw: true,
      canTranscribe: false,
      generateSpeech: vi.fn(),
      generateImage,
      transcribe: vi.fn(),
    };
    const execCtx: SchemaExecutionContext = {
      ...ctx(graph, mockProvider([]), { scene_text: 'Тёмный подвал, капает вода.' }),
      mediaProvider,
      mediaImage: { model: 'dall-e-3', size: '1024x1024' },
    };

    const outputs = await executeSchema(graph, execCtx);

    // image_url остаётся строкой-промптом (обратная совместимость).
    expect(typeof outputs.image_url).toBe('string');
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage.mock.calls[0][0]).toMatchObject({ model: 'dall-e-3', size: '1024x1024' });
    // Бинарный результат прокинут через выходы узла media_generate.
    const mediaNode = graph.nodes.find((node) => node.type === 'media_generate');
    const nodeOut = execCtx.nodeOutputs.get(mediaNode!.id);
    expect(Buffer.isBuffer(nodeOut?.image)).toBe(true);
    expect(nodeOut?.extension).toBe('png');
  });

  it('media_generate без провайдера медиа возвращает только промпт (issue #238)', async () => {
    const graph = buildDefaultIllustrationSchema(TEST_PROMPT_TEMPLATES);
    const execCtx = ctx(graph, mockProvider([]), { scene_text: 'Сцена' });
    const outputs = await executeSchema(graph, execCtx);
    expect(typeof outputs.image_url).toBe('string');
    const mediaNode = graph.nodes.find((node) => node.type === 'media_generate');
    const nodeOut = execCtx.nodeOutputs.get(mediaNode!.id);
    expect(nodeOut?.image).toBeUndefined();
  });

  it('прерывает бесконечный цикл в transform по таймауту (этап B, issue #245)', async () => {
    // До этапа B `new Function` с пользовательским while(true) вешал процесс. Теперь код
    // исполняется в vm с таймаутом, поэтому некорректный граф падает с ошибкой, а не зависает.
    const graph = transformGraph('while (true) {}');
    await expect(executeSchema(graph, ctx(graph, mockProvider([]), { value: 1 }))).rejects.toThrow(
      'превысило лимит',
    );
  });

  it('loop пробрасывает data-вход в тело, идёт по элементам и агрегирует (этап B, issue #245)', async () => {
    const body: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'loop_body',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'double',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return Number(input.value) * 2;', output: 'value' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'b-exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'b-in', from: 'start', fromPort: 'value', to: 'double', toPort: 'value' },
        { id: 'b-out', from: 'double', fromPort: 'value', to: 'end', toPort: 'value' },
      ],
    };
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'loop_test',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'loop',
          type: 'loop',
          position: { x: 200, y: 0 },
          config: { maxIterations: 10, iterateItems: true, aggregate: 'collect', bodyGraph: body },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'loop', toPort: 'exec' },
        { id: 'exec2', from: 'loop', fromPort: 'done', to: 'end', toPort: 'exec' },
        { id: 'val-in', from: 'start', fromPort: 'value', to: 'loop', toPort: 'value' },
        { id: 'val-out', from: 'loop', fromPort: 'value', to: 'end', toPort: 'value' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { value: [3, 5] });
    const outputs = await executeSchema(graph, context);
    // Тело удваивает каждый элемент входного массива; aggregate=collect собирает все итерации.
    expect(outputs.value).toEqual([{ value: 6 }, { value: 10 }]);
  });

  it('sub_schema по slug исполняет схему из резолвера и изолирует переменные (этап B, issue #245)', async () => {
    const child: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'child_schema',
      variables: { childOnly: 42 },
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'tenx',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return Number(input.value) * 10;', output: 'value' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'c-exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'c-in', from: 'start', fromPort: 'value', to: 'tenx', toPort: 'value' },
        { id: 'c-out', from: 'tenx', fromPort: 'value', to: 'end', toPort: 'value' },
      ],
    };
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'parent_schema',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'sub',
          type: 'sub_schema',
          position: { x: 200, y: 0 },
          config: { schemaSlug: 'child' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
        { id: 'exec2', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'val-in', from: 'start', fromPort: 'value', to: 'sub', toPort: 'value' },
        { id: 'val-out', from: 'sub', fromPort: 'value', to: 'end', toPort: 'value' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { value: 5 });
    context.resolveSubSchema = async (slug) => (slug === 'child' ? child : null);
    const outputs = await executeSchema(graph, context);
    expect(outputs.value).toBe(50);
    // Изоляция: переменные вложенной схемы не протекают в родительский контекст.
    expect(context.variables.has('childOnly')).toBe(false);
  });

  it('sub_schema бросает ошибку, если активной схемы по slug нет (этап B, issue #245)', async () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'parent_missing',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'sub',
          type: 'sub_schema',
          position: { x: 200, y: 0 },
          config: { schemaSlug: 'absent' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
        { id: 'exec2', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
    };

    const context = ctx(graph, mockProvider([]), {});
    context.resolveSubSchema = async () => null;
    // Нехватка данных в БД доставляется ошибкой — legacy/«тихого» fallback нет (issue #238/#245).
    await expect(executeSchema(graph, context)).rejects.toThrow('не найдена');
  });

  it('sub_schema пробрасывает несколько именованных портов входа и выхода (issue #310)', async () => {
    // Суб-схема считает сумму и разность двух именованных входов a/b и отдаёт их
    // через два именованных выхода sum/diff. Проверяем, что движок пробрасывает не
    // только порт value, но любые именованные граничные порты по рёбрам.
    const child: SchemaGraph = {
      version: 1,
      subSchemaClass: 'common',
      slug: 'calc',
      variables: {},
      nodes: [
        {
          id: 'start',
          type: 'start',
          position: { x: 0, y: 0 },
          config: {
            outputs: [
              { id: 'a', label: 'A', type: 'number' },
              { id: 'b', label: 'B', type: 'number' },
            ],
          },
        },
        {
          id: 'sum',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return Number(input.a) + Number(input.b);', output: 'sum' },
        },
        {
          id: 'diff',
          type: 'transform',
          position: { x: 200, y: 120 },
          config: { code: 'return Number(input.a) - Number(input.b);', output: 'diff' },
        },
        {
          id: 'end',
          type: 'end',
          position: { x: 400, y: 0 },
          config: {
            inputs: [
              { id: 'sum', label: 'Сумма', type: 'number' },
              { id: 'diff', label: 'Разность', type: 'number' },
            ],
          },
        },
      ],
      edges: [
        { id: 'c-exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'c-a-sum', from: 'start', fromPort: 'a', to: 'sum', toPort: 'a' },
        { id: 'c-b-sum', from: 'start', fromPort: 'b', to: 'sum', toPort: 'b' },
        { id: 'c-a-diff', from: 'start', fromPort: 'a', to: 'diff', toPort: 'a' },
        { id: 'c-b-diff', from: 'start', fromPort: 'b', to: 'diff', toPort: 'b' },
        { id: 'c-sum-out', from: 'sum', fromPort: 'sum', to: 'end', toPort: 'sum' },
        { id: 'c-diff-out', from: 'diff', fromPort: 'diff', to: 'end', toPort: 'diff' },
      ],
    };
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'parent_calc',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub', type: 'sub_schema', position: { x: 200, y: 0 }, config: { schemaSlug: 'calc' } },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
        { id: 'exec2', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'a-in', from: 'start', fromPort: 'a', to: 'sub', toPort: 'a' },
        { id: 'b-in', from: 'start', fromPort: 'b', to: 'sub', toPort: 'b' },
        { id: 'sum-out', from: 'sub', fromPort: 'sum', to: 'end', toPort: 'sum' },
        { id: 'diff-out', from: 'sub', fromPort: 'diff', to: 'end', toPort: 'diff' },
      ],
    };

    const context = ctx(graph, mockProvider([]), { a: 10, b: 3 });
    context.resolveSubSchema = async (slug) => (slug === 'calc' ? child : null);
    const outputs = await executeSchema(graph, context);
    expect(outputs.sum).toBe(13);
    expect(outputs.diff).toBe(7);
  });

  it('sub_schema: узел manifest внутри читает манифест корневого контекста (issue #310)', async () => {
    // Суб-схема с узлом manifest без gameId: имя игры берётся из ctx.manifest
    // вызывающей игры. Одна и та же суб-схема под двумя манифестами даёт разный
    // результат — привязки к конкретной игре нет.
    const child: SchemaGraph = {
      version: 1,
      subSchemaClass: 'common',
      slug: 'game_name',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [] } },
        { id: 'm', type: 'manifest', position: { x: 200, y: 0 }, config: { fields: ['name'] } },
        {
          id: 'end',
          type: 'end',
          position: { x: 400, y: 0 },
          config: { inputs: [{ id: 'name', label: 'Имя игры', type: 'string' }] },
        },
      ],
      edges: [
        { id: 'c-exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'c-name', from: 'm', fromPort: 'name', to: 'end', toPort: 'name' },
      ],
    };
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'parent_manifest',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub', type: 'sub_schema', position: { x: 200, y: 0 }, config: { schemaSlug: 'game_name' } },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
        { id: 'exec2', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'name-out', from: 'sub', fromPort: 'name', to: 'end', toPort: 'name' },
      ],
    };

    const bomjCtx = ctx(graph, mockProvider([]), {}, state());
    bomjCtx.resolveSubSchema = async () => child;
    const bomjOut = await executeSchema(graph, bomjCtx);
    expect(bomjOut.name).toBe(TEST_GAMES.bomj.name);

    const redHoodCtx: SchemaExecutionContext = {
      ...ctx(graph, mockProvider([]), {}, state()),
      manifest: TEST_GAMES.red_hood,
    };
    redHoodCtx.resolveSubSchema = async () => child;
    const redHoodOut = await executeSchema(graph, redHoodCtx);
    expect(redHoodOut.name).toBe(TEST_GAMES.red_hood.name);

    expect(bomjOut.name).not.toBe(redHoodOut.name);
  });

  it('llm_request: поле config.retries переопределяет глобальный maxRetries (issue #248)', async () => {
    // Граф с одним llm_request: первые две попытки возвращают невалидный JSON,
    // третья — валидный. При глобальном maxRetries=1 узел не успел бы получить
    // корректный ответ; node.config.retries=3 поднимает лимит попыток локально.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'retries_override',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'llm',
          type: 'llm_request',
          position: { x: 200, y: 0 },
          config: {
            userPrompt: 'верни json',
            retryPrompt: 'повтори: {{base_prompt}}',
            retries: 3,
            outputs: [{ name: 'answer', type: 'string' }],
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'exec1', from: 'start', fromPort: 'exec', to: 'llm', toPort: 'exec' },
        { id: 'exec2', from: 'llm', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'answer-end', from: 'llm', fromPort: 'answer', to: 'end', toPort: 'answer' },
      ],
    };
    const provider = mockProvider(['не json', 'тоже не json', '{"answer":"готово"}']);
    const context = ctx(graph, provider, {});
    context.maxRetries = 1;

    const outputs = await executeSchema(graph, context);

    expect(provider.generateText).toHaveBeenCalledTimes(3);
    expect(outputs.answer).toBe('готово');
  });

  it('constant отдаёт значения портов с приведением типов (issue #319)', async () => {
    // constant — data-only узел без входов: exec идёт start → end, а значения портов
    // забираются по требованию. Проверяем приведение всех поддерживаемых типов, особенно
    // boolean='false' (Boolean('false') === true — частая ловушка).
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'constant_test',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'constant',
          type: 'constant',
          position: { x: 200, y: 0 },
          config: {
            outputs: [
              { name: 'title', type: 'string', value: 'Привет' },
              { name: 'count', type: 'number', value: '42' },
              { name: 'flag_off', type: 'boolean', value: 'false' },
              { name: 'flag_on', type: 'boolean', value: 'true' },
              { name: 'cfg', type: 'object', value: '{"a":1}' },
              { name: 'tags', type: 'string_array', value: '["x","y"]' },
              { name: 'items', type: 'object_array', value: '[{"id":1}]' },
              { name: 'broken', type: 'object', value: 'не json' },
            ],
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'e-title', from: 'constant', fromPort: 'title', to: 'end', toPort: 'title' },
        { id: 'e-count', from: 'constant', fromPort: 'count', to: 'end', toPort: 'count' },
        { id: 'e-off', from: 'constant', fromPort: 'flag_off', to: 'end', toPort: 'flag_off' },
        { id: 'e-on', from: 'constant', fromPort: 'flag_on', to: 'end', toPort: 'flag_on' },
        { id: 'e-cfg', from: 'constant', fromPort: 'cfg', to: 'end', toPort: 'cfg' },
        { id: 'e-tags', from: 'constant', fromPort: 'tags', to: 'end', toPort: 'tags' },
        { id: 'e-items', from: 'constant', fromPort: 'items', to: 'end', toPort: 'items' },
        { id: 'e-broken', from: 'constant', fromPort: 'broken', to: 'end', toPort: 'broken' },
      ],
    };

    const outputs = await executeSchema(graph, ctx(graph, mockProvider([]), {}));

    expect(outputs.title).toBe('Привет');
    expect(outputs.count).toBe(42);
    expect(outputs.flag_off).toBe(false);
    expect(outputs.flag_on).toBe(true);
    expect(outputs.cfg).toEqual({ a: 1 });
    expect(outputs.tags).toEqual(['x', 'y']);
    expect(outputs.items).toEqual([{ id: 1 }]);
    // Невалидный JSON для object → пустой объект (а не падение).
    expect(outputs.broken).toEqual({});
  });
});
