// Вспомогательные чистые функции для раскрытого редактора текста (issue #285).
// Вынесены отдельно от React-компонента, чтобы покрыть логику вставки юнит-тестами.

export type InsertMode = 'template' | 'code';

// Формат вставляемого фрагмента: редактор шаблона оборачивает имя входа в {{...}},
// редактор кода вставляет голое имя поля.
export function formatInsertSnippet(name: string, mode: InsertMode): string {
  return mode === 'template' ? `{{${name}}}` : name;
}

export interface InsertResult {
  value: string;
  caret: number;
}

// Вставляет фрагмент в позицию курсора (выделение от start до end заменяется).
// Возвращает новый текст и позицию курсора сразу после вставки.
export function insertSnippetAtSelection(
  value: string,
  snippet: string,
  start: number,
  end: number,
): InsertResult {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return {
    value: value.slice(0, from) + snippet + value.slice(to),
    caret: from + snippet.length,
  };
}
