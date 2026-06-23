import { describe, expect, it } from 'vitest';
import {
  GAME_STATE_READ_OUTPUTS,
  SchemaContractError,
  execInputPortIds,
  execOutputPortIds,
  getNodePaletteForSchema,
  getNodePortDefinitions,
  portColor,
  schemaEndPortType,
  schemaStartPortType,
  validateSchemaGraphContract,
  type SchemaContractErrorCode,
  type SchemaGraph,
} from '@tg-games/schema-contract';
import { executeSchema, type SchemaExecutionContext } from '@tg-games/core/engine/schemaEngine.js';

function baseGraph(): SchemaGraph {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'transform', type: 'transform', position: { x: 200, y: 0 }, config: { expression: 'inputs.value' } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      // transform — data-only узел (issue #201): без exec-портов, исполняется по требованию,
      // когда end забирает его выход. Exec-поток идёт напрямую start → end.
      { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'value', from: 'start', fromPort: 'value', to: 'transform', toPort: 'value' },
      { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

function expectContractError(work: () => void, code: SchemaContractErrorCode): SchemaContractError {
  try {
    work();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaContractError);
    expect(err).toMatchObject({ code });
    return err as SchemaContractError;
  }
  throw new Error(`Ожидалась ошибка ${code}`);
}

describe('shared schema contract', () => {
  it('хранит schema-specific boundary ports и цвета портов в общем registry', () => {
    // issue #213: у конечных узлов остаются только обозначенные граничные порты.
    expect(schemaStartPortType('action', 'action')).toBe('string');
    expect(schemaEndPortType('action', 'narrative')).toBeNull();
    expect(schemaEndPortType('action', 'state_delta')).toBeNull();
    expect(schemaStartPortType('hint', 'state')).toBeNull();
    expect(schemaEndPortType('hint', 'hints')).toBe('string_array');
    expect(schemaStartPortType('illustration', 'narrative')).toBeNull();
    expect(schemaStartPortType('illustration', 'state')).toBeNull();
    expect(schemaEndPortType('illustration', 'image_url')).toBe('string');
    expect(schemaEndPortType('illustration', 'prompt')).toBeNull();
    expect(schemaStartPortType('support', 'user_query')).toBe('string');
    expect(schemaEndPortType('support', 'reply')).toBe('string');
    // issue #244: на end поддержки появились флаги решения консультанта.
    expect(schemaEndPortType('support', 'escalate')).toBe('boolean');
    expect(schemaEndPortType('support', 'resolved')).toBe('boolean');
    expect(schemaEndPortType('support', 'summary')).toBe('string');
    expect(portColor('object_array')).toBe('#67e8f9');
  });

  it('задаёт schema-specific palette policy', () => {
    expect(getNodePaletteForSchema('action')).toContain('game_state_write');
    expect(getNodePaletteForSchema('support')).not.toContain('game_state_write');
  });

  it('не добавляет exec-порты блокам чтения и записи памяти', () => {
    const memoryRead = {
      id: 'memory_read',
      type: 'game_memory_read',
      position: { x: 100, y: 0 },
      config: {},
    } satisfies SchemaGraph['nodes'][number];
    const memoryWrite = {
      id: 'memory_write',
      type: 'game_memory_write',
      position: { x: 200, y: 0 },
      config: {},
    } satisfies SchemaGraph['nodes'][number];

    expect(execInputPortIds(memoryRead)).toEqual([]);
    expect(execOutputPortIds(memoryRead)).toEqual([]);
    expect(execInputPortIds(memoryWrite)).toEqual([]);
    expect(execOutputPortIds(memoryWrite)).toEqual([]);

    const readPorts = getNodePortDefinitions(memoryRead);
    const writePorts = getNodePortDefinitions(memoryWrite);
    expect([...readPorts.inputs, ...readPorts.outputs].some((port) => port.type === 'exec')).toBe(false);
    expect([...writePorts.inputs, ...writePorts.outputs].some((port) => port.type === 'exec')).toBe(false);
    expect(writePorts.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'narrative', type: 'string' }),
        expect.objectContaining({ id: 'enabled', type: 'boolean' }),
      ]),
    );
  });

  it('делает read/manifest/transform data-only (issue #201)', () => {
    // game_state_read/variable_read — pull-источники без exec-портов. game_state_write и
    // variable_write (issue #208) стали exec-узлами с побочным эффектом — проверяются ниже.
    const dataOnlyTypes: SchemaGraph['nodes'][number]['type'][] = [
      'game_state_read',
      'manifest',
      'variable_read',
      'transform',
    ];

    for (const type of dataOnlyTypes) {
      const node = { id: type, type, position: { x: 0, y: 0 }, config: {} } satisfies SchemaGraph['nodes'][number];
      expect(execInputPortIds(node), `${type} exec inputs`).toEqual([]);
      expect(execOutputPortIds(node), `${type} exec outputs`).toEqual([]);
      const ports = getNodePortDefinitions(node);
      expect(
        [...ports.inputs, ...ports.outputs].some((port) => port.type === 'exec'),
        `${type} has no exec port`,
      ).toBe(false);
    }
  });

  it('write-блоки исполняются в exec-потоке (issue #208)', () => {
    // Write-узлы — побочные эффекты без выходов: один exec-вход и один exec-выход.
    for (const type of ['game_state_write', 'variable_write'] as const) {
      const node = { id: type, type, position: { x: 0, y: 0 }, config: {} } satisfies SchemaGraph['nodes'][number];
      expect(execInputPortIds(node), `${type} exec inputs`).toEqual(['exec']);
      expect(execOutputPortIds(node), `${type} exec outputs`).toEqual(['exec']);
    }

    // game_state_write принимает единственный вход state (объект) и не имеет data-выходов.
    const writer = { id: 'w', type: 'game_state_write' as const, position: { x: 0, y: 0 }, config: {} };
    const ports = getNodePortDefinitions(writer);
    expect(ports.inputs.filter((port) => port.type !== 'exec')).toEqual([
      expect.objectContaining({ id: 'state', type: 'object' }),
    ]);
    expect(ports.outputs.filter((port) => port.type !== 'exec')).toEqual([]);
  });

  it('делит variable на variable_read и variable_write (issue #201)', () => {
    // По умолчанию (пустой config) — один порт value, без портов противоположного направления.
    const read = getNodePortDefinitions({ id: 'r', type: 'variable_read', position: { x: 0, y: 0 }, config: {} });
    expect(read.inputs).toEqual([]);
    expect(read.outputs).toEqual([expect.objectContaining({ id: 'value', type: 'any' })]);

    const write = getNodePortDefinitions({ id: 'w', type: 'variable_write', position: { x: 0, y: 0 }, config: {} });
    expect(write.inputs.filter((port) => port.type !== 'exec')).toEqual([expect.objectContaining({ id: 'value', type: 'any' })]);
    expect(write.outputs.filter((port) => port.type !== 'exec')).toEqual([]);
  });

  it('variable-блоки задают именованные порты по config (issue #208)', () => {
    // variable_read: множество именованных выходов, имя порта = имени переменной, входов нет.
    const read = getNodePortDefinitions({
      id: 'r',
      type: 'variable_read',
      position: { x: 0, y: 0 },
      config: { outputs: [{ name: 'gold', type: 'number' }, { name: 'hero', type: 'object' }] },
    });
    expect(read.inputs).toEqual([]);
    expect(read.outputs).toEqual([
      expect.objectContaining({ id: 'gold', type: 'number' }),
      expect.objectContaining({ id: 'hero', type: 'object' }),
    ]);

    // variable_write: множество именованных входов, имя порта = имени переменной, data-выходов нет.
    const write = getNodePortDefinitions({
      id: 'w',
      type: 'variable_write',
      position: { x: 0, y: 0 },
      config: { inputs: [{ name: 'gold', type: 'number' }, { name: 'hero', type: 'object' }] },
    });
    // Узел исполняется в exec-потоке: data-выходов нет, остаётся только служебный exec.
    expect(write.outputs.filter((port) => port.type !== 'exec')).toEqual([]);
    expect(write.inputs.filter((port) => port.type !== 'exec')).toEqual([
      expect.objectContaining({ id: 'gold', type: 'number' }),
      expect.objectContaining({ id: 'hero', type: 'object' }),
    ]);
  });

  it('игнорирует legacy config.name у variable-блоков (issue #232)', () => {
    // Регрессия issue #232: legacy config.name больше не задаёт имя порта. Узел с одним
    // только config.name получает дефолтный порт value, а не одноимённый порт.
    const read = getNodePortDefinitions({
      id: 'r',
      type: 'variable_read',
      position: { x: 0, y: 0 },
      config: { name: 'gold' },
    });
    expect(read.outputs).toEqual([expect.objectContaining({ id: 'value', type: 'any' })]);

    const write = getNodePortDefinitions({
      id: 'w',
      type: 'variable_write',
      position: { x: 0, y: 0 },
      config: { name: 'gold' },
    });
    expect(write.inputs.filter((port) => port.type !== 'exec')).toEqual([
      expect.objectContaining({ id: 'value', type: 'any' }),
    ]);
  });

  it('экспортирует GAME_STATE_READ_OUTPUTS и согласует его с портами game_state_read (issue #228)', () => {
    // Регрессия issue #228: модуль должен предоставлять экспорт GAME_STATE_READ_OUTPUTS,
    // иначе импорт падает с "does not provide an export named 'GAME_STATE_READ_OUTPUTS'".
    expect(GAME_STATE_READ_OUTPUTS).toEqual([{ id: 'state', label: 'state', type: 'object' }]);

    const read = getNodePortDefinitions({ id: 'r', type: 'game_state_read', position: { x: 0, y: 0 }, config: {} });
    expect(read.outputs).toEqual(
      GAME_STATE_READ_OUTPUTS.map((port) => expect.objectContaining({ id: port.id, type: port.type })),
    );
  });

  it('game_state блоки: read только state-выход, write только state-вход (issue #208)', () => {
    const read = getNodePortDefinitions({ id: 'r', type: 'game_state_read', position: { x: 0, y: 0 }, config: {} });
    expect(read.inputs).toEqual([]);
    expect(read.outputs).toEqual([expect.objectContaining({ id: 'state', type: 'object' })]);

    const write = getNodePortDefinitions({ id: 'w', type: 'game_state_write', position: { x: 0, y: 0 }, config: {} });
    // game_state_write — exec-узел: единственный data-вход state, data-выходов нет.
    expect(write.outputs.filter((port) => port.type !== 'exec')).toEqual([]);
    expect(write.inputs.filter((port) => port.type !== 'exec')).toEqual([
      expect.objectContaining({ id: 'state', type: 'object' }),
    ]);
  });

  it('узлы истории — data-only с одним выходом messages (issue #271)', () => {
    // support_history_read и game_history_read: pull-источники без exec-портов,
    // единственный выход messages типа object_array (массив реплик {role, message}).
    for (const type of ['support_history_read', 'game_history_read'] as const) {
      const node = { id: type, type, position: { x: 0, y: 0 }, config: {} } satisfies SchemaGraph['nodes'][number];
      expect(execInputPortIds(node), `${type} exec inputs`).toEqual([]);
      expect(execOutputPortIds(node), `${type} exec outputs`).toEqual([]);
      const ports = getNodePortDefinitions(node);
      expect(ports.inputs).toEqual([]);
      expect(ports.outputs).toEqual([expect.objectContaining({ id: 'messages', type: 'object_array' })]);
    }
  });

  it('узлы истории разведены по типам схем (issue #271)', () => {
    // support_history_read доступен только в схеме support; game_history_read — в
    // игровых схемах (action/hint/illustration), но не в support.
    expect(getNodePaletteForSchema('support')).toContain('support_history_read');
    expect(getNodePaletteForSchema('support')).not.toContain('game_history_read');
    for (const schemaType of ['action', 'hint', 'illustration'] as const) {
      expect(getNodePaletteForSchema(schemaType)).toContain('game_history_read');
      expect(getNodePaletteForSchema(schemaType)).not.toContain('support_history_read');
    }
  });

  it('variable-блоки требуют уникальные непустые имена портов (issue #208)', () => {
    const dup = {
      version: 1 as const,
      schemaType: 'action' as const,
      slug: 's',
      nodes: [
        { id: 'w', type: 'variable_write' as const, position: { x: 0, y: 0 }, config: { inputs: [{ name: 'a', type: 'any' }, { name: 'a', type: 'any' }] } },
      ],
      edges: [],
      variables: {},
    } satisfies SchemaGraph;
    expect(() => validateSchemaGraphContract(dup)).toThrow();

    const empty = {
      ...dup,
      nodes: [
        { id: 'r', type: 'variable_read' as const, position: { x: 0, y: 0 }, config: { outputs: [{ name: '', type: 'any' }] } },
      ],
    } satisfies SchemaGraph;
    expect(() => validateSchemaGraphContract(empty)).toThrow();
  });

  it('даёт блоку merge один exec-выход и динамические exec-входы (issue #203)', () => {
    const merge = { id: 'merge-1', type: 'merge', position: { x: 0, y: 0 }, config: {} } satisfies SchemaGraph['nodes'][number];

    // Новый блок: ровно два exec-входа и один exec-выход, без data-портов.
    const fresh = getNodePortDefinitions(merge);
    expect(fresh.inputs).toEqual([
      expect.objectContaining({ id: 'exec_1', type: 'exec' }),
      expect.objectContaining({ id: 'exec_2', type: 'exec' }),
    ]);
    expect(fresh.outputs).toEqual([expect.objectContaining({ id: 'exec', type: 'exec' })]);
    expect([...fresh.inputs, ...fresh.outputs].every((port) => port.type === 'exec')).toBe(true);

    // При подключении к последнему свободному входу появляется новый свободный вход —
    // exec_1, exec_2 заняты → добавляется exec_3.
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'action',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'log', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', type: 'log', position: { x: 0, y: 0 }, config: {} },
        merge,
        { id: 'end', type: 'end', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'm1', from: 'a', fromPort: 'exec', to: 'merge-1', toPort: 'exec_1' },
        { id: 'm2', from: 'b', fromPort: 'exec', to: 'merge-1', toPort: 'exec_2' },
      ],
    };
    expect(getNodePortDefinitions(merge, graph).inputs.map((port) => port.id)).toEqual([
      'exec_1',
      'exec_2',
      'exec_3',
    ]);
    expect(execInputPortIds(merge, graph)).toEqual(['exec_1', 'exec_2', 'exec_3']);

    // Отключение последнего занятого входа убирает лишний свободный вход обратно.
    graph.edges = graph.edges.filter((edge) => edge.toPort !== 'exec_2');
    expect(getNodePortDefinitions(merge, graph).inputs.map((port) => port.id)).toEqual(['exec_1', 'exec_2']);
  });

  it('валидирует exec-рёбра к динамическим входам merge (issue #203)', () => {
    const graph: SchemaGraph = {
      version: 1,
      schemaType: 'action',
      slug: 'action',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'log', position: { x: 0, y: 0 }, config: {} },
        { id: 'merge-1', type: 'merge', position: { x: 0, y: 0 }, config: {} },
        { id: 'end', type: 'end', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: 's-a', from: 'start', fromPort: 'exec', to: 'a', toPort: 'exec' },
        { id: 's-m', from: 'start', fromPort: 'exec', to: 'merge-1', toPort: 'exec_1' },
        { id: 'a-m', from: 'a', fromPort: 'exec', to: 'merge-1', toPort: 'exec_2' },
        { id: 'm-end', from: 'merge-1', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
    };
    expect(() => validateSchemaGraphContract(graph)).not.toThrow();
  });

  it('отклоняет exec-рёбра к data-only memory-блокам', () => {
    const graph = baseGraph();
    graph.nodes.push({
      id: 'memory_read',
      type: 'game_memory_read',
      position: { x: 120, y: 120 },
      config: {},
    });
    graph.edges.push({
      id: 'old-memory-exec',
      from: 'start',
      fromPort: 'exec',
      to: 'memory_read',
      toPort: 'exec',
    });

    expectContractError(() => validateSchemaGraphContract(graph), 'missing_exec_input');
  });

  it('разрешает llm_request без config.kind (issue #199)', () => {
    const graph = baseGraph();
    graph.nodes.splice(1, 0, {
      id: 'llm',
      type: 'llm_request',
      position: { x: 100, y: 120 },
      config: { outputs: [{ name: 'value', type: 'string' }] },
    });

    expect(() => validateSchemaGraphContract(graph)).not.toThrow();
  });

  it('стандартизирует ошибку формы портов LLM-узла', () => {
    const graph = baseGraph();
    graph.nodes.splice(1, 0, {
      id: 'llm',
      type: 'llm_request',
      position: { x: 100, y: 120 },
      config: { inputs: 'not-an-array' },
    });

    const err = expectContractError(() => validateSchemaGraphContract(graph), 'invalid_llm_ports_shape');
    expect(err.message).toBe('llm_request-узлу llm нужен массив config.inputs');
  });

  it('выводит порты transform из config.inputs/outputs (issue #204)', () => {
    const node = {
      id: 'transform',
      type: 'transform',
      position: { x: 0, y: 0 },
      config: {
        inputs: [{ name: 'value', type: 'number' }],
        outputs: [
          { name: 'result', type: 'any', path: 'result' },
          { name: 'score', type: 'number', path: 'result.score' },
        ],
      },
    } satisfies SchemaGraph['nodes'][number];

    const ports = getNodePortDefinitions(node);
    expect(ports.inputs).toEqual([expect.objectContaining({ id: 'value', type: 'number' })]);
    expect(ports.outputs).toEqual([
      expect.objectContaining({ id: 'result', type: 'any' }),
      expect.objectContaining({ id: 'score', type: 'number' }),
    ]);
  });

  it('даёт transform выход result по умолчанию без config.outputs (issue #204)', () => {
    const node = {
      id: 'transform',
      type: 'transform',
      position: { x: 0, y: 0 },
      config: { code: 'return input;' },
    } satisfies SchemaGraph['nodes'][number];

    expect(getNodePortDefinitions(node).outputs).toEqual([
      expect.objectContaining({ id: 'result', type: 'any' }),
    ]);
  });

  it('стандартизирует ошибку формы портов transform-узла (issue #204)', () => {
    const graph = baseGraph();
    graph.nodes[1] = {
      id: 'transform',
      type: 'transform',
      position: { x: 200, y: 0 },
      config: { outputs: 'not-an-array' },
    };

    const err = expectContractError(() => validateSchemaGraphContract(graph), 'invalid_transform_ports_shape');
    expect(err.message).toBe('transform-узлу transform нужен массив config.outputs');
  });

  it('стандартизирует loop limits', () => {
    const graph = baseGraph();
    graph.nodes[1] = {
      id: 'transform',
      type: 'loop',
      position: { x: 200, y: 0 },
      config: { maxIterations: 0 },
    };

    const err = expectContractError(() => validateSchemaGraphContract(graph), 'invalid_loop_limits');
    expect(err.message).toBe('loop-узлу transform нужен maxIterations от 1 до 100');
  });

  it('стандартизирует duplicate data inputs и mixed exec/data для UI/API/runtime', async () => {
    const duplicate = baseGraph();
    duplicate.edges.push({
      id: 'duplicate-input',
      from: 'start',
      fromPort: 'inputs',
      to: 'transform',
      toPort: 'value',
    });

    expectContractError(() => validateSchemaGraphContract(duplicate), 'duplicate_data_input');

    const mixed = baseGraph();
    mixed.edges.push({
      id: 'mixed-port',
      from: 'start',
      fromPort: 'value',
      to: 'transform',
      toPort: 'exec',
    });
    const mixedError = expectContractError(() => validateSchemaGraphContract(mixed), 'mixed_port_kinds');
    expect(mixedError.message).toBe('Ребро mixed-port смешивает exec-порт и data-порт');
    await expect(executeSchema(mixed, {} as SchemaExecutionContext)).rejects.toMatchObject({
      code: 'mixed_port_kinds',
      message: mixedError.message,
    });
  });
});
