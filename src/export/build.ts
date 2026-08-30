/**
 * The shared row-builder — SRS §11.2.
 *
 * "A CSV writer shares the same row-builder, so the two formats can never
 *  drift."
 *
 * This module is pure and has no SheetJS import, so it is unit-testable and
 * both writers consume its output. It is also the ONE place the export-boundary
 * conversion happens.
 *
 * §11.4 — money is written as a NUMERIC cell, in rupees, derived from integer
 * paise as `paise / 100`. That division is exact for any value this business
 * will encounter and is the second (and last) sanctioned crossing of the money
 * boundary, the first being `formatPaise()` at the render boundary. No `₹`
 * character is embedded in a value; the header names the unit.
 */

import { formatPaise } from '../money';
import type {
  AnyExport,
  BalancesExport,
  DealerLedgerExport,
  ExportFilters,
  TransactionsExport,
} from './types';

/** A typed cell. `null` renders as an empty cell, never as 0 or "". */
export type Cell = string | number | null | { date: string };

export interface Sheet {
  /** Workbook/sheet name, e.g. `Ledger`. */
  name: string;
  /** Suggested file name without extension. */
  fileName: string;
  /** Title block above the header (§11.3). */
  title: string[];
  header: string[];
  rows: Cell[][];
  /** The totals row beneath the last data row (§11.3). */
  totals: Cell[];
  /** 0-based indices of columns holding money, for `#,##0.00` (§11.4). */
  moneyColumns: number[];
  /** 0-based indices of columns holding real dates (§11.4). */
  dateColumns: number[];
  /** Column widths in characters, so nothing renders as `####` (§11.4). */
  widths: number[];
  /** 0-based indices of rows that are voided, for strike-through (§11.4). */
  struckRows: number[];
}

/**
 * The single sanctioned paise → rupee conversion for exports.
 *
 * Returns `null` for `null` so a blank column stays blank — §11.3 requires the
 * Debit and Credit columns to be blank when zero, and a 0 there would be read
 * as a real figure.
 */
function rupees(paise: number | null | undefined): number | null {
  if (paise === null || paise === undefined) return null;
  return paise / 100;
}

/** Blank when zero, per §11.3's Debit/Credit columns. */
function rupeesOrBlank(paise: number): number | null {
  return paise === 0 ? null : paise / 100;
}

/** The plain-language direction for column T (§11.4). */
export function directionOf(balancePaise: number): string {
  if (balancePaise > 0) return 'Dealer owes you';
  if (balancePaise < 0) return 'You owe dealer';
  return 'Settled';
}

function bankLabel(bank: string | null): string | null {
  if (bank === 'od') return 'OD';
  if (bank === 'current') return 'Current';
  return null;
}

/** "Filtered: 01 Aug 2026 – 31 Aug 2026 · OD only", or "No filters applied". */
export function describeFilters(filters: ExportFilters): string {
  const parts: string[] = [];
  if (filters.from || filters.to) {
    parts.push(`Dates: ${filters.from ?? 'start'} to ${filters.to ?? 'today'}`);
  }
  if (filters.type) parts.push(`Type: ${filters.type}`);
  if (filters.mode) parts.push(`Mode: ${filters.mode}`);
  if (filters.bankAccount) parts.push(`Bank account: ${bankLabel(filters.bankAccount)}`);
  if (filters.dealerType) parts.push(`Dealer type: ${filters.dealerType}`);
  return parts.length ? `Filters applied — ${parts.join(' · ')}` : 'No filters applied';
}

const BUSINESS_NAME = 'ASH Overseas';

/**
 * `YYYY-MM-DD` for a real Excel date cell.
 *
 * The date is passed through as text and tagged, not parsed into a Date here:
 * `entry_date` is an IST calendar date, not an instant (§12.4), and the writer
 * turns it into an Excel serial without a timezone ever being involved.
 */
function dateCell(ymd: string): Cell {
  return { date: ymd };
}

function sum(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

// ---------------------------------------------------------------------------

const LEDGER_HEADER = [
  'Date',
  'Type',
  'Invoice No.',
  'Reference',
  'Item(s)',
  'Quantity',
  'Unit',
  'Rate (₹)',
  'Base Total (₹)',
  'Discount (₹)',
  'Freight (₹)',
  'GST %',
  'GST Amount (₹)',
  'Round Off (₹)',
  'Total (₹)',
  'Bank A/c',
  'Debit (₹)',
  'Credit (₹)',
  'Balance (₹)',
  'Direction',
  'Status',
  'Notes',
];

function buildDealerLedger(data: DealerLedgerExport, generatedAt: string): Sheet {
  const rows: Cell[][] = [];
  const struckRows: number[] = [];

  data.rows.forEach((r, i) => {
    if (r.status === 'VOIDED') struckRows.push(i);
    rows.push([
      dateCell(r.entryDate),
      r.type,
      r.invoiceNo,
      r.reference,
      r.items,
      r.quantity,
      r.unit,
      rupees(r.ratePaise),
      rupees(r.baseTotalPaise),
      rupees(r.discountPaise),
      rupees(r.freightPaise),
      r.gstRate,
      rupees(r.gstAmountPaise),
      rupees(r.roundOffPaise),
      rupees(r.totalPaise),
      bankLabel(r.bankAccount),
      rupeesOrBlank(r.debitPaise),
      rupeesOrBlank(r.creditPaise),
      // §11.4 — stays numerically NEGATIVE so Excel can sum and chart it, with
      // the plain language in the adjacent column. This is the one place a raw
      // sign is acceptable.
      rupees(r.balancePaise),
      directionOf(r.balancePaise),
      r.status,
      r.notes,
    ]);
  });

  return {
    name: 'Ledger',
    fileName: `${data.dealerName}-ledger-${generatedAt}`,
    title: [
      BUSINESS_NAME,
      `Dealer ledger — ${data.dealerName}`,
      describeFilters(data.filters),
      // Plain language, as everywhere the owner reads a balance (§10.8), and
      // formatted through the money module rather than ad hoc. This is a title
      // string, not a cell value, so the currency symbol belongs here.
      `Closing balance: ${directionOf(data.closingBalancePaise)} ${formatPaise(
        Math.abs(data.closingBalancePaise),
      )}`,
      `Generated ${generatedAt}`,
    ],
    header: LEDGER_HEADER,
    rows,
    totals: [
      'TOTAL',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      sum(data.rows.map((r) => rupees(r.baseTotalPaise))),
      sum(data.rows.map((r) => rupees(r.discountPaise))),
      sum(data.rows.map((r) => rupees(r.freightPaise))),
      null,
      sum(data.rows.map((r) => rupees(r.gstAmountPaise))),
      null,
      sum(data.rows.map((r) => rupees(r.totalPaise))),
      null,
      sum(data.rows.map((r) => rupeesOrBlank(r.debitPaise))),
      sum(data.rows.map((r) => rupeesOrBlank(r.creditPaise))),
      null,
      null,
      null,
      null,
    ],
    moneyColumns: [7, 8, 9, 10, 12, 13, 14, 16, 17, 18],
    dateColumns: [0],
    widths: [12, 10, 14, 12, 24, 10, 8, 12, 14, 12, 12, 7, 14, 12, 14, 10, 14, 14, 14, 16, 9, 24],
    struckRows,
  };
}

function buildTransactions(data: TransactionsExport, generatedAt: string): Sheet {
  const rows: Cell[][] = [];
  const struckRows: number[] = [];

  data.rows.forEach((r, i) => {
    if (r.status === 'VOIDED') struckRows.push(i);
    rows.push([
      dateCell(r.entryDate),
      r.dealerName,
      r.type,
      r.invoiceNo,
      r.reference,
      r.items,
      r.quantity,
      r.unit,
      rupees(r.ratePaise),
      rupees(r.baseTotalPaise),
      rupees(r.discountPaise),
      rupees(r.freightPaise),
      r.gstRate,
      rupees(r.gstAmountPaise),
      rupees(r.roundOffPaise),
      rupees(r.totalPaise),
      bankLabel(r.bankAccount),
      rupeesOrBlank(r.debitPaise),
      rupeesOrBlank(r.creditPaise),
      r.status,
      r.notes,
    ]);
  });

  return {
    name: 'Transactions',
    fileName: `transactions-${generatedAt}`,
    title: [
      BUSINESS_NAME,
      'All transactions',
      describeFilters(data.filters),
      `Generated ${generatedAt}`,
    ],
    // Dealer inserted after Date; no running Balance or Direction, because a
    // cross-dealer running balance is meaningless (§11.3).
    header: [
      'Date',
      'Dealer',
      'Type',
      'Invoice No.',
      'Reference',
      'Item(s)',
      'Quantity',
      'Unit',
      'Rate (₹)',
      'Base Total (₹)',
      'Discount (₹)',
      'Freight (₹)',
      'GST %',
      'GST Amount (₹)',
      'Round Off (₹)',
      'Total (₹)',
      'Bank A/c',
      'Debit (₹)',
      'Credit (₹)',
      'Status',
      'Notes',
    ],
    rows,
    totals: [
      'TOTAL',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      sum(data.rows.map((r) => rupees(r.baseTotalPaise))),
      sum(data.rows.map((r) => rupees(r.discountPaise))),
      sum(data.rows.map((r) => rupees(r.freightPaise))),
      null,
      sum(data.rows.map((r) => rupees(r.gstAmountPaise))),
      null,
      sum(data.rows.map((r) => rupees(r.totalPaise))),
      null,
      sum(data.rows.map((r) => rupeesOrBlank(r.debitPaise))),
      sum(data.rows.map((r) => rupeesOrBlank(r.creditPaise))),
      null,
      null,
    ],
    moneyColumns: [8, 9, 10, 11, 13, 14, 15, 17, 18],
    dateColumns: [0],
    widths: [12, 22, 10, 14, 12, 24, 10, 8, 12, 14, 12, 12, 7, 14, 12, 14, 10, 14, 14, 9, 24],
    struckRows,
  };
}

function buildBalances(data: BalancesExport, generatedAt: string): Sheet {
  const rows = data.rows.map((r) => [
    r.dealerName,
    r.type,
    r.gstin,
    r.stateCode,
    rupees(r.balancePaise),
    directionOf(r.balancePaise),
    r.lastActivity ? dateCell(r.lastActivity) : null,
    r.transactionCount,
  ]);

  const net = data.rows.reduce((sum_, r) => sum_ + r.balancePaise, 0);

  return {
    name: 'Balances',
    fileName: `dealer-balances-${generatedAt}`,
    title: [
      BUSINESS_NAME,
      'Dealer balances',
      describeFilters(data.filters),
      `Generated ${generatedAt}`,
    ],
    header: [
      'Dealer',
      'Type',
      'GSTIN',
      'State',
      'Balance (₹)',
      'Direction',
      'Last Activity',
      'Transaction Count',
    ],
    rows,
    totals: ['TOTAL', null, null, null, rupees(net), directionOf(net), null, null],
    moneyColumns: [4],
    dateColumns: [6],
    widths: [24, 10, 18, 8, 16, 16, 14, 18],
    struckRows: [],
  };
}

/**
 * Build the sheet for any export.
 *
 * `generatedAt` is passed in rather than read from the clock so the output is
 * deterministic and testable.
 */
export function buildSheet(data: AnyExport, generatedAt: string): Sheet {
  switch (data.kind) {
    case 'dealer-ledger':
      return buildDealerLedger(data, generatedAt);
    case 'transactions':
      return buildTransactions(data, generatedAt);
    case 'balances':
      return buildBalances(data, generatedAt);
  }
}
