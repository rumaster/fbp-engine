#!/usr/bin/env node
// Генератор CommonJS-сборки пакета @tg-games/schema-contract.
//
// Единый источник правды — `index.mjs` (ESM). Файл `index.cjs` генерируется из
// него автоматически: тело модуля идентично, отличается только заголовок
// `'use strict'` и форма экспорта (`export { ... }` → `exports.X = ...`). Это
// убирает ручную синхронизацию двух почти одинаковых файлов (этап E,
// docs/schema-engine-gap-plan.md, issue #254).
//
// Использование:
//   node packages/schema-contract/build.mjs          — записать index.cjs
//   node packages/schema-contract/build.mjs --check   — проверить синхронность
//
// Режим --check ничего не пишет: он сравнивает сгенерированный CJS с тем, что
// лежит на диске, и завершается с кодом 1 при расхождении. Используется
// тест-стражем (tests/schema-contract-sync.test.ts) и может вызываться в CI.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mjsPath = join(here, 'index.mjs');
const cjsPath = join(here, 'index.cjs');

/**
 * Преобразует ESM-исходник в эквивалентный CommonJS-модуль.
 * @param {string} mjs содержимое index.mjs
 * @returns {string} содержимое index.cjs
 */
export function generateCjs(mjs) {
  const marker = '\nexport {';
  const markerIndex = mjs.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('index.mjs: не найден блок `export { ... }`');
  }

  // Тело модуля — всё до финального блока export (без хвостовой пустой строки).
  const body = mjs.slice(0, markerIndex).replace(/\s*$/, '');

  // Разбираем именованные экспорты, включая алиасы `A as B`.
  const exportBlock = mjs.slice(markerIndex);
  const braceStart = exportBlock.indexOf('{');
  const braceEnd = exportBlock.indexOf('}');
  if (braceStart === -1 || braceEnd === -1) {
    throw new Error('index.mjs: не удалось разобрать блок export');
  }
  const specifiers = exportBlock
    .slice(braceStart + 1, braceEnd)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = part.match(/^(\S+)\s+as\s+(\S+)$/);
      if (match) {
        return { local: match[1], exported: match[2] };
      }
      return { local: part, exported: part };
    });

  const exportLines = specifiers
    .map(({ local, exported }) => `exports.${exported} = ${local};`)
    .join('\n');

  return `'use strict';\n\n${body}\n\n${exportLines}\n`;
}

function main() {
  const mjs = readFileSync(mjsPath, 'utf8');
  const generated = generateCjs(mjs);

  if (process.argv.includes('--check')) {
    const current = readFileSync(cjsPath, 'utf8');
    if (current !== generated) {
      console.error(
        'index.cjs рассинхронизирован с index.mjs.\n' +
          'Запустите `npm run build:contract`, чтобы перегенерировать его.',
      );
      process.exit(1);
    }
    console.log('schema-contract: index.cjs синхронен с index.mjs.');
    return;
  }

  writeFileSync(cjsPath, generated);
  console.log('schema-contract: index.cjs сгенерирован из index.mjs.');
}

// Запуск только когда файл вызван напрямую (а не импортирован тестом).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
