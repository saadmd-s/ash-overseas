/**
 * Replay and voids — SRS §15.5, §15.6, §15.7.
 *
 * Like the rest of the posting layer this does no arithmetic of its own: it
 * reads rows, hands them to the pure `replay()`, and writes back what comes out.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  compareEntryOrder,
  replay,
  verifyRunningBalances,
  type ReplayableEntry,
} from '../ledger/engine';
import type { BatchItem, Db } from './db';
import type { Paise } from '../money';

/**
 * Which ledger rows a replay sees.
 *
 * §15.5 says "all non-voided entries". §15.8 rule 5 settles what that means for
 * reversals: a voided source keeps its rows, and "their effect is neutralised
 * ONLY by reversing entries" — so the original entry and its reversal both stay
 * in the replay, cancelling each other out. Dropping the pair instead would
 * reach the same final balance but erase the correction from the history, and
 * §10.5 and §11.4 both require the reversal to remain visible.
 */
async function replayableEntries(db: Db, dealerId: number) {
  return db
    .select({
      id: schema.ledgerEntries.id,
      entryDate: schema.ledgerEntries.entryDate,
      debitPaise: schema.ledgerEntries.debitPaise,
      creditPaise: schema.ledgerEntries.creditPaise,
      runningBalancePaise: schema.ledgerEntries.runningBalancePaise,
      label: schema.ledgerEntries.label,
      bankAccount: schema.ledgerEntries.bankAccount,
    })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.dealerId, dealerId))
    .orderBy(asc(schema.ledgerEntries.entryDate), asc(schema.ledgerEntries.id));
}

function asReplayable(rows: Awaited<ReturnType<typeof replayableEntries>>): ReplayableEntry[] {
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entryDate,
    debitPaise: r.debitPaise,
    creditPaise: r.creditPaise,
    label: (r.label ?? 'Sale') as ReplayableEntry['label'],
    bankAccount: r.bankAccount,
  }));
}

/**
 * §15.5 — replay all entries for a dealer in `(entry_date, id)` order and
 * rewrite every running balance from zero.
 *
 * Called after every void (§15.7) and after any back-dated insert that lands
 * before existing entries (§15.6).
 *
 * The writes are batched, as §15.7 requires. Only rows whose balance actually
 * changed are written — a replay after a late-dated insert usually touches
 * nothing, and an empty batch is skipped entirely.
 */
export async function recomputeLedger(db: Db, dealerId: number): Promise<{ updated: number }> {
  /*
   * Sorted here with the engine's OWN comparator, even though the query
   * already orders by (entry_date, id).
   *
   * The loop below pairs `rows[i]` with `recomputed[i]` by position, and
   * `replay` re-sorts internally — so the two agree only for as long as the SQL
   * ORDER BY and `compareEntryOrder` stay identical. If they ever diverged, this
   * would write each recomputed balance onto the WRONG entry: no error, no
   * failing insert, just silently corrupted running balances across a dealer's
   * whole history. Sorting both sides through the same function removes the
   * coupling rather than documenting it.
   */
  const rows = (await replayableEntries(db, dealerId)).sort(compareEntryOrder);
  if (rows.length === 0) return { updated: 0 };

  const recomputed = replay(asReplayable(rows));

  const updates: BatchItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const stored = rows[i].runningBalancePaise;
    const expected = recomputed[i].runningBalancePaise;
    if (stored !== expected) {
      updates.push(
        db
          .update(schema.ledgerEntries)
          .set({ runningBalancePaise: expected })
          .where(eq(schema.ledgerEntries.id, rows[i].id)),
      );
    }
  }

  if (updates.length === 0) return { updated: 0 };
  await db.batch(updates as [BatchItem, ...BatchItem[]]);
  return { updated: updates.length };
}

/**
 * §15.8 — does a replay reproduce every stored running balance?
 *
 * The arithmetic is integer and exact, so a divergence is a defect, never
 * rounding drift.
 */
export async function checkLedgerIntegrity(db: Db, dealerId: number) {
  const rows = await replayableEntries(db, dealerId);
  return verifyRunningBalances(
    rows.map((r) => ({
      id: r.id,
      entryDate: r.entryDate,
      debitPaise: r.debitPaise,
      creditPaise: r.creditPaise,
      runningBalancePaise: r.runningBalancePaise,
      label: (r.label ?? 'Sale') as ReplayableEntry['label'],
      bankAccount: r.bankAccount,
    })),
  );
}

// ---------------------------------------------------------------------------
// Voids — §15.7
// ---------------------------------------------------------------------------

export interface VoidResult {
  reversalEntryId: number;
  runningBalancePaise: Paise;
}

/**
 * Void a transaction or a payment.
 *
 * §15.7, in order, all in one batch:
 *   1. post a reversing ledger row, equal and opposite, linked to the original
 *   2. flag the source `is_voided` — its own rows are retained in full
 *   3. write an audit row with before/after state
 * then run `recomputeLedger`.
 *
 * Nothing is ever hard-deleted (FR-A1, §15.8 rule 1).
 */
async function voidSource(
  db: Db,
  opts: {
    sourceType: 'transaction' | 'payment';
    sourceId: number;
    dealerId: number;
    flagVoided: BatchItem;
    beforeJson: string;
  },
): Promise<VoidResult> {
  const originals = await db
    .select({
      id: schema.ledgerEntries.id,
      entryDate: schema.ledgerEntries.entryDate,
      debitPaise: schema.ledgerEntries.debitPaise,
      creditPaise: schema.ledgerEntries.creditPaise,
      bankAccount: schema.ledgerEntries.bankAccount,
    })
    .from(schema.ledgerEntries)
    .where(
      and(
        eq(schema.ledgerEntries.sourceType, opts.sourceType),
        eq(schema.ledgerEntries.sourceId, opts.sourceId),
      ),
    )
    .limit(1);

  const original = originals[0];
  if (!original) throw new Error('No ledger entry found for that record.');

  const alreadyReversed = await db
    .select({ id: schema.ledgerEntries.id })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.reversesEntryId, original.id))
    .limit(1);
  if (alreadyReversed[0]) throw new Error('That record has already been voided.');

  // The reversal is equal and opposite. Its running balance is provisional —
  // recomputeLedger below rewrites every balance from zero, which is what makes
  // the result correct even when the void is of a back-dated entry.
  const provisional = sql`(SELECT COALESCE(
      (SELECT running_balance_paise FROM ledger_entries
        WHERE dealer_id = ${opts.dealerId}
        ORDER BY entry_date DESC, id DESC LIMIT 1), 0)
    + ${original.creditPaise} - ${original.debitPaise})`;

  await db.batch([
    db.insert(schema.ledgerEntries).values({
      dealerId: opts.dealerId,
      // The reversal carries the ORIGINAL entry's date, so replay places it
      // beside what it undoes rather than at the end of the history.
      entryDate: original.entryDate,
      sourceType: 'reversal',
      sourceId: opts.sourceId,
      reversesEntryId: original.id,
      debitPaise: original.creditPaise,
      creditPaise: original.debitPaise,
      runningBalancePaise: provisional as unknown as number,
      bankAccount: original.bankAccount,
      label: 'Reversal',
      description: `Reversal of ${opts.sourceType} #${opts.sourceId}`,
    }),
    opts.flagVoided,
    db.insert(schema.auditLog).values({
      action: 'void',
      entity: opts.sourceType === 'transaction' ? 'transactions' : 'payments',
      entityId: opts.sourceId,
      beforeJson: opts.beforeJson,
      afterJson: JSON.stringify({ isVoided: true, reversesEntryId: original.id }),
    }),
  ]);

  const reversal = await db
    .select({ id: schema.ledgerEntries.id })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.reversesEntryId, original.id))
    .limit(1);

  await recomputeLedger(db, opts.dealerId);

  const balance = await db
    .select({ balance: schema.ledgerEntries.runningBalancePaise })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.dealerId, opts.dealerId))
    .orderBy(sql`entry_date DESC`, sql`id DESC`)
    .limit(1);

  return {
    reversalEntryId: reversal[0]!.id,
    runningBalancePaise: balance[0]?.balance ?? 0,
  };
}

export async function voidTransaction(db: Db, transactionId: number): Promise<VoidResult> {
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transactionId))
    .limit(1);

  const tx = rows[0];
  if (!tx) throw new Error('No such transaction.');
  if (tx.isVoided) throw new Error('That transaction is already voided.');

  return voidSource(db, {
    sourceType: 'transaction',
    sourceId: transactionId,
    dealerId: tx.dealerId,
    flagVoided: db
      .update(schema.transactions)
      .set({ isVoided: true })
      .where(eq(schema.transactions.id, transactionId)),
    beforeJson: JSON.stringify({
      humanId: tx.humanId,
      mode: tx.mode,
      entryDate: tx.entryDate,
      grandTotalPaise: tx.grandTotalPaise,
      isVoided: false,
    }),
  });
}

export async function voidPayment(db: Db, paymentId: number): Promise<VoidResult> {
  const rows = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId))
    .limit(1);

  const pay = rows[0];
  if (!pay) throw new Error('No such payment.');
  if (pay.isVoided) throw new Error('That payment is already voided.');

  return voidSource(db, {
    sourceType: 'payment',
    sourceId: paymentId,
    dealerId: pay.dealerId,
    flagVoided: db
      .update(schema.payments)
      .set({ isVoided: true })
      .where(eq(schema.payments.id, paymentId)),
    beforeJson: JSON.stringify({
      humanId: pay.humanId,
      direction: pay.direction,
      entryDate: pay.entryDate,
      amountPaise: pay.amountPaise,
      isVoided: false,
    }),
  });
}
