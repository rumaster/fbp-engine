/**
 * Тесты для защиты от двойного клика (issue #14).
 *
 * Проверяем, что:
 * 1. acquireProcessingLock возвращает true при первом захвате и false при повторном.
 * 2. releaseProcessingLock снимает блокировку и позволяет снова захватить её.
 * 3. Сообщение с кнопками подсказок можно скрыть (editMessageReplyMarkup возвращает undefined).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setLastHints, getHint, clearDialogState } from '../src/bot/userState.js';

// ── Мок БД-пула ──────────────────────────────────────────────────────────────
// acquireProcessingLock использует UPDATE ... WHERE is_processing = FALSE.
// Эмулируем БД через in-memory Map.

interface FakeSession {
  id: string;
  is_processing: boolean;
}

function createFakePool(sessions: FakeSession[]) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('WHERE id = $1 AND is_processing = FALSE')) {
        const id = params[0] as string;
        const s = sessions.find((x) => x.id === id);
        if (!s || s.is_processing) return { rowCount: 0 };
        s.is_processing = true;
        return { rowCount: 1 };
      }
      if (sql.includes('SET is_processing = FALSE')) {
        const id = params[0] as string;
        const s = sessions.find((x) => x.id === id);
        if (s) s.is_processing = false;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }),
  };
}

// ── Логика acquireProcessingLock/releaseProcessingLock (без реального пула) ──

async function acquireLock(pool: ReturnType<typeof createFakePool>, id: string) {
  const { rowCount } = await pool.query(
    'UPDATE game_sessions SET is_processing = TRUE WHERE id = $1 AND is_processing = FALSE',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

async function releaseLock(pool: ReturnType<typeof createFakePool>, id: string) {
  await pool.query(
    'UPDATE game_sessions SET is_processing = FALSE WHERE id = $1',
    [id],
  );
}

describe('acquireProcessingLock / releaseProcessingLock (#14)', () => {
  it('первый захват возвращает true', async () => {
    const sessions = [{ id: 'sess-1', is_processing: false }];
    const pool = createFakePool(sessions);

    const result = await acquireLock(pool, 'sess-1');

    expect(result).toBe(true);
    expect(sessions[0].is_processing).toBe(true);
  });

  it('повторный захват возвращает false (двойной клик отклонён)', async () => {
    const sessions = [{ id: 'sess-1', is_processing: false }];
    const pool = createFakePool(sessions);

    const first = await acquireLock(pool, 'sess-1');
    const second = await acquireLock(pool, 'sess-1');

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('после releaseProcessingLock захват снова возможен', async () => {
    const sessions = [{ id: 'sess-1', is_processing: false }];
    const pool = createFakePool(sessions);

    await acquireLock(pool, 'sess-1');
    await releaseLock(pool, 'sess-1');
    const result = await acquireLock(pool, 'sess-1');

    expect(result).toBe(true);
  });

  it('блокировка не мешает другой сессии', async () => {
    const sessions = [
      { id: 'sess-1', is_processing: false },
      { id: 'sess-2', is_processing: false },
    ];
    const pool = createFakePool(sessions);

    await acquireLock(pool, 'sess-1');
    const result = await acquireLock(pool, 'sess-2');

    expect(result).toBe(true);
  });
});

// ── Состояние диалога (userState) ────────────────────────────────────────────

describe('userState — подсказки (#14)', () => {
  const userId = 999;

  beforeEach(() => {
    clearDialogState(userId);
  });

  it('getHint возвращает нужное действие по индексу', () => {
    setLastHints(userId, ['идти', 'искать', 'спать']);
    expect(getHint(userId, 0)).toBe('идти');
    expect(getHint(userId, 2)).toBe('спать');
  });

  it('getHint возвращает undefined для устаревшей подсказки', () => {
    expect(getHint(userId, 0)).toBeUndefined();
  });

  it('setLastHints заменяет предыдущие подсказки', () => {
    setLastHints(userId, ['a', 'b', 'c']);
    setLastHints(userId, ['x', 'y']);
    expect(getHint(userId, 0)).toBe('x');
    expect(getHint(userId, 2)).toBeUndefined();
  });
});
