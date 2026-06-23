import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Регрессия issue #242: docker-контейнер падал при запуске с ошибкой
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@tg-games/schema-contract'
 *   imported from /app/packages/core/dist/engine/schemaEngine.js
 *
 * Причина: @tg-games/schema-contract — локальный workspace-пакет. При `npm ci`
 * npm создаёт симлинк
 *   node_modules/@tg-games/schema-contract -> ../packages/schema-contract
 * Если каталог packages/ не скопирован в образ, симлинк остаётся битым и
 * импорт пакета в рантайме падает.
 *
 * После рефакторинга монорепо (issue #269) ядро живёт в packages/core и
 * импортирует контракт схем; сам контракт — отдельный workspace-пакет.
 * Тест следит за тем, чтобы Dockerfile создавал каталоги workspace-пакетов ДО
 * npm ci, иначе workspace-симлинк не резолвится. При этом до npm ci должны
 * копироваться только package.json-файлы: полный COPY packages инвалидирует
 * слой npm ci при любом изменении исходников и делает повторные Docker-сборки
 * заметно медленнее (issue #377).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

describe('Dockerfile: локальный пакет @tg-games/schema-contract (issue #242)', () => {
  const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');

  it('schema-contract подключён как workspace-зависимость ядра', () => {
    const corePkg = JSON.parse(
      readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8'),
    );
    expect(corePkg.dependencies['@tg-games/schema-contract']).toBeDefined();

    const rootPkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(rootPkg.workspaces).toContain('packages/*');
  });

  it('workspace-манифесты копируются до npm ci без полного COPY packages', () => {
    const lines = dockerfile
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const requiredManifestCopies = [
      'COPY package.json package-lock.json ./',
      'COPY packages/core/package.json ./packages/core/package.json',
      'COPY packages/schema-contract/package.json ./packages/schema-contract/package.json',
      'COPY apps/bot/package.json ./apps/bot/package.json',
    ];

    // Для каждой инструкции `RUN npm ci...` должны быть предшествующие COPY
    // package.json-файлов внутри той же стадии (после последнего FROM).
    let stageLines: string[] = [];
    let installedDependenciesInStage = false;
    let npmCiCount = 0;
    for (const line of lines) {
      if (/^FROM\s/i.test(line)) {
        stageLines = [];
        installedDependenciesInStage = false;
        continue;
      }
      stageLines.push(line);
      if (!installedDependenciesInStage && /^COPY\s+packages\b/i.test(line)) {
        const copiesOnlyWorkspaceManifest =
          /^COPY\s+packages\/[^/]+\/package\.json\s+\./i.test(line);
        expect(
          copiesOnlyWorkspaceManifest,
          'до npm ci нельзя копировать весь packages/ или исходники workspace-пакета',
        ).toBe(true);
        continue;
      }
      if (/^RUN\s+(?:--mount=\S+\s+)*npm\s+ci\b/i.test(line)) {
        npmCiCount += 1;
        for (const copyLine of requiredManifestCopies) {
          expect(stageLines, `${copyLine} должен быть до npm ci`).toContain(
            copyLine,
          );
        }
        installedDependenciesInStage = true;
      }
    }

    // Убеждаемся, что тест реально проверил инструкции npm ci.
    expect(npmCiCount).toBeGreaterThan(0);
  });
});
