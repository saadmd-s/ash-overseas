/**
 * Human-readable identifiers — FR-T9.
 *
 * `{MODE}-{YYYY}-{MM}-{NNNN}`, e.g. `SALE-2026-08-0039`. The sequence is
 * zero-padded and scoped to mode and month, and is generated inside the same
 * atomic write as everything else (§15.3).
 *
 * The counter lives in `id_sequences` — a table the SRS requires the behaviour
 * of but never defines. Owner-approved 29 Aug 2026; see docs/BACKEND_SCHEMA.md §7.
 */

import { sql, type SQL } from 'drizzle-orm';
import { idSequences } from '../db/schema';
import type { BatchItem, Db } from './db';

export type IdPrefix = 'SALE' | 'PURCHASE' | 'RCPT' | 'PAY';

/** The sequence scope for an entry: `SALE-2026-08`. */
export function sequenceScope(prefix: IdPrefix, entryDate: string): string {
  // entry_date is text 'YYYY-MM-DD' (§12.4), so the year and month are a slice.
  // No Date object is constructed: this is an IST calendar date, not an instant,
  // and parsing it into a Date is how off-by-one-day bugs get in.
  return `${prefix}-${entryDate.slice(0, 7)}`;
}

export function prefixForTransaction(mode: 'purchase' | 'sale'): IdPrefix {
  return mode === 'sale' ? 'SALE' : 'PURCHASE';
}

export function prefixForPayment(direction: 'received' | 'paid'): IdPrefix {
  return direction === 'received' ? 'RCPT' : 'PAY';
}

/**
 * Consume the next number in a scope.
 *
 * One statement, so it is atomic on its own and atomic with everything around
 * it inside a batch. After it runs, `next_value` holds the number that will be
 * issued NEXT, so the one just consumed is `next_value - 1` — which is what
 * {@link humanIdExpr} reads.
 *
 * The sequence never rewinds and a number is never reused, so a human ID refers
 * to exactly one record forever, voided or not. That is what makes it safe to
 * quote in conversation and print in an export, and it is why a count of rows
 * would be the wrong counter: voided rows are retained.
 */
export function allocateSequence(db: Db, scope: string): BatchItem {
  return db
    .insert(idSequences)
    .values({ scope, nextValue: 2 })
    .onConflictDoUpdate({
      target: idSequences.scope,
      set: { nextValue: sql`${idSequences.nextValue} + 1` },
    });
}

/**
 * The human ID, computed in SQL from the counter allocated above.
 *
 * This is the answer to the batch ID-allocation problem (docs/TRD.md §5.1).
 * D1 will not surface one statement's generated key to a later statement in the
 * same batch, and splitting into two batches would break the all-or-nothing
 * guarantee §15.3 demands. Deriving the ID in SQL keeps the whole write in one
 * batch — and because `human_id` is UNIQUE, every later statement can find the
 * header row it belongs to without ever knowing its integer id.
 */
export function humanIdExpr(scope: string): SQL {
  return sql`(${scope} || '-' || printf('%04d', (SELECT next_value - 1 FROM id_sequences WHERE scope = ${scope})))`;
}
