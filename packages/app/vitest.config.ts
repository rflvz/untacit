import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against core's TypeScript sources so they work even when
      // packages/core/dist has not been built yet (parallel agents).
      '@untacit/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@untacit/extractors': fileURLToPath(new URL('../extractors/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['sidecar/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
