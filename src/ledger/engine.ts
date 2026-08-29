/**
 * The ledger engine — a PURE module with no database imports.
 *
 * SRS §15.1: given a prior balance and an event, it returns the entry to post.
 * The §6 scenarios exercise it directly, with no D1 in the test.
 *
 * ⚠ PHASE 0: contract only. The implementations throw, so the §6 acceptance
 * suite fails for the right reason — the figures are encoded before the engine
 * exists, which is what stops the engine being written to match whatever it
 * happens to produce. Implement in Phase 1 (SRS §23).
 */

import type { Paise } from '../money';

export type BankAccount = 'od' | 'current';

export type EntryLabel = 'Sale' | 'Purchase' | 'Received' | 'Paid' | 'Opening' | 'Reversal';

/** The movement an entry makes, independent of how it was stored. */
export interface Movement {
  debitPaise: Paise;
  creditPaise: Paise;
}

export type LedgerEvent =
  | {
      kind: 'transaction';
      mode: 'purchase' | 'sale';
      /** A return / credit-debit note posts OPPOSITE to its mode — §7. */
      isReturnNote: boolean;
      grandTotalPaise: Paise;
      entryDate: string;
      bankAccount: BankAccount;
    }
  | {
      kind: 'payment';
      /** received = money FROM the dealer. */
      direction: 'received' | 'paid';
      amountPaise: Paise;
      entryDate: string;
      bankAccount: BankAccount | null;
    }
  | {
      kind: 'opening';
      direction: 'owes_us' | 'we_owe';
      amountPaise: Paise;
      entryDate: string;
    }
  | {
      kind: 'reversal';
      /** The movement being undone; the reversal is equal and opposite. */
      reverses: Movement;
      entryDate: string;
      bankAccount: BankAccount | null;
    };

export interface PostedEntry extends Movement {
  runningBalancePaise: Paise;
  label: EntryLabel;
  bankAccount: BankAccount | null;
  entryDate: string;
}

/**
 * The whole of SRS §7, as one pure function.
 *
 * | Event                     | Effect                      |
 * | ------------------------- | --------------------------- |
 * | Sale (goods to dealer)    | debit  grandTotalPaise      |
 * | Purchase (goods from)     | credit grandTotalPaise      |
 * | Money received            | credit amountPaise          |
 * | Money paid                | debit  amountPaise          |
 * | Opening                   | debit or credit as entered  |
 * | Reversal                  | equal and opposite          |
 *
 * A transaction flagged `isReturnNote` posts opposite to its mode.
 *
 * runningBalancePaise = priorBalancePaise + debitPaise − creditPaise.
 * Exactly one of debit/credit is non-zero on any entry.
 */
export function post(_priorBalancePaise: Paise, _event: LedgerEvent): PostedEntry {
  throw new Error('post() is not implemented — Phase 1 (SRS §23)');
}

/** A stored entry as replay sees it: its movement plus its order key. */
export interface ReplayableEntry extends Movement {
  id: number;
  entryDate: string;
  label: EntryLabel;
  bankAccount: BankAccount | null;
}

/**
 * SRS §15.5 — replay all non-voided entries from zero (or the opening entry),
 * in `(entry_date, id)` order, recomputing every running balance.
 *
 * Called after every void, and after any back-dated insert that lands before
 * existing entries (§15.6). The caller is responsible for having excluded
 * voided sources; this function replays exactly what it is given.
 */
export function replay(_entries: ReplayableEntry[]): PostedEntry[] {
  throw new Error('replay() is not implemented — Phase 1 (SRS §23)');
}
