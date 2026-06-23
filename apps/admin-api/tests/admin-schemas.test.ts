import { describe, expect, it, vi } from 'vitest';
import { AdminDataService } from '../src/admin/admin-data.service';
import { normalizeSchemaGraph } from '../src/admin/schema-graph';
import type { DatabaseService } from '../src/database/database.service';

type QueryMock = ReturnType<typeof vi.fn>;

function makeDatabase(query: QueryMock): DatabaseService {
  return { query } as unknown as DatabaseService;
}

function makeTransactionDatabase(query: QueryMock) {
  const transaction = vi.fn(async (work: (client: { query: QueryMock }) => Promise<unknown>) => work({ query }));
  return {
    database: { query, transaction } as unknown as DatabaseService,
    transaction,
  };
}

function graph(code = 'return Number(input.value) + 1;') {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
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
      { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'value', from: 'start', fromPort: 'value', to: 'transform', toPort: 'value' },
      { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

function contextGraph() {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'memory', type: 'game_memory_read', position: { x: 200, y: 0 }, config: {} },
      {
        id: 'transform',
        type: 'transform',
        position: { x: 400, y: 0 },
        config: {
          code:
            'return [input.context.history[0]?.action, input.memory, state.location, manifest.name].join(" | ");',
          output: 'result',
        },
      },
      { id: 'end', type: 'end', position: { x: 600, y: 0 }, config: {} },
    ],
    edges: [
      // game_memory_read и transform — data-only узлы (issue #201): exec идёт
      // напрямую start → end, данные тянутся по требованию через data-порты.
      { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'context', from: 'start', fromPort: 'inputs', to: 'transform', toPort: 'context' },
      { id: 'memory-text', from: 'memory', fromPort: 'memory', to: 'transform', toPort: 'memory' },
      { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

function llmGraph() {
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'llm',
        type: 'llm_request',
        position: { x: 200, y: 0 },
        config: {
          kind: 'narrative_generation',
          systemPrompt: 'Игра: {{game_name}}',
          userPrompt: 'Действие: {{action}}',
          retryPrompt: '{{base_prompt}}\n\nОшибка JSON: {{error_text}}',
          outputs: [{ name: 'narrative', type: 'string' }],
        },
      },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'start-llm', from: 'start', fromPort: 'exec', to: 'llm', toPort: 'exec' },
      { id: 'llm-end', from: 'llm', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'action', from: 'start', fromPort: 'action', to: 'llm', toPort: 'action' },
      { id: 'narrative', from: 'llm', fromPort: 'narrative', to: 'end', toPort: 'narrative' },
    ],
  };
}

function variableWriteGraph(config: Record<string, unknown>) {
  // Узел variable_write (issue #232): exec-поток start → write → end. config.name больше
  // не поддерживается — порты берутся из config.inputs, пустая конфигурация даёт value.
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'write', type: 'variable_write', position: { x: 200, y: 0 }, config },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'start-write', from: 'start', fromPort: 'exec', to: 'write', toPort: 'exec' },
      { id: 'write-end', from: 'write', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
  };
}

function schemaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schema-1',
    schema_slug: 'action',
    schema_type: 'action',
    schema_class: null,
    game_id: null,
    graph_json: graph(),
    is_active: true,
    description: 'desc',
    created_at: '2026-06-12T12:00:00.000Z',
    updated_at: '2026-06-12T12:00:00.000Z',
    ...overrides,
  };
}

function isSql(sql: unknown, fragment: string): boolean {
  return String(sql).includes(fragment);
}

function mockParams(call: unknown[] | undefined): unknown[] {
  return Array.isArray(call?.[1]) ? (call[1] as unknown[]) : [];
}

function parseJsonParam(params: unknown[], index: number): unknown {
  return JSON.parse(String(params[index]));
}

describe('AdminDataService schemas', () => {
  it('сохраняет новую версию схемы и архивирует прежнюю активную', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [schemaRow()] });
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.updateSchema({
      slug: 'action',
      schemaType: 'action',
      graphJson: graph(),
      description: 'desc',
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO schema_history');
    expect(String(query.mock.calls[1][0])).toContain('UPDATE schemas');
    expect(String(query.mock.calls[2][0])).toContain('INSERT INTO schemas');
    expect(result).toMatchObject({ schema_slug: 'action', graph_json: graph() });
  });

  it('отклоняет граф с битым ребром до обращения к БД', async () => {
    const broken = {
      ...graph(),
      edges: [{ id: 'broken', from: 'start', fromPort: 'value', to: 'missing', toPort: 'value' }],
    };
    const query = vi.fn();
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    await expect(
      service.updateSchema({ slug: 'action', schemaType: 'action', graphJson: broken }),
    ).rejects.toMatchObject({
      response: {
        code: 'unknown_edge_to',
        message: 'Ребро broken ссылается на неизвестный узел missing',
      },
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('импорт схем считает неизменённую активную запись как unchanged', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [schemaRow()] })
      .mockResolvedValueOnce({ rows: [{ schema_slug: 'action' }] });
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.importSchemas([
      { schemaSlug: 'action', schemaType: 'action', graphJson: graph(), description: 'desc' },
    ]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 1, created: 0, updated: 0, unchanged: 1 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO schema_history'))).toBe(false);
  });

  it('выполняет test-run сохранённой схемы production engine и пишет schema_execution_log', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow()] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { inputs: { value: 4 } });

    expect(result.outputs).toEqual({ result: 5 });
    expect(result.costMillicents).toBe(0);
    expect(result.durationMs).toEqual(expect.any(Number));
    const logCall = query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO schema_execution_log'));
    const params = mockParams(logCall);
    // Столбцы schema_execution_log: schema_slug, schema_type, schema_class, game_id,
    // session_id, status, inputs_json, outputs_json, llm_log, duration_ms, error_*.
    expect(params.slice(0, 6)).toEqual(['action', 'action', null, null, null, 'ok']);
    expect(parseJsonParam(params, 6)).toMatchObject({ value: 4, history: [], memoryTopK: 12 });
    expect(parseJsonParam(params, 7)).toEqual({ result: 5 });
    expect(parseJsonParam(params, 8)).toEqual([]);
    expect(params[9]).toEqual(expect.any(Number));
  });

  it('строит test-run context из inputs: history, memoryCells и state', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: contextGraph() })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', {
      inputs: {
        state: { ...defaultState(), location: 'Архив' },
        history: [{ turn: 1, action: 'открыть дверь', outcome: 'дверь открыта' }],
        memoryCells: [{ id: 'memory-1', content: 'договор с кузнецом', category: 'npc', importance: 3, turn_created: 1 }],
      },
    });

    expect(String(result.outputs.result)).toContain('открыть дверь');
    expect(String(result.outputs.result)).toContain('договор с кузнецом');
    expect(String(result.outputs.result)).toContain('Архив');
    // Без gameId сессии не запрашиваются
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'FROM game_sessions'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'FROM game_steps'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'FROM game_memory_cells'))).toBe(false);
    const logCall = query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO schema_execution_log'));
    // Без gameId: game_id ($4) = null, session_id ($5) = null.
    expect(mockParams(logCall)[3]).toBeNull();
    expect(mockParams(logCall)[4]).toBeNull();
  });

  it('строит test-run context с supportHistory из inputs', async () => {
    const supportGraph = {
      version: 1,
      schemaType: 'support',
      slug: 'action',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'history_read', type: 'support_history_read', position: { x: 200, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 400, y: 0 },
          config: { code: 'return input.messages[0]?.message ?? "пусто";', output: 'result' },
        },
        { id: 'end', type: 'end', position: { x: 600, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'messages', from: 'history_read', fromPort: 'messages', to: 'transform', toPort: 'messages' },
        { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
      ],
    };
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: supportGraph, schema_type: 'support' })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', {
      inputs: {
        user_query: 'Не могу начать игру',
        supportHistory: [
          { role: 'user', message: 'Помогите с игрой' },
          { role: 'bot', message: 'Уточните проблему' },
        ],
      },
    });

    expect(String(result.outputs.result)).toBe('Помогите с игрой');
  });

  it('использует gameId для manifest и выбора game-specific схемы', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM game_manifests')) {
        return { rows: [{ game_id: 'game-2', manifest: { ...defaultManifest('game-2'), name: 'Игра 2' } }] };
      }
      if (isSql(sql, 'FROM schemas')) {
        return { rows: [schemaRow({ graph_json: graph('return manifest.name;') })] };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { gameId: 'game-2', inputs: {} });

    expect(result.outputs).toEqual({ result: 'Игра 2' });
    const schemaCall = query.mock.calls.find(([sql]) => isSql(sql, 'FROM schemas'));
    expect(schemaCall?.[1]).toEqual(['action', 'game-2']);
  });

  it('делает LLM retry через production llm_request и считает стоимость по usage', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: llmGraph() })] };
      if (isSql(sql, 'FROM model_defaults')) {
        return {
          rows: [
            {
              key: 'llm_model_name',
              value: 'gpt-4o-mini',
              updated_at: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', {
      inputs: {
        action: 'осмотреться',
        __mockLlmResponses: ['не JSON', '{"narrative":"готово"}'],
        mockUsage: { promptTokens: 10, completionTokens: 5 },
        maxRetries: 2,
      },
    });

    expect(result.outputs).toMatchObject({ narrative: 'готово' });
    expect(result.llmLog).toHaveLength(2);
    expect(result.llmLog[0]).toMatchObject({ nodeId: 'llm', kind: 'narrative_generation' });
    expect(result.costMillicents).toBeGreaterThan(0);
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'FROM model_defaults'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'FROM model_rules'))).toBe(false);
  });

  it('запускает test-run схемы с variable_write без config.name (issue #232)', async () => {
    // Регрессия issue #232: до issue #208 узел variable_write требовал config.name и
    // запуск теста падал с «variable_write-узлу нужен config.name». Сейчас тест должен
    // проходить как с пустой конфигурацией, так и с узлом, где остался legacy config.name
    // (он больше не поддерживается, но и ошибку запуска не вызывает).
    for (const config of [{}, { name: 'gold', value: 7 }]) {
      const query = vi.fn(async (sql: unknown) => {
        if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: variableWriteGraph(config) })] };
        if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
        return { rows: [] };
      });
      const service = new AdminDataService(makeDatabase(query));

      const result = await service.testSchema('action', { inputs: {} });

      expect(result.outputs).toEqual({});
      expect(result.durationMs).toEqual(expect.any(Number));
    }
  });

  it('возвращает полный лог по узлам потока и pure-зависимостям (issue #347)', async () => {
    // contextGraph: exec-поток идёт start → end, а game_memory_read и transform —
    // pure-узлы (без exec-входа), которые подтягиваются по запросу данных. Отчёт
    // должен содержать запись по КАЖДОЙ ноде потока и по каждой запрошенной pure-ноде.
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: contextGraph() })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', {
      inputs: { history: [{ action: 'осмотреться', outcome: '' }] },
    });

    const byNode = new Map(result.nodeTrace.map((entry) => [entry.nodeId, entry]));
    // Все четыре узла графа присутствуют в отчёте.
    expect([...byNode.keys()].sort()).toEqual(['end', 'memory', 'start', 'transform']);
    // start/end дошли по потоку, memory/transform подтянуты как зависимости данных.
    expect(byNode.get('start')?.via).toBe('flow');
    expect(byNode.get('end')?.via).toBe('flow');
    expect(byNode.get('memory')?.via).toBe('data');
    expect(byNode.get('transform')?.via).toBe('data');
    // У каждой записи есть тип узла, порядковый номер, длительность и флаг успеха.
    expect(byNode.get('transform')).toMatchObject({
      nodeType: 'transform',
      failed: false,
      schemaSlug: 'action',
      depth: 0,
    });
    expect(result.nodeTrace.every((entry) => typeof entry.durationMs === 'number')).toBe(true);
    expect(result.nodeTrace.map((entry) => entry.order)).toEqual(
      result.nodeTrace.map((_, index) => index + 1),
    );
  });

  it('прикладывает лог по узлам к ошибке test-run с упавшим узлом (issue #347)', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: graph('return process.env.SECRET;') })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    await service
      .testSchema('action', { inputs: { value: 4 } })
      .then(() => {
        throw new Error('ожидалась ошибка test-run');
      })
      .catch((err: unknown) => {
        const response = (err as { response?: { nodeTrace?: unknown } }).response ?? {};
        expect(Array.isArray(response.nodeTrace)).toBe(true);
        const trace = response.nodeTrace as Array<{ nodeId: string; failed: boolean }>;
        // Упавший узел (transform) присутствует в отчёте и помечен как ошибочный.
        const failed = trace.find((entry) => entry.failed);
        expect(failed?.nodeId).toBe('transform');
      });
  });

  it('возвращает nodeId/nodeType и логирует ошибку test-run', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: graph('return process.env.SECRET;') })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    await expect(service.testSchema('action', { inputs: { value: 4 } })).rejects.toMatchObject({
      response: {
        nodeId: 'transform',
        nodeType: 'transform',
        message: expect.stringContaining('запрещённый доступ'),
      },
    });
    const logCall = query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO schema_execution_log'));
    // status='error' ($6), а узел ошибки фиксируется в столбцах error_node_id ($11)
    // и error_node_type ($12).
    const params = mockParams(logCall);
    expect(params[5]).toBe('error');
    expect(params[10]).toBe('transform');
    expect(params[11]).toBe('transform');
  });

  it('возвращает lastRaw для упавшего LLM-узла', async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ graph_json: llmGraph() })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    await expect(
      service.testSchema('action', {
        inputs: {
          action: 'осмотреться',
          __mockLlmResponses: ['сырой ответ'],
          maxRetries: 1,
        },
      }),
    ).rejects.toMatchObject({
      response: {
        nodeId: 'llm',
        nodeType: 'llm_request',
        message: expect.stringContaining('не вернул валидный JSON'),
        lastRaw: 'сырой ответ',
      },
    });
  });

  it('возвращает 404 для отсутствующей схемы', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const service = new AdminDataService(makeDatabase(query));

    await expect(service.testSchema('action', { inputs: {} })).rejects.toMatchObject({
      response: {
        message: 'Схема не найдена',
      },
      status: 404,
    });
  });

  it('deleteSchemaHistoryEntry удаляет запись и бросает 404 если не найдена', async () => {
    const queryFound = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const serviceFound = new AdminDataService(makeDatabase(queryFound));
    await expect(serviceFound.deleteSchemaHistoryEntry('action', 'hist-1')).resolves.toBeUndefined();
    expect(String(queryFound.mock.calls[0][0])).toContain('DELETE FROM schema_history');
    expect(queryFound.mock.calls[0][1]).toEqual(['action', 'hist-1']);

    const queryMissing = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const serviceMissing = new AdminDataService(makeDatabase(queryMissing));
    await expect(serviceMissing.deleteSchemaHistoryEntry('action', 'hist-missing')).rejects.toMatchObject({
      response: { message: 'Версия схемы не найдена' },
      status: 404,
    });
  });
});

describe('AdminDataService schema drafts (issue #286)', () => {
  it('getSchemaDraft возвращает черновик, если он есть', async () => {
    const draft = graph('return Number(input.value) + 2;');
    const query = vi.fn(async () => ({ rows: [schemaRow({ draft_graph_json: draft })] }));
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.getSchemaDraft('action');

    expect(result.has_draft).toBe(true);
    expect(result.graph_json).toEqual(draft);
  });

  it('getSchemaDraft возвращает рабочую версию, если черновика нет', async () => {
    const query = vi.fn(async () => ({ rows: [schemaRow({ draft_graph_json: null })] }));
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.getSchemaDraft('action');

    expect(result.has_draft).toBe(false);
    expect(result.graph_json).toEqual(graph());
  });

  it('saveSchemaDraft пишет draft_graph_json без записи в историю', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [schemaRow()] }) // findActiveSchema
      .mockResolvedValueOnce({ rows: [schemaRow({ draft_graph_json: graph() })] }); // UPDATE
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.saveSchemaDraft({ slug: 'action', graphJson: graph() });

    expect(result.has_draft).toBe(true);
    const updateCall = query.mock.calls.find(([sql]) => isSql(sql, 'SET draft_graph_json'));
    expect(updateCall).toBeDefined();
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'INSERT INTO schema_history'))).toBe(false);
  });

  it('promoteSchemaDraft переносит черновик в рабочую версию и архивирует прежнюю', async () => {
    const draft = graph('return Number(input.value) + 3;');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [schemaRow({ draft_graph_json: draft })] }) // SELECT active
      .mockResolvedValueOnce({ rows: [] }) // INSERT history
      .mockResolvedValueOnce({ rows: [schemaRow({ graph_json: draft, draft_graph_json: null })] }); // UPDATE
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.promoteSchemaDraft('action');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO schema_history');
    expect(String(query.mock.calls[2][0])).toContain('graph_json = draft_graph_json');
    expect(result).toMatchObject({ has_draft: false, graph_json: draft });
  });

  it('promoteSchemaDraft без черновика ничего не меняет', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [schemaRow({ draft_graph_json: null })] });
    const { database } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.promoteSchemaDraft('action');

    expect(result).toMatchObject({ has_draft: false });
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'INSERT INTO schema_history'))).toBe(false);
  });

  it('resetSchemaDraft обнуляет черновик и возвращает рабочую версию', async () => {
    const query = vi.fn(async () => ({ rows: [schemaRow({ draft_graph_json: null })] }));
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.resetSchemaDraft('action');

    expect(result).toMatchObject({ has_draft: false, graph_json: graph() });
    const call = query.mock.calls[0];
    expect(String(call[0])).toContain('SET draft_graph_json = NULL');
    expect(call[1]).toEqual(['action', null]);
  });

  it('resetSchemaDraft бросает 404 для отсутствующей схемы', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const service = new AdminDataService(makeDatabase(query));

    await expect(service.resetSchemaDraft('action')).rejects.toMatchObject({
      response: { message: 'Схема не найдена' },
      status: 404,
    });
  });

  it('saveSchemaDraft создаёт игровую строку, когда игра наследует базовую схему (issue #234)', async () => {
    const draft = graph('return Number(input.value) + 5;');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [schemaRow({ game_id: null })] }) // findActiveSchema → база
      .mockResolvedValueOnce({ rows: [schemaRow({ game_id: 'game-alpha', draft_graph_json: draft })] }); // INSERT
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.saveSchemaDraft({ slug: 'action', graphJson: draft, gameId: 'game-alpha' });

    expect(result.has_draft).toBe(true);
    const insertCall = query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO schemas'));
    expect(insertCall).toBeDefined();
    const params = mockParams(insertCall);
    expect(params[3]).toBe('game-alpha');
    expect(String(params[4])).toContain('+ 1'); // рабочая версия = базовый граф
    expect(String(params[5])).toContain('+ 5'); // черновик = правки редактора
    // Историю не трогаем — черновик не создаёт версий.
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'INSERT INTO schema_history'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'SET draft_graph_json'))).toBe(false);
  });

  it('promoteSchemaDraft форкает базовую схему в игровую при сохранении (issue #234)', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // SELECT активной игровой строки → нет
      .mockResolvedValueOnce({ rows: [schemaRow({ game_id: null })] }) // SELECT базовой
      .mockResolvedValueOnce({ rows: [schemaRow({ game_id: 'game-alpha' })] }); // INSERT
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.promoteSchemaDraft('action', 'game-alpha');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ has_draft: false });
    const insertCall = query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO schemas'));
    expect(insertCall).toBeDefined();
    expect(mockParams(insertCall)[3]).toBe('game-alpha');
    // Форк новой игровой схемы не архивирует историю.
    expect(query.mock.calls.some(([sql]) => isSql(sql, 'INSERT INTO schema_history'))).toBe(false);
  });

  it('resetSchemaDraft для наследующей игры возвращает базовую версию без ошибки', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // UPDATE → игровой строки нет
      .mockResolvedValueOnce({ rows: [schemaRow({ game_id: null })] }); // findActiveSchema → база
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.resetSchemaDraft('action', 'game-alpha');

    expect(result).toMatchObject({ has_draft: false, graph_json: graph() });
  });

  it('testSchema выполняется на черновике, если он есть', async () => {
    const draft = graph('return Number(input.value) + 10;');
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) return { rows: [schemaRow({ draft_graph_json: draft })] };
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { inputs: { value: 4 } });

    // Рабочая версия дала бы 5 (value + 1), черновик даёт 14 (value + 10).
    expect(result.outputs).toEqual({ result: 14 });
  });

  it('testSchema берёт переменные из черновика, а не из рабочей версии (issue #355)', async () => {
    // Граф читает переменную factor в transform и отдаёт её на выход. Рабочая версия
    // объявляет factor='working', черновик — factor='draft'. Тест черновика обязан
    // прогоняться с переменными черновика.
    const variableGraph = (factor: string) => ({
      version: 1,
      schemaType: 'action',
      slug: 'action',
      variables: { factor },
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return variables.factor;', output: 'result' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
      ],
    });
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) {
        return {
          rows: [
            schemaRow({
              graph_json: variableGraph('working'),
              draft_graph_json: variableGraph('draft'),
            }),
          ],
        };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { inputs: {} });

    // До исправления переменные сеялись из рабочей версии и тест отдавал 'working'.
    expect(result.outputs).toEqual({ result: 'draft' });
  });

  it('testSchema суб-схемы берёт переменные из черновика суб-схемы (issue #355)', async () => {
    // Прямой тест суб-схемы — точный сценарий из заголовка задачи: открыли суб-схему
    // в редакторе, поменяли переменную в черновике и запустили тест. Тест обязан идти
    // по черновику суб-схемы. До фикса переменные сеялись из рабочей версии — и по
    // факту тестировалась рабочая, а не черновик. Отличие от теста выше: здесь
    // тестируемый граф — именно суб-схема (subSchemaClass), а не пайплайн-схема.
    const subVariableGraph = (factor: string) => ({
      version: 1,
      subSchemaClass: 'common',
      slug: 'calc',
      variables: { factor },
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [] } },
        {
          id: 'transform',
          type: 'transform',
          position: { x: 200, y: 0 },
          config: { code: 'return variables.factor;', output: 'result' },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: [{ id: 'result', label: 'Рез', type: 'string' }] } },
      ],
      edges: [
        { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
      ],
    });
    const query = vi.fn(async (sql: unknown) => {
      if (isSql(sql, 'FROM schemas')) {
        return {
          rows: [
            schemaRow({
              schema_slug: 'calc',
              schema_type: null,
              schema_class: 'common',
              graph_json: subVariableGraph('working'),
              draft_graph_json: subVariableGraph('draft'),
            }),
          ],
        };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('calc', { inputs: {}, context: 'support' });

    // До исправления переменные сеялись из рабочей версии и тест отдавал 'working'.
    expect(result.outputs).toEqual({ result: 'draft' });
  });

  it('testSchema прогоняет черновик и для вложенной суб-схемы (issue #343)', async () => {
    const subWorking = subSchemaGraph('common', 'return Number(input.value) + 1;');
    const subDraft = subSchemaGraph('common', 'return Number(input.value) + 100;');
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      if (isSql(sql, 'FROM schemas')) {
        const slug = Array.isArray(params) ? params[0] : undefined;
        if (slug === 'calc') {
          return {
            rows: [
              schemaRow({
                schema_slug: 'calc',
                schema_type: null,
                schema_class: 'common',
                graph_json: subWorking,
                draft_graph_json: subDraft,
              }),
            ],
          };
        }
        // Верхняя схема черновика не имеет — исполняется её рабочая версия.
        return { rows: [schemaRow({ graph_json: parentWithSubGraph() })] };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { inputs: { value: 4 } });

    // Рабочая версия суб-схемы дала бы 5 (value + 1), её черновик даёт 104 (value + 100).
    expect(result.outputs).toEqual({ result: 104 });
  });

  it('testSchema использует рабочую версию суб-схемы при отсутствии черновика (issue #343)', async () => {
    const subWorking = subSchemaGraph('common', 'return Number(input.value) + 1;');
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      if (isSql(sql, 'FROM schemas')) {
        const slug = Array.isArray(params) ? params[0] : undefined;
        if (slug === 'calc') {
          return {
            rows: [
              schemaRow({
                schema_slug: 'calc',
                schema_type: null,
                schema_class: 'common',
                graph_json: subWorking,
                draft_graph_json: null,
              }),
            ],
          };
        }
        return { rows: [schemaRow({ graph_json: parentWithSubGraph() })] };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { inputs: { value: 4 } });

    expect(result.outputs).toEqual({ result: 5 });
  });
});

function defaultManifest(gameId: string) {
  return {
    id: gameId,
    name: 'Тестовая схема',
    description: '',
    priceStars: 1,
    limits: { maxHp: 100, maxInventoryItems: 10 },
    worldRules: [],
    startTime: { season: 'лето', date: '1 июня', time: '12:00', time_of_day: 'день' },
    characterPresets: [],
    locationPresets: [],
  };
}

function defaultState() {
  return {
    location: 'Тестовая локация',
    narrative: '',
    character: { hp: 100, max_hp: 100, skills: {}, inventory: [] },
    world_flags: {},
    world_time: { season: 'лето', date: '1 июня', time: '12:00', time_of_day: 'день' },
    turn_count: 0,
  };
}

describe('backend schema graph contract', () => {
  it('валидирует динамические input-порты llm_request по config.inputs', () => {
    const broken = {
      version: 1,
      schemaType: 'action',
      slug: 'action',
      variables: {},
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'llm',
          type: 'llm_request',
          position: { x: 200, y: 0 },
          config: {
            kind: 'narrative_generation',
            inputs: [{ name: 'context', type: 'object' }],
            outputs: [{ name: 'value', type: 'string' }],
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'start-llm', from: 'start', fromPort: 'exec', to: 'llm', toPort: 'exec' },
        { id: 'llm-end', from: 'llm', fromPort: 'exec', to: 'end', toPort: 'exec' },
        { id: 'bad-input', from: 'start', fromPort: 'action', to: 'llm', toPort: 'context' },
      ],
    };

    expect(() => normalizeSchemaGraph(broken, 'action', 'action')).toThrow('Несовместимые порты');
    try {
      normalizeSchemaGraph(broken, 'action', 'action');
    } catch (err) {
      expect(err).toMatchObject({
        response: {
          code: 'incompatible_ports',
        },
      });
    }
  });
});

// ── Суб-схемы (issue #310) ──────────────────────────────────────────────────
// Суб-схема — самостоятельная сущность с классом (game/support/common) вместо
// schemaType и настраиваемыми граничными портами на узлах start/end.

function subSchemaGraph(subSchemaClass = 'common', code = 'return Number(input.value) + 1;') {
  return {
    version: 1,
    subSchemaClass,
    slug: 'calc',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [{ id: 'value', label: 'Знач', type: 'number' }] } },
      { id: 'transform', type: 'transform', position: { x: 200, y: 0 }, config: { code, output: 'result' } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: [{ id: 'result', label: 'Рез', type: 'number' }] } },
    ],
    edges: [
      { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'value', from: 'start', fromPort: 'value', to: 'transform', toPort: 'value' },
      { id: 'result', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

function manifestSubSchemaGraph() {
  // game-суб-схема с узлом manifest без gameId — работает на манифесте вызывающей игры.
  return {
    version: 1,
    subSchemaClass: 'game',
    slug: 'game_name',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [] } },
      { id: 'm', type: 'manifest', position: { x: 200, y: 0 }, config: { fields: ['name'] } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: [{ id: 'name', label: 'Имя', type: 'string' }] } },
    ],
    edges: [
      { id: 'start-end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'name', from: 'm', fromPort: 'name', to: 'end', toPort: 'name' },
    ],
  };
}

function parentWithSubGraph(subSlug = 'calc') {
  // Пайплайн action с узлом sub_schema, который пробрасывает value → result.
  return {
    version: 1,
    schemaType: 'action',
    slug: 'action',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'sub', type: 'sub_schema', position: { x: 200, y: 0 }, config: { schemaSlug: subSlug } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'start-sub', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
      { id: 'sub-end', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'value-in', from: 'start', fromPort: 'value', to: 'sub', toPort: 'value' },
      { id: 'result-out', from: 'sub', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

// common-суб-схема, которая внутри вызывает game-суб-схему `gamesub` (issue #351).
// Без контекста выполнения «игра» вложенная game-суб-схема не резолвится (common
// не из игрового домена), с контекстом — резолвится.
function commonParentWithGameSubGraph(subSlug = 'gamesub') {
  return {
    version: 1,
    subSchemaClass: 'common',
    slug: 'parent',
    variables: {},
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: [{ id: 'value', label: 'Знач', type: 'number' }] } },
      { id: 'sub', type: 'sub_schema', position: { x: 200, y: 0 }, config: { schemaSlug: subSlug } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: [{ id: 'result', label: 'Рез', type: 'number' }] } },
    ],
    edges: [
      { id: 'start-sub', from: 'start', fromPort: 'exec', to: 'sub', toPort: 'exec' },
      { id: 'sub-end', from: 'sub', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'value-in', from: 'start', fromPort: 'value', to: 'sub', toPort: 'value' },
      { id: 'result-out', from: 'sub', fromPort: 'result', to: 'end', toPort: 'result' },
    ],
  };
}

describe('AdminDataService schema test context (issue #351)', () => {
  function mockDatabase(parentGraph: unknown, gameSub: unknown) {
    return vi.fn(async (sql: unknown, params?: unknown) => {
      if (isSql(sql, 'FROM game_manifests')) {
        return { rows: [{ game_id: 'game-2', manifest: { ...defaultManifest('game-2'), name: 'Игра 2' } }] };
      }
      if (isSql(sql, 'FROM schemas')) {
        const slug = Array.isArray(params) ? params[0] : undefined;
        if (slug === 'gamesub') {
          return {
            rows: [
              schemaRow({
                schema_slug: 'gamesub',
                schema_type: null,
                schema_class: 'game',
                graph_json: gameSub,
              }),
            ],
          };
        }
        return {
          rows: [schemaRow({ schema_slug: 'parent', schema_type: null, schema_class: 'common', graph_json: parentGraph })],
        };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
  }

  it('контекст «игра» резолвит вложенную game-суб-схему из common-суб-схемы', async () => {
    const gameSub = subSchemaGraph('game', 'return Number(input.value) + 1;');
    const query = mockDatabase(commonParentWithGameSubGraph(), gameSub);
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('parent', {
      inputs: { value: 4 },
      context: 'game',
      gameId: 'game-2',
    });

    expect(result.outputs).toEqual({ result: 5 });
    // gameId контекста используется при подборе активной суб-схемы.
    const subCall = query.mock.calls.find(
      ([sql, params]) => isSql(sql, 'FROM schemas') && Array.isArray(params) && params[0] === 'gamesub',
    );
    expect(subCall?.[1]).toEqual(['gamesub', 'game-2']);
  });

  it('без контекста «игра» common-суб-схема не видит game-суб-схему', async () => {
    const gameSub = subSchemaGraph('game', 'return Number(input.value) + 1;');
    const query = mockDatabase(commonParentWithGameSubGraph(), gameSub);
    const service = new AdminDataService(makeDatabase(query));

    await expect(service.testSchema('parent', { inputs: { value: 4 } })).rejects.toBeDefined();
  });
});

describe('AdminDataService sub-schemas (issue #310)', () => {
  it('normalizeSchemaGraph принимает суб-схему с узлом manifest без игры', () => {
    const graph = normalizeSchemaGraph(manifestSubSchemaGraph(), 'game_name', 'game');
    expect(graph.subSchemaClass).toBe('game');
    expect(graph.schemaType).toBeUndefined();
    expect(graph.gameId).toBeUndefined();
  });

  it('normalizeSchemaGraph отклоняет граф с обоими schemaType и subSchemaClass', () => {
    const broken = { ...subSchemaGraph('common'), schemaType: 'action' };
    expect(() => normalizeSchemaGraph(broken, 'calc')).toThrow(
      'ровно одно из schemaType',
    );
  });

  it('updateSchema сохраняет суб-схему с schema_type=null и schema_class из графа', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // INSERT history
      .mockResolvedValueOnce({ rows: [] }) // UPDATE archive
      .mockResolvedValueOnce({ rows: [schemaRow({ schema_slug: 'calc', schema_type: null, schema_class: 'common', graph_json: subSchemaGraph('common') })] });
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.updateSchema({
      slug: 'calc',
      schemaClass: 'common',
      graphJson: subSchemaGraph('common'),
      description: '',
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    const insertCall = query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO schemas'));
    expect(insertCall).toBeDefined();
    const params = mockParams(insertCall);
    // INSERT INTO schemas: schema_slug($1), schema_type($2), schema_class($3), game_id($4)…
    expect(params[0]).toBe('calc');
    expect(params[1]).toBeNull(); // schema_type отсутствует у суб-схемы
    expect(params[2]).toBe('common'); // schema_class
    expect(result).toMatchObject({ schema_slug: 'calc', schema_class: 'common', schema_type: null });
  });

  it('updateSchema отклоняет одновременно schemaType и schemaClass до БД', async () => {
    const query = vi.fn();
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    await expect(
      service.updateSchema({ slug: 'calc', schemaType: 'action', schemaClass: 'common', graphJson: subSchemaGraph('common') }),
    ).rejects.toMatchObject({ response: { message: expect.stringContaining('ровно одно из schemaType') } });
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('listSchemas отдаёт schema_class в составе списка', async () => {
    const query = vi.fn(async () => ({
      rows: [
        schemaRow(),
        schemaRow({ id: 'schema-2', schema_slug: 'calc', schema_type: null, schema_class: 'common', graph_json: subSchemaGraph('common') }),
      ],
    }));
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.listSchemas();

    expect(String(query.mock.calls[0][0])).toContain('schema_class');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ schema_slug: 'action', schema_class: null });
    expect(result.items[1]).toMatchObject({ schema_slug: 'calc', schema_class: 'common' });
  });

  it('test-run пайплайна резолвит совместимую common-суб-схему и пробрасывает порты', async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
      if (isSql(sql, 'FROM schemas')) {
        if (params?.[0] === 'calc') {
          return { rows: [schemaRow({ schema_slug: 'calc', schema_type: null, schema_class: 'common', graph_json: subSchemaGraph('common') })] };
        }
        return { rows: [schemaRow({ graph_json: parentWithSubGraph('calc') })] };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    const result = await service.testSchema('action', { inputs: { value: 4 } });

    expect(result.outputs).toEqual({ result: 5 });
  });

  it('test-run пайплайна не подключает несовместимую support-суб-схему из action-домена', async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
      if (isSql(sql, 'FROM schemas')) {
        if (params?.[0] === 'calc') {
          // support-суб-схема недоступна из action-домена → резолвер вернёт null.
          return { rows: [schemaRow({ schema_slug: 'calc', schema_type: null, schema_class: 'support', graph_json: subSchemaGraph('support') })] };
        }
        return { rows: [schemaRow({ graph_json: parentWithSubGraph('calc') })] };
      }
      if (isSql(sql, 'INSERT INTO schema_execution_log')) return { rows: [] };
      return { rows: [] };
    });
    const service = new AdminDataService(makeDatabase(query));

    await expect(service.testSchema('action', { inputs: { value: 4 } })).rejects.toMatchObject({
      response: {
        nodeId: 'sub',
        nodeType: 'sub_schema',
        message: expect.stringContaining('не найдена'),
      },
    });
  });
});
