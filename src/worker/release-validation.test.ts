import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createTransactionSchema,
  entryDate,
  exportFilterSchema,
  ledgerQuerySchema,
} from './schemas';
import { createDealer, createPayment, makeDb } from '../posting/post';
import * as schema from '../db/schema';

describe('Release validation regressions', () => {
  it.each(['2026-02-29', '2026-02-31', '2026-04-31', '2026-13-01'])(
    'rejects the impossible date %s at each date boundary',
    (value) => {
      expect(entryDate.safeParse(value).success).toBe(false);
      expect(ledgerQuerySchema.safeParse({ from: value }).success).toBe(false);
      expect(exportFilterSchema.safeParse({ to: value }).success).toBe(false);
    },
  );
  it('accepts a genuine leap day', () => {
    expect(entryDate.safeParse('2024-02-29').success).toBe(true);
  });
  it.each([1e308, Number.MAX_SAFE_INTEGER])(
    'rejects calculated monetary overflow for quantity %s',
    (quantity) => {
      expect(
        createTransactionSchema.safeParse({
          dealerId: 1,
          mode: 'sale',
          entryDate: '2026-08-01',
          bankAccount: 'od',
          lines: [{ quantity, ratePaise: 100 }],
        }).success,
      ).toBe(false);
    },
  );
  it('returns a generic 500 with security headers when a real void write fails', async () => {
    const db = makeDb(env.DB);
    const dealer = await createDealer(db, { name: 'Error regression' });
    const payment = await createPayment(db, {
      dealerId: dealer.id,
      entryDate: '2026-08-01',
      direction: 'paid',
      amountPaise: 10000,
    });
    await env.DB.exec(
      "CREATE TRIGGER audit_failure BEFORE INSERT ON ledger_entries WHEN NEW.source_type = 'reversal' BEGIN SELECT RAISE(ABORT, 'private-database-marker'); END",
    );
    try {
      const response = await SELF.fetch(`https://x/api/payments/${payment.id}/void`, {
        method: 'POST',
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const text = await response.text();
      expect(text).toContain('INTERNAL');
      expect(text).not.toContain('private-database-marker');
      expect(text).not.toContain('INSERT');
    } finally {
      await env.DB.exec('DROP TRIGGER audit_failure');
    }
  });
  it('normalizes a cash payment bank tag in both payment and ledger rows', async () => {
    const db = makeDb(env.DB);
    const dealer = await createDealer(db, { name: 'Cash regression' });
    await createPayment(db, {
      dealerId: dealer.id,
      entryDate: '2026-08-01',
      direction: 'paid',
      amountPaise: 10000,
      method: 'cash',
      bankAccount: 'od',
    });
    expect((await db.select().from(schema.payments))[0].bankAccount).toBeNull();
    expect((await db.select().from(schema.ledgerEntries))[0].bankAccount).toBeNull();
  });
  it.each(['/api/auth/me', '/api/dealers', '/api/missing'])('prevents caching %s', async (path) => {
    const response = await SELF.fetch(`https://x${path}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

it('rejects oversized bodies before route processing', async () => {
  const response = await SELF.fetch('https://x/api/dealers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(270000) }),
  });
  expect(response.status).toBe(413);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('bounds line counts and notes', () => {
  const input = {
    dealerId: 1,
    mode: 'sale',
    entryDate: '2026-08-01',
    bankAccount: 'od',
    lines: [{ quantity: 1, ratePaise: 100 }],
  };
  expect(
    createTransactionSchema.safeParse({ ...input, lines: Array(26).fill(input.lines[0]) }).success,
  ).toBe(false);
  expect(createTransactionSchema.safeParse({ ...input, notes: 'x'.repeat(4001) }).success).toBe(
    false,
  );
});
it.each(['from=2026-02-31', 'mode=garbage', 'bankAccount=unknown'])(
  'rejects invalid transaction filters: %s',
  async (query) => {
    expect((await SELF.fetch(`https://x/api/transactions?${query}`)).status).toBe(400);
  },
);
