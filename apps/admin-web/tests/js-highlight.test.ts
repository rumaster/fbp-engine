import { describe, expect, it } from 'vitest';

import { escapeHtml, renderHighlightedHtml, tokenizeJs } from '../src/jsHighlight';

describe('подсветка JS-синтаксиса (issue #291)', () => {
  it('сохраняет исходный текст при склейке токенов', () => {
    const code = 'const x = foo(input.value) + 1; // комментарий';
    const joined = tokenizeJs(code)
      .map((token) => token.value)
      .join('');
    expect(joined).toBe(code);
  });

  it('распознаёт ключевые слова', () => {
    const types = tokenizeJs('return input;').filter((token) => token.type === 'keyword');
    expect(types.map((token) => token.value)).toEqual(['return']);
  });

  it('распознаёт литералы-значения', () => {
    const literals = tokenizeJs('x = true || null').filter((token) => token.type === 'literal');
    expect(literals.map((token) => token.value)).toEqual(['true', 'null']);
  });

  it('распознаёт строки во всех видах кавычек', () => {
    const strings = tokenizeJs('a = "d" + \'q\' + `t`').filter((token) => token.type === 'string');
    expect(strings.map((token) => token.value)).toEqual(['"d"', "'q'", '`t`']);
  });

  it('не подсвечивает ключевые слова внутри строк', () => {
    const tokens = tokenizeJs('"return"');
    expect(tokens).toEqual([{ type: 'string', value: '"return"' }]);
  });

  it('обрабатывает экранированные кавычки в строках', () => {
    const tokens = tokenizeJs('"a\\"b"');
    expect(tokens).toEqual([{ type: 'string', value: '"a\\"b"' }]);
  });

  it('распознаёт однострочные и многострочные комментарии', () => {
    const comments = tokenizeJs('// one\n/* two */').filter((token) => token.type === 'comment');
    expect(comments.map((token) => token.value)).toEqual(['// one', '/* two */']);
  });

  it('распознаёт числа, включая hex и дробные', () => {
    const numbers = tokenizeJs('1 + 0xFF + 3.14').filter((token) => token.type === 'number');
    expect(numbers.map((token) => token.value)).toEqual(['1', '0xFF', '3.14']);
  });

  it('экранирует HTML-символы в обычном тексте', () => {
    expect(renderHighlightedHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('экранирует HTML-символы внутри строковых токенов', () => {
    expect(renderHighlightedHtml('"<x>"')).toBe('<span class="tok-string">"&lt;x&gt;"</span>');
  });

  it('оборачивает значимые токены в span с классом токена', () => {
    expect(renderHighlightedHtml('const')).toBe('<span class="tok-keyword">const</span>');
  });

  it('дублирует завершающий перевод строки, чтобы слой совпадал с textarea', () => {
    expect(renderHighlightedHtml('a\n')).toBe('a\n\n');
  });

  it('escapeHtml экранирует амперсанд, угловые скобки', () => {
    expect(escapeHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; "c"');
  });
});
