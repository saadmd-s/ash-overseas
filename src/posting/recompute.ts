/** Atomic correction and replay; all money decisions stay in the pure engine. */
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { verifyRunningBalances, type ReplayableEntry } from '../ledger/engine';
import { ledgerRows, planAppend, replayUpdates } from './ledger-write';
import { withLedgerWrite, type PreparedWrite } from './write';
import type { BatchItem, Db } from './db';
import type { Paise } from '../money';

export async function recomputeLedger(db: Db, dealerId: number): Promise<{ updated: number }> {
  return withLedgerWrite(db, async () => {
    const { updates, changed: updated } = replayUpdates(db, await ledgerRows(db, dealerId));
    if (updated)
      updates.push(
        db.insert(schema.auditLog).values({
          action: 'replay',
          entity: 'dealers',
          entityId: dealerId,
          afterJson: JSON.stringify({ updated }),
        }),
      );
    return { statements: updates, result: () => ({ updated }) };
  });
}

export async function checkLedgerIntegrity(db: Db, dealerId: number) {
  const rows = await ledgerRows(db, dealerId);
  return verifyRunningBalances(
    rows.map((r) => ({ ...r, label: (r.label ?? 'Sale') as ReplayableEntry['label'] })),
  );
}

export interface VoidResult {
  reversalEntryId: number;
  runningBalancePaise: Paise;
}
export class VoidConflict extends Error {}

async function prepareVoid(
  db: Db,
  opts: {
    sourceType: 'transaction' | 'payment' | 'opening';
    sourceId: number | null;
    dealerId: number;
    flagVoided: BatchItem | null;
    originalEntryId?: number;
    beforeJson: string;
  },
): Promise<PreparedWrite<VoidResult>> {
  const [original] = await db
    .select()
    .from(schema.ledgerEntries)
    .where(
      opts.originalEntryId !== undefined
        ? eq(schema.ledgerEntries.id, opts.originalEntryId)
        : and(
            eq(schema.ledgerEntries.sourceType, opts.sourceType),
            eq(schema.ledgerEntries.sourceId, opts.sourceId ?? -1),
          ),
    )
    .limit(1);
  if (!original) throw new Error('No ledger entry found for that record.');
  const [reversed] = await db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.reversesEntryId, original.id))
    .limit(1);
  if (reversed) throw new VoidConflict('That entry has already been deleted.');
  const plan = await planAppend(db, opts.dealerId, {
    kind: 'reversal',
    reverses: original,
    entryDate: original.entryDate,
    bankAccount: original.bankAccount,
  });
  const entry = plan.entry;
  const statements: BatchItem[] = [
    db
      .insert(schema.ledgerEntries)
      .values({
        dealerId: opts.dealerId,
        entryDate: original.entryDate,
        sourceType: 'reversal',
        sourceId: opts.sourceId,
        reversesEntryId: original.id,
        debitPaise: entry.debitPaise,
        creditPaise: entry.creditPaise,
        runningBalancePaise: entry.runningBalancePaise,
        bankAccount: original.bankAccount,
        label: 'Reversal',
        description: 'Cancels a deleted entry',
      })
      .returning({ id: schema.ledgerEntries.id }),
    db.insert(schema.auditLog).values({
      action: 'void',
      entity:
        opts.sourceType === 'transaction'
          ? 'transactions'
          : opts.sourceType === 'payment'
            ? 'payments'
            : 'dealers',
      entityId: opts.sourceType === 'opening' ? opts.dealerId : opts.sourceId,
      beforeJson: opts.beforeJson,
      afterJson: JSON.stringify({ isVoided: true, reversesEntryId: original.id }),
    }),
  ];
  if (opts.flagVoided) statements.push(opts.flagVoided);
  statements.push(...plan.updates);
  return {
    statements,
    result: (results) => ({
      reversalEntryId: (results[0] as { id: number }[])[0].id,
      runningBalancePaise: plan.closingBalance,
    }),
  };
}

export async function voidTransaction(db: Db, transactionId: number): Promise<VoidResult> {
  return withLedgerWrite(db, async () => {
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, transactionId))
      .limit(1);

    const tx = rows[0];
    if (!tx) throw new VoidConflict('No such transaction.');
    if (tx.isVoided) throw new VoidConflict('That entry has already been deleted.');

    return prepareVoid(db, {
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
  });
}

/**
 * Delete a dealer's balance carried over from the old book.
 *
 * The same void as any other entry — an equal and opposite cancellation, an
 * audit row, a replay — addressed by the ledger row itself, because an opening
 * has no source record to flag.
 */
export async function voidOpening(db: Db, dealerId: number): Promise<VoidResult> {
  return withLedgerWrite(db, async () => {
    const openings = await db
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.dealerId, dealerId),
          eq(schema.ledgerEntries.sourceType, 'opening'),
        ),
      )
      .orderBy(asc(schema.ledgerEntries.id));

    for (const opening of openings) {
      const reversed = await db
        .select({ id: schema.ledgerEntries.id })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.reversesEntryId, opening.id))
        .limit(1);
      if (reversed[0]) continue;

      return prepareVoid(db, {
        sourceType: 'opening',
        sourceId: null,
        dealerId,
        flagVoided: null,
        originalEntryId: opening.id,
        beforeJson: JSON.stringify({
          opening: {
            entryDate: opening.entryDate,
            debitPaise: opening.debitPaise,
            creditPaise: opening.creditPaise,
          },
        }),
      });
    }

    throw new VoidConflict('This dealer has no balance from the old book to delete.');
  });
}

export async function voidPayment(db: Db, paymentId: number): Promise<VoidResult> {
  return withLedgerWrite(db, async () => {
    const rows = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId))
      .limit(1);

    const pay = rows[0];
    if (!pay) throw new VoidConflict('No such payment.');
    if (pay.isVoided) throw new VoidConflict('That entry has already been deleted.');

    return prepareVoid(db, {
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
  });
}
