import { describe, expect, it } from 'vitest';
import { adminApiEnvFilePaths } from '../src/config/env-files';

describe('adminApiEnvFilePaths', () => {
  it('подключает корневой .env при запуске из src', () => {
    expect(adminApiEnvFilePaths('/repo/apps/admin-api/src/config')).toEqual([
      '/repo/.env',
      '/repo/apps/admin-api/.env',
    ]);
  });

  it('подключает корневой .env при запуске из dist', () => {
    expect(adminApiEnvFilePaths('/repo/apps/admin-api/dist/config')).toEqual([
      '/repo/.env',
      '/repo/apps/admin-api/.env',
    ]);
  });
});
