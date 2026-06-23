// Лёгкая подсветка JS-синтаксиса для раскрытого редактора кода (issue #291).
// Реализована без внешних зависимостей: маленький токенизатор разбивает исходник
// на типизированные токены, а renderHighlightedHtml превращает их в безопасный HTML
// со span'ами. Логика вынесена в чистые функции, чтобы покрыть её юнит-тестами.

export type TokenType =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'plain';

export interface JsToken {
  type: TokenType;
  value: string;
}

// Ключевые слова языка (управляющие конструкции, объявления, модификаторы).
const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super',
  'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield',
]);

// Литералы-значения подсвечиваются отдельным цветом.
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

const isIdentifierStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch);
const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

// Разбивает исходный JS-код на токены. Конкатенация value всех токенов равна
// исходной строке — это инвариант, на котором держится корректность подсветки.
export function tokenizeJs(code: string): JsToken[] {
  const tokens: JsToken[] = [];
  let plain = '';
  const flushPlain = () => {
    if (plain) {
      tokens.push({ type: 'plain', value: plain });
      plain = '';
    }
  };

  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = i + 1 < n ? code[i + 1] : '';

    // Однострочный комментарий.
    if (ch === '/' && next === '/') {
      flushPlain();
      let j = i + 2;
      while (j < n && code[j] !== '\n') j += 1;
      tokens.push({ type: 'comment', value: code.slice(i, j) });
      i = j;
      continue;
    }

    // Многострочный комментарий.
    if (ch === '/' && next === '*') {
      flushPlain();
      let j = i + 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j += 1;
      j = j < n ? j + 2 : n;
      tokens.push({ type: 'comment', value: code.slice(i, j) });
      i = j;
      continue;
    }

    // Строки: одинарные, двойные кавычки и шаблонные литералы.
    if (ch === '"' || ch === "'" || ch === '`') {
      flushPlain();
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ type: 'string', value: code.slice(i, j) });
      i = j;
      continue;
    }

    // Числа (включая hex/bin/oct, экспоненту и BigInt-суффикс).
    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      flushPlain();
      const rest = code.slice(i);
      const match = rest.match(
        /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)n?/,
      );
      const value = match ? match[0] : ch;
      tokens.push({ type: 'number', value });
      i += value.length;
      continue;
    }

    // Идентификаторы: ключевые слова, литералы или обычный текст.
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentifierPart(code[j])) j += 1;
      const word = code.slice(i, j);
      if (KEYWORDS.has(word)) {
        flushPlain();
        tokens.push({ type: 'keyword', value: word });
      } else if (LITERALS.has(word)) {
        flushPlain();
        tokens.push({ type: 'literal', value: word });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

// Экранирует символы, опасные при вставке текста в HTML.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Собирает HTML с подсветкой. Обычный текст вставляется без обёртки, а значимые
// токены — в span с классом tok-<type>. Завершающий перевод строки дублируется,
// чтобы последняя пустая строка не схлопывалась в <pre> и слой совпадал с textarea.
export function renderHighlightedHtml(code: string): string {
  const html = tokenizeJs(code)
    .map((token) =>
      token.type === 'plain'
        ? escapeHtml(token.value)
        : `<span class="tok-${token.type}">${escapeHtml(token.value)}</span>`,
    )
    .join('');
  return code.endsWith('\n') ? `${html}\n` : html;
}
