/**
 * SRS §6 — the six acceptance scenarios, A to F.
 *
 * "These scenarios define correct behaviour precisely. The ledger engine must
 *  reproduce every figure below exactly. They are the application's primary
 *  acceptance tests and must be implemented as automated tests before the
 *  ledger is considered complete."
 *
 * ⚠ PHASE 0: these are EXPECTED TO FAIL. The engine is a contract with throwing
 * bodies. The Phase 0 gate (§23) is that this suite "runs and fails for the
 * right reason" — i.e. `post() is not implemented`, never a wrong figure.
 *
 * Every expected number below is transcribed from §6 and must not be adjusted
 * to match the implementation. If the engine disagrees, the engine is wrong.
 *
 * Figures are in paise: ₹3,23,000 → 32_300_000.
 */

import { describe, expect, it } from 'vitest';
import { lineAmount, transactionTotals } from '../money';
import { post, replay, type LedgerEvent, type PostedEntry, type ReplayableEntry } from './engine';

/** Post a sequence of events from zero, returning every entry in order. */
function postAll(events: LedgerEvent[]): PostedEntry[] {
  const entries: PostedEntry[] = [];
  let balance = 0;
  for (const event of events) {
    const entry = post(balance, event);
    entries.push(entry);
    balance = entry.runningBalancePaise;
  }
  return entries;
}

/** The grand total of a single-line transaction at a given GST rate. */
function saleTotal(quantity: number, ratePaise: number, gstRate = 18): number {
  return transactionTotals({
    linesPaise: [lineAmount(quantity, ratePaise)],
    discountPaise: 0,
    freightPaise: 0,
    gstRate,
  }).grandTotalPaise;
}

// ---------------------------------------------------------------------------

describe('Scenario A — money and goods moving both ways (§6.1)', () => {
  const events: LedgerEvent[] = [
    {
      kind: 'payment',
      direction: 'received',
      amountPaise: 60_000_000, // ₹6,00,000
      entryDate: '2026-08-01',
      bankAccount: 'od',
    },
    {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: saleTotal(1000, 20_000), // 1,000 kg × ₹200 + 18%
      entryDate: '2026-08-05',
      bankAccount: 'od',
    },
    {
      kind: 'transaction',
      mode: 'purchase',
      isReturnNote: false,
      grandTotalPaise: saleTotal(500, 10_000), // 500 kg × ₹100 + 18%
      entryDate: '2026-08-10',
      bankAccount: 'od',
    },
    {
      kind: 'payment',
      direction: 'paid',
      amountPaise: 10_000_000, // ₹1,00,000
      entryDate: '2026-08-15',
      bankAccount: 'od',
    },
  ];

  it('walks the balance through every step exactly', () => {
    const entries = postAll(events);
    expect(entries.map((e) => e.runningBalancePaise)).toEqual([
      -60_000_000, // −6,00,000
      -36_400_000, // −3,64,000
      -42_300_000, // −4,23,000
      -32_300_000, // −3,23,000
    ]);
  });

  it('posts money received as a credit', () => {
    const entry = post(0, events[0]);
    expect(entry.creditPaise).toBe(60_000_000);
    expect(entry.debitPaise).toBe(0);
    expect(entry.label).toBe('Received');
  });

  it('posts a sale as a debit of the rounded grand total', () => {
    const entry = post(-60_000_000, events[1]);
    expect(entry.debitPaise).toBe(23_600_000); // 2,00,000 + 36,000 GST
    expect(entry.creditPaise).toBe(0);
    expect(entry.label).toBe('Sale');
  });

  it('posts a purchase as a credit', () => {
    const entry = post(-36_400_000, events[2]);
    expect(entry.creditPaise).toBe(5_900_000); // 50,000 + 9,000 GST
    expect(entry.debitPaise).toBe(0);
    expect(entry.label).toBe('Purchase');
  });

  it('posts money paid as a debit', () => {
    const entry = post(-42_300_000, events[3]);
    expect(entry.debitPaise).toBe(10_000_000);
    expect(entry.label).toBe('Paid');
  });

  it('ends at "You owe dealer ₹3,23,000"', () => {
    const entries = postAll(events);
    expect(entries.at(-1)!.runningBalancePaise).toBe(-32_300_000);
  });
});

// ---------------------------------------------------------------------------

describe('Scenario B — GST and invoice round-off (§6.2)', () => {
  // 9,510 kg × ₹24.00, GST 18%.
  const totals = transactionTotals({
    linesPaise: [lineAmount(9510, 2400)],
    discountPaise: 0,
    freightPaise: 0,
    gstRate: 18,
  });

  it('computes base ₹2,28,240.00', () => {
    expect(totals.baseTotalPaise).toBe(22_824_000);
  });

  it('computes GST ₹41,083.20', () => {
    expect(totals.gstAmountPaise).toBe(4_108_320);
  });

  it('posts the rounded ₹2,69,323.00, not the raw ₹2,69,323.20', () => {
    expect(totals.grandTotalPaise).toBe(26_932_300);
    expect(totals.taxablePaise + totals.gstAmountPaise).toBe(26_932_320);
  });

  it('stores round_off_paise = −20', () => {
    expect(totals.roundOffPaise).toBe(-20);
  });

  it('debits the ledger with the rounded figure', () => {
    const entry = post(0, {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: totals.grandTotalPaise,
      entryDate: '2026-07-09',
      bankAccount: 'od',
    });
    expect(entry.debitPaise).toBe(26_932_300);
    expect(entry.runningBalancePaise).toBe(26_932_300);
  });
});

// ---------------------------------------------------------------------------

describe('Scenario C — advance against two shipments (§6.3)', () => {
  const events: LedgerEvent[] = [
    {
      kind: 'payment',
      direction: 'received',
      amountPaise: 80_886_700, // ₹8,08,867 advance
      entryDate: '2026-07-02',
      bankAccount: 'od',
    },
    {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: saleTotal(9510, 2400), // ASH 39
      entryDate: '2026-07-09',
      bankAccount: 'od',
    },
    {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: saleTotal(11_650, 1600), // ASH 42
      entryDate: '2026-07-21',
      bankAccount: 'od',
    },
  ];

  it('walks the balance through every step exactly', () => {
    const entries = postAll(events);
    expect(entries.map((e) => e.runningBalancePaise)).toEqual([
      -80_886_700, // −8,08,867
      -53_954_400, // −5,39,544
      -31_959_200, // −3,19,592
    ]);
  });

  it('ends at "You owe dealer ₹3,19,592"', () => {
    expect(postAll(events).at(-1)!.runningBalancePaise).toBe(-31_959_200);
  });
});

// ---------------------------------------------------------------------------

describe('Scenario D — balance crossing zero (§6.4)', () => {
  it('flips from "you owe" to "dealer owes you" with no special handling', () => {
    // Continuing Scenario C from −3,19,592, a sale with base ₹3,00,000 at 18%.
    const entry = post(-31_959_200, {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: transactionTotals({
        linesPaise: [30_000_000],
        discountPaise: 0,
        freightPaise: 0,
        gstRate: 18,
      }).grandTotalPaise,
      entryDate: '2026-07-28',
      bankAccount: 'od',
    });

    expect(entry.debitPaise).toBe(35_400_000); // 3,00,000 + 54,000 GST
    expect(entry.runningBalancePaise).toBe(3_440_800); // +34,408
  });
});

// ---------------------------------------------------------------------------

describe('Scenario E — void and replay (§6.5)', () => {
  it('a reversal posts equal and opposite', () => {
    const entry = post(-31_959_200, {
      kind: 'reversal',
      reverses: { debitPaise: 21_995_200, creditPaise: 0 },
      entryDate: '2026-07-21',
      bankAccount: 'od',
    });

    expect(entry.creditPaise).toBe(21_995_200);
    expect(entry.debitPaise).toBe(0);
    expect(entry.label).toBe('Reversal');
    expect(entry.runningBalancePaise).toBe(-53_954_400); // −5,39,544
  });

  it('replay of the remaining entries returns the pre-void position', () => {
    // The ASH 42 sale is voided, so replay sees only the advance and ASH 39.
    const remaining: ReplayableEntry[] = [
      {
        id: 1,
        entryDate: '2026-07-02',
        debitPaise: 0,
        creditPaise: 80_886_700,
        label: 'Received',
        bankAccount: 'od',
      },
      {
        id: 2,
        entryDate: '2026-07-09',
        debitPaise: 26_932_300,
        creditPaise: 0,
        label: 'Sale',
        bankAccount: 'od',
      },
    ];

    const entries = replay(remaining);
    expect(entries.map((e) => e.runningBalancePaise)).toEqual([-80_886_700, -53_954_400]);
    expect(entries.at(-1)!.runningBalancePaise).toBe(-53_954_400);
  });

  it('replays in (entry_date, id) order, not insertion order', () => {
    // §15.4 — a stable tiebreak for entries sharing a date, and never
    // insertion order. Given out of order, replay must still sort correctly.
    const outOfOrder: ReplayableEntry[] = [
      {
        id: 2,
        entryDate: '2026-07-09',
        debitPaise: 26_932_300,
        creditPaise: 0,
        label: 'Sale',
        bankAccount: 'od',
      },
      {
        id: 1,
        entryDate: '2026-07-02',
        debitPaise: 0,
        creditPaise: 80_886_700,
        label: 'Received',
        bankAccount: 'od',
      },
    ];

    expect(replay(outOfOrder).map((e) => e.runningBalancePaise)).toEqual([
      -80_886_700, -53_954_400,
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('Scenario F — the bank account tag does not split the balance (§6.6)', () => {
  const events: LedgerEvent[] = [
    {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: 5_900_000, // base 50,000 + GST 9,000
      entryDate: '2026-08-03',
      bankAccount: 'od',
    },
    {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: 11_800_000, // base 1,00,000 + GST 18,000
      entryDate: '2026-08-04',
      bankAccount: 'current',
    },
  ];

  it('produces ONE headline of +1,77,000 across both bank accounts', () => {
    const entries = postAll(events);
    expect(entries.map((e) => e.runningBalancePaise)).toEqual([5_900_000, 17_700_000]);
    expect(entries.at(-1)!.runningBalancePaise).toBe(17_700_000);
  });

  it('carries the bank tag onto the entry without affecting the posting', () => {
    const entries = postAll(events);
    expect(entries[0].bankAccount).toBe('od');
    expect(entries[1].bankAccount).toBe('current');
  });

  it('posts identically regardless of which bank account is tagged', () => {
    // Declared narrowly rather than spread from `events`, so the discriminated
    // union stays narrowed and the bank tag is the only thing that varies.
    const sale = {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: false,
      grandTotalPaise: 5_900_000,
      entryDate: '2026-08-03',
    } as const;

    const asOd = post(0, { ...sale, bankAccount: 'od' });
    const asCurrent = post(0, { ...sale, bankAccount: 'current' });

    expect(asOd.debitPaise).toBe(asCurrent.debitPaise);
    expect(asOd.creditPaise).toBe(asCurrent.creditPaise);
    expect(asOd.runningBalancePaise).toBe(asCurrent.runningBalancePaise);
  });
});

// ---------------------------------------------------------------------------

describe('Posting rules — §7 cases not covered by a scenario', () => {
  it('a sale return credits, opposite to its mode', () => {
    const entry = post(0, {
      kind: 'transaction',
      mode: 'sale',
      isReturnNote: true,
      grandTotalPaise: 5_900_000,
      entryDate: '2026-08-10',
      bankAccount: 'od',
    });
    expect(entry.creditPaise).toBe(5_900_000);
    expect(entry.debitPaise).toBe(0);
  });

  it('a purchase return debits, opposite to its mode', () => {
    const entry = post(0, {
      kind: 'transaction',
      mode: 'purchase',
      isReturnNote: true,
      grandTotalPaise: 5_900_000,
      entryDate: '2026-08-10',
      bankAccount: 'od',
    });
    expect(entry.debitPaise).toBe(5_900_000);
    expect(entry.creditPaise).toBe(0);
  });

  it('an opening position posts as entered', () => {
    const owed = post(0, {
      kind: 'opening',
      direction: 'owes_us',
      amountPaise: 5_000_000,
      entryDate: '2026-04-01',
    });
    expect(owed.debitPaise).toBe(5_000_000);
    expect(owed.label).toBe('Opening');

    const owing = post(0, {
      kind: 'opening',
      direction: 'we_owe',
      amountPaise: 5_000_000,
      entryDate: '2026-04-01',
    });
    expect(owing.creditPaise).toBe(5_000_000);
  });

  it('never posts both a debit and a credit on one entry', () => {
    const entries = postAll([
      {
        kind: 'payment',
        direction: 'received',
        amountPaise: 1_000_000,
        entryDate: '2026-08-01',
        bankAccount: 'od',
      },
      {
        kind: 'transaction',
        mode: 'sale',
        isReturnNote: false,
        grandTotalPaise: 5_900_000,
        entryDate: '2026-08-02',
        bankAccount: 'od',
      },
    ]);

    for (const entry of entries) {
      expect(entry.debitPaise === 0 || entry.creditPaise === 0).toBe(true);
    }
  });

  it('an empty replay is a settled balance', () => {
    expect(replay([])).toEqual([]);
  });
});
