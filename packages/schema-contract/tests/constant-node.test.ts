import { describe, it, expect } from 'vitest';
// @ts-expect-error — пакет на чистом ESM без локальных типов в тесте.
import {
  NODE_TYPES,
  BASE_NODE_PALETTE,
  DATA_ONLY_NODE_TYPES,
  CONSTANT_PORT_TYPES,
  NODE_TYPE_LABELS,
  getNodePortDefinitions,
  validateSchemaGraphContract,
  SchemaContractError,
} from '../index.mjs';

/**
 * Поведенческие тесты узла constant (issue #319): регистрация типа,
 * порты, DATA_ONLY, валидация конфига.
 */

describe('constant node (issue #319)', () => {
  it("'constant' зарегистрирован в NODE_TYPES", () => {
    expect(NODE_TYPES).toContain('constant');
  });

  it("'constant' есть в BASE_NODE_PALETTE", () => {
    expect(BASE_NODE_PALETTE).toContain('constant');
  });

  it("'constant' есть в DATA_ONLY_NODE_TYPES", () => {
    expect(DATA_ONLY_NODE_TYPES).toContain('constant');
  });

  it('CONSTANT_PORT_TYPES содержит нужные типы и не содержит exec/any', () => {
    expect(CONSTANT_PORT_TYPES).toContain('string');
    expect(CONSTANT_PORT_TYPES).toContain('number');
    expect(CONSTANT_PORT_TYPES).toContain('boolean');
    expect(CONSTANT_PORT_TYPES).toContain('object');
    expect(CONSTANT_PORT_TYPES).toContain('string_array');
    expect(CONSTANT_PORT_TYPES).toContain('object_array');
    expect(CONSTANT_PORT_TYPES).not.toContain('exec');
    expect(CONSTANT_PORT_TYPES).not.toContain('any');
  });

  it('NODE_TYPE_LABELS содержит метку для constant', () => {
    expect(NODE_TYPE_LABELS.constant).toBe('Constant');
  });

  it('getNodePortDefinitions: нет входов, выходы берутся из config.outputs', () => {
    const node = {
      id: 'constant-1',
      type: 'constant',
      position: { x: 0, y: 0 },
      config: {
        outputs: [
          { name: 'greeting', type: 'string', value: 'Hello' },
          { name: 'count', type: 'number', value: '42' },
        ],
      },
    };
    const { inputs, outputs } = getNodePortDefinitions(node);
    expect(inputs).toHaveLength(0);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ id: 'greeting', type: 'string', direction: 'output' });
    expect(outputs[1]).toMatchObject({ id: 'count', type: 'number', direction: 'output' });
  });

  it('getNodePortDefinitions: пустой конфиг даёт один выход value:string', () => {
    const node = {
      id: 'constant-1',
      type: 'constant',
      position: { x: 0, y: 0 },
      config: {},
    };
    const { inputs, outputs } = getNodePortDefinitions(node);
    expect(inputs).toHaveLength(0);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ id: 'value', type: 'string', direction: 'output' });
  });

  it('getNodePortDefinitions: неизвестный тип порта сводится к string', () => {
    const node = {
      id: 'constant-1',
      type: 'constant',
      position: { x: 0, y: 0 },
      config: { outputs: [{ name: 'x', type: 'unknown_type', value: '' }] },
    };
    const { outputs } = getNodePortDefinitions(node);
    expect(outputs[0]).toMatchObject({ id: 'x', type: 'string' });
  });

  it('validateSchemaGraphContract: constant-узел в схеме без ошибок', () => {
    const graph = {
      version: 1,
      schemaType: 'action',
      slug: 'test-constant',
      nodes: [
        { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'end-1', type: 'end', position: { x: 200, y: 0 }, config: {} },
        {
          id: 'constant-1',
          type: 'constant',
          position: { x: 100, y: 100 },
          config: { outputs: [{ name: 'greeting', type: 'string', value: 'hi' }] },
        },
      ],
      edges: [
        { id: 'e1', from: 'start-1', fromPort: 'exec', to: 'end-1', toPort: 'exec' },
      ],
      variables: {},
    };
    expect(() => validateSchemaGraphContract(graph)).not.toThrow();
  });

  it('validateSchemaGraphContract: дублирующийся порт бросает ошибку', () => {
    const graph = {
      version: 1,
      schemaType: 'action',
      slug: 'test-constant-dup',
      nodes: [
        { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'end-1', type: 'end', position: { x: 200, y: 0 }, config: {} },
        {
          id: 'constant-1',
          type: 'constant',
          position: { x: 100, y: 100 },
          config: {
            outputs: [
              { name: 'dup', type: 'string', value: 'a' },
              { name: 'dup', type: 'number', value: '1' },
            ],
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'start-1', fromPort: 'exec', to: 'end-1', toPort: 'exec' },
      ],
      variables: {},
    };
    expect(() => validateSchemaGraphContract(graph)).toThrow(SchemaContractError);
  });
});
