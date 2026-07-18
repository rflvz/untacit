import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@untacit/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@untacit/extractors': fileURLToPath(new URL('../extractors/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
