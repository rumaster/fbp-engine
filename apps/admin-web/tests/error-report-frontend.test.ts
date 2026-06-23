import { describe, expect, it } from 'vitest';

import { formatErrorReport, isIgnorableErrorMessage } from '../src/errorReport';

// Отчёт об ошибке интерфейса (issue #230): проверяем, что формат пригоден для
// прямой вставки в задачу на доработку — Markdown с сообщением, контекстом и
// корректно ограждёнными блоками стека.
describe('formatErrorReport', () => {
  it('собирает полный отчёт со всеми секциями', () => {
    const report = formatErrorReport({
      message: 'Minified React error #185',
      stack: 'Error: #185\n    at ni (index.js:8:27493)',
      componentStack: '\n    at BlueprintNode\n    at ReactFlow',
      scope: 'Редактор схем',
      source: 'Рендер React',
      href: 'http://localhost/#/schemas/action',
      time: '2026-06-14T10:00:00.000Z',
    });

    expect(report).toContain('## Ошибка интерфейса');
    expect(report).toContain('**Сообщение:** Minified React error #185');
    expect(report).toContain('**Где:** Редактор схем');
    expect(report).toContain('**Источник:** Рендер React');
    expect(report).toContain('**Адрес:** http://localhost/#/schemas/action');
    expect(report).toContain('**Время:** 2026-06-14T10:00:00.000Z');
    expect(report).toContain('**Стек:**');
    expect(report).toContain('at ni (index.js:8:27493)');
    expect(report).toContain('**Стек компонентов:**');
    expect(report).toContain('at BlueprintNode');
  });

  it('опускает пустые секции', () => {
    const report = formatErrorReport({ message: 'Просто ошибка' });
    expect(report).toContain('**Сообщение:** Просто ошибка');
    expect(report).not.toContain('**Где:**');
    expect(report).not.toContain('**Стек:**');
    expect(report).not.toContain('**Стек компонентов:**');
  });

  it('подставляет заглушку для пустого сообщения', () => {
    expect(formatErrorReport({ message: '   ' })).toContain('**Сообщение:** Неизвестная ошибка');
  });

  it('не дублирует стек, повторяющий сообщение', () => {
    const report = formatErrorReport({ message: 'boom', stack: 'boom' });
    expect(report).not.toContain('**Стек:**');
  });

  it('расширяет ограждение, если в стеке есть тройные бэктики', () => {
    const stack = 'line with ``` triple ticks';
    const report = formatErrorReport({ message: 'm', stack });
    // Ограждение длиннее любой последовательности бэктиков внутри содержимого,
    // поэтому блок кода не «рвётся».
    expect(report).toContain('````');
    expect(report).toContain(stack);
  });
});

describe('isIgnorableErrorMessage', () => {
  it('игнорирует benign-предупреждения ResizeObserver (источник — ReactFlow)', () => {
    expect(isIgnorableErrorMessage('ResizeObserver loop limit exceeded')).toBe(true);
    expect(
      isIgnorableErrorMessage('ResizeObserver loop completed with undelivered notifications.'),
    ).toBe(true);
  });

  it('не игнорирует настоящие ошибки', () => {
    expect(isIgnorableErrorMessage('Minified React error #185')).toBe(false);
    expect(isIgnorableErrorMessage('')).toBe(false);
    expect(isIgnorableErrorMessage(null)).toBe(false);
    expect(isIgnorableErrorMessage(undefined)).toBe(false);
  });
});
