import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Тесты бота гоняются против ИСХОДНИКОВ ядра (packages/core/src/*.ts),
// а не против собранного dist. Алиас переписывает спецификаторы вида
// `@tg-games/core/<путь>.js` в соответствующий `.ts`-файл ядра, поэтому
// сборка ядра для запуска тестов не требуется. Литерал `$1` в пути
// сохраняется через fileURLToPath и подставляется vite при замене по regexp.
const coreSrc = fileURLToPath(new URL('../../packages/core/src/$1.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@tg-games\/core\/(.*)\.js$/, replacement: coreSrc }],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
