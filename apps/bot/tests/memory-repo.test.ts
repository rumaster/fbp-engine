/**
 * Юнит-тесты репозитория ячеек долговременной памяти (issue #166).
 *
 * Проверяем:
 *  1. Схема БД содержит таблицу game_memory_cells с нужными колонками и индексами.
 *  2. insertMemoryCells формирует один многострочный INSERT и маппит результат.
 *  3. listActiveMemoryCells сортирует по важности и свежести.
 *  4. insertMemoryCellsSafely не роняет ход при сбое записи (best-effort).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tg-games/core/db/pool.js', () => ({ getPool: vi.fn() }));

import { getPool } from '@tg-games/core/db/pool.js';
import {
  insertMemoryCells,
  insertMemoryCellsSafely,
  listActiveMemoryCells,
  type NewMemoryCellInput,
} from '@tg-games/core/db/repositories/memoryCells.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

/** Строка таблицы game_memory_cells (как её вернул бы pg). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    session_id: 'sess-1',
    step_id: 'step-1',
    content: 'Мост сожжён.',
    category: 'мир',
    importance: 3,
    turn_created: 4,
    created_at: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

function newInput(overrides: Partial<NewMemoryCellInput> = {}): NewMemoryCellInput {
  return {
    sessionId: 'sess-1',
    stepId: 'step-1',
    content: 'Мост сожжён.',
    category: 'мир',
    importance: 3,
    turnCreated: 4,
    ...overrides,
  };
}

describe('схема game_memory_cells (issue #166)', () => {
  it('создаёт таблицу с нужными колонками и индексами', () => {
    const schema = readFileSync(join(repoRoot, 'packages/core/src/db/schema.sql'), 'utf8');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS game_memory_cells');
    expect(schema).toMatch(/session_id\s+UUID\s+NOT NULL\s+REFERENCES game_sessions/);
    expect(schema).toMatch(/step_id\s+UUID\s+REFERENCES game_steps \(id\) ON DELETE CASCADE/);
    expect(schema).toMatch(/content\s+TEXT\s+NOT NULL/);
    expect(schema).toMatch(/importance\s+SMALLINT\s+NOT NULL\s+DEFAULT 1/);
    expect(schema).toContain('idx_game_memory_cells_session');
    expect(schema).toContain('idx_game_memory_cells_step');
  });
});

describe('insertMemoryCells (issue #166)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('не обращается к БД на пустом входе', async () => {
    const query = vi.fn();
    vi.mocked(getPool).mockReturnValue({ query } as never);
    expect(await insertMemoryCells([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('вставляет ячейки одним многострочным запросом и маппит результат', async () => {
    const query = vi.fn(async () => ({ rows: [row(), row({ id: 'm2' })] }));
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const result = await insertMemoryCells([
      newInput(),
      newInput({ content: 'Старьёвщик ждёт проволоку.', category: 'цели', importance: 2 }),
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    // Один INSERT с двумя группами плейсхолдеров ($1..$6, $7..$12).
    expect(sql).toContain('INSERT INTO game_memory_cells');
    expect(sql).toContain('($1, $2, $3, $4, $5, $6)');
    expect(sql).toContain('($7, $8, $9, $10, $11, $12)');
    expect(params).toHaveLength(12);
    expect(params.slice(0, 6)).toEqual(['sess-1', 'step-1', 'Мост сожжён.', 'мир', 3, 4]);

    // Результат смаппен в доменные ячейки (camelCase).
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'm1', sessionId: 'sess-1', turnCreated: 4 });
  });

  it('подставляет NULL вместо отсутствующего stepId', async () => {
    const query = vi.fn(async () => ({ rows: [row({ step_id: null })] }));
    vi.mocked(getPool).mockReturnValue({ query } as never);

    await insertMemoryCells([newInput({ stepId: null })]);
    const [, params] = query.mock.calls[0];
    expect(params[1]).toBeNull();
  });
});

describe('listActiveMemoryCells (issue #166)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('запрашивает ячейки сессии с сортировкой по важности и свежести', async () => {
    const query = vi.fn(async () => ({ rows: [row(), row({ id: 'm2', importance: 1 })] }));
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const cells = await listActiveMemoryCells('sess-1');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE session_id = $1');
    expect(sql).toContain('ORDER BY importance DESC, turn_created DESC');
    expect(params).toEqual(['sess-1']);
    expect(cells.map((c) => c.id)).toEqual(['m1', 'm2']);
  });
});

describe('insertMemoryCellsSafely (issue #166)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('возвращает пустой список и не пробрасывает ошибку при сбое БД', async () => {
    const query = vi.fn(async () => {
      throw new Error('БД недоступна');
    });
    vi.mocked(getPool).mockReturnValue({ query } as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await insertMemoryCellsSafely([newInput()]);

    expect(result).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
