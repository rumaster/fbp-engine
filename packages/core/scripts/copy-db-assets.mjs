#!/usr/bin/env node
// Копирует ассеты подсистемы БД (`schema.sql` baseline и сырые SQL/Cypher
// миграции) из `src/db/` в `dist/db/` после `tsc`. Раньше build-строка делала
// только `cp src/db/schema.sql dist/db/schema.sql`; с появлением версионных
// миграций (issue #336) добавились каталоги `migrations/postgres/*.sql` и
// `migrations/cypher/*.cypher`, которые должны попадать в собранный пакет, чтобы
// раннер мог читать их из `dist/` (registry резолвит файлы по `import.meta.url`).
//
// Использование: вызывается из `npm run build -w packages/core`.

import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const srcDb = join(packageRoot, 'src', 'db');
const distDb = join(packageRoot, 'dist', 'db');

/** Создаёт каталог если его нет (рекурсивно). */
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/** Копирует один файл, создавая каталог назначения. */
function copy(srcPath, destPath) {
  ensureDir(dirname(destPath));
  copyFileSync(srcPath, destPath);
}

/**
 * Рекурсивно копирует все файлы из `srcRoot` в `destRoot`, оставляя только
 * соответствующие предикату (по умолчанию — все).
 */
function copyTree(srcRoot, destRoot, accept = () => true) {
  if (!existsSync(srcRoot)) return 0;
  let count = 0;
  for (const entry of readdirSync(srcRoot)) {
    const srcPath = join(srcRoot, entry);
    const destPath = join(destRoot, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      count += copyTree(srcPath, destPath, accept);
    } else if (stats.isFile() && accept(srcPath)) {
      copy(srcPath, destPath);
      count++;
    }
  }
  return count;
}

ensureDir(distDb);

// 1. Baseline-схема (обязательна, baseline-миграция её читает).
copy(join(srcDb, 'schema.sql'), join(distDb, 'schema.sql'));

// 2. Будущие версионные SQL-миграции (`migrations/postgres/NNNN_*.sql`).
const pgCount = copyTree(
  join(srcDb, 'migrations', 'postgres'),
  join(distDb, 'migrations', 'postgres'),
  (p) => p.endsWith('.sql'),
);

// 3. Будущие версионные Cypher-миграции (`migrations/cypher/NNNN_*.cypher`).
const cyCount = copyTree(
  join(srcDb, 'migrations', 'cypher'),
  join(distDb, 'migrations', 'cypher'),
  (p) => p.endsWith('.cypher'),
);

console.log(
  `db-assets: schema.sql + postgres=${pgCount} + cypher=${cyCount} → dist/db/`,
);
