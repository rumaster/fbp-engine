/**
 * Юнит-тесты репозитория обращений поддержки в части статуса `escalated`
 * (issue #244). Проверяем:
 *  1. Схема БД объявляет статус `escalated` и активный индекс по open+escalated.
 *  2. getOrCreateActiveTicket считает активными open и escalated.
 *  3. markTicketEscalated переводит open → escalated идемпотентно.
 *  4. listActiveTicketsForAdmin показывает только escalated.
 *  5. closeTicket закрывает только escalated, autoCloseTicket — только open.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tg-games/core/db/pool.js', () => ({ getPool: vi.fn() }));

import { getPool } from '@tg-games/core/db/pool.js';
import {
  autoCloseTicket,
  closeTicket,
  getOrCreateActiveTicket,
  listActiveTicketsForAdmin,
  markTicketEscalated,
} from '@tg-games/core/db/repositories/support.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

/** Мок pool.query, возвращающий заданные строки. */
function mockQuery(rows: unknown[] = []) {
  const query = vi.fn(async () => ({ rows }));
  vi.mocked(getPool).mockReturnValue({ query } as never);
  return query;
}

/** Мок pool.connect() для транзакционных методов. */
function mockClient(selectRows: unknown[], insertRows: unknown[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT')) return { rows: selectRows };
    if (sql.startsWith('INSERT')) return { rows: insertRows };
    return { rows: [] };
  });
  const release = vi.fn();
  vi.mocked(getPool).mockReturnValue({
    connect: vi.fn(async () => ({ query, release })),
  } as never);
  return query;
}

describe('схема статусов обращений (issue #244)', () => {
  const schema = readFileSync(join(repoRoot, 'packages/core/src/db/schema.sql'), 'utf8');

  it('объявляет статус escalated в enum', () => {
    expect(schema).toContain("'open', 'escalated', 'closed', 'auto_closed'");
  });

  it('идемпотентно добавляет escalated к существующему enum', () => {
    expect(schema).toContain("ALTER TYPE support_ticket_status ADD VALUE 'escalated'");
  });

  it('активный индекс покрывает оба статуса open и escalated', () => {
    expect(schema).toMatch(/CREATE UNIQUE INDEX[^;]+WHERE status IN \('open', 'escalated'\)/s);
  });
});

describe('getOrCreateActiveTicket (issue #244)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('считает активными обращения в статусах open и escalated', async () => {
    const query = mockClient([{ id: 't1', status: 'escalated' }], []);
    const { ticket, created } = await getOrCreateActiveTicket('user-1');
    expect(created).toBe(false);
    expect(ticket.id).toBe('t1');
    const selectSql = query.mock.calls.find((c) => String(c[0]).startsWith('SELECT'))?.[0];
    expect(String(selectSql)).toContain("status IN ('open', 'escalated')");
  });
});

describe('markTicketEscalated (issue #244)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('переводит open → escalated, не сдвигая существующий момент эскалации', async () => {
    const query = mockQuery([]);
    await markTicketEscalated('t1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("SET status = 'escalated'");
    expect(sql).toContain('escalated_at = COALESCE(escalated_at, now())');
    expect(sql).toContain("WHERE id = $1 AND status = 'open'");
    expect(params).toEqual(['t1']);
  });
});

describe('listActiveTicketsForAdmin (issue #244)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('показывает администратору только переданные оператору обращения', async () => {
    const query = mockQuery([]);
    await listActiveTicketsForAdmin('admin-1');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("WHERE t.status = 'escalated'");
  });
});

describe('закрытие обращений (issue #244)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closeTicket закрывает только переданные оператору обращения', async () => {
    const query = mockQuery([{ id: 't1', status: 'closed' }]);
    await closeTicket('t1');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("SET status = 'closed'");
    expect(sql).toContain("WHERE id = $1 AND status = 'escalated'");
  });

  it('autoCloseTicket закрывает обращение только на стадии консультации', async () => {
    const query = mockQuery([{ id: 't1', status: 'auto_closed' }]);
    await autoCloseTicket('t1');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("SET status = 'auto_closed'");
    expect(sql).toContain("WHERE id = $1 AND status = 'open'");
  });
});
