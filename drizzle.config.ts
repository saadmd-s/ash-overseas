import { defineConfig } from 'drizzle-kit';

// drizzle-kit authors the migration SQL; `wrangler d1 migrations apply` applies
// it (SRS §13). An applied migration is never hand-edited — add a new one.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
});
