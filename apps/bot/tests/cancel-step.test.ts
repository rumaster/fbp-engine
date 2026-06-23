/**
 * Юнит-тесты отмены хода (issue #116).
 *
 * Проверяем:
 *  1. Схема БД содержит колонки is_cancelled и state_before в game_steps.
 *  2. Репозиторий cancelLastStep помечает последний неотменённый ход и
 *     восстанавливает состояние сессии из снимка state_before.
 *  3. Выгрузка истории (formatHistory) помечает отменённые ходы.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';
import type { GameState } from '@tg-games/core/types.js';

vi.mock('@tg-games/core/db/pool.js', () => ({ getPool: vi.fn() }));

import { getPool } from '@tg-games/core/db/pool.js';
import { cancelLastStep } from '@tg-games/core/db/repositories/steps.js';
import { formatHistory } from '../src/bot/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const sampleState: GameState = {
  location: 'Теплотрасса',
  narrative: 'Вы очнулись.',
  character: { hp: 75, max_hp: 100, skills: {}, inventory: [] },
  world_flags: {},
  world_time: { season: 'осень', date: '14 октября', time: '08:00', time_of_day: 'утро' },
  turn_count: 1,
};

function makeStep(overrides: Partial<StepRow> = {}): StepRow {
  return {
    id: 'step-1',
    session_id: 'sess-1',
    action_text: 'осмотреться',
    llm_raw_response: null,
    changes_summary: 'Вы нашли монету',
    step_credits: 0,
    token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cost_millicents: 0,
    is_cancelled: false,
    state_before: sampleState,
    created_at: new Date('2026-05-27T10:02:00Z'),
    ...overrides,
  };
}

/** Фейковый клиент пула, отвечающий на BEGIN/SELECT/UPDATE/COMMIT. */
function fakeClient(selectRows: StepRow[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM game_steps/.test(sql)) {
      return { rows: selectRows, rowCount: selectRows.length };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { client, calls };
}

describe('схема отмены хода (issue #116)', () => {
  it('добавляет колонки is_cancelled и state_before в game_steps', () => {
    const schema = readFileSync(join(repoRoot, 'packages/core/src/db/schema.sql'), 'utf8');
    expect(schema).toMatch(/is_cancelled\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+FALSE/);
    expect(schema).toMatch(/state_before\s+JSONB/);
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS is_cancelled');
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS state_before');
  });
});

describe('cancelLastStep (issue #116)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('помечает последний ход отменённым и откатывает состояние сессии', async () => {
    const step = makeStep();
    const { client, calls } = fakeClient([step]);
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never);

    const result = await cancelLastStep('sess-1');

    expect(result?.id).toBe('step-1');
    expect(result?.is_cancelled).toBe(true);

    // Ход помечен отменённым.
    const markCall = calls.find((c) => /UPDATE game_steps SET is_cancelled = TRUE/.test(c.sql));
    expect(markCall?.params).toEqual(['step-1']);

    // Состояние сессии восстановлено из снимка state_before.
    const restoreCall = calls.find((c) => /UPDATE game_sessions SET current_state/.test(c.sql));
    expect(restoreCall).toBeDefined();
    expect(restoreCall?.params?.[0]).toBe('sess-1');
    expect(JSON.parse(restoreCall?.params?.[1] as string)).toEqual(sampleState);

    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('удаляет ячейки долговременной памяти отменяемого хода (issue #166)', async () => {
    const step = makeStep();
    const { client, calls } = fakeClient([step]);
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never);

    await cancelLastStep('sess-1');

    const deleteCall = calls.find((c) => /DELETE FROM game_memory_cells/.test(c.sql));
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.params).toEqual(['step-1']);
    // Удаление памяти выполняется до COMMIT, в той же транзакции.
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('не трогает память, когда отменять нечего (issue #166)', async () => {
    const { client, calls } = fakeClient([]);
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never);

    await cancelLastStep('sess-1');

    expect(calls.some((c) => /DELETE FROM game_memory_cells/.test(c.sql))).toBe(false);
  });

  it('возвращает null, когда отменять нечего', async () => {
    const { client, calls } = fakeClient([]);
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never);

    const result = await cancelLastStep('sess-1');

    expect(result).toBeNull();
    expect(calls.some((c) => /UPDATE game_steps/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /UPDATE game_sessions/.test(c.sql))).toBe(false);
  });

  it('не откатывает состояние у старого хода без снимка state_before', async () => {
    const step = makeStep({ state_before: null });
    const { client, calls } = fakeClient([step]);
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never);

    const result = await cancelLastStep('sess-1');

    expect(result?.is_cancelled).toBe(true);
    // Ход помечается отменённым, но состояние сессии не трогаем.
    expect(calls.some((c) => /UPDATE game_steps SET is_cancelled = TRUE/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /UPDATE game_sessions/.test(c.sql))).toBe(false);
  });
});

describe('выгрузка истории помечает отменённые ходы (issue #116)', () => {
  it('помечает отменённый ход и оставляет обычный без пометки', () => {
    const steps: StepRow[] = [
      makeStep({ id: 'a', action_text: 'осмотреться', changes_summary: 'Нашли монету' }),
      makeStep({
        id: 'b',
        action_text: 'ударить стену',
        changes_summary: 'Поранили руку',
        is_cancelled: true,
      }),
    ];

    const text = formatHistory(steps);

    expect(text).toContain('Ход 1. 🎮 осмотреться');
    expect(text).toContain('Ход 2. 🚫 ударить стену (отменён)');
    // Отменённый ход всё равно присутствует в выгрузке вместе с итогом.
    expect(text).toContain('Поранили руку');
  });
});
