/**
 * SRS §15.3 — the atomicity requirement, as an explicit integration test.
 *
 * "Every multi-row write — the transaction header, its lines, the ledger entry,
 *  the human-ID sequence, and the audit row — MUST be issued as a single
 *  db.batch([...]), so it commits entirely or not at all. A forced mid-batch
 *  failure must leave NO partial rows; this is an explicit integration test."
 *
 * These tests take the batch the production code actually builds
 * (`buildTransactionBatch` / `buildPaymentBatch`), inject a failing statement
 * into the middle of it, and assert the database is untouched afterwards.
 * Building an approximation of the batch here would prove nothing about the
 * code that ships.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  buildPaymentBatch,
  buildTransactionBatch,
  createDealer,
  createTransaction,
  makeDb,
  type Db,
} from './post';
import type { BatchItem } from './db';

let db: Db;
let dealerId: number;

beforeEach(async () => {
  db = makeDb(env.DB);
  ({ id: dealerId } = await createDealer(db, { name: 'Kumar Traders' }));
});

async function counts() {
  const [txs, lines, entries, audit, seqs] = await Promise.all([
    db.select().from(schema.transactions),
    db.select().from(schema.transactionLines),
    db.select().from(schema.ledgerEntries),
    db.select().from(schema.auditLog),
    db.select().from(schema.idSequences),
  ]);
  return {
    transactions: txs.length,
    lines: lines.length,
    ledgerEntries: entries.length,
    audit: audit.length,
    sequences: seqs.length,
  };
}

/**
 * A statement guaranteed to fail at execution time, not at build time: an
 * insert violating the NOT NULL on `ledger_entries.running_balance_paise`.
 */
function poisonStatement(): BatchItem {
  return db.run(
    sql`INSERT INTO ledger_entries (dealer_id, entry_date, source_type, running_balance_paise)
        VALUES (${dealerId}, '2026-08-01', 'transaction', NULL)`,
  ) as unknown as BatchItem;
}

const sampleTransaction = {
  mode: 'sale' as const,
  entryDate: '2026-08-03',
  bankAccount: 'od' as const,
  gstRate: 18,
  lines: [
    { itemName: 'Castings', quantity: 9510, unit: 'kg', ratePaise: 2400 },
    { itemName: 'Scrap', quantity: 100, unit: 'kg', ratePaise: 1000 },
  ],
};

describe('§15.3 — a forced mid-batch failure leaves no partial rows', () => {
  it('writes nothing when a statement fails partway through a transaction create', async () => {
    const before = await counts();
    expect(before).toEqual({
      transactions: 0,
      lines: 0,
      ledgerEntries: 0,
      audit: 0,
      sequences: 0,
    });

    const { statements } = buildTransactionBatch(db, { dealerId, ...sampleTransaction }, 0);

    // Break it in the middle — after the sequence allocation, the header and
    // the first line have been queued, before the ledger entry and audit row.
    const poisoned = [...statements];
    poisoned.splice(3, 0, poisonStatement());

    await expect(db.batch(poisoned as [BatchItem, ...BatchItem[]])).rejects.toThrow();

    // Everything, including the human-ID sequence, must be untouched.
    expect(await counts()).toEqual(before);
  });

  it('does not advance the human-ID sequence when the batch fails', async () => {
    // The sequence allocation is the FIRST statement in the batch. If it were
    // issued outside the batch — the obvious shortcut — this is the assertion
    // that would fail, and the ledger would develop gaps in its numbering.
    const { statements } = buildTransactionBatch(db, { dealerId, ...sampleTransaction }, 0);
    const poisoned = [...statements, poisonStatement()];

    await expect(db.batch(poisoned as [BatchItem, ...BatchItem[]])).rejects.toThrow();

    const seqs = await db.select().from(schema.idSequences);
    expect(seqs).toHaveLength(0);

    // And the next successful write still gets 0001.
    const created = await createTransaction(db, { dealerId, ...sampleTransaction });
    expect(created.humanId).toBe('SALE-2026-08-0001');
  });

  it('writes nothing when a payment batch fails', async () => {
    const { statements } = buildPaymentBatch(
      db,
      {
        dealerId,
        entryDate: '2026-08-01',
        direction: 'received',
        amountPaise: 60_000_000,
        bankAccount: 'od',
      },
      0,
    );

    const poisoned = [...statements];
    poisoned.splice(2, 0, poisonStatement());

    await expect(db.batch(poisoned as [BatchItem, ...BatchItem[]])).rejects.toThrow();

    const payments = await db.select().from(schema.payments);
    expect(payments).toHaveLength(0);
    expect(await counts()).toMatchObject({ ledgerEntries: 0, audit: 0, sequences: 0 });
  });

  it('leaves an earlier committed write intact', async () => {
    // A failed batch must not roll back anything that already committed.
    const first = await createTransaction(db, { dealerId, ...sampleTransaction });

    const { statements } = buildTransactionBatch(
      db,
      { dealerId, ...sampleTransaction, entryDate: '2026-08-04' },
      0,
    );
    const poisoned = [...statements, poisonStatement()];
    await expect(db.batch(poisoned as [BatchItem, ...BatchItem[]])).rejects.toThrow();

    const after = await counts();
    expect(after.transactions).toBe(1);
    expect(after.lines).toBe(2);
    expect(after.ledgerEntries).toBe(1);

    const [tx] = await db.select().from(schema.transactions);
    expect(tx.humanId).toBe(first.humanId);
    expect(tx.grandTotalPaise).toBe(first.grandTotalPaise);
  });
});

describe('§15.3 — the successful batch writes every row together', () => {
  it('commits header, lines, ledger entry, sequence and audit row as one', async () => {
    await createTransaction(db, { dealerId, ...sampleTransaction });

    expect(await counts()).toEqual({
      transactions: 1,
      lines: 2,
      ledgerEntries: 1,
      audit: 1,
      sequences: 1,
    });
  });

  it('links every row to the header without ever knowing its integer id', async () => {
    // The batch cannot read a generated key, so lines, the ledger entry and the
    // audit row all resolve the header through its UNIQUE human_id. This proves
    // that indirection actually resolves (docs/TRD.md §5.1).
    const created = await createTransaction(db, { dealerId, ...sampleTransaction });

    const lines = await db.select().from(schema.transactionLines);
    const [entry] = await db.select().from(schema.ledgerEntries);
    const [audit] = await db.select().from(schema.auditLog);

    expect(lines.map((l) => l.transactionId)).toEqual([created.id, created.id]);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(entry.sourceId).toBe(created.id);
    expect(entry.sourceType).toBe('transaction');
    expect(audit.entityId).toBe(created.id);
  });
});
