import { describe, expect, it } from 'vitest';

import { testInputFields } from '../src/schemaGraph';
import type { SchemaType } from '../src/schemaGraph';
import {
  helpTopicForField,
  SCHEMA_TEST_HELP,
  type SchemaHelpTopic,
} from '../src/schemaTestHelp';

const SCHEMA_TYPES: SchemaType[] = ['action', 'hint', 'illustration', 'support'];

function assertValidTopic(topic: SchemaHelpTopic): void {
  expect(topic.title.length).toBeGreaterThan(0);
  expect(topic.description.length).toBeGreaterThan(0);
  for (const paragraph of topic.description) {
    expect(paragraph.length).toBeGreaterThan(0);
  }
  expect(topic.examples.length).toBeGreaterThan(0);
  for (const example of topic.examples) {
    expect(example.caption.length).toBeGreaterThan(0);
    // Каждый пример обязан быть валидным JSON, чтобы оператор мог его скопировать.
    expect(() => JSON.parse(example.json)).not.toThrow();
  }
}

describe('справка по структурам теста схемы (issue #306)', () => {
  it('содержит разделы для history, supportHistory и inputs', () => {
    expect(Object.keys(SCHEMA_TEST_HELP).sort()).toEqual(
      ['history', 'inputs', 'supportHistory'].sort(),
    );
  });

  it('у каждого раздела есть описание и валидные JSON-примеры', () => {
    for (const topic of Object.values(SCHEMA_TEST_HELP)) {
      assertValidTopic(topic);
    }
  });

  it('помечает каждое JSON-поле теста справкой', () => {
    for (const schemaType of SCHEMA_TYPES) {
      for (const field of testInputFields(schemaType)) {
        if (field.kind !== 'json') continue;
        const topic = helpTopicForField(field.key);
        expect(topic, `нет справки для JSON-поля ${field.key}`).toBeDefined();
        // Заголовок справки совпадает с лейблом поля, чтобы подсказка была узнаваема.
        expect(topic?.title).toBe(field.label);
      }
    }
  });

  it('возвращает undefined для поля без справки', () => {
    expect(helpTopicForField('action')).toBeUndefined();
    expect(helpTopicForField('does_not_exist')).toBeUndefined();
  });

  it('раздел inputs объясняет мокание отдельных узлов через mockResponses', () => {
    const inputs = SCHEMA_TEST_HELP.inputs;
    const text = inputs.description.join(' ');
    expect(text).toContain('mockResponses');
    // В примерах раздела inputs должен быть mockResponses, чтобы показать мокание.
    const withMock = inputs.examples.filter((example) =>
      example.json.includes('mockResponses'),
    );
    expect(withMock.length).toBeGreaterThan(0);
  });
});
