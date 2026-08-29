import { defineConfig } from 'vitest/config';

// Phase 0: the pure suites only — src/money and src/ledger have no dependencies
// and need no runtime beyond node. SRS §20 also requires a D1-backed
// integration level using @cloudflare/vitest-pool-workers; that arrives in
// Phase 1 alongside the posting layer, as a second Vitest project.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
