import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The app's own tests run without a browser. Everything under test is either a pure reading of an
 * environment or a component that renders on the server, which is where these surfaces are first
 * produced anyway: a wallet is never needed to read a mandate and is never needed to test one.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
