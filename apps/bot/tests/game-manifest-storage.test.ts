import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

describe('хранение манифестов игр в БД (issue #106)', () => {
  it('создаёт таблицу game_manifests с JSONB-манифестом', () => {
    const schema = readFileSync(join(repoRoot, 'packages/core/src/db/schema.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS game_manifests');
    expect(schema).toMatch(/manifest\s+JSONB\s+NOT NULL/);
    expect(schema).toContain('INSERT INTO game_manifests');
  });

  it('не держит статический справочник GAMES в TypeScript-коде приложения', () => {
    const source = readFileSync(join(repoRoot, 'packages/core/src/games/manifests.ts'), 'utf8');

    expect(source).not.toMatch(/export\s+const\s+GAMES\b/);
  });
});
