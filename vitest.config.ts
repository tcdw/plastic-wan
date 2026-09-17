import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'apps/admin-next/src/**/*.test.ts'],
    // bun test ran files sequentially; keep the same execution semantics so
    // SQLite fixtures, temp directories and shared ports stay deterministic.
    fileParallelism: false,
  },
});
