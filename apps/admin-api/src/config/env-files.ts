import { join } from 'node:path';

export function adminApiEnvFilePaths(baseDir = __dirname): string[] {
  const appDir = join(baseDir, '..', '..');
  return [
    join(appDir, '..', '..', '.env'),
    join(appDir, '.env'),
  ];
}
