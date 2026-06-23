/**
 * Эфемерное состояние диалога пользователя (в памяти процесса).
 *
 * Хранит лишь временный контекст шага — последние показанные подсказки,
 * чтобы по клику на кнопку восстановить текст действия. Игровое состояние
 * и указатель активной игры живут в БД.
 *
 * Для горизонтального масштабирования это хранилище следует вынести
 * в Redis; для одного инстанса бота памяти достаточно.
 */
export interface DialogState {
  lastHints: string[];
  pendingTopUpAction?: PendingTopUpAction;
}

export interface PendingTopUpAction {
  sessionId: string;
  actionText: string;
}

const store = new Map<number, DialogState>();

function ensure(telegramId: number): DialogState {
  let s = store.get(telegramId);
  if (!s) {
    s = { lastHints: [] };
    store.set(telegramId, s);
  }
  return s;
}

/** Сохраняет показанные подсказки для последующего клика по кнопке. */
export function setLastHints(telegramId: number, hints: string[]): void {
  ensure(telegramId).lastHints = hints;
}

/** Возвращает подсказку по индексу или undefined. */
export function getHint(telegramId: number, index: number): string | undefined {
  return ensure(telegramId).lastHints[index];
}

/** Запоминает действие, которое нужно выполнить после пополнения кредитов. */
export function setPendingTopUpAction(
  telegramId: number,
  sessionId: string,
  actionText: string,
): void {
  ensure(telegramId).pendingTopUpAction = { sessionId, actionText };
}

/** Возвращает ожидающее действие для сессии или undefined. */
export function getPendingTopUpAction(
  telegramId: number,
  sessionId: string,
): PendingTopUpAction | undefined {
  const pending = ensure(telegramId).pendingTopUpAction;
  return pending?.sessionId === sessionId ? pending : undefined;
}

/** Очищает ожидающее действие после пополнения или если пополнение невозможно. */
export function clearPendingTopUpAction(telegramId: number, sessionId?: string): void {
  const state = ensure(telegramId);
  if (sessionId && state.pendingTopUpAction?.sessionId !== sessionId) return;
  delete state.pendingTopUpAction;
}

/** Полностью сбрасывает состояние пользователя (используется в тестах). */
export function clearDialogState(telegramId: number): void {
  store.delete(telegramId);
}
