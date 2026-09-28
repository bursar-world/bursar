import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The drill forks a chain and walks a dispute through twelve hours of chain time. Every other
    // file finishes well inside the default.
    testTimeout: 10_000,
  },
});
