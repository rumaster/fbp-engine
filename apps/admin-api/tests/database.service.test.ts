import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

const poolEnd = vi.fn();
const poolQuery = vi.fn();
const poolConnect = vi.fn();
const PoolMock = vi.fn(function MockPool() {
  return {
    query: poolQuery,
    connect: poolConnect,
    end: poolEnd,
  };
});

vi.mock('pg', () => ({
  Pool: PoolMock,
}));

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

describe('DatabaseService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('использует дефолты подключения, если DB_* заданы пустыми строками', async () => {
    const { DatabaseService } = await import('../src/database/database.service');

    const service = new DatabaseService(
      makeConfig({
        DB_HOST: '',
        DB_PORT: '',
        DB_USER: '',
        DB_PASSWORD: '',
        DB_NAME: '',
      }),
    );

    expect(PoolMock).toHaveBeenCalledWith({
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'postgres_password',
      database: 'tg_rpg_db',
    });

    await service.onModuleDestroy();
  });

  it('передаёт непустые DB_* без замены дефолтами', async () => {
    const { DatabaseService } = await import('../src/database/database.service');

    const service = new DatabaseService(
      makeConfig({
        DB_HOST: 'postgres_db',
        DB_PORT: '15432',
        DB_USER: 'admin_user',
        DB_PASSWORD: 'real_password',
        DB_NAME: 'prod_db',
      }),
    );

    expect(PoolMock).toHaveBeenCalledWith({
      host: 'postgres_db',
      port: 15432,
      user: 'admin_user',
      password: 'real_password',
      database: 'prod_db',
    });

    await service.onModuleDestroy();
  });
});
