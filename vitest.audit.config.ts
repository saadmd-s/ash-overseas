import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Optional focused run of the release regressions; these also run in pnpm test.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['DB'],
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./drizzle/migrations') },
      },
    }),
  ],
  test: {
    include: ['src/posting/release-regressions.test.ts'],
    setupFiles: ['./src/posting/test-setup.ts'],
  },
});
