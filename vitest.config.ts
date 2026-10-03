import { defineConfig } from 'vitest/config';

// Admin i18n resolves its default language from `navigator.language`, which
// Node derives from the environment. Pin it before workers fork so language-
// dependent unit tests are deterministic on every machine.
process.env.LANG = 'en_US.UTF-8';
process.env.LC_ALL = 'en_US.UTF-8';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'apps/admin-next/src/**/*.test.ts', 'packages/image-service/test/**/*.test.ts'],
    // bun test ran files sequentially; keep the same execution semantics so
    // SQLite fixtures, temp directories and shared ports stay deterministic.
    fileParallelism: false,
  },
});
