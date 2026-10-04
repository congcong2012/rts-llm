import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The simulation core is deterministic and IO-free, so no test needs to
    // touch the network or the filesystem.
    testTimeout: 20_000,
  },
});
