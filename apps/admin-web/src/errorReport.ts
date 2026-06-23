// Форматирование отчёта об ошибке интерфейса в Markdown, готовый к копированию
// прямо в задачу на доработку (issue #230). Чистая функция без обращений к
// глобальному состоянию (location/Date передаются аргументами), чтобы её можно
// было детерминированно покрыть unit-тестами.

export interface ErrorReportInput {
  // Человекочитаемое сообщение об ошибке.
  message: string;
  // Стек вызова (error.stack), если доступен.
  stack?: string;
  // Стек React-компонентов из componentDidCatch, если ошибка из рендера.
  componentStack?: string;
  // Где произошла ошибка (например, «Редактор схем»).
  scope?: string;
  // Откуда поймана: render, window.error, unhandledrejection.
  source?: string;
  // Адрес страницы (window.location.href).
  href?: string;
  // Метка времени в ISO-формате (new Date().toISOString()).
  time?: string;
}

// Безвредные «ошибки», которые браузер шлёт как window 'error', но настоящими
// сбоями не являются и не должны поднимать рамку. Главный источник — ReactFlow,
// который активно использует ResizeObserver и штатно роняет это предупреждение
// (см. https://stackoverflow.com/q/49384120). Список держим узким, чтобы реальные
// ошибки вроде «Minified React error #185» по-прежнему доходили до пользователя.
const IGNORABLE_ERROR_PATTERNS = [
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed with undelivered notifications/i,
];

export function isIgnorableErrorMessage(message: string | undefined | null): boolean {
  const text = (message ?? '').trim();
  if (!text) return false;
  return IGNORABLE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function fence(content: string): string {
  // Длина ограждения должна превышать самую длинную последовательность бэктиков
  // внутри текста, иначе блок кода «порвётся» (важно для минифицированных стеков).
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${content.replace(/\s+$/, '')}\n${ticks}`;
}

function trimOrFallback(value: string | undefined): string {
  return (value ?? '').trim();
}

// Собирает Markdown-отчёт. Пустые секции опускаются, чтобы отчёт оставался
// компактным и пригодным для вставки в issue/PR.
export function formatErrorReport(input: ErrorReportInput): string {
  const message = trimOrFallback(input.message) || 'Неизвестная ошибка';
  const lines: string[] = ['## Ошибка интерфейса', '', `**Сообщение:** ${message}`];

  const scope = trimOrFallback(input.scope);
  if (scope) lines.push(`**Где:** ${scope}`);

  const source = trimOrFallback(input.source);
  if (source) lines.push(`**Источник:** ${source}`);

  const href = trimOrFallback(input.href);
  if (href) lines.push(`**Адрес:** ${href}`);

  const time = trimOrFallback(input.time);
  if (time) lines.push(`**Время:** ${time}`);

  const stack = trimOrFallback(input.stack);
  if (stack && stack !== message) {
    lines.push('', '**Стек:**', fence(stack));
  }

  const componentStack = trimOrFallback(input.componentStack);
  if (componentStack) {
    lines.push('', '**Стек компонентов:**', fence(componentStack));
  }

  return lines.join('\n');
}
