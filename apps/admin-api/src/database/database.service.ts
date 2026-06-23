import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

function optionalConfig(config: ConfigService, key: string, fallback: string): string {
  const value = config.get<string>(key);
  return value === undefined || value === '' ? fallback : value;
}

@Injectable()
export class DatabaseService implements DatabaseClient, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      host: optionalConfig(config, 'DB_HOST', 'localhost'),
      port: Number(optionalConfig(config, 'DB_PORT', '5432')),
      user: optionalConfig(config, 'DB_USER', 'postgres'),
      password: optionalConfig(config, 'DB_PASSWORD', 'postgres_password'),
      database: optionalConfig(config, 'DB_NAME', 'tg_rpg_db'),
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
