/**
 * SRS §6 at the D1-integration level.
 *
 * §20's gating rule: all six scenarios must pass at BOTH the pure and the
 * integration level. The figures here are the same ones src/ledger asserts —
 * an engine that is right in isolation but wrong through the database is still
 * wrong, and this file is what tells the two apart.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  createDealer,
  createPayment,
  createTransaction,
  currentBalance,
  makeDb,
  type Db,
} from './post';
import { checkLedgerIntegrity, recomputeLedger, voidTransaction } from './recompute';

let db: Db;
let dealerId: number;

beforeEach(async () => {
  db = makeDb(env.DB);
  ({ id: dealerId } = await createDealer(db, { name: 'Kumar Traders', type: 'both' }));
});

/** Every ledger row for the dealer, in `(entry_date, id)` order (§15.4). */
async function history(id = dealerId) {
  return db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.dealerId, id))
    .orderBy(asc(schema.ledgerEntries.entryDate), asc(schema.ledgerEntries.id));
}

const sale = (
  entryDate: string,
  quantity: number,
  ratePaise: number,
  bankAccount: 'od' | 'current' = 'od',
) =>
  createTransaction(db, {
    dealerId,
    mode: 'sale' as const,
    entryDate,
    bankAccount,
    gstRate: 18,
    lines: [{ quantity, ratePaise }],
  });

// ---------------------------------------------------------------------------

describe('Scenario A through D1 (§6.1)', () => {
  it('walks the balance through every step exactly', async () => {
    await createPayment(db, {
      dealerId,
      entryDate: '2026-08-01',
      direction: 'received',
      amountPaise: 60_000_000,
      bankAccount: 'od',
    });
    await sale('2026-08-05', 1000, 20_000);
    await createTransaction(db, {
      dealerId,
      mode: 'purchase',
      entryDate: '2026-08-10',
      bankAccount: 'od',
      gstRate: 18,
      lines: [{ quantity: 500, ratePaise: 10_000 }],
    });
    await createPayment(db, {
      dealerId,
      entryDate: '2026-08-15',
      direction: 'paid',
      amountPaise: 10_000_000,
      bankAccount: 'od',
    });

    const rows = await history();
    expect(rows.map((r) => r.runningBalancePaise)).toEqual([
      -60_000_000, -36_400_000, -42_300_000, -32_300_000,
    ]);
    expect(await currentBalance(db, dealerId)).toBe(-32_300_000);
  });
});

describe('Scenario B through D1 (§6.2)', () => {
  it('stores round_off_paise = −20 and posts the rounded total', async () => {
    const created = await sale('2026-07-09', 9510, 2400);

    expect(created.grandTotalPaise).toBe(26_932_300);
    expect(created.roundOffPaise).toBe(-20);

    const [tx] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, created.id));

    expect(tx.baseTotalPaise).toBe(22_824_000);
    expect(tx.gstAmountPaise).toBe(4_108_320);
    expect(tx.roundOffPaise).toBe(-20);
    expect(tx.grandTotalPaise).toBe(26_932_300);

    const rows = await history();
    expect(rows[0].debitPaise).toBe(26_932_300);
  });
});

describe('Scenario C through D1 (§6.3)', () => {
  it('ends at −3,19,592', async () => {
    await createPayment(db, {
      dealerId,
      entryDate: '2026-07-02',
      direction: 'received',
      amountPaise: 80_886_700,
      bankAccount: 'od',
    });
    await sale('2026-07-09', 9510, 2400);
    await sale('2026-07-21', 11_650, 1600);

    expect((await history()).map((r) => r.runningBalancePaise)).toEqual([
      -80_886_700, -53_954_400, -31_959_200,
    ]);
    expect(await currentBalance(db, dealerId)).toBe(-31_959_200);
  });
});

describe('Scenario D through D1 (§6.4)', () => {
  it('crosses zero to +34,408', async () => {
    await createPayment(db, {
      dealerId,
      entryDate: '2026-07-02',
      direction: 'received',
      amountPaise: 80_886_700,
      bankAccount: 'od',
    });
    await sale('2026-07-09', 9510, 2400);
    await sale('2026-07-21', 11_650, 1600);

    await createTransaction(db, {
      dealerId,
      mode: 'sale',
      entryDate: '2026-07-28',
      bankAccount: 'od',
      gstRate: 18,
      lines: [{ quantity: 1, ratePaise: 30_000_000 }],
    });

    expect(await currentBalance(db, dealerId)).toBe(3_440_800);
  });
});

describe('Scenario E through D1 (§6.5)', () => {
  it('void posts a reversal, retains the source, and returns to −5,39,544', async () => {
    await createPayment(db, {
      dealerId,
      entryDate: '2026-07-02',
      direction: 'received',
      amountPaise: 80_886_700,
      bankAccount: 'od',
    });
    await sale('2026-07-09', 9510, 2400);
    const ash42 = await sale('2026-07-21', 11_650, 1600);

    expect(await currentBalance(db, dealerId)).toBe(-31_959_200);

    const result = await voidTransaction(db, ash42.id);
    expect(result.runningBalancePaise).toBe(-53_954_400);
    expect(await currentBalance(db, dealerId)).toBe(-53_954_400);

    // The source is flagged, NOT deleted — its rows are retained in full.
    const [tx] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, ash42.id));
    expect(tx.isVoided).toBe(true);
    expect(tx.grandTotalPaise).toBe(21_995_200);

    const lines = await db
      .select()
      .from(schema.transactionLines)
      .where(eq(schema.transactionLines.transactionId, ash42.id));
    expect(lines).toHaveLength(1);

    // The reversal is linked to the entry it undoes.
    const rows = await history();
    const reversal = rows.find((r) => r.sourceType === 'reversal');
    expect(reversal).toBeDefined();
    expect(reversal!.creditPaise).toBe(21_995_200);
    expect(reversal!.debitPaise).toBe(0);
    expect(reversal!.label).toBe('Reversal');

    const original = rows.find((r) => r.sourceType === 'transaction' && r.sourceId === ash42.id);
    expect(reversal!.reversesEntryId).toBe(original!.id);

    // And an audit row records it (FR-A4).
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'void'));
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe(ash42.id);
    expect(audit[0].beforeJson).toContain('21995200');
  });

  it('refuses to void the same record twice', async () => {
    const tx = await sale('2026-07-09', 9510, 2400);
    await voidTransaction(db, tx.id);
    await expect(voidTransaction(db, tx.id)).rejects.toThrow(/already voided/i);
  });

  it('never hard-deletes a financial row', async () => {
    const tx = await sale('2026-07-09', 9510, 2400);
    await voidTransaction(db, tx.id);

    const txCount = await db.select().from(schema.transactions);
    const entries = await history();
    expect(txCount).toHaveLength(1);
    // The original entry AND its reversal both remain (§15.8 rule 5).
    expect(entries).toHaveLength(2);
  });
});

describe('Scenario F through D1 (§6.6)', () => {
  it('produces ONE headline of +1,77,000 across both bank accounts', async () => {
    await createTransaction(db, {
      dealerId,
      mode: 'sale',
      entryDate: '2026-08-03',
      bankAccount: 'od',
      gstRate: 18,
      lines: [{ quantity: 1, ratePaise: 5_000_000 }],
    });
    await createTransaction(db, {
      dealerId,
      mode: 'sale',
      entryDate: '2026-08-04',
      bankAccount: 'current',
      gstRate: 18,
      lines: [{ quantity: 1, ratePaise: 10_000_000 }],
    });

    expect(await currentBalance(db, dealerId)).toBe(17_700_000);

    const rows = await history();
    expect(rows.map((r) => r.runningBalancePaise)).toEqual([5_900_000, 17_700_000]);
    expect(rows.map((r) => r.bankAccount)).toEqual(['od', 'current']);

    // Filtering to OD alone shows one row — and the true balance is unchanged.
    const odOnly = rows.filter((r) => r.bankAccount === 'od');
    expect(odOnly).toHaveLength(1);
    expect(await currentBalance(db, dealerId)).toBe(17_700_000);
  });
});

// ---------------------------------------------------------------------------

describe('Back-dated entries (§15.6)', () => {
  it('replays so no later balance is left stale', async () => {
    await sale('2026-08-10', 1, 5_000_000); // +5,900,000
    await sale('2026-08-20', 1, 10_000_000); // +17,700,000
    expect(await currentBalance(db, dealerId)).toBe(17_700_000);

    // An entry dated BEFORE both of the above.
    await createPayment(db, {
      dealerId,
      entryDate: '2026-08-01',
      direction: 'received',
      amountPaise: 2_000_000,
      bankAccount: 'od',
    });

    const rows = await history();
    expect(rows.map((r) => r.entryDate)).toEqual(['2026-08-01', '2026-08-10', '2026-08-20']);
    expect(rows.map((r) => r.runningBalancePaise)).toEqual([-2_000_000, 3_900_000, 15_700_000]);
    expect(await currentBalance(db, dealerId)).toBe(15_700_000);
  });

  it('leaves balances untouched when the insert is chronologically last', async () => {
    await sale('2026-08-10', 1, 5_000_000);
    const before = await history();
    await sale('2026-08-20', 1, 10_000_000);

    const after = await history();
    expect(after[0].runningBalancePaise).toBe(before[0].runningBalancePaise);
  });
});

describe('Integrity check (§15.8)', () => {
  it('confirms replay reproduces every stored balance', async () => {
    await createPayment(db, {
      dealerId,
      entryDate: '2026-07-02',
      direction: 'received',
      amountPaise: 80_886_700,
      bankAccount: 'od',
    });
    await sale('2026-07-09', 9510, 2400);
    await sale('2026-07-21', 11_650, 1600);

    expect(await checkLedgerIntegrity(db, dealerId)).toEqual({ ok: true });
  });

  it('detects a balance that has been tampered with', async () => {
    await sale('2026-07-09', 9510, 2400);
    const rows = await history();

    await db
      .update(schema.ledgerEntries)
      .set({ runningBalancePaise: 1 })
      .where(eq(schema.ledgerEntries.id, rows[0].id));

    const result = await checkLedgerIntegrity(db, dealerId);
    expect(result.ok).toBe(false);

    // And a replay repairs it.
    await recomputeLedger(db, dealerId);
    expect(await checkLedgerIntegrity(db, dealerId)).toEqual({ ok: true });
    expect(await currentBalance(db, dealerId)).toBe(26_932_300);
  });
});

describe('Opening position (FR-D5)', () => {
  it('is an opening ledger entry, not a field on the dealer', async () => {
    const { id } = await createDealer(db, {
      name: 'Advance Metals',
      opening: { direction: 'we_owe', amountPaise: 5_000_000, entryDate: '2026-04-01' },
    });

    const rows = await history(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe('opening');
    expect(rows[0].creditPaise).toBe(5_000_000);
    expect(rows[0].runningBalancePaise).toBe(-5_000_000);
    expect(await currentBalance(db, id)).toBe(-5_000_000);
  });
});

describe('Human IDs (FR-T9)', () => {
  it('formats as {MODE}-{YYYY}-{MM}-{NNNN} and increments within a month', async () => {
    const first = await sale('2026-08-03', 1, 100_000);
    const second = await sale('2026-08-04', 1, 100_000);

    expect(first.humanId).toBe('SALE-2026-08-0001');
    expect(second.humanId).toBe('SALE-2026-08-0002');
  });

  it('scopes the sequence to mode and month', async () => {
    const augustSale = await sale('2026-08-03', 1, 100_000);
    const septemberSale = await sale('2026-09-03', 1, 100_000);
    const purchase = await createTransaction(db, {
      dealerId,
      mode: 'purchase',
      entryDate: '2026-08-05',
      bankAccount: 'od',
      gstRate: 18,
      lines: [{ quantity: 1, ratePaise: 100_000 }],
    });

    expect(augustSale.humanId).toBe('SALE-2026-08-0001');
    expect(septemberSale.humanId).toBe('SALE-2026-09-0001');
    expect(purchase.humanId).toBe('PURCHASE-2026-08-0001');
  });

  it('gives payments their own prefixes', async () => {
    const received = await createPayment(db, {
      dealerId,
      entryDate: '2026-08-01',
      direction: 'received',
      amountPaise: 100_000,
      bankAccount: 'od',
    });
    const paid = await createPayment(db, {
      dealerId,
      entryDate: '2026-08-02',
      direction: 'paid',
      amountPaise: 100_000,
      bankAccount: 'od',
    });

    expect(received.humanId).toBe('RCPT-2026-08-0001');
    expect(paid.humanId).toBe('PAY-2026-08-0001');
  });

  it('does not reuse a number after a void', async () => {
    const first = await sale('2026-08-03', 1, 100_000);
    await voidTransaction(db, first.id);
    const second = await sale('2026-08-04', 1, 100_000);

    // The voided row keeps its ID and the sequence never rewinds — which is
    // exactly why a count-based counter would be wrong.
    expect(first.humanId).toBe('SALE-2026-08-0001');
    expect(second.humanId).toBe('SALE-2026-08-0002');
  });
});

describe('Payments — method and bank tag (FR-P2)', () => {
  it('omits the bank account for cash', async () => {
    const created = await createPayment(db, {
      dealerId,
      entryDate: '2026-08-01',
      direction: 'received',
      amountPaise: 100_000,
      method: 'cash',
      bankAccount: 'od',
    });

    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, created.id));
    expect(row.bankAccount).toBeNull();
  });
});
