import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error — генератор сборки на чистом ESM без типов.
import { generateCjs } from '../build.mjs';

/**
 * Тест-страж синхронности пакета @tg-games/schema-contract (этап E,
 * docs/schema-engine-gap-plan.md, issue #254).
 *
 * Пакет поставляется тремя файлами, которые легко рассинхронизировать вручную:
 *   index.mjs — единый источник правды (ESM);
 *   index.cjs — генерируется из index.mjs (`npm run build:contract`);
 *   index.d.ts — типы, поддерживаются вручную.
 *
 * Тест ловит расхождения до того, как они попадут в рантайм:
 *   1. сгенерированный из index.mjs CJS совпадает с index.cjs на диске;
 *   2. набор именованных экспортов одинаков в .mjs, .cjs и .d.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
// Тест лежит внутри пакета (packages/schema-contract/tests), артефакты — на уровень выше.
const pkgDir = join(here, '..');

function read(file: string): string {
  return readFileSync(join(pkgDir, file), 'utf8');
}

/** Имена из финального блока `export { ... }` в index.mjs (с учётом алиасов). */
function mjsExports(source: string): Set<string> {
  const block = source.slice(source.indexOf('\nexport {'));
  const inner = block.slice(block.indexOf('{') + 1, block.indexOf('}'));
  const names = inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const alias = part.match(/\s+as\s+(\S+)$/);
      return alias ? alias[1] : part;
    });
  return new Set(names);
}

/** Имена из `exports.X = ...` в index.cjs. */
function cjsExports(source: string): Set<string> {
  const names = [...source.matchAll(/^exports\.(\w+)\s*=/gm)].map((m) => m[1]);
  return new Set(names);
}

/** Публичные имена из `export const|function|class|type|interface` в index.d.ts. */
function dtsExports(source: string): Set<string> {
  const names = [
    ...source.matchAll(/^export\s+(?:declare\s+)?(?:const|function|class|type|interface)\s+(\w+)/gm),
  ].map((m) => m[1]);
  return new Set(names);
}

describe('schema-contract: синхронность сборки (issue #254, этап E)', () => {
  it('index.cjs совпадает с генерацией из index.mjs', () => {
    const generated = generateCjs(read('index.mjs'));
    expect(read('index.cjs')).toBe(generated);
  });

  it('наборы именованных экспортов в .mjs и .cjs совпадают', () => {
    const mjs = [...mjsExports(read('index.mjs'))].sort();
    const cjs = [...cjsExports(read('index.cjs'))].sort();
    expect(cjs).toEqual(mjs);
  });

  it('все runtime-экспорты объявлены в index.d.ts', () => {
    const runtime = mjsExports(read('index.mjs'));
    const types = dtsExports(read('index.d.ts'));
    const missing = [...runtime].filter((name) => !types.has(name)).sort();
    expect(missing, `нет деклараций типов для: ${missing.join(', ')}`).toEqual([]);
  });
});
