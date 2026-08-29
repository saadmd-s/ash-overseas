import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CLEANED_TABLES, userTables } from './test-setup';

describe('D1 test harness', () => {
  it('applies the committed migration to an isolated database', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name);

    for (const table of [
      'app_credentials',
      'audit_log',
      'dealers',
      'id_sequences',
      'ledger_entries',
      'payments',
      'transaction_lines',
      'transactions',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('cleans every table the migration creates', async () => {
    // If a future migration adds a table, this fails rather than letting state
    // leak silently into the ledger tests.
    for (const table of await userTables()) {
      expect(CLEANED_TABLES).toContain(table);
    }
  });

  it('starts empty — no state leaks between tests', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger_entries').first<{
      n: number;
    }>();
    expect(row!.n).toBe(0);
  });
});
