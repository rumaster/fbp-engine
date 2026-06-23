import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

describe('admin build runtime', () => {
  it('build:admin собирает core до admin-api', () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const buildAdmin = rootPackage.scripts?.['build:admin'] ?? '';

    const coreBuild = 'npm run build -w packages/core';
    const adminApiBuild = 'npm run build -w apps/admin-api';
    expect(buildAdmin).toContain(coreBuild);
    expect(buildAdmin).toContain(adminApiBuild);
    expect(buildAdmin.indexOf(coreBuild)).toBeLessThan(buildAdmin.indexOf(adminApiBuild));
  });
});
