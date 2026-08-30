import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

/**
 * SRS §20 requires two test levels, and the §6 scenarios must pass at BOTH:
 *
 *   pure        — src/money and src/ledger. No dependencies, no runtime beyond
 *                 node. This is where the acceptance figures are proven.
 *   integration — the posting layer against a real local D1, in workerd. This
 *                 is where atomicity and replay are proven.
 *
 * Asserting the same §6 figures at both levels is deliberate: an engine that is
 * right in isolation but wrong through the database is still wrong.
 */

// The committed migration SQL, applied to each isolated test database. Tests
// therefore run against exactly the schema production will have — a migration
// that does not apply cleanly fails the suite, not just the deploy.
const migrations = await readD1Migrations('./drizzle/migrations');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'pure',
          include: [
            'src/money/**/*.test.ts',
            'src/ledger/**/*.test.ts',
            'src/export/**/*.test.ts',
            // Auth crypto is Web Crypto only, so it runs unchanged in Node.
            // That portability is the requirement (§16.1), not a convenience.
            'src/auth/**/*.test.ts',
            // The maintenance scripts are plain Node too (SRS §19).
            'scripts/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              d1Databases: ['DB'],
              bindings: { TEST_MIGRATIONS: migrations },
            },
          }),
        ],
        test: {
          name: 'integration',
          include: ['src/posting/**/*.test.ts', 'src/worker/**/*.test.ts'],
          setupFiles: ['./src/posting/test-setup.ts'],
        },
      },
    ],
  },
});
