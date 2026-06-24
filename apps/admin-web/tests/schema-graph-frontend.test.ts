import { describe, expect, it } from 'vitest';

import {
  arePortTypesCompatible,
  buildTestInputs,
  buildSubSchemaTestInputs,
  defaultSubSchemaTestInputValues,
  subSchemaTestInputFields,
  buildNodeBodyTestInputs,
  defaultNodeBodyTestInputValues,
  nodeBodyTestInputFields,
  canConnectGraphPorts,
  clipboardHasContent,
  connectGraphPorts,
  createGraphNode,
  defaultTestInputValues,
  diffSchemaBundle,
  duplicateGraphNode,
  duplicateGraphNodes,
  extractGraphClipboard,
  formatImportSummary,
  getBodyGraph,
  getNodePaletteForSchema,
  getNodePorts,
  graphKindLabel,
  isCopyableNode,
  isTextEditingElement,
  loopModeFromConfig,
  collapseLoopFrames,
  reopenBodyGraphFrames,
  getLoopBodyGraph,
  loopBodySlug,
  makeEmptyLoopBodyGraph,
  writeLoopBodyGraph,
  makeEmptyGraph,
  makeEmptySubSchemaGraph,
  nodePaletteAvailability,
  normalizeSchemaGraph,
  paletteKindLabel,
  parseSchemaBundle,
  pasteGraphClipboard,
  portColor,
  removeGraphSelection,
  schemaClipboardAction,
  shouldDeleteSchemaSelection,
  subSchemaConfigPatch,
  testInputFields,
  updateGraphNodePosition,
  type SchemaGraph,
} from '../src/schemaGraph';

function llmGraph(): SchemaGraph {
  return {
    version: 1,
    slug: 'action',
    schemaType: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'llm',
        type: 'llm_request',
        position: { x: 240, y: 0 },
        config: { outputs: [{ name: 'keys', jsonPath: 'keys', type: 'string_array' }] },
      },
      { id: 'knowledge', type: 'knowledge_query', position: { x: 480, y: 0 }, config: {} },
      { id: 'end', type: 'end', position: { x: 720, y: 0 }, config: {} },
    ],
    edges: [{ id: 'start:exec->llm:exec', from: 'start', fromPort: 'exec', to: 'llm', toPort: 'exec' }],
  };
}

describe('frontend schema graph helpers', () => {
  it('разрешает any только для data-портов, а exec соединяет только с exec', () => {
    expect(arePortTypesCompatible('string', 'any')).toBe(true);
    expect(arePortTypesCompatible('any', 'object_array')).toBe(true);
    expect(arePortTypesCompatible('exec', 'exec')).toBe(true);
    expect(arePortTypesCompatible('exec', 'string')).toBe(false);
    expect(arePortTypesCompatible('string_array', 'object')).toBe(false);
  });

  it('использует outputs llm_request как типизированные output-порты', () => {
    const graph = llmGraph();
    const llm = graph.nodes.find((node) => node.id === 'llm');
    expect(llm).toBeDefined();
    expect(getNodePorts(llm!, graph).outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'keys', type: 'string_array' }),
        expect.objectContaining({ id: 'raw', type: 'string' }),
      ]),
    );
  });

  it('использует inputs llm_request как типизированные input-порты', () => {
    const graph = llmGraph();
    const llm = graph.nodes.find((node) => node.id === 'llm');
    expect(llm).toBeDefined();
    if (!llm) return;

    llm.config.inputs = [
      { name: 'context', type: 'object', description: 'Контекст сцены' },
      { name: 'query', type: 'string', description: 'Запрос' },
    ];

    expect(getNodePorts(llm, graph).inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'context', type: 'object' }),
        expect.objectContaining({ id: 'query', type: 'string' }),
      ]),
    );
  });

  it('не добавляет предопределённых входов llm_request без config.inputs (issue #199)', () => {
    const graph = llmGraph();
    const llm = graph.nodes.find((node) => node.id === 'llm');
    expect(llm).toBeDefined();
    if (!llm) return;
    llm.config = {};

    const inputs = getNodePorts(llm, graph).inputs;
    // Остаётся только exec-вход: ни expertise/memory/narrative/state/value больше нет.
    expect(inputs).toEqual([expect.objectContaining({ id: 'exec', type: 'exec' })]);
  });

  it('наращивает exec-входы блока merge при подключении потоков (issue #203)', () => {
    let graph = makeEmptyGraph('action', 'action');
    const merge = createGraphNode(graph, 'merge', { x: 240, y: 0 });
    graph = { ...graph, nodes: [...graph.nodes, merge] };
    const first = createGraphNode(graph, 'log', { x: 120, y: -80 });
    graph = { ...graph, nodes: [...graph.nodes, first] };
    const second = createGraphNode(graph, 'log', { x: 120, y: 80 });
    graph = { ...graph, nodes: [...graph.nodes, second] };

    // Новый блок: два exec-входа и один exec-выход, без data-портов.
    expect(getNodePorts(merge, graph).inputs.map((port) => port.id)).toEqual(['exec_1', 'exec_2']);
    expect(getNodePorts(merge, graph).outputs).toEqual([expect.objectContaining({ id: 'exec', type: 'exec' })]);

    // Подключаем первый поток к свободному входу exec_1.
    graph = connectGraphPorts(graph, {
      source: first.id,
      sourceHandle: 'exec',
      target: merge.id,
      targetHandle: 'exec_1',
    });
    // Свободным остаётся exec_2, лишних входов пока не появилось.
    expect(getNodePorts(merge, graph).inputs.map((port) => port.id)).toEqual(['exec_1', 'exec_2']);

    // Подключаем второй поток к последнему свободному входу exec_2 — добавляется exec_3.
    expect(canConnectGraphPorts(graph, {
      source: second.id,
      sourceHandle: 'exec',
      target: merge.id,
      targetHandle: 'exec_2',
    }).valid).toBe(true);
    graph = connectGraphPorts(graph, {
      source: second.id,
      sourceHandle: 'exec',
      target: merge.id,
      targetHandle: 'exec_2',
    });
    expect(getNodePorts(merge, graph).inputs.map((port) => port.id)).toEqual(['exec_1', 'exec_2', 'exec_3']);

    // Удаление ребра ко второму входу убирает лишний свободный вход обратно до двух.
    const secondEdge = graph.edges.find((edge) => edge.to === merge.id && edge.toPort === 'exec_2');
    expect(secondEdge).toBeDefined();
    graph = removeGraphSelection(graph, [], [secondEdge!.id]);
    expect(getNodePorts(merge, graph).inputs.map((port) => port.id)).toEqual(['exec_1', 'exec_2']);
  });

  it('даёт expertise/memory особые типы и единственный выход state у game_state_read (issue #208)', () => {
    const graph = makeEmptyGraph('action', 'action');
    const knowledge = createGraphNode(graph, 'knowledge_query', { x: 120, y: 0 });
    const memoryRead = createGraphNode(graph, 'game_memory_read', { x: 240, y: 0 });
    const stateRead = createGraphNode(graph, 'game_state_read', { x: 360, y: 0 });

    expect(getNodePorts(knowledge, graph).outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'expertise', type: 'expertise' })]),
    );
    expect(getNodePorts(memoryRead, graph).outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'memory', type: 'memory' })]),
    );
    // issue #208: game_state_read — только один выход state и никаких входов.
    const statePorts = getNodePorts(stateRead, graph);
    expect(statePorts.inputs).toEqual([]);
    expect(statePorts.outputs).toEqual([expect.objectContaining({ id: 'state', type: 'object' })]);
  });

  it('подключает expertise/memory к llm_request и state из game_state_read (issue #208)', () => {
    const graph = makeEmptyGraph('action', 'action');
    const knowledge = createGraphNode(graph, 'knowledge_query', { x: 120, y: 0 });
    const memoryRead = createGraphNode(graph, 'game_memory_read', { x: 240, y: 0 });
    const stateRead = createGraphNode(graph, 'game_state_read', { x: 360, y: 0 });
    const llm = createGraphNode(graph, 'llm_request', { x: 480, y: 0 });
    llm.config = {
      inputs: [
        { name: 'expertise', type: 'expertise' },
        { name: 'memory', type: 'memory' },
        { name: 'state', type: 'object' },
      ],
    };
    graph.nodes.push(knowledge, memoryRead, stateRead, llm);

    expect(
      canConnectGraphPorts(graph, {
        source: knowledge.id,
        sourceHandle: 'expertise',
        target: llm.id,
        targetHandle: 'expertise',
      }).valid,
    ).toBe(true);
    expect(
      canConnectGraphPorts(graph, {
        source: memoryRead.id,
        sourceHandle: 'memory',
        target: llm.id,
        targetHandle: 'memory',
      }).valid,
    ).toBe(true);
    expect(
      canConnectGraphPorts(graph, {
        source: stateRead.id,
        sourceHandle: 'state',
        target: llm.id,
        targetHandle: 'state',
      }).valid,
    ).toBe(true);
  });

  it('добавляет только обозначенные start/end data-порты по типу схемы', () => {
    // issue #213: у конечных узлов остаются только exec и перечисленные граничные порты.
    const action = makeEmptyGraph('action', 'action');
    expect(getNodePorts(action.nodes[0], action).outputs.map((p) => p.id)).toEqual(['exec', 'action']);
    expect(getNodePorts(action.nodes[1], action).inputs.map((p) => p.id)).toEqual(['exec']);

    const hint = makeEmptyGraph('hint', 'hint');
    expect(getNodePorts(hint.nodes[0], hint).outputs.map((p) => p.id)).toEqual(['exec']);
    expect(getNodePorts(hint.nodes[1], hint).inputs.map((p) => p.id)).toEqual(['exec', 'hints']);
    expect(getNodePorts(hint.nodes[1], hint).inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'hints', type: 'string_array' })]),
    );

    const illustration = makeEmptyGraph('illustration', 'illustration');
    expect(getNodePorts(illustration.nodes[0], illustration).outputs.map((p) => p.id)).toEqual(['exec']);
    expect(getNodePorts(illustration.nodes[1], illustration).inputs.map((p) => p.id)).toEqual([
      'exec',
      'image_url',
    ]);
    expect(getNodePorts(illustration.nodes[1], illustration).inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'image_url', type: 'string' })]),
    );

    const support = makeEmptyGraph('support', 'support');
    expect(getNodePorts(support.nodes[0], support).outputs.map((p) => p.id)).toEqual(['exec', 'user_query']);
    // issue #244: на end поддержки добавлены флаги решения консультанта и summary.
    expect(getNodePorts(support.nodes[1], support).inputs.map((p) => p.id)).toEqual([
      'exec',
      'reply',
      'escalate',
      'resolved',
      'summary',
    ]);
  });

  it('у media_generate настраиваемые входы как у llm_request и выход image_url (issue #225)', () => {
    const graph = makeEmptyGraph('illustration', 'illustration');
    const media = createGraphNode(graph, 'media_generate', { x: 120, y: 0 });

    // По умолчанию — никаких предопределённых narrative/state, только exec-входы.
    expect(media.config).toEqual({ prompt: '', inputs: [] });
    const emptyPorts = getNodePorts(media, graph);
    expect(emptyPorts.inputs.map((port) => port.id)).toEqual(['exec']);
    expect(emptyPorts.outputs.map((port) => port.id)).toEqual(['exec', 'image_url']);
    expect(emptyPorts.outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'image_url', type: 'string' })]),
    );

    // Настраиваемые входы берутся из config.inputs (как у llm_request).
    const configured = {
      ...media,
      config: { prompt: '{{scene}}', inputs: [{ name: 'scene', type: 'string' }] },
    };
    const ports = getNodePorts(configured, graph);
    expect(ports.inputs.map((port) => port.id)).toEqual(['exec', 'scene']);
    expect(ports.inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'scene', type: 'string' })]),
    );
    expect(ports.inputs.some((port) => port.id === 'narrative' || port.id === 'state')).toBe(false);
  });

  it('ограничивает палитру узлов политикой типа схемы', () => {
    expect(getNodePaletteForSchema('action')).toContain('game_state_write');
    expect(getNodePaletteForSchema('support')).not.toContain('game_state_write');
  });

  it('не показывает exec-порты у Memory read/write в редакторе', () => {
    const graph = makeEmptyGraph('action', 'action');
    const read = createGraphNode(graph, 'game_memory_read', { x: 120, y: 0 });
    const write = createGraphNode(graph, 'game_memory_write', { x: 240, y: 0 });

    expect(getNodePorts(read, graph).inputs).toHaveLength(0);
    expect(getNodePorts(read, graph).outputs).toEqual([
      expect.objectContaining({ id: 'memory', type: 'memory', direction: 'output' }),
    ]);

    const writePorts = getNodePorts(write, graph);
    expect([...writePorts.inputs, ...writePorts.outputs].some((port) => port.type === 'exec')).toBe(false);
    expect(writePorts.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'narrative', type: 'string' }),
        expect.objectContaining({ id: 'enabled', type: 'boolean' }),
      ]),
    );
  });

  it('использует цвета портов из ТЗ blueprint-редактора', () => {
    expect(portColor('exec')).toBe('#ffffff');
    expect(portColor('string')).toBe('#ff6fb1');
    expect(portColor('number')).toBe('#31c48d');
    expect(portColor('boolean')).toBe('#ef4444');
    expect(portColor('object')).toBe('#3b82f6');
    expect(portColor('string_array')).toBe('#f9a8d4');
    expect(portColor('object_array')).toBe('#67e8f9');
    expect(portColor('expertise')).toBe('#f59e0b');
    expect(portColor('memory')).toBe('#a855f7');
    expect(portColor('any')).toBe('#9ca3af');
  });

  it('добавляет совместимое соединение и блокирует несовместимое', () => {
    const graph = llmGraph();
    const valid = canConnectGraphPorts(graph, {
      source: 'llm',
      sourceHandle: 'keys',
      target: 'knowledge',
      targetHandle: 'keys',
    });
    expect(valid.valid).toBe(true);

    const connected = connectGraphPorts(graph, {
      source: 'llm',
      sourceHandle: 'keys',
      target: 'knowledge',
      targetHandle: 'keys',
    });
    expect(connected.edges.at(-1)).toMatchObject({ from: 'llm', fromPort: 'keys', to: 'knowledge', toPort: 'keys' });

    expect(
      canConnectGraphPorts(graph, {
        source: 'knowledge',
        sourceHandle: 'documents',
        target: 'llm',
        targetHandle: 'memory',
      }),
    ).toMatchObject({ valid: false });
  });

  it('не позволяет подключить несколько data-рёбер к одному input-порту', () => {
    const base = llmGraph();
    // Второй источник string_array, чтобы проверить именно занятость input-порта, а не
    // несовместимость типов (issue #213: универсального start:inputs больше нет).
    const transform = {
      id: 'transform',
      type: 'transform' as const,
      position: { x: 240, y: 160 },
      config: { outputs: [{ name: 'extra', type: 'string_array' as const }] },
    };
    const withTransform: SchemaGraph = { ...base, nodes: [...base.nodes, transform] };
    const graph = connectGraphPorts(withTransform, {
      source: 'llm',
      sourceHandle: 'keys',
      target: 'knowledge',
      targetHandle: 'keys',
    });

    expect(
      canConnectGraphPorts(graph, {
        source: 'transform',
        sourceHandle: 'extra',
        target: 'knowledge',
        targetHandle: 'keys',
      }),
    ).toMatchObject({ valid: false, message: expect.stringContaining('input-порт') });
  });

  it('обновляет позиции, дублирует и удаляет выбранные узлы без удаления start/end', () => {
    const base = makeEmptyGraph('hint', 'hint');
    const node = createGraphNode(base, 'transform', { x: 120, y: 160 });
    const withNode = { ...base, nodes: [...base.nodes, node] };
    const moved = updateGraphNodePosition(withNode, node.id, { x: 140.4, y: 180.6 });
    expect(moved.nodes.find((item) => item.id === node.id)?.position).toEqual({ x: 140, y: 181 });

    const duplicated = duplicateGraphNode(moved, node.id);
    expect(duplicated.duplicatedId).toBeTruthy();
    expect(duplicated.graph.nodes).toHaveLength(4);

    const cleaned = removeGraphSelection(duplicated.graph, ['start', node.id], []);
    expect(cleaned.nodes.map((item) => item.id)).toContain('start');
    expect(cleaned.nodes.map((item) => item.id)).not.toContain(node.id);
  });

  it('удаляет выбранное ребро и связи удалённого блока', () => {
    const connected = connectGraphPorts(llmGraph(), {
      source: 'llm',
      sourceHandle: 'keys',
      target: 'knowledge',
      targetHandle: 'keys',
    });
    const dataEdge = connected.edges.find((edge) => edge.from === 'llm' && edge.to === 'knowledge');
    expect(dataEdge).toBeDefined();
    if (!dataEdge) return;

    const withoutEdge = removeGraphSelection(connected, [], [dataEdge.id]);
    expect(withoutEdge.edges.map((edge) => edge.id)).not.toContain(dataEdge.id);
    expect(withoutEdge.nodes.map((node) => node.id)).toEqual(['start', 'llm', 'knowledge', 'end']);

    const withoutNode = removeGraphSelection(connected, ['llm'], []);
    expect(withoutNode.nodes.map((node) => node.id)).toEqual(['start', 'knowledge', 'end']);
    expect(withoutNode.edges.some((edge) => edge.from === 'llm' || edge.to === 'llm')).toBe(false);
  });

  it('нормализует импортированный graph JSON', () => {
    expect(normalizeSchemaGraph({ ...makeEmptyGraph('support', 'support'), variables: undefined })).toMatchObject({
      slug: 'support',
      schemaType: 'support',
      variables: {},
    });
  });
});

describe('удаление выделения клавиатурой (issue #211)', () => {
  it('распознаёт поля ввода текста', () => {
    expect(isTextEditingElement({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEditingElement({ tagName: 'textarea' })).toBe(true);
    expect(isTextEditingElement({ tagName: 'SELECT' })).toBe(true);
    expect(isTextEditingElement({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEditingElement({ tagName: 'DIV' })).toBe(false);
    expect(isTextEditingElement(null)).toBe(false);
    expect(isTextEditingElement(undefined)).toBe(false);
  });

  it('Backspace не удаляет блок никогда', () => {
    expect(shouldDeleteSchemaSelection('Backspace', null)).toBe(false);
    expect(shouldDeleteSchemaSelection('Backspace', { tagName: 'DIV' })).toBe(false);
    expect(shouldDeleteSchemaSelection('Backspace', { tagName: 'INPUT' })).toBe(false);
  });

  it('Delete удаляет блок только вне поля ввода текста', () => {
    expect(shouldDeleteSchemaSelection('Delete', null)).toBe(true);
    expect(shouldDeleteSchemaSelection('Delete', { tagName: 'DIV' })).toBe(true);
    expect(shouldDeleteSchemaSelection('Delete', { tagName: 'INPUT' })).toBe(false);
    expect(shouldDeleteSchemaSelection('Delete', { tagName: 'TEXTAREA' })).toBe(false);
    expect(shouldDeleteSchemaSelection('Delete', { tagName: 'SELECT' })).toBe(false);
    expect(shouldDeleteSchemaSelection('Delete', { tagName: 'DIV', isContentEditable: true })).toBe(false);
  });

  it('прочие клавиши не удаляют блок', () => {
    expect(shouldDeleteSchemaSelection('a', null)).toBe(false);
    expect(shouldDeleteSchemaSelection('Enter', null)).toBe(false);
  });
});

// Выделение и массовые операции copy/cut/paste/duplicate (issue #230).
function twoNodeGraph(): SchemaGraph {
  // start → llm → transform → end, плюс data-ребро llm.keys → transform.value.
  let graph = makeEmptyGraph('action', 'action');
  const llm = createGraphNode(graph, 'llm_request', { x: 120, y: 0 });
  llm.config = { outputs: [{ name: 'keys', jsonPath: 'keys', type: 'string_array' }] };
  const transform = createGraphNode(graph, 'transform', { x: 320, y: 0 });
  transform.config = { code: 'return input;', inputs: [{ name: 'value', type: 'string_array' }], outputs: [] };
  graph = { ...graph, nodes: [...graph.nodes, llm, transform] };
  graph = connectGraphPorts(graph, {
    source: llm.id,
    sourceHandle: 'keys',
    target: transform.id,
    targetHandle: 'value',
  });
  return graph;
}

describe('массовые операции с узлами (issue #230)', () => {
  it('isCopyableNode исключает только start и end', () => {
    const graph = twoNodeGraph();
    expect(isCopyableNode(graph.nodes.find((node) => node.id === 'start'))).toBe(false);
    expect(isCopyableNode(graph.nodes.find((node) => node.id === 'end'))).toBe(false);
    expect(isCopyableNode(graph.nodes.find((node) => node.type === 'llm_request'))).toBe(true);
    expect(isCopyableNode(undefined)).toBe(false);
  });

  it('extractGraphClipboard копирует выбранные узлы и рёбра между ними', () => {
    const graph = twoNodeGraph();
    const llmId = graph.nodes.find((node) => node.type === 'llm_request')!.id;
    const transformId = graph.nodes.find((node) => node.type === 'transform')!.id;

    // Оба узла выбраны — ребро между ними тоже попадает в буфер.
    const both = extractGraphClipboard(graph, [llmId, transformId]);
    expect(both.nodes.map((node) => node.id).sort()).toEqual([llmId, transformId].sort());
    expect(both.edges).toHaveLength(1);

    // Выбран один узел — ребро между двумя узлами не попадает (конец вне выделения).
    const one = extractGraphClipboard(graph, [llmId]);
    expect(one.nodes).toHaveLength(1);
    expect(one.edges).toHaveLength(0);

    // start/end не копируются даже если выбраны.
    const withTerminals = extractGraphClipboard(graph, ['start', 'end', llmId]);
    expect(withTerminals.nodes.map((node) => node.id)).toEqual([llmId]);

    expect(clipboardHasContent(both)).toBe(true);
    expect(clipboardHasContent({ nodes: [], edges: [] })).toBe(false);
    expect(clipboardHasContent(null)).toBe(false);
  });

  it('pasteGraphClipboard вставляет узлы с новыми id, сдвигом и перемапленными рёбрами', () => {
    const graph = twoNodeGraph();
    const llmId = graph.nodes.find((node) => node.type === 'llm_request')!.id;
    const transformId = graph.nodes.find((node) => node.type === 'transform')!.id;
    const clipboard = extractGraphClipboard(graph, [llmId, transformId]);

    const result = pasteGraphClipboard(graph, clipboard, { x: 50, y: 60 });
    // Добавились два новых узла и одно ребро.
    expect(result.graph.nodes).toHaveLength(graph.nodes.length + 2);
    expect(result.graph.edges).toHaveLength(graph.edges.length + 1);
    expect(result.nodeIds).toHaveLength(2);

    // Новые id не совпадают с исходными.
    expect(result.nodeIds).not.toContain(llmId);
    expect(result.nodeIds).not.toContain(transformId);

    // Позиции сдвинуты на offset.
    const sourceLlm = graph.nodes.find((node) => node.id === llmId)!;
    const pastedLlm = result.graph.nodes.find(
      (node) => node.type === 'llm_request' && result.nodeIds.includes(node.id),
    )!;
    expect(pastedLlm.position).toEqual({ x: sourceLlm.position.x + 50, y: sourceLlm.position.y + 60 });

    // Скопированное ребро соединяет только вставленные узлы.
    const pastedEdge = result.graph.edges.find(
      (edge) => result.nodeIds.includes(edge.from) && result.nodeIds.includes(edge.to),
    );
    expect(pastedEdge).toBeDefined();
    expect(pastedEdge!.fromPort).toBe('keys');
    expect(pastedEdge!.toPort).toBe('value');
  });

  it('повторная вставка одного буфера даёт разные id (без коллизий)', () => {
    const graph = twoNodeGraph();
    const llmId = graph.nodes.find((node) => node.type === 'llm_request')!.id;
    const clipboard = extractGraphClipboard(graph, [llmId]);

    const first = pasteGraphClipboard(graph, clipboard);
    const second = pasteGraphClipboard(first.graph, clipboard);
    expect(second.nodeIds).not.toEqual(first.nodeIds);
    const ids = second.graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('duplicateGraphNodes дублирует группу узлов вместе с внутренними рёбрами', () => {
    const graph = twoNodeGraph();
    const llmId = graph.nodes.find((node) => node.type === 'llm_request')!.id;
    const transformId = graph.nodes.find((node) => node.type === 'transform')!.id;

    const result = duplicateGraphNodes(graph, [llmId, transformId]);
    expect(result.nodeIds).toHaveLength(2);
    expect(result.graph.nodes).toHaveLength(graph.nodes.length + 2);
    expect(result.graph.edges).toHaveLength(graph.edges.length + 1);
  });
});

describe('горячие клавиши буфера обмена (issue #230)', () => {
  const mod = { ctrlKey: true, metaKey: false };

  it('распознаёт copy/cut/paste/duplicate по Ctrl/Cmd', () => {
    expect(schemaClipboardAction({ key: 'c', ...mod }, null)).toBe('copy');
    expect(schemaClipboardAction({ key: 'x', ...mod }, null)).toBe('cut');
    expect(schemaClipboardAction({ key: 'v', ...mod }, null)).toBe('paste');
    expect(schemaClipboardAction({ key: 'd', ...mod }, null)).toBe('duplicate');
    // Регистронезависимо и для Cmd на macOS.
    expect(schemaClipboardAction({ key: 'C', ctrlKey: false, metaKey: true }, null)).toBe('copy');
  });

  it('без модификатора и для прочих клавиш ничего не делает', () => {
    expect(schemaClipboardAction({ key: 'c', ctrlKey: false, metaKey: false }, null)).toBeNull();
    expect(schemaClipboardAction({ key: 'a', ...mod }, null)).toBeNull();
  });

  it('в полях ввода текста горячие клавиши не перехватываются', () => {
    expect(schemaClipboardAction({ key: 'c', ...mod }, { tagName: 'INPUT' })).toBeNull();
    expect(schemaClipboardAction({ key: 'v', ...mod }, { tagName: 'TEXTAREA' })).toBeNull();
    expect(schemaClipboardAction({ key: 'd', ...mod }, { tagName: 'DIV', isContentEditable: true })).toBeNull();
  });
});

describe('nodePaletteAvailability (issue #248, этап D, item 5)', () => {
  it('для action доступны все базовые узлы, кроме истории поддержки (issue #271)', () => {
    const palette = nodePaletteAvailability('action');
    expect(palette.length).toBeGreaterThan(0);
    // support_history_read — узел только для схемы support, в action он заблокирован.
    const supportHistory = palette.find((entry) => entry.type === 'support_history_read');
    expect(supportHistory?.available).toBe(false);
    expect(supportHistory?.reason).toContain('недоступен');
    // Остальные узлы (включая game_history_read) в action доступны.
    const rest = palette.filter((entry) => entry.type !== 'support_history_read');
    expect(rest.every((entry) => entry.available)).toBe(true);
    expect(rest.every((entry) => entry.reason === undefined)).toBe(true);
  });

  it('для support узел game_state_write помечен недоступным с причиной', () => {
    const palette = nodePaletteAvailability('support');
    const blocked = palette.find((entry) => entry.type === 'game_state_write');
    expect(blocked).toBeDefined();
    expect(blocked?.available).toBe(false);
    expect(blocked?.reason).toContain('недоступен');
    // Прочие узлы при этом остаются доступными.
    expect(palette.find((entry) => entry.type === 'llm_request')?.available).toBe(true);
  });

  it('возвращает все базовые узлы независимо от схемы (в отличие от getNodePaletteForSchema)', () => {
    const full = nodePaletteAvailability('support').length;
    const filtered = getNodePaletteForSchema('support').length;
    expect(full).toBeGreaterThan(filtered);
  });
});

describe('loopModeFromConfig (issue #248, item 4)', () => {
  it('пустое exitExpression — режим count', () => {
    expect(loopModeFromConfig({ maxIterations: 3 })).toBe('count');
    expect(loopModeFromConfig({ exitExpression: '   ' })).toBe('count');
  });

  it('непустое exitExpression — режим expression', () => {
    expect(loopModeFromConfig({ exitExpression: 'state.done' })).toBe('expression');
  });
});

describe('typed test inputs (issue #248, item 3)', () => {
  it('action имеет поле действия и историю', () => {
    const fields = testInputFields('action');
    expect(fields.map((field) => field.key)).toEqual(['action', 'history']);
  });

  it('hint имеет JSON-поле истории (issue #289)', () => {
    const fields = testInputFields('hint');
    expect(fields.map((field) => field.key)).toEqual(['history']);
    expect(fields[0].kind).toBe('json');
  });

  it('support имеет поля запроса и истории переписки (issue #289)', () => {
    const fields = testInputFields('support');
    expect(fields.map((field) => field.key)).toEqual(['user_query', 'supportHistory']);
    expect(fields[1].kind).toBe('json');
  });

  it('buildTestInputs накладывает значения поверх дефолтов', () => {
    const inputs = buildTestInputs('action', { action: 'Открыть дверь' });
    expect(inputs.action).toBe('Открыть дверь');
    // Служебное поле mockResponses сохраняется из дефолтов.
    expect(inputs).toHaveProperty('mockResponses');
  });

  it('buildTestInputs парсит JSON-поле истории (issue #289)', () => {
    const history = [{ turn: 1, action: 'Идти на север', outcome: 'Лес' }];
    const inputs = buildTestInputs('action', { action: 'Осмотреться', history: JSON.stringify(history) });
    expect(inputs.history).toEqual(history);
  });

  it('buildTestInputs оставляет дефолт при невалидном JSON в истории (issue #289)', () => {
    const inputs = buildTestInputs('action', { action: 'Осмотреться', history: 'not json' });
    expect(inputs.history).toEqual(defaultTestInputValues('action').history);
  });

  it('buildTestInputs парсит supportHistory для support-схемы (issue #289)', () => {
    const supportHistory = [{ role: 'user', message: 'Привет' }];
    const inputs = buildTestInputs('support', {
      user_query: 'Вопрос',
      supportHistory: JSON.stringify(supportHistory),
    });
    expect(inputs.supportHistory).toEqual(supportHistory);
  });

  it('buildTestInputs игнорирует пустые значения, оставляя дефолт', () => {
    const inputs = buildTestInputs('illustration', { narrative: '' });
    expect(inputs.narrative).toBe(defaultTestInputValues('illustration').narrative);
  });
});

describe('sub-schema test inputs by start node (issue #343)', () => {
  function subGraphWithStartPorts(
    outputs: { id: string; label: string; type: string }[],
  ): SchemaGraph {
    const graph = makeEmptySubSchemaGraph('calc', 'common');
    const start = graph.nodes.find((node) => node.id === 'start');
    if (!start) throw new Error('нет start-узла');
    start.config = { ...start.config, outputs };
    return graph;
  }

  it('subSchemaTestInputFields строит поля по граничным входам start-узла', () => {
    const graph = subGraphWithStartPorts([
      { id: 'name', label: 'Имя', type: 'string' },
      { id: 'count', label: 'Счётчик', type: 'number' },
      { id: 'items', label: 'Список', type: 'string_array' },
    ]);
    const fields = subSchemaTestInputFields(graph);
    expect(fields.map((field) => field.key)).toEqual(['name', 'count', 'items']);
    expect(fields[0].kind).toBe('text');
    expect(fields[1].kind).toBe('text');
    expect(fields[2].kind).toBe('json');
  });

  it('subSchemaTestInputFields для суб-схемы без входов возвращает пустой список', () => {
    expect(subSchemaTestInputFields(makeEmptySubSchemaGraph('calc', 'common'))).toEqual([]);
  });

  it('defaultSubSchemaTestInputValues даёт дефолт по типу каждого порта', () => {
    const graph = subGraphWithStartPorts([
      { id: 'name', label: 'Имя', type: 'string' },
      { id: 'count', label: 'Счётчик', type: 'number' },
      { id: 'enabled', label: 'Флаг', type: 'boolean' },
      { id: 'items', label: 'Список', type: 'string_array' },
      { id: 'payload', label: 'Объект', type: 'object' },
    ]);
    expect(defaultSubSchemaTestInputValues(graph)).toEqual({
      name: '',
      count: 0,
      enabled: false,
      items: [],
      payload: {},
    });
  });

  it('buildSubSchemaTestInputs приводит значения к типу порта', () => {
    const graph = subGraphWithStartPorts([
      { id: 'name', label: 'Имя', type: 'string' },
      { id: 'count', label: 'Счётчик', type: 'number' },
      { id: 'enabled', label: 'Флаг', type: 'boolean' },
      { id: 'items', label: 'Список', type: 'string_array' },
    ]);
    const inputs = buildSubSchemaTestInputs(graph, {
      name: 'Иван',
      count: '42',
      enabled: 'true',
      items: '["меч", "щит"]',
    });
    expect(inputs).toEqual({
      name: 'Иван',
      count: 42,
      enabled: true,
      items: ['меч', 'щит'],
    });
  });

  it('buildSubSchemaTestInputs подставляет дефолт для пустого поля', () => {
    const graph = subGraphWithStartPorts([{ id: 'count', label: 'Счётчик', type: 'number' }]);
    expect(buildSubSchemaTestInputs(graph, { count: '' })).toEqual({ count: 0 });
  });

  it('buildSubSchemaTestInputs возвращает дефолт при невалидном JSON', () => {
    const graph = subGraphWithStartPorts([{ id: 'items', label: 'Список', type: 'string_array' }]);
    expect(buildSubSchemaTestInputs(graph, { items: 'not json' })).toEqual({ items: [] });
  });

  it('buildSubSchemaTestInputs игнорирует ключи без граничного порта', () => {
    const graph = subGraphWithStartPorts([{ id: 'name', label: 'Имя', type: 'string' }]);
    const inputs = buildSubSchemaTestInputs(graph, { name: 'Тест', stray: 'x' });
    expect(inputs).toEqual({ name: 'Тест' });
  });
});

describe('node-body test inputs by node ports (issue #390)', () => {
  // Поля изолированного теста тела узла строятся по входным data-портам самого
  // тестируемого узла (loop → value; graph_rag → query/options), а не по граничным
  // портам внутреннего start-узла тела.
  function loopNode() {
    const graph = makeEmptyGraph('action', 'action');
    return createGraphNode(graph, 'loop', { x: 200, y: 0 });
  }

  function ragNode() {
    const graph = makeEmptyGraph('action', 'action');
    return createGraphNode(graph, 'graph_rag', { x: 200, y: 0 });
  }

  it('nodeBodyTestInputFields строит поле по входу value узла loop', () => {
    const fields = nodeBodyTestInputFields(loopNode());
    expect(fields.map((field) => field.key)).toEqual(['value']);
    // value имеет тип any → редактируется как JSON.
    expect(fields[0].kind).toBe('json');
  });

  it('nodeBodyTestInputFields строит поля по входам query/options узла graph_rag (issue #392)', () => {
    const fields = nodeBodyTestInputFields(ragNode());
    expect(fields.map((field) => field.key)).toEqual(['query', 'options']);
    expect(fields[0].kind).toBe('text');
    expect(fields[1].kind).toBe('json');
  });

  it('nodeBodyTestInputFields исключает exec-порты узла', () => {
    const fields = nodeBodyTestInputFields(ragNode());
    expect(fields.some((field) => field.key === 'exec')).toBe(false);
  });

  it('defaultNodeBodyTestInputValues даёт дефолт по типу каждого входа', () => {
    expect(defaultNodeBodyTestInputValues(ragNode())).toEqual({ query: '', options: {} });
  });

  it('buildNodeBodyTestInputs приводит значения к типу входного порта узла', () => {
    const inputs = buildNodeBodyTestInputs(ragNode(), undefined, {
      query: 'Как начать игру?',
      options: '{ "topK": 5 }',
    });
    expect(inputs).toEqual({ query: 'Как начать игру?', options: { topK: 5 } });
  });

  it('buildNodeBodyTestInputs подставляет дефолт для пустого поля', () => {
    expect(buildNodeBodyTestInputs(ragNode(), undefined, { query: '', options: '' })).toEqual({
      query: '',
      options: {},
    });
  });
});

describe('schema bundle import (issue #248, item 1)', () => {
  const graphA = makeEmptyGraph('action', 'action');
  const graphH = makeEmptyGraph('hint', 'hint');

  it('parseSchemaBundle читает формат глобального экспорта', () => {
    const items = parseSchemaBundle({
      version: 1,
      items: [
        { schemaSlug: 'action', schemaType: 'action', gameId: null, graphJson: graphA, description: 'A' },
        { schemaSlug: 'hint', schemaType: 'hint', gameId: null, graphJson: graphH },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0].schemaSlug).toBe('action');
    expect(items[1].description).toBeNull();
  });

  it('parseSchemaBundle оборачивает одиночный graph_json', () => {
    const items = parseSchemaBundle(graphA);
    expect(items).toHaveLength(1);
    expect(items[0].schemaSlug).toBe('action');
  });

  it('parseSchemaBundle отвергает мусор', () => {
    expect(() => parseSchemaBundle({ foo: 'bar' })).toThrow();
  });

  it('diffSchemaBundle классифицирует created/updated/unchanged', () => {
    const items = parseSchemaBundle({
      version: 1,
      items: [
        { schemaSlug: 'action', schemaType: 'action', gameId: null, graphJson: graphA },
        { schemaSlug: 'hint', schemaType: 'hint', gameId: null, graphJson: graphH },
        { schemaSlug: 'support', schemaType: 'support', gameId: null, graphJson: makeEmptyGraph('support', 'support') },
      ],
    });
    const changedHint = { ...graphH, nodes: [...graphH.nodes] };
    changedHint.variables = { touched: true };
    const diff = diffSchemaBundle(items, [
      { schemaSlug: 'action', gameId: null, graphJson: graphA },
      { schemaSlug: 'hint', gameId: null, graphJson: changedHint },
    ]);
    expect(diff.total).toBe(3);
    expect(diff.unchanged).toBe(1); // action идентичен
    expect(diff.updated).toBe(1); // hint изменён
    expect(diff.created).toBe(1); // support новый
  });

  it('formatImportSummary форматирует сводку', () => {
    expect(formatImportSummary({ total: 3, created: 1, updated: 1, unchanged: 1 })).toContain('создано: 1');
  });
});

describe('frontend sub-schemas (issue #310)', () => {
  it('makeEmptySubSchemaGraph строит граф с классом и пустыми граничными портами', () => {
    const graph = makeEmptySubSchemaGraph('calc', 'common');
    expect(graph.subSchemaClass).toBe('common');
    expect(graph.schemaType).toBeUndefined();
    const start = graph.nodes.find((node) => node.id === 'start');
    const end = graph.nodes.find((node) => node.id === 'end');
    expect(start?.config.outputs).toEqual([]);
    expect(end?.config.inputs).toEqual([]);
    // start → end соединены exec-потоком по умолчанию.
    expect(graph.edges).toEqual([
      expect.objectContaining({ from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' }),
    ]);
  });

  it('makeEmptySubSchemaGraph пробрасывает gameId, если задан', () => {
    expect(makeEmptySubSchemaGraph('calc', 'game', 'game-alpha').gameId).toBe('game-alpha');
    expect(makeEmptySubSchemaGraph('calc', 'game').gameId).toBeUndefined();
  });

  it('paletteKindLabel и graphKindLabel дают метку класса для суб-схемы', () => {
    expect(paletteKindLabel('common')).toBe('Общая');
    expect(paletteKindLabel('action')).toBe('Действие');
    expect(graphKindLabel(makeEmptySubSchemaGraph('calc', 'support'))).toBe('Поддержка');
    expect(graphKindLabel(makeEmptyGraph('action', 'action'))).toBe('Действие');
  });

  it('normalizeSchemaGraph принимает суб-схему и отклоняет XOR-нарушение', () => {
    const sub = makeEmptySubSchemaGraph('calc', 'common');
    const normalized = normalizeSchemaGraph(sub);
    expect(normalized.subSchemaClass).toBe('common');
    expect(normalized.schemaType).toBeUndefined();

    expect(() => normalizeSchemaGraph({ ...sub, schemaType: 'action' })).toThrow('ровно одно из schemaType');
    const withoutClass = { ...sub, subSchemaClass: undefined };
    expect(() => normalizeSchemaGraph(withoutClass)).toThrow('ровно одно из schemaType');
  });

  it('nodePaletteAvailability отражает палитру класса: support без game_state_write', () => {
    const palette = nodePaletteAvailability('support');
    const gameWrite = palette.find((entry) => entry.type === 'game_state_write');
    expect(gameWrite?.available).toBe(false);
    expect(gameWrite?.reason).toContain('Поддержка');
    const llm = palette.find((entry) => entry.type === 'llm_request');
    expect(llm?.available).toBe(true);
  });

  it('defaultTestInputValues для суб-схемы пуст — входы задаются граничными портами', () => {
    expect(defaultTestInputValues('common')).toEqual({});
    expect(defaultTestInputValues('game')).toEqual({});
  });

  it('createGraphNode даёт узлу sub_schema конфиг с ключом schemaSlug (как читает движок)', () => {
    const graph = makeEmptyGraph('action', 'action');
    const node = createGraphNode(graph, 'sub_schema', { x: 240, y: 0 });
    expect(node.config).toMatchObject({ schemaSlug: '', ports: { inputs: [], outputs: [] } });
    expect(node.config).not.toHaveProperty('slug');
  });

  it('subSchemaConfigPatch пишет slug и снимок портов одним патчем (issue #315)', () => {
    const options = [
      {
        slug: 'calc',
        ports: {
          inputs: [{ id: 'value', label: 'Знач', type: 'number' as const }],
          outputs: [{ id: 'result', label: 'Рез', type: 'string' as const }],
        },
      },
    ];
    const patch = subSchemaConfigPatch({ schemaSlug: '', ports: { inputs: [], outputs: [] } }, 'calc', options);
    // И slug, и порты должны примениться вместе — иначе селектор «не работает» (issue #315).
    expect(patch.schemaSlug).toBe('calc');
    expect(patch.ports).toEqual({
      inputs: [{ id: 'value', label: 'Знач', type: 'number' }],
      outputs: [{ id: 'result', label: 'Рез', type: 'string' }],
    });
    // Снимок узла читается стандартным getNodePorts.
    const ports = getNodePorts({ id: 'sub', type: 'sub_schema', position: { x: 0, y: 0 }, config: patch });
    expect(ports.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'value', type: 'number' })]));
    expect(ports.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'result', type: 'string' })]));
  });

  it('subSchemaConfigPatch сбрасывает снимок портов для неизвестного slug, сохраняя прочие ключи', () => {
    const patch = subSchemaConfigPatch(
      { schemaSlug: 'calc', ports: { inputs: [{ id: 'value', label: '', type: 'number' }], outputs: [] }, graph: { keep: true } },
      'unknown-slug',
      [],
    );
    expect(patch.schemaSlug).toBe('unknown-slug');
    expect(patch.ports).toBeUndefined();
    expect(patch.graph).toEqual({ keep: true });
  });

  it('getNodePorts читает порты узла sub_schema из снимка config.ports', () => {
    const node: SchemaGraph['nodes'][number] = {
      id: 'sub',
      type: 'sub_schema',
      position: { x: 0, y: 0 },
      config: {
        slug: 'calc',
        ports: {
          inputs: [{ id: 'value', label: 'Знач', type: 'number' }],
          outputs: [{ id: 'result', label: 'Рез', type: 'string' }],
        },
      },
    };
    const ports = getNodePorts(node);
    expect(ports.inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'value', type: 'number' })]),
    );
    expect(ports.outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'result', type: 'string' })]),
    );
  });
});

// Навигация по телам loop-узлов на канвасе (issue #337): открытие тела цикла,
// чтение/запись config.bodyGraph и сборка вложенного стека обратно в корневой граф.
describe('навигация по телу loop-узла (issue #337)', () => {
  // Корневой граф с одним loop-узлом без сохранённого тела.
  function rootWithLoop(loopId = 'loop1'): SchemaGraph {
    const base = makeEmptyGraph('action', 'action');
    return {
      ...base,
      nodes: [
        ...base.nodes,
        { id: loopId, type: 'loop', position: { x: 260, y: 60 }, config: {}, label: 'Цикл' },
      ],
    };
  }

  it('loopBodySlug строит детерминированный slug тела от родителя и id узла', () => {
    expect(loopBodySlug('action', 'loop1')).toBe('action::loop:loop1');
  });

  it('makeEmptyLoopBodyGraph наследует kind родителя и содержит start/end', () => {
    const parent = makeEmptyGraph('action', 'action');
    const body = makeEmptyLoopBodyGraph(parent, 'loop1');
    expect(body.slug).toBe('action::loop:loop1');
    expect(body.schemaType).toBe('action');
    expect(body.subSchemaClass).toBeUndefined();
    expect(body.nodes.map((node) => node.id)).toEqual(['start', 'end']);
    expect(body.edges).toHaveLength(1);
  });

  it('makeEmptyLoopBodyGraph переносит subSchemaClass для суб-схемного родителя', () => {
    const parent = makeEmptySubSchemaGraph('calc', 'value');
    const body = makeEmptyLoopBodyGraph(parent, 'loop1');
    expect(body.subSchemaClass).toBe('value');
    expect(body.schemaType).toBeUndefined();
  });

  it('getLoopBodyGraph возвращает пустое тело, когда bodyGraph отсутствует', () => {
    const root = rootWithLoop();
    const body = getLoopBodyGraph(root, 'loop1');
    expect(body.slug).toBe('action::loop:loop1');
    expect(body.nodes.map((node) => node.id)).toEqual(['start', 'end']);
  });

  it('getLoopBodyGraph читает сохранённое тело и возвращает его копию', () => {
    const root = rootWithLoop();
    const stored = makeEmptyLoopBodyGraph(root, 'loop1');
    stored.nodes.push({ id: 'a', type: 'action', position: { x: 100, y: 100 }, config: {}, label: 'A' });
    const withBody = writeLoopBodyGraph(root, 'loop1', stored);
    const read = getLoopBodyGraph(withBody, 'loop1');
    expect(read.nodes.map((node) => node.id)).toContain('a');
    // Это копия: мутация результата не затрагивает хранилище.
    read.nodes.push({ id: 'b', type: 'action', position: { x: 0, y: 0 }, config: {}, label: 'B' });
    expect(getLoopBodyGraph(withBody, 'loop1').nodes.map((node) => node.id)).not.toContain('b');
  });

  it('writeLoopBodyGraph кладёт тело в config.bodyGraph нужного узла, не трогая прочие', () => {
    const root = rootWithLoop();
    const body = makeEmptyLoopBodyGraph(root, 'loop1');
    const updated = writeLoopBodyGraph(root, 'loop1', body);
    const loopNode = updated.nodes.find((node) => node.id === 'loop1');
    expect(loopNode?.config.bodyGraph).toEqual(body);
    // Узлы start/end остались нетронутыми.
    expect(updated.nodes.find((node) => node.id === 'start')?.config.bodyGraph).toBeUndefined();
  });

  it('collapseLoopFrames без кадров возвращает лист как есть', () => {
    const leaf = makeEmptyGraph('action', 'action');
    expect(collapseLoopFrames([], leaf)).toBe(leaf);
  });

  it('collapseLoopFrames собирает отредактированное вложенное тело обратно в корень', () => {
    const root = rootWithLoop('outer');
    // Открываем тело внешнего цикла, добавляем вложенный loop-узел.
    const outerBody = getLoopBodyGraph(root, 'outer');
    const innerLoopId = 'inner';
    const outerBodyWithInner: SchemaGraph = {
      ...outerBody,
      nodes: [
        ...outerBody.nodes,
        { id: innerLoopId, type: 'loop', position: { x: 200, y: 60 }, config: {}, label: 'Внутр' },
      ],
    };
    // Открываем тело вложенного цикла и редактируем его.
    const innerBody = getLoopBodyGraph(outerBodyWithInner, innerLoopId);
    const editedInner: SchemaGraph = {
      ...innerBody,
      nodes: [
        ...innerBody.nodes,
        { id: 'leaf', type: 'action', position: { x: 100, y: 100 }, config: {}, label: 'Лист' },
      ],
    };
    // Стек кадров: внешний цикл в корне, затем вложенный цикл в теле внешнего.
    const frames = [
      { parentGraph: root, loopNodeId: 'outer' },
      { parentGraph: outerBodyWithInner, loopNodeId: innerLoopId },
    ];
    const rebuilt = collapseLoopFrames(frames, editedInner);
    const outer = rebuilt.nodes.find((node) => node.id === 'outer')?.config.bodyGraph as SchemaGraph;
    expect(outer.nodes.map((node) => node.id)).toContain(innerLoopId);
    const inner = outer.nodes.find((node) => node.id === innerLoopId)?.config.bodyGraph as SchemaGraph;
    expect(inner.nodes.map((node) => node.id)).toContain('leaf');
  });

  // Восстановление открытых тел узлов после сохранения схемы (issue #393): редактор
  // не должен закрывать открытую схему узла и сбрасывать камеру при сохранении.
  it('reopenBodyGraphFrames пустой стек возвращает корень как лист без кадров', () => {
    const root = rootWithLoop();
    const result = reopenBodyGraphFrames(root, []);
    expect(result.frames).toEqual([]);
    expect(result.leaf).toBe(root);
  });

  it('reopenBodyGraphFrames восстанавливает вложенный путь на свежем корне', () => {
    // Свежий корень с outer-циклом, в чьём теле лежит inner-цикл с узлом leaf.
    const root = rootWithLoop('outer');
    const outerBody = getLoopBodyGraph(root, 'outer');
    const innerLoopId = 'inner';
    const innerBodyWithLeaf: SchemaGraph = (() => {
      const outerWithInner: SchemaGraph = {
        ...outerBody,
        nodes: [
          ...outerBody.nodes,
          { id: innerLoopId, type: 'loop', position: { x: 200, y: 60 }, config: {}, label: 'Внутр' },
        ],
      };
      const innerBody = getLoopBodyGraph(outerWithInner, innerLoopId);
      const editedInner: SchemaGraph = {
        ...innerBody,
        nodes: [
          ...innerBody.nodes,
          { id: 'leaf', type: 'action', position: { x: 100, y: 100 }, config: {}, label: 'Лист' },
        ],
      };
      return collapseLoopFrames(
        [
          { parentGraph: root, loopNodeId: 'outer' },
          { parentGraph: outerWithInner, loopNodeId: innerLoopId },
        ],
        editedInner,
      );
    })();

    // Старый стек ссылается на устаревшие снимки родителей — восстанавливаем по пути id.
    const staleFrames = [
      { parentGraph: root, loopNodeId: 'outer' },
      { parentGraph: outerBody, loopNodeId: innerLoopId },
    ];
    const result = reopenBodyGraphFrames(innerBodyWithLeaf, staleFrames);

    expect(result.frames.map((frame) => frame.loopNodeId)).toEqual(['outer', innerLoopId]);
    expect(result.frames[0].parentGraph).toBe(innerBodyWithLeaf);
    expect(result.frames.every((frame) => frame.nodeType === 'loop')).toBe(true);
    // Лист — тело внутреннего цикла с сохранённым узлом leaf.
    expect(result.leaf.nodes.map((node) => node.id)).toContain('leaf');
  });

  it('reopenBodyGraphFrames останавливается, если узел пути исчез из графа', () => {
    // Корень без loop-узла: путь обрывается на первом же кадре.
    const root = makeEmptyGraph('action', 'action');
    const staleFrames = [{ parentGraph: rootWithLoop(), loopNodeId: 'loop1' }];
    const result = reopenBodyGraphFrames(root, staleFrames);
    expect(result.frames).toEqual([]);
    expect(result.leaf).toBe(root);
  });
});

describe('graph_rag bodyGraph (issue #386)', () => {
  it('createGraphNode создаёт graph_rag с дефолтным телом и скрытым graph_query', () => {
    const graph = makeEmptyGraph('action', 'action');
    const node = createGraphNode(graph, 'graph_rag', { x: 240, y: 0 });

    expect(node.config.maxIterations).toBe(3);
    const body = node.config.bodyGraph as SchemaGraph;
    expect(body.slug).toBe(`action::graph_rag:${node.id}`);
    expect(body.subSchemaClass).toBe('common');
    expect(body.nodes.some((candidate) => candidate.type === 'graph_query')).toBe(true);

    const withNode = { ...graph, nodes: [...graph.nodes, node] };
    const read = getBodyGraph(withNode, node.id);
    expect(read.nodes.some((candidate) => candidate.type === 'graph_query')).toBe(true);
    read.nodes.push({ id: 'probe', type: 'log', position: { x: 0, y: 0 }, config: {} });
    expect(((node.config.bodyGraph as SchemaGraph).nodes).some((candidate) => candidate.id === 'probe')).toBe(false);

    expect(getNodePaletteForSchema('action')).toContain('graph_rag');
    expect(getNodePaletteForSchema('action')).not.toContain('graph_query');
  });
});
