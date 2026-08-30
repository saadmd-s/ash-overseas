/**
 * Export row shapes — shared between the Worker and the browser.
 *
 * SRS §11.2: the API returns raw rows with money as **integer paise**; the
 * export module performs the single paise → rupee conversion at the boundary
 * (§11.4). Nothing in this file is in rupees.
 */

export type BankAccount = 'od' | 'current';

/** Blank, or the flag shown in the Status column (§11.3). */
export type RowStatus = '' | 'VOIDED' | 'REVERSAL';

/** One row of a dealer ledger export — SRS §11.3, columns A–V. */
export interface LedgerExportRow {
  entryDate: string; // 'YYYY-MM-DD'
  type: string; // Sale | Purchase | Received | Paid | Opening | Reversal
  invoiceNo: string | null;
  reference: string | null;
  items: string | null; // line items joined with '; '
  quantity: number | null; // blank for payments
  unit: string | null;
  ratePaise: number | null; // blank for multi-line transactions (§11.3, col H)
  baseTotalPaise: number | null;
  discountPaise: number | null;
  freightPaise: number | null;
  gstRate: number | null;
  gstAmountPaise: number | null;
  roundOffPaise: number | null;
  totalPaise: number | null;
  bankAccount: BankAccount | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number; // running balance, signed
  status: RowStatus;
  notes: string | null;
}

/** All-transactions export: the same columns with Dealer inserted after Date. */
export interface TransactionExportRow extends Omit<LedgerExportRow, 'balancePaise'> {
  dealerName: string;
}

/** Dealer-balances export — SRS §11.3. */
export interface BalanceExportRow {
  dealerName: string;
  type: string;
  gstin: string | null;
  stateCode: string | null;
  balancePaise: number; // signed
  lastActivity: string | null;
  transactionCount: number;
}

/** The filters that were on screen, restated in the sheet's subtitle (§11.1). */
export interface ExportFilters {
  from?: string;
  to?: string;
  type?: string;
  mode?: string;
  bankAccount?: string;
  dealerType?: string;
}

export interface DealerLedgerExport {
  kind: 'dealer-ledger';
  dealerName: string;
  closingBalancePaise: number;
  filters: ExportFilters;
  rows: LedgerExportRow[];
}

export interface TransactionsExport {
  kind: 'transactions';
  filters: ExportFilters;
  rows: TransactionExportRow[];
}

export interface BalancesExport {
  kind: 'balances';
  filters: ExportFilters;
  rows: BalanceExportRow[];
}

export type AnyExport = DealerLedgerExport | TransactionsExport | BalancesExport;
