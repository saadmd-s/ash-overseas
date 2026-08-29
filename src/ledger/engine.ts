/**
 * The ledger engine — a PURE module with no database imports.
 *
 * SRS §15.1: given a prior balance and an event, it returns the entry to post.
 * The §6 scenarios exercise it directly, with no D1 in the test.
 *
 * The §6 acceptance scenarios were encoded against this contract in Phase 0,
 * before any of it was implemented, so the figures could not be written to
 * match whatever the engine happened to produce.
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
export function post(priorBalancePaise: Paise, event: LedgerEvent): PostedEntry {
  const movement = movementFor(event);

  return {
    ...movement,
    // The whole of the sign convention, in one line (§5).
    runningBalancePaise: priorBalancePaise + movement.debitPaise - movement.creditPaise,
    label: labelFor(event),
    bankAccount: bankAccountFor(event),
    entryDate: event.entryDate,
  };
}

/** Which way the money moves, and by how much — the whole of §7. */
function movementFor(event: LedgerEvent): Movement {
  switch (event.kind) {
    case 'transaction': {
      // A sale debits and a purchase credits — unless the transaction is a
      // return or credit/debit note, which posts OPPOSITE to its mode (§7).
      const debits = event.isReturnNote ? event.mode === 'purchase' : event.mode === 'sale';
      return debits
        ? { debitPaise: event.grandTotalPaise, creditPaise: 0 }
        : { debitPaise: 0, creditPaise: event.grandTotalPaise };
    }

    case 'payment':
      // received = money FROM the dealer, so the business owes them more.
      return event.direction === 'received'
        ? { debitPaise: 0, creditPaise: event.amountPaise }
        : { debitPaise: event.amountPaise, creditPaise: 0 };

    case 'opening':
      return event.direction === 'owes_us'
        ? { debitPaise: event.amountPaise, creditPaise: 0 }
        : { debitPaise: 0, creditPaise: event.amountPaise };

    case 'reversal':
      // Equal and opposite. Because roundPaise is symmetric about zero, a
      // reversal restores the prior balance exactly — no residue.
      return {
        debitPaise: event.reverses.creditPaise,
        creditPaise: event.reverses.debitPaise,
      };
  }
}

function labelFor(event: LedgerEvent): EntryLabel {
  switch (event.kind) {
    case 'transaction':
      // The label follows the MODE, not the direction of the posting. A sale
      // return is still a Sale in the history; `is_return_note` on the source
      // row is what marks it as a return.
      return event.mode === 'sale' ? 'Sale' : 'Purchase';
    case 'payment':
      return event.direction === 'received' ? 'Received' : 'Paid';
    case 'opening':
      return 'Opening';
    case 'reversal':
      return 'Reversal';
  }
}

function bankAccountFor(event: LedgerEvent): BankAccount | null {
  // Copied onto the entry for filtering and export ONLY. It never reached
  // movementFor above, and it never will — that is the §4.3 invariant, and
  // Scenario F is its test.
  switch (event.kind) {
    case 'transaction':
      return event.bankAccount;
    case 'payment':
    case 'reversal':
      return event.bankAccount;
    case 'opening':
      return null;
  }
}

/**
 * The replay and display order key (§15.4): `(entry_date, id)`.
 *
 * `entry_date` is text `YYYY-MM-DD`, so a lexicographic compare IS a
 * chronological compare — the reason §12.4 chose that format. `id` is the
 * stable tiebreak for entries sharing a date. Insertion order is never relied
 * upon, and money is never sorted by a float.
 */
export function compareEntryOrder(
  a: { entryDate: string; id: number },
  b: { entryDate: string; id: number },
): number {
  if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
  return a.id - b.id;
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
export function replay(entries: ReplayableEntry[]): PostedEntry[] {
  // Sort a copy: replay must not mutate what it was handed.
  const ordered = [...entries].sort(compareEntryOrder);

  let balance = 0;
  return ordered.map((entry) => {
    balance = balance + entry.debitPaise - entry.creditPaise;
    return {
      debitPaise: entry.debitPaise,
      creditPaise: entry.creditPaise,
      runningBalancePaise: balance,
      label: entry.label,
      bankAccount: entry.bankAccount,
      entryDate: entry.entryDate,
    };
  });
}

/**
 * Does a replay of `entries` reproduce every stored running balance?
 *
 * The arithmetic is integer and exact, so there is no rounding drift to excuse
 * a mismatch: any divergence is a defect. Used by the §15.8 integrity check.
 */
export function verifyRunningBalances(
  entries: (ReplayableEntry & { runningBalancePaise: Paise })[],
): { ok: true } | { ok: false; firstDivergenceId: number; expected: Paise; stored: Paise } {
  const ordered = [...entries].sort(compareEntryOrder);
  const recomputed = replay(ordered);

  for (let i = 0; i < ordered.length; i++) {
    const expected = recomputed[i].runningBalancePaise;
    const stored = ordered[i].runningBalancePaise;
    if (expected !== stored) {
      return { ok: false, firstDivergenceId: ordered[i].id, expected, stored };
    }
  }
  return { ok: true };
}
