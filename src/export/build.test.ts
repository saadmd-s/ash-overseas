/**
 * The shared row-builder — SRS §11.3, §11.4.
 *
 * The figures here are Scenario C's, so the export can be checked against the
 * same numbers the ledger tests assert. §23's Phase 2 gate is that "the exported
 * figures reconcile EXACTLY with the screen"; this is where that is proven for
 * the conversion itself.
 */

import { describe, expect, it } from 'vitest';
import { buildSheet, describeFilters, directionOf } from './build';
import type { DealerLedgerExport, LedgerExportRow } from './types';

const AT = '2026-08-29';

function row(over: Partial<LedgerExportRow> = {}): LedgerExportRow {
  return {
    entryDate: '2026-07-09',
    type: 'Sale',
    invoiceNo: null,
    reference: 'ASH 39',
    items: 'Castings',
    quantity: 9510,
    unit: 'kg',
    ratePaise: 2400,
    baseTotalPaise: 22_824_000,
    discountPaise: 0,
    freightPaise: 0,
    gstRate: 18,
    gstAmountPaise: 4_108_320,
    roundOffPaise: -20,
    totalPaise: 26_932_300,
    bankAccount: 'od',
    debitPaise: 26_932_300,
    creditPaise: 0,
    balancePaise: -53_954_400,
    status: '',
    notes: null,
    ...over,
  };
}

function ledger(rows: LedgerExportRow[], closing = -31_959_200): DealerLedgerExport {
  return {
    kind: 'dealer-ledger',
    dealerName: 'Kumar Traders',
    closingBalancePaise: closing,
    filters: {},
    rows,
  };
}

describe('Money conversion at the export boundary (§11.4)', () => {
  const sheet = buildSheet(ledger([row()]), AT);
  const [first] = sheet.rows;

  it('converts paise to rupees exactly', () => {
    expect(first[8]).toBe(228_240); // base total ₹2,28,240.00
    expect(first[12]).toBe(41_083.2); // GST ₹41,083.20
    expect(first[14]).toBe(269_323); // total ₹2,69,323.00
  });

  it('carries the round-off through as −0.20', () => {
    expect(first[13]).toBe(-0.2);
  });

  it('writes money as numbers, not strings, and embeds no currency symbol', () => {
    for (const col of sheet.moneyColumns) {
      const value = first[col];
      expect(value === null || typeof value === 'number').toBe(true);
      expect(String(value)).not.toContain('₹');
    }
  });

  it('names the unit in the header instead', () => {
    expect(sheet.header[14]).toBe('Total (₹)');
  });

  it('reconciles with the figure the ledger posted', () => {
    // 26,932,300 paise is what Scenario B/C posts. Column O must be the same
    // number in rupees — this is the "reconciles exactly" gate.
    expect(first[14]! as number).toBe(26_932_300 / 100);
  });
});

describe('Blank versus zero (§11.3)', () => {
  it('leaves Debit blank when zero, and Credit when zero', () => {
    const [debitSide] = buildSheet(ledger([row()]), AT).rows;
    expect(debitSide[16]).toBe(269_323); // Debit
    expect(debitSide[17]).toBeNull(); // Credit — blank, not 0

    const [creditSide] = buildSheet(
      ledger([row({ debitPaise: 0, creditPaise: 80_886_700 })]),
      AT,
    ).rows;
    expect(creditSide[16]).toBeNull();
    expect(creditSide[17]).toBe(808_867);
  });

  it('leaves quantity and rate blank for a payment row', () => {
    const [payment] = buildSheet(
      ledger([
        row({
          type: 'Received',
          quantity: null,
          unit: null,
          ratePaise: null,
          baseTotalPaise: null,
          gstRate: null,
          gstAmountPaise: null,
          roundOffPaise: null,
          items: null,
        }),
      ]),
      AT,
    ).rows;

    expect(payment[5]).toBeNull(); // Quantity
    expect(payment[7]).toBeNull(); // Rate
    expect(payment[8]).toBeNull(); // Base Total
  });

  it('leaves Rate blank for a multi-line transaction', () => {
    // An averaged rate would be a fabricated figure, so §11.3 leaves it empty.
    const [multi] = buildSheet(ledger([row({ ratePaise: null, quantity: null })]), AT).rows;
    expect(multi[7]).toBeNull();
  });
});

describe('The signed balance and its plain-language twin (§11.4)', () => {
  it('keeps a payable numerically negative, with the words alongside', () => {
    const [r] = buildSheet(ledger([row({ balancePaise: -31_959_200 })]), AT).rows;
    expect(r[18]).toBe(-319_592); // sums and charts correctly in Excel
    expect(r[19]).toBe('You owe dealer'); // removes any ambiguity for a human
  });

  it('reads the other way when the dealer owes', () => {
    const [r] = buildSheet(ledger([row({ balancePaise: 3_440_800 })]), AT).rows;
    expect(r[18]).toBe(34_408);
    expect(r[19]).toBe('Dealer owes you');
  });

  it('says Settled at zero', () => {
    expect(directionOf(0)).toBe('Settled');
  });
});

describe('Voided rows are included, never dropped (§11.4)', () => {
  const sheet = buildSheet(
    ledger([
      row({ status: 'VOIDED', entryDate: '2026-07-21' }),
      row({
        status: 'REVERSAL',
        type: 'Reversal',
        entryDate: '2026-07-21',
        debitPaise: 0,
        creditPaise: 21_995_200,
      }),
    ]),
    AT,
  );

  it('keeps the voided row and flags it', () => {
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0][20]).toBe('VOIDED');
  });

  it('marks it for strike-through', () => {
    expect(sheet.struckRows).toEqual([0]);
  });

  it('puts the reversal on the following row', () => {
    expect(sheet.rows[1][20]).toBe('REVERSAL');
    expect(sheet.rows[1][17]).toBe(219_952); // the reversing credit
  });
});

describe('Title block and totals (§11.3)', () => {
  const sheet = buildSheet(
    {
      ...ledger([row(), row({ debitPaise: 0, creditPaise: 80_886_700, totalPaise: 80_886_700 })]),
      filters: { bankAccount: 'od', from: '2026-07-01' },
    },
    AT,
  );

  it('states the business, the dealer, the filters and the generation date', () => {
    expect(sheet.title[0]).toBe('ASH Overseas');
    expect(sheet.title[1]).toContain('Kumar Traders');
    expect(sheet.title[2]).toContain('Bank account: OD');
    expect(sheet.title.at(-1)).toContain(AT);
  });

  it('states the closing balance in plain language, never a bare sign', () => {
    const closing = sheet.title[3];
    expect(closing).toContain('You owe dealer');
    expect(closing).not.toMatch(/-\s*₹/);
  });

  it('sums Debit, Credit, Base, GST and Total', () => {
    expect(sheet.totals[8]).toBe(228_240 * 2); // base
    expect(sheet.totals[16]).toBe(269_323); // debit
    expect(sheet.totals[17]).toBe(808_867); // credit
  });

  it('describes an unfiltered export honestly', () => {
    expect(describeFilters({})).toBe('No filters applied');
  });
});

describe('Dates are real dates, not strings (§11.4)', () => {
  it('tags the date column for the writer', () => {
    const sheet = buildSheet(ledger([row()]), AT);
    expect(sheet.dateColumns).toEqual([0]);
    expect(sheet.rows[0][0]).toEqual({ date: '2026-07-09' });
  });
});

describe('Column widths (§11.4)', () => {
  it('sets a width for every column, so nothing renders as ####', () => {
    const sheet = buildSheet(ledger([row()]), AT);
    expect(sheet.widths).toHaveLength(sheet.header.length);
    expect(sheet.widths.every((w) => w > 0)).toBe(true);
  });
});

describe('All-transactions sheet (§11.3)', () => {
  const sheet = buildSheet(
    {
      kind: 'transactions',
      filters: {},
      rows: [{ ...row(), dealerName: 'Kumar Traders' }],
    },
    AT,
  );

  it('inserts Dealer after Date', () => {
    expect(sheet.header.slice(0, 3)).toEqual(['Date', 'Dealer', 'Type']);
    expect(sheet.rows[0][1]).toBe('Kumar Traders');
  });

  it('omits the running balance and direction, which are meaningless here', () => {
    expect(sheet.header).not.toContain('Balance (₹)');
    expect(sheet.header).not.toContain('Direction');
  });

  it('retains the totals row', () => {
    expect(sheet.totals[0]).toBe('TOTAL');
  });
});

describe('Dealer-balances sheet (§11.3)', () => {
  const sheet = buildSheet(
    {
      kind: 'balances',
      filters: {},
      rows: [
        {
          dealerName: 'Kumar Traders',
          type: 'both',
          gstin: '33ABCDE1234F1Z5',
          stateCode: '33',
          balancePaise: -31_959_200,
          lastActivity: '2026-07-21',
          transactionCount: 2,
        },
      ],
    },
    AT,
  );

  it('carries a signed balance and its direction', () => {
    expect(sheet.rows[0][4]).toBe(-319_592);
    expect(sheet.rows[0][5]).toBe('You owe dealer');
  });

  it('sums the net position', () => {
    expect(sheet.totals[4]).toBe(-319_592);
    expect(sheet.totals[5]).toBe('You owe dealer');
  });
});
