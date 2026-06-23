import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Neo4jMigration, PostgresMigration } from '@tg-games/core/db/migrator.js';

/**
 * Тесты версионного раннера миграций (issue #336).
 *
 * Раннер инжектирует список миграций из `registry.js`, который мокируем —
 * благодаря этому проверяем именно поведение раннера без зависимости от
 * реальной (Postgres-only baseline-)схемы.
 *
 * `vi.mock` поднимается выше объявлений верхнего уровня, поэтому массивы
 * миграций и vi.fn-моки заводим через `vi.hoisted` — иначе фабрики
 * обращаются к переменным до их инициализации (Temporal Dead Zone).
 */

const {
  poolQueryMock,
  clientQueryMock,
  clientReleaseMock,
  poolConnectMock,
  neo4jReadMock,
  neo4jWriteMock,
  postgresMigrations,
  neo4jMigrations,
} = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const clientReleaseMock = vi.fn();
  return {
    poolQueryMock: vi.fn(),
    clientQueryMock,
    clientReleaseMock,
    poolConnectMock: vi.fn(async () => ({
      query: clientQueryMock,
      release: clientReleaseMock,
    })),
    neo4jReadMock: vi.fn(),
    neo4jWriteMock: vi.fn(),
    postgresMigrations: [] as PostgresMigration[],
    neo4jMigrations: [] as Neo4jMigration[],
  };
});

vi.mock('@tg-games/core/db/pool.js', () => ({
  getPool: () => ({ query: poolQueryMock, connect: poolConnectMock }),
}));

vi.mock('@tg-games/core/db/neo4j.js', () => ({
  runNeo4jRead: (work: Parameters<typeof neo4jReadMock>[0]) => neo4jReadMock(work),
  runNeo4jWrite: (work: Parameters<typeof neo4jWriteMock>[0]) => neo4jWriteMock(work),
}));

vi.mock('@tg-games/core/db/migrations/registry.js', () => ({
  postgresMigrations,
  neo4jMigrations,
}));

import { runPostgresMigrations, runNeo4jMigrations } from '@tg-games/core/db/migrator.js';

beforeEach(() => {
  poolQueryMock.mockReset();
  clientQueryMock.mockReset();
  clientReleaseMock.mockReset();
  poolConnectMock.mockClear();
  neo4jReadMock.mockReset();
  neo4jWriteMock.mockReset();
  postgresMigrations.length = 0;
  neo4jMigrations.length = 0;
});

describe('runPostgresMigrations', () => {
  it('создаёт таблицу schema_migrations и пропускает применённые версии', async () => {
    postgresMigrations.push(
      {
        version: '0001',
        name: 'baseline',
        transactional: false,
        run: vi.fn(async () => undefined),
      },
      {
        version: '0002',
        name: 'add_table',
        run: vi.fn(async () => undefined),
      },
    );
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT version FROM schema_migrations')) {
        return { rows: [{ version: '0001' }] };
      }
      return { rows: [] };
    });
    clientQueryMock.mockResolvedValue({ rows: [] });

    const applied = await runPostgresMigrations();

    expect(applied).toEqual(['0002']);
    // 0001 уже применён — его run не должен быть вызван повторно.
    expect(postgresMigrations[0].run).not.toHaveBeenCalled();
    expect(postgresMigrations[1].run).toHaveBeenCalledTimes(1);
    // DDL трекера — первый запрос.
    expect(poolQueryMock.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    // 0002 — transactional по умолчанию: должен открыть клиента и BEGIN/COMMIT.
    expect(poolConnectMock).toHaveBeenCalledTimes(1);
    const clientCalls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(clientCalls[0]).toBe('BEGIN');
    expect(clientCalls).toContainEqual('COMMIT');
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
    // Запись в трекер происходит в той же транзакции.
    const insertCall = clientQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO schema_migrations'),
    );
    expect(insertCall?.[1]).toEqual(['0002', 'add_table']);
  });

  it('для transactional:false запускает миграцию без BEGIN и пишет трекер через пул', async () => {
    const runSpy = vi.fn(async () => undefined);
    postgresMigrations.push({
      version: '0001',
      name: 'baseline',
      transactional: false,
      run: runSpy,
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT version FROM schema_migrations')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const applied = await runPostgresMigrations();

    expect(applied).toEqual(['0001']);
    expect(runSpy).toHaveBeenCalledTimes(1);
    // Без обрамляющей транзакции — клиент не запрашивается.
    expect(poolConnectMock).not.toHaveBeenCalled();
    expect(clientQueryMock).not.toHaveBeenCalled();
    // Запись в трекер выполняется напрямую через пул.
    const insertCall = poolQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO schema_migrations'),
    );
    expect(insertCall?.[1]).toEqual(['0001', 'baseline']);
  });

  it('откатывает транзакцию и не пишет трекер при ошибке миграции', async () => {
    const error = new Error('boom');
    postgresMigrations.push({
      version: '0002',
      name: 'broken',
      run: vi.fn(async () => {
        throw error;
      }),
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT version FROM schema_migrations')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    clientQueryMock.mockResolvedValue({ rows: [] });

    await expect(runPostgresMigrations()).rejects.toBe(error);

    const clientCalls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('ROLLBACK');
    expect(clientCalls).not.toContain('COMMIT');
    expect(clientCalls.some((sql) => sql.includes('INSERT INTO schema_migrations'))).toBe(false);
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('применяет миграции строго в порядке версий, даже если их добавили вразнобой', async () => {
    const order: string[] = [];
    postgresMigrations.push(
      {
        version: '0003',
        name: 'third',
        transactional: false,
        run: async () => void order.push('0003'),
      },
      {
        version: '0001',
        name: 'first',
        transactional: false,
        run: async () => void order.push('0001'),
      },
      {
        version: '0002',
        name: 'second',
        transactional: false,
        run: async () => void order.push('0002'),
      },
    );
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT version FROM schema_migrations')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const applied = await runPostgresMigrations();

    expect(applied).toEqual(['0001', '0002', '0003']);
    expect(order).toEqual(['0001', '0002', '0003']);
  });
});

describe('runNeo4jMigrations', () => {
  it('создаёт constraint трекера, пропускает применённые версии и пишет узел SchemaMigration', async () => {
    const runSpy = vi.fn(async () => undefined);
    neo4jMigrations.push(
      {
        version: '0001',
        name: 'baseline',
        run: vi.fn(async () => undefined),
      },
      {
        version: '0002',
        name: 'add_index',
        run: runSpy,
      },
    );

    // 1-й write — DDL constraint трекера; 2-й — миграция + узел.
    const txWriteRun = vi.fn(async () => ({ records: [] }));
    neo4jWriteMock.mockImplementation(async (work: (tx: { run: typeof txWriteRun }) => Promise<unknown>) => {
      return work({ run: txWriteRun });
    });
    // Read возвращает уже применённую версию.
    neo4jReadMock.mockImplementation(async (work: (tx: { run: (q: string) => Promise<{ records: Array<{ get: (k: string) => string }> }> }) => Promise<unknown>) => {
      return work({
        run: async () => ({
          records: [{ get: () => '0001' }],
        }),
      });
    });

    const applied = await runNeo4jMigrations();

    expect(applied).toEqual(['0002']);
    // Один read (получить применённые), несколько writes: DDL + миграция.
    expect(neo4jReadMock).toHaveBeenCalledTimes(1);
    expect(neo4jWriteMock).toHaveBeenCalledTimes(2);
    // 0001 не должен выполняться повторно.
    expect(neo4jMigrations[0].run).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
    // Среди запросов в writes должен быть CREATE SchemaMigration с правильными параметрами.
    const createTrackerCall = txWriteRun.mock.calls.find(([query]) =>
      String(query).includes('CREATE (m:SchemaMigration'),
    );
    expect(createTrackerCall?.[1]).toEqual({ version: '0002', name: 'add_index' });
  });

  it('возвращает пустой список, если ничего не применилось', async () => {
    neo4jMigrations.push({
      version: '0001',
      name: 'baseline',
      run: vi.fn(),
    });
    const txWriteRun = vi.fn(async () => ({ records: [] }));
    neo4jWriteMock.mockImplementation(async (work: (tx: { run: typeof txWriteRun }) => Promise<unknown>) => {
      return work({ run: txWriteRun });
    });
    neo4jReadMock.mockImplementation(async (work: (tx: { run: (q: string) => Promise<{ records: Array<{ get: (k: string) => string }> }> }) => Promise<unknown>) => {
      return work({
        run: async () => ({ records: [{ get: () => '0001' }] }),
      });
    });

    const applied = await runNeo4jMigrations();

    expect(applied).toEqual([]);
    expect(neo4jMigrations[0].run).not.toHaveBeenCalled();
  });
});
