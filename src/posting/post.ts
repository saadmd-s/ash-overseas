/**
 * The posting layer — a thin wrapper around the pure engine that performs the
 * database writes.
 *
 * It contains NO arithmetic (§15.1). Every figure comes from src/money, every
 * posting decision from src/ledger. This module's only job is composing the
 * `db.batch([...])` correctly.
 *
 * SRS §15.3: D1 offers no interactive BEGIN…COMMIT over the Workers binding, so
 * every multi-row write MUST be one batch — header, lines, ledger entry,
 * human-ID sequence and audit row commit together or not at all.
 */

import { and, desc, eq, gt, or, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema';
import { lineAmount, transactionTotals, type Paise } from '../money';
import { post, type BankAccount, type LedgerEvent } from '../ledger/engine';
import {
  allocateSequence,
  humanIdExpr,
  prefixForPayment,
  prefixForTransaction,
  sequenceScope,
} from './ids';
import { recomputeLedger } from './recompute';
import type { BatchItem, Db } from './db';

export { makeDb } from './db';
export type { Db } from './db';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The running balance as of the last entry on or before `entryDate`.
 *
 * §15.2 computes the new balance from "the previous entry's running balance for
 * that dealer" — previous in `(entry_date, id)` order (§15.4), not insertion
 * order. A dealer with no entries is 0: settled.
 */
export async function balanceBefore(db: Db, dealerId: number, entryDate: string): Promise<Paise> {
  const rows = await db
    .select({ balance: schema.ledgerEntries.runningBalancePaise })
    .from(schema.ledgerEntries)
    .where(
      and(
        eq(schema.ledgerEntries.dealerId, dealerId),
        sql`${schema.ledgerEntries.entryDate} <= ${entryDate}`,
      ),
    )
    .orderBy(desc(schema.ledgerEntries.entryDate), desc(schema.ledgerEntries.id))
    .limit(1);

  return rows[0]?.balance ?? 0;
}

/** The dealer's current balance — the stored value, never recomputed (FR-L1). */
export async function currentBalance(db: Db, dealerId: number): Promise<Paise> {
  const rows = await db
    .select({ balance: schema.ledgerEntries.runningBalancePaise })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.dealerId, dealerId))
    .orderBy(desc(schema.ledgerEntries.entryDate), desc(schema.ledgerEntries.id))
    .limit(1);

  return rows[0]?.balance ?? 0;
}

/**
 * Did this insert land before existing entries? If so every later running
 * balance is now stale and §15.6 requires a replay.
 */
async function hasEntriesAfter(
  db: Db,
  dealerId: number,
  entryDate: string,
  id: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.ledgerEntries.id })
    .from(schema.ledgerEntries)
    .where(
      and(
        eq(schema.ledgerEntries.dealerId, dealerId),
        or(
          gt(schema.ledgerEntries.entryDate, entryDate),
          and(eq(schema.ledgerEntries.entryDate, entryDate), gt(schema.ledgerEntries.id, id)),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Transactions (goods)
// ---------------------------------------------------------------------------

export interface TransactionLineInput {
  itemName?: string | null;
  quantity: number;
  unit?: string | null;
  ratePaise: Paise;
}

export interface CreateTransactionInput {
  dealerId: number;
  mode: 'purchase' | 'sale';
  entryDate: string;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  referenceTag?: string | null;
  bankAccount: BankAccount;
  gstRate: number;
  discountPaise?: Paise;
  freightPaise?: Paise;
  isReturnNote?: boolean;
  notes?: string | null;
  lines: TransactionLineInput[];
}

export interface CreatedTransaction {
  id: number;
  humanId: string;
  grandTotalPaise: Paise;
  roundOffPaise: Paise;
  runningBalancePaise: Paise;
}

/**
 * Build every statement for a transaction create, in commit order.
 *
 * Exported so the atomicity test can take this exact array, break one statement
 * in the middle, and prove the batch leaves nothing behind (§15.3). A test that
 * built its own approximation of the batch would prove nothing about this code.
 */
export function buildTransactionBatch(
  db: Db,
  input: CreateTransactionInput,
  priorBalancePaise: Paise,
): { statements: BatchItem[]; scope: string; grandTotalPaise: Paise; roundOffPaise: Paise } {
  const discountPaise = input.discountPaise ?? 0;
  const freightPaise = input.freightPaise ?? 0;
  const isReturnNote = input.isReturnNote ?? false;

  // Every figure from the money module. Nothing is computed here.
  const linesPaise = input.lines.map((l) => lineAmount(l.quantity, l.ratePaise));
  const totals = transactionTotals({
    linesPaise,
    discountPaise,
    freightPaise,
    gstRate: input.gstRate,
  });

  // The posting decision from the pure engine. Nothing is decided here.
  const event: LedgerEvent = {
    kind: 'transaction',
    mode: input.mode,
    isReturnNote,
    grandTotalPaise: totals.grandTotalPaise,
    entryDate: input.entryDate,
    bankAccount: input.bankAccount,
  };
  const entry = post(priorBalancePaise, event);

  const scope = sequenceScope(prefixForTransaction(input.mode), input.entryDate);
  const humanId = humanIdExpr(scope);
  // The header row, found by its UNIQUE human_id — see ids.ts for why.
  const txId: SQL = sql`(SELECT id FROM transactions WHERE human_id = ${humanId})`;

  const statements: BatchItem[] = [
    // 1. Allocate the human-ID sequence, inside the batch (§15.3).
    allocateSequence(db, scope),

    // 2. The header.
    db.insert(schema.transactions).values({
      humanId: humanId as unknown as string,
      mode: input.mode,
      dealerId: input.dealerId,
      entryDate: input.entryDate,
      invoiceNo: input.invoiceNo ?? null,
      invoiceDate: input.invoiceDate ?? null,
      referenceTag: input.referenceTag ?? null,
      bankAccount: input.bankAccount,
      gstRate: input.gstRate,
      baseTotalPaise: totals.baseTotalPaise,
      discountPaise,
      freightPaise,
      gstAmountPaise: totals.gstAmountPaise,
      roundOffPaise: totals.roundOffPaise,
      grandTotalPaise: totals.grandTotalPaise,
      isReturnNote,
      notes: input.notes ?? null,
      isVoided: false,
    }),

    // 3. The lines.
    ...input.lines.map((line, i) =>
      db.insert(schema.transactionLines).values({
        transactionId: txId as unknown as number,
        lineNo: i + 1,
        itemName: line.itemName ?? null,
        quantity: line.quantity,
        unit: line.unit ?? null,
        ratePaise: line.ratePaise,
        amountPaise: linesPaise[i],
      }),
    ),

    // 4. The ledger entry, with its running balance already computed (§15.2).
    db.insert(schema.ledgerEntries).values({
      dealerId: input.dealerId,
      entryDate: input.entryDate,
      sourceType: 'transaction',
      sourceId: txId as unknown as number,
      debitPaise: entry.debitPaise,
      creditPaise: entry.creditPaise,
      runningBalancePaise: entry.runningBalancePaise,
      bankAccount: entry.bankAccount,
      label: entry.label,
      description: input.referenceTag ?? input.invoiceNo ?? null,
    }),

    // 5. The audit row (FR-A4). No money in `before`; this is a create.
    db.insert(schema.auditLog).values({
      action: 'create',
      entity: 'transactions',
      entityId: txId as unknown as number,
      beforeJson: null,
      afterJson: JSON.stringify({
        humanIdScope: scope,
        mode: input.mode,
        dealerId: input.dealerId,
        entryDate: input.entryDate,
        grandTotalPaise: totals.grandTotalPaise,
        roundOffPaise: totals.roundOffPaise,
      }),
    }),
  ];

  return {
    statements,
    scope,
    grandTotalPaise: totals.grandTotalPaise,
    roundOffPaise: totals.roundOffPaise,
  };
}

export async function createTransaction(
  db: Db,
  input: CreateTransactionInput,
): Promise<CreatedTransaction> {
  const priorBalancePaise = await balanceBefore(db, input.dealerId, input.entryDate);
  const { statements, scope, grandTotalPaise, roundOffPaise } = buildTransactionBatch(
    db,
    input,
    priorBalancePaise,
  );

  await db.batch(statements as [BatchItem, ...BatchItem[]]);

  const created = await db
    .select({ id: schema.transactions.id, humanId: schema.transactions.humanId })
    .from(schema.transactions)
    .where(eq(schema.transactions.humanId, sql`${humanIdExpr(scope)}`))
    .limit(1);

  const row = created[0];
  if (!row) throw new Error('Transaction was not written — the batch did not commit.');

  const ledgerRow = await db
    .select({ id: schema.ledgerEntries.id })
    .from(schema.ledgerEntries)
    .where(
      and(
        eq(schema.ledgerEntries.sourceType, 'transaction'),
        eq(schema.ledgerEntries.sourceId, row.id),
      ),
    )
    .limit(1);

  // §15.6 — a back-dated entry is legitimate. Post it, then replay, so every
  // later running balance is rewritten and the stored balance is never stale.
  if (
    ledgerRow[0] &&
    (await hasEntriesAfter(db, input.dealerId, input.entryDate, ledgerRow[0].id))
  ) {
    await recomputeLedger(db, input.dealerId);
  }

  return {
    id: row.id,
    humanId: row.humanId,
    grandTotalPaise,
    roundOffPaise,
    runningBalancePaise: await currentBalance(db, input.dealerId),
  };
}

// ---------------------------------------------------------------------------
// Payments (money)
// ---------------------------------------------------------------------------

export interface CreatePaymentInput {
  dealerId: number;
  entryDate: string;
  direction: 'received' | 'paid';
  amountPaise: Paise;
  method?: 'cash' | 'bank' | 'cheque' | 'upi' | null;
  bankAccount?: BankAccount | null;
  reference?: string | null;
  notes?: string | null;
}

export interface CreatedPayment {
  id: number;
  humanId: string;
  runningBalancePaise: Paise;
}

export function buildPaymentBatch(
  db: Db,
  input: CreatePaymentInput,
  priorBalancePaise: Paise,
): { statements: BatchItem[]; scope: string } {
  const event: LedgerEvent = {
    kind: 'payment',
    direction: input.direction,
    amountPaise: input.amountPaise,
    entryDate: input.entryDate,
    bankAccount: input.bankAccount ?? null,
  };
  const entry = post(priorBalancePaise, event);

  const scope = sequenceScope(prefixForPayment(input.direction), input.entryDate);
  const humanId = humanIdExpr(scope);
  const payId: SQL = sql`(SELECT id FROM payments WHERE human_id = ${humanId})`;

  const statements: BatchItem[] = [
    allocateSequence(db, scope),

    db.insert(schema.payments).values({
      humanId: humanId as unknown as string,
      dealerId: input.dealerId,
      entryDate: input.entryDate,
      direction: input.direction,
      amountPaise: input.amountPaise,
      // §10.7 — the bank tag is omitted for cash.
      method: input.method ?? null,
      bankAccount: input.method === 'cash' ? null : (input.bankAccount ?? null),
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      isVoided: false,
    }),

    db.insert(schema.ledgerEntries).values({
      dealerId: input.dealerId,
      entryDate: input.entryDate,
      sourceType: 'payment',
      sourceId: payId as unknown as number,
      debitPaise: entry.debitPaise,
      creditPaise: entry.creditPaise,
      runningBalancePaise: entry.runningBalancePaise,
      bankAccount: entry.bankAccount,
      label: entry.label,
      description: input.reference ?? null,
    }),

    db.insert(schema.auditLog).values({
      action: 'create',
      entity: 'payments',
      entityId: payId as unknown as number,
      beforeJson: null,
      afterJson: JSON.stringify({
        humanIdScope: scope,
        dealerId: input.dealerId,
        entryDate: input.entryDate,
        direction: input.direction,
        amountPaise: input.amountPaise,
      }),
    }),
  ];

  return { statements, scope };
}

export async function createPayment(db: Db, input: CreatePaymentInput): Promise<CreatedPayment> {
  const priorBalancePaise = await balanceBefore(db, input.dealerId, input.entryDate);
  const { statements, scope } = buildPaymentBatch(db, input, priorBalancePaise);

  await db.batch(statements as [BatchItem, ...BatchItem[]]);

  const created = await db
    .select({ id: schema.payments.id, humanId: schema.payments.humanId })
    .from(schema.payments)
    .where(eq(schema.payments.humanId, sql`${humanIdExpr(scope)}`))
    .limit(1);

  const row = created[0];
  if (!row) throw new Error('Payment was not written — the batch did not commit.');

  const ledgerRow = await db
    .select({ id: schema.ledgerEntries.id })
    .from(schema.ledgerEntries)
    .where(
      and(
        eq(schema.ledgerEntries.sourceType, 'payment'),
        eq(schema.ledgerEntries.sourceId, row.id),
      ),
    )
    .limit(1);

  if (
    ledgerRow[0] &&
    (await hasEntriesAfter(db, input.dealerId, input.entryDate, ledgerRow[0].id))
  ) {
    await recomputeLedger(db, input.dealerId);
  }

  return {
    id: row.id,
    humanId: row.humanId,
    runningBalancePaise: await currentBalance(db, input.dealerId),
  };
}

// ---------------------------------------------------------------------------
// Dealers
// ---------------------------------------------------------------------------

export interface CreateDealerInput {
  name: string;
  contact?: string | null;
  address?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
  type?: 'supplier' | 'buyer' | 'both';
  /** FR-D5 — recorded as an `opening` ledger entry, never a mutable field. */
  opening?: { direction: 'owes_us' | 'we_owe'; amountPaise: Paise; entryDate: string };
}

export async function createDealer(db: Db, input: CreateDealerInput): Promise<{ id: number }> {
  const inserted = await db
    .insert(schema.dealers)
    .values({
      name: input.name,
      contact: input.contact ?? null,
      address: input.address ?? null,
      gstin: input.gstin ?? null,
      stateCode: input.stateCode ?? null,
      type: input.type ?? 'both',
      isArchived: false,
    })
    .returning({ id: schema.dealers.id });

  const dealer = inserted[0];
  if (!dealer) throw new Error('Dealer was not created.');

  if (input.opening) {
    const entry = post(0, {
      kind: 'opening',
      direction: input.opening.direction,
      amountPaise: input.opening.amountPaise,
      entryDate: input.opening.entryDate,
    });

    await db.batch([
      db.insert(schema.ledgerEntries).values({
        dealerId: dealer.id,
        entryDate: input.opening.entryDate,
        sourceType: 'opening',
        // §12.3 leaves the convention unstated; an opening entry has no separate
        // source record — the dealer is already named on the row. See
        // docs/BACKEND_SCHEMA.md §4.5.
        sourceId: null,
        debitPaise: entry.debitPaise,
        creditPaise: entry.creditPaise,
        runningBalancePaise: entry.runningBalancePaise,
        bankAccount: null,
        label: 'Opening',
        description: 'Opening position',
      }),
      db.insert(schema.auditLog).values({
        action: 'create',
        entity: 'dealers',
        entityId: dealer.id,
        beforeJson: null,
        afterJson: JSON.stringify({ opening: input.opening }),
      }),
    ]);
  }

  return { id: dealer.id };
}
