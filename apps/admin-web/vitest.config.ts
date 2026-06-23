import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Юнит-тесты админки (логика, не рендер) гоняются под node и берут общий код
// ядра из исходников packages/core/src. E2E-тесты Playwright (issue #336: тоже
// *.test.ts) лежат в отдельном каталоге tests/e2e и исключены из vitest —
// их запускает Playwright (см. playwright.config.ts).
const coreSrc = fileURLToPath(new URL('../../packages/core/src/$1.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@tg-games\/core\/(.*)\.js$/, replacement: coreSrc }],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
