import { defineConfig } from 'vitest/config';

// End-to-end against real contracts on a local anvil chain. Needs Foundry, the contract
// dependencies in smart-contract/lib, and Postgres (TEST_DATABASE_URL).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.ts'],
    fileParallelism: false,
    sequence: { shuffle: false },
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
