import { describe, it, expect } from 'vitest';
// @ts-expect-error — пакет на чистом ESM без локальных типов в тесте.
import {
  SUB_SCHEMA_CLASSES,
  isSubSchemaClass,
  isSubSchemaGraph,
  subSchemaClassLabel,
  graphPaletteKind,
  isSubSchemaUsableIn,
  getNodePaletteForSchema,
  isNodeTypeAllowedInSchema,
  boundaryStartPorts,
  boundaryEndPorts,
  subSchemaNodePorts,
  validateSchemaGraphContract,
  SchemaContractError,
} from '../index.mjs';

/**
 * Поведенческие тесты модели суб-схем контракта (issue #310): классы, граничные
 * порты, палитра по классу, XOR-дискриминатор и строгая валидация. Дополняют
 * тест-страж синхронности (schema-contract-sync.test.ts) проверкой логики.
 */

interface BoundaryPort {
  id: string;
  label?: string;
  type: string;
}

function subGraph(options: {
  subSchemaClass?: string;
  startOutputs?: BoundaryPort[];
  endInputs?: BoundaryPort[];
  extraNodes?: unknown[];
  schemaType?: string;
  gameId?: string;
} = {}): Record<string, unknown> {
  const {
    startOutputs = [],
    endInputs = [],
    extraNodes = [],
    schemaType,
    gameId,
  } = options;
  // Явно переданный `undefined` должен означать «без класса» (пайплайн); дефолт
  // применяем только когда ключ вовсе не задан — иначе сработал бы дефолт
  // деструктуризации и пайплайн-граф получил бы subSchemaClass.
  const subSchemaClass = 'subSchemaClass' in options ? options.subSchemaClass : 'game';
  return {
    version: 1,
    ...(schemaType ? { schemaType } : {}),
    ...(subSchemaClass ? { subSchemaClass } : {}),
    slug: 'sub_example',
    ...(gameId ? { gameId } : {}),
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { outputs: startOutputs } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, config: { inputs: endInputs } },
      ...extraNodes,
    ],
    edges: [{ id: 'e', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' }],
    variables: {},
  };
}

describe('контракт суб-схем (issue #310)', () => {
  it('SUB_SCHEMA_CLASSES = game/support/common и предикат с метками', () => {
    expect(SUB_SCHEMA_CLASSES).toEqual(['game', 'support', 'common']);
    for (const cls of SUB_SCHEMA_CLASSES) expect(isSubSchemaClass(cls)).toBe(true);
    expect(isSubSchemaClass('action')).toBe(false);
    expect(isSubSchemaClass('unknown')).toBe(false);
    expect(subSchemaClassLabel('game')).toBe('Игровая');
    expect(subSchemaClassLabel('support')).toBe('Поддержка');
    expect(subSchemaClassLabel('common')).toBe('Общая');
  });

  it('isSubSchemaGraph и graphPaletteKind различают суб-схему и пайплайн', () => {
    const sub = subGraph({ subSchemaClass: 'support' });
    const pipeline = subGraph({ subSchemaClass: undefined, schemaType: 'action' });
    expect(isSubSchemaGraph(sub)).toBe(true);
    expect(isSubSchemaGraph(pipeline)).toBe(false);
    expect(graphPaletteKind(sub)).toBe('support');
    expect(graphPaletteKind(pipeline)).toBe('action');
  });

  it('граничные порты суб-схемы читаются из config узлов start/end', () => {
    const graph = subGraph({
      startOutputs: [
        { id: 'value', label: 'Значение', type: 'number' },
        { id: 'prompt', label: 'Запрос', type: 'string' },
      ],
      endInputs: [{ id: 'result', label: 'Итог', type: 'string' }],
    });
    expect(boundaryStartPorts(graph)).toEqual([
      { id: 'value', label: 'Значение', type: 'number' },
      { id: 'prompt', label: 'Запрос', type: 'string' },
    ]);
    expect(boundaryEndPorts(graph)).toEqual([{ id: 'result', label: 'Итог', type: 'string' }]);
  });

  it('boundaryPortRows отбрасывает невалидные и дублирующиеся записи', () => {
    const graph = subGraph({
      startOutputs: [
        { id: 'ok', type: 'string' },
        { id: 'ok', type: 'number' }, // дубль id — отбрасывается
        { id: 'плохой id', type: 'string' }, // невалидный id
        { id: 'exec_port', type: 'exec' }, // exec запрещён как граничный
        { id: 'noType' }, // нет типа
      ] as BoundaryPort[],
    });
    expect(boundaryStartPorts(graph)).toEqual([{ id: 'ok', label: 'ok', type: 'string' }]);
  });

  it('subSchemaNodePorts: снимок config.ports и приоритет инлайн-графа', () => {
    // Снимок портов, который редактор кэширует при выборе slug.
    const fromSnapshot = subSchemaNodePorts({
      type: 'sub_schema',
      config: {
        ports: {
          inputs: [{ id: 'value', label: 'Знач', type: 'number' }],
          outputs: [{ id: 'result', label: 'Рез', type: 'string' }],
        },
      },
    });
    expect(fromSnapshot.inputs).toEqual([{ id: 'value', label: 'Знач', type: 'number' }]);
    expect(fromSnapshot.outputs).toEqual([{ id: 'result', label: 'Рез', type: 'string' }]);

    // Инлайн-граф приоритетнее снимка.
    const inline = subGraph({
      startOutputs: [{ id: 'a', type: 'number' }],
      endInputs: [{ id: 'b', type: 'string' }],
    });
    const fromInline = subSchemaNodePorts({
      type: 'sub_schema',
      config: { graph: inline, ports: { inputs: [{ id: 'ignored', type: 'string' }], outputs: [] } },
    });
    expect(fromInline.inputs).toEqual([{ id: 'a', label: 'a', type: 'number' }]);
    expect(fromInline.outputs).toEqual([{ id: 'b', label: 'b', type: 'string' }]);
  });

  it('палитра узлов по классу: common = пересечение game и support', () => {
    const game = new Set(getNodePaletteForSchema('game'));
    const support = new Set(getNodePaletteForSchema('support'));
    const common = new Set(getNodePaletteForSchema('common'));

    // game допускает запись состояния игры, support — нет; common — тоже нет.
    expect(isNodeTypeAllowedInSchema('game', 'game_state_write')).toBe(true);
    expect(isNodeTypeAllowedInSchema('support', 'game_state_write')).toBe(false);
    expect(isNodeTypeAllowedInSchema('common', 'game_state_write')).toBe(false);
    // support допускает чтение истории поддержки, game — нет; common — нет.
    expect(isNodeTypeAllowedInSchema('support', 'support_history_read')).toBe(true);
    expect(isNodeTypeAllowedInSchema('game', 'support_history_read')).toBe(false);
    expect(isNodeTypeAllowedInSchema('common', 'support_history_read')).toBe(false);

    // common = пересечение: всё, что в common, есть и в game, и в support.
    for (const nodeType of common) {
      expect(game.has(nodeType), `${nodeType} должен быть в палитре game`).toBe(true);
      expect(support.has(nodeType), `${nodeType} должен быть в палитре support`).toBe(true);
    }
  });

  it('isSubSchemaUsableIn: common — отовсюду, game/support — только из своего домена', () => {
    // common доступна из любого контекста.
    for (const caller of ['action', 'hint', 'illustration', 'support', 'game', 'common']) {
      expect(isSubSchemaUsableIn('common', caller)).toBe(true);
    }
    // game-суб-схема — только из игрового домена (action/hint/illustration/game).
    expect(isSubSchemaUsableIn('game', 'action')).toBe(true);
    expect(isSubSchemaUsableIn('game', 'hint')).toBe(true);
    expect(isSubSchemaUsableIn('game', 'game')).toBe(true);
    expect(isSubSchemaUsableIn('game', 'support')).toBe(false);
    // support-суб-схема — только из контекста поддержки.
    expect(isSubSchemaUsableIn('support', 'support')).toBe(true);
    expect(isSubSchemaUsableIn('support', 'action')).toBe(false);
  });

  describe('валидация контракта суб-схемы', () => {
    it('валидная суб-схема проходит', () => {
      expect(() => validateSchemaGraphContract(subGraph())).not.toThrow();
    });

    it('узел manifest без gameId допустим (нет требования привязки к игре)', () => {
      const graph = subGraph({
        subSchemaClass: 'game',
        extraNodes: [{ id: 'm', type: 'manifest', position: { x: 100, y: 100 }, config: {} }],
      });
      // gameId не задан — суб-схема работает на манифесте вызывающей игры.
      expect(graph.gameId).toBeUndefined();
      expect(() => validateSchemaGraphContract(graph)).not.toThrow();
    });

    it('одновременно schemaType и subSchemaClass → invalid_sub_schema_class', () => {
      const graph = subGraph({ subSchemaClass: 'game', schemaType: 'action' });
      expect(() => validateSchemaGraphContract(graph)).toThrow(SchemaContractError);
      try {
        validateSchemaGraphContract(graph);
      } catch (err) {
        expect((err as InstanceType<typeof SchemaContractError>).code).toBe('invalid_sub_schema_class');
      }
    });

    it('узел, запрещённый классом, → node_type_blocked', () => {
      const graph = subGraph({
        subSchemaClass: 'support',
        extraNodes: [{ id: 'w', type: 'game_state_write', position: { x: 100, y: 100 }, config: {} }],
      });
      try {
        validateSchemaGraphContract(graph);
        throw new Error('ожидалась ошибка контракта');
      } catch (err) {
        expect((err as InstanceType<typeof SchemaContractError>).code).toBe('node_type_blocked');
      }
    });

    it('некорректный id граничного порта → invalid_boundary_port_id', () => {
      const graph = subGraph({ startOutputs: [{ id: 'bad id!', type: 'string' }] });
      try {
        validateSchemaGraphContract(graph);
        throw new Error('ожидалась ошибка контракта');
      } catch (err) {
        expect((err as InstanceType<typeof SchemaContractError>).code).toBe('invalid_boundary_port_id');
      }
    });

    it('exec как тип граничного порта → invalid_boundary_port_type', () => {
      const graph = subGraph({ endInputs: [{ id: 'result', type: 'exec' }] });
      try {
        validateSchemaGraphContract(graph);
        throw new Error('ожидалась ошибка контракта');
      } catch (err) {
        expect((err as InstanceType<typeof SchemaContractError>).code).toBe('invalid_boundary_port_type');
      }
    });

    it('дубль id граничного порта → duplicate_boundary_port', () => {
      const graph = subGraph({
        startOutputs: [
          { id: 'value', type: 'string' },
          { id: 'value', type: 'number' },
        ],
      });
      try {
        validateSchemaGraphContract(graph);
        throw new Error('ожидалась ошибка контракта');
      } catch (err) {
        expect((err as InstanceType<typeof SchemaContractError>).code).toBe('duplicate_boundary_port');
      }
    });
  });
});
