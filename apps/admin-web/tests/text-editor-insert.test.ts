import { describe, expect, it } from 'vitest';

import { formatInsertSnippet, insertSnippetAtSelection } from '../src/textEditorInsert';

describe('раскрытый редактор текста — вставка портов (issue #285)', () => {
  it('редактор шаблона оборачивает имя входа в {{...}}', () => {
    expect(formatInsertSnippet('state', 'template')).toBe('{{state}}');
  });

  it('редактор кода вставляет голое имя поля', () => {
    expect(formatInsertSnippet('state', 'code')).toBe('state');
  });

  it('вставляет фрагмент в позицию курсора', () => {
    const result = insertSnippetAtSelection('Hello !', '{{name}}', 6, 6);
    expect(result.value).toBe('Hello {{name}}!');
    expect(result.caret).toBe(6 + '{{name}}'.length);
  });

  it('заменяет выделенный диапазон вставляемым фрагментом', () => {
    const result = insertSnippetAtSelection('Hello WORLD!', 'foo', 6, 11);
    expect(result.value).toBe('Hello foo!');
    expect(result.caret).toBe(6 + 3);
  });

  it('добавляет фрагмент в конец, когда позиция выходит за пределы текста', () => {
    const result = insertSnippetAtSelection('abc', 'X', 99, 99);
    expect(result.value).toBe('abcX');
    expect(result.caret).toBe(4);
  });

  it('корректно работает с пустым полем', () => {
    const result = insertSnippetAtSelection('', '{{input}}', 0, 0);
    expect(result.value).toBe('{{input}}');
    expect(result.caret).toBe('{{input}}'.length);
  });
});
