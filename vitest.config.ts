import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{shared,api,worker,scripts,tests}/**/*.{test,spec}.ts'],
    coverage: { reporter: ['text', 'lcov'], include: ['{shared,api,worker}/src/**'] },
    testTimeout: 20_000,
  },
});
