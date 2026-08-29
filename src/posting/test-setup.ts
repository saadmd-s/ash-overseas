import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

/**
 * A clean, migrated database before every test.
 *
 * Isolation matters more than speed here: a ledger test that inherits another
 * test's rows can pass for the wrong reason, and the running balance and the
 * human-ID sequence are exactly the kind of state that leaks. (The pool used to
 * offer `isolatedStorage`; it was removed in v0.22, so we do it explicitly.)
 *
 * Child tables first, `dealers` last, so the deletes never trip a foreign key.
 */
const TABLES_CHILD_FIRST = [
  'audit_log',
  'ledger_entries',
  'transaction_lines',
  'transactions',
  'payments',
  'id_sequences',
  'app_credentials',
  'dealers',
] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('PRAGMA foreign_keys = ON');

  await env.DB.batch([
    ...TABLES_CHILD_FIRST.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    // Restart AUTOINCREMENT, so ids are predictable per test rather than
    // carrying over and making a failure hard to read.
    env.DB.prepare('DELETE FROM sqlite_sequence'),
  ]);
});

/** Every table the migration creates, so the cleanup list cannot silently rot. */
export async function userTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all<{ name: string }>();

  // Filtered here rather than in SQL: LIKE-escaping an underscore is fiddly,
  // and none of these are tables this application owns — SQLite internals,
  // D1's migration bookkeeping, and Cloudflare's own _cf_* tables.
  return results
    .map((r) => r.name)
    .filter(
      (name) => !name.startsWith('sqlite_') && !name.startsWith('_cf_') && name !== 'd1_migrations',
    );
}

export const CLEANED_TABLES: readonly string[] = TABLES_CHILD_FIRST;
