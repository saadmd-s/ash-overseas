/**
 * Export row assembly — the server half of SRS §11.
 *
 * §11.2: the API returns raw rows with money as **integer paise**; the browser
 * does the conversion. Nothing here divides by 100.
 *
 * §11.4: voided rows are INCLUDED, flagged, with their reversal on the
 * following row. They are never silently omitted — "a spreadsheet that quietly
 * drops records is worse than one that shows them."
 */

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../posting/db';
import type {
  BalanceExportRow,
  ExportFilters,
  LedgerExportRow,
  RowStatus,
  TransactionExportRow,
} from '../export/types';

/** Line items joined with `; `, blank when nothing was entered (§11.3, col E). */
function joinItems(names: (string | null)[]): string | null {
  const present = names.filter((n): n is string => !!n && n.trim() !== '');
  return present.length ? present.join('; ') : null;
}

interface LineRow {
  transactionId: number;
  itemName: string | null;
  quantity: number;
  unit: string | null;
  ratePaise: number;
}

function lineSummary(lines: LineRow[]) {
  return {
    items: joinItems(lines.map((l) => l.itemName)),
    // A single line reports its quantity, unit and rate. Multi-line leaves Rate
    // blank (§11.3, col H) — an average rate would be a fabricated figure.
    quantity: lines.length === 1 ? lines[0].quantity : null,
    unit: lines.length === 1 ? lines[0].unit : null,
    ratePaise: lines.length === 1 ? lines[0].ratePaise : null,
  };
}

async function linesByTransaction(
  db: Db,
  transactionIds: number[],
): Promise<Map<number, LineRow[]>> {
  const map = new Map<number, LineRow[]>();
  if (transactionIds.length === 0) return map;

  const rows = await db
    .select({
      transactionId: schema.transactionLines.transactionId,
      itemName: schema.transactionLines.itemName,
      quantity: schema.transactionLines.quantity,
      unit: schema.transactionLines.unit,
      ratePaise: schema.transactionLines.ratePaise,
    })
    .from(schema.transactionLines)
    .where(inArray(schema.transactionLines.transactionId, transactionIds))
    .orderBy(asc(schema.transactionLines.lineNo));

  for (const row of rows) {
    const existing = map.get(row.transactionId);
    if (existing) existing.push(row);
    else map.set(row.transactionId, [row]);
  }
  return map;
}

// ---------------------------------------------------------------------------

/** The shape `modeMatcher` needs off a ledger row — a subset of the full row. */
export interface ModeFilterableEntry {
  id: number;
  sourceType: 'transaction' | 'payment' | 'opening' | 'reversal';
  sourceId: number | null;
  reversesEntryId: number | null;
}

/**
 * Which ledger rows a `mode=purchase|sale` filter keeps (SRS 14, APP_FLOW 7).
 *
 * A mode belongs to a TRANSACTION, not to a ledger row, so it has to be
 * resolved through the source record - and for a reversal, through the entry it
 * reverses. A reversal row's own `source_id` names a row in either the
 * transactions or the payments table and nothing on the row says which; the two
 * tables autoincrement independently, so transaction 5 and payment 5 both
 * exist and the id alone is ambiguous. `reverses_entry_id` is not ambiguous.
 *
 * A payment and an opening position are neither a purchase nor a sale, so a
 * mode filter excludes them.
 *
 * This lives in one place because the dealer screen and the dealer export must
 * answer the same question the same way; two copies of this rule would drift
 * and the spreadsheet would disagree with the screen it was exported from.
 */
export function modeMatcher(
  entries: ModeFilterableEntry[],
  txModeById: Map<number, 'purchase' | 'sale'>,
  mode: 'purchase' | 'sale',
): (entry: ModeFilterableEntry) => boolean {
  const byId = new Map(entries.map((e) => [e.id, e]));

  return (entry) => {
    const origin =
      entry.sourceType === 'reversal' && entry.reversesEntryId !== null
        ? (byId.get(entry.reversesEntryId) ?? null)
        : entry;

    if (!origin || origin.sourceType !== 'transaction' || origin.sourceId === null) return false;
    return txModeById.get(origin.sourceId) === mode;
  };
}

// ---------------------------------------------------------------------------

/** Every ledger row for a dealer, enriched with its source record. */
export async function dealerLedgerRows(
  db: Db,
  dealerId: number,
  filters: ExportFilters,
): Promise<LedgerExportRow[]> {
  const entries = await db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.dealerId, dealerId))
    .orderBy(asc(schema.ledgerEntries.entryDate), asc(schema.ledgerEntries.id));

  const txIds = entries
    .filter((e) => e.sourceType === 'transaction' || e.sourceType === 'reversal')
    .map((e) => e.sourceId)
    .filter((id): id is number => id !== null);

  const [transactions, payments, lines] = await Promise.all([
    txIds.length
      ? db.select().from(schema.transactions).where(inArray(schema.transactions.id, txIds))
      : Promise.resolve([]),
    db.select().from(schema.payments).where(eq(schema.payments.dealerId, dealerId)),
    linesByTransaction(db, txIds),
  ]);

  const txById = new Map(transactions.map((t) => [t.id, t]));
  const payById = new Map(payments.map((p) => [p.id, p]));

  // One definition of the mode filter, shared with the dealer screen. It also
  // now covers REVERSAL rows, which the old inline check let through unfiltered
  // - so a `mode=sale` export could carry the reversal of a purchase.
  const mode = filters.mode === 'purchase' || filters.mode === 'sale' ? filters.mode : null;
  const matchesMode = mode
    ? modeMatcher(entries, new Map(transactions.map((t) => [t.id, t.mode])), mode)
    : null;

  const rows: LedgerExportRow[] = [];

  for (const entry of entries) {
    // The presentational filters, applied to which rows are SHOWN. The running
    // balance on each row is the stored one — never recomputed over the subset
    // (§6.6).
    if (filters.from && entry.entryDate < filters.from) continue;
    if (filters.to && entry.entryDate > filters.to) continue;
    if (filters.bankAccount && entry.bankAccount !== filters.bankAccount) continue;
    if (filters.type && entry.sourceType !== filters.type) continue;
    if (matchesMode && !matchesMode(entry)) continue;

    const base = {
      entryDate: entry.entryDate,
      type: entry.label ?? entry.sourceType,
      bankAccount: entry.bankAccount,
      debitPaise: entry.debitPaise,
      creditPaise: entry.creditPaise,
      balancePaise: entry.runningBalancePaise,
    };

    if (entry.sourceType === 'transaction' && entry.sourceId !== null) {
      const tx = txById.get(entry.sourceId);
      if (!tx) continue;

      const summary = lineSummary(lines.get(tx.id) ?? []);
      rows.push({
        ...base,
        invoiceNo: tx.invoiceNo,
        reference: tx.referenceTag,
        ...summary,
        baseTotalPaise: tx.baseTotalPaise,
        discountPaise: tx.discountPaise,
        freightPaise: tx.freightPaise,
        gstRate: tx.gstRate,
        gstAmountPaise: tx.gstAmountPaise,
        roundOffPaise: tx.roundOffPaise,
        totalPaise: tx.grandTotalPaise,
        // Flagged, not dropped (§11.4).
        status: (tx.isVoided ? 'VOIDED' : '') as RowStatus,
        notes: tx.notes,
      });
      continue;
    }

    if (entry.sourceType === 'payment' && entry.sourceId !== null) {
      const pay = payById.get(entry.sourceId);
      if (!pay) continue;

      rows.push({
        ...base,
        invoiceNo: null,
        reference: pay.reference,
        items: null,
        quantity: null, // blank for payments (§11.3, col F)
        unit: null,
        ratePaise: null,
        baseTotalPaise: null,
        discountPaise: null,
        freightPaise: null,
        gstRate: null,
        gstAmountPaise: null,
        roundOffPaise: null,
        totalPaise: pay.amountPaise,
        status: (pay.isVoided ? 'VOIDED' : '') as RowStatus,
        notes: pay.notes,
      });
      continue;
    }

    // Opening and reversal rows carry no source detail of their own.
    rows.push({
      ...base,
      invoiceNo: null,
      reference: null,
      items: null,
      quantity: null,
      unit: null,
      ratePaise: null,
      baseTotalPaise: null,
      discountPaise: null,
      freightPaise: null,
      gstRate: null,
      gstAmountPaise: null,
      roundOffPaise: null,
      totalPaise: entry.debitPaise !== 0 ? entry.debitPaise : entry.creditPaise,
      status: (entry.sourceType === 'reversal' ? 'REVERSAL' : '') as RowStatus,
      notes: entry.description,
    });
  }

  return rows;
}

/** Every transaction across dealers, honouring the active filters (FR-X2). */
export async function transactionRows(
  db: Db,
  filters: ExportFilters & { dealerId?: number },
): Promise<TransactionExportRow[]> {
  const conditions = [];
  if (filters.from) conditions.push(gte(schema.transactions.entryDate, filters.from));
  if (filters.to) conditions.push(lte(schema.transactions.entryDate, filters.to));
  if (filters.mode === 'purchase' || filters.mode === 'sale') {
    conditions.push(eq(schema.transactions.mode, filters.mode));
  }
  if (filters.bankAccount === 'od' || filters.bankAccount === 'current') {
    conditions.push(eq(schema.transactions.bankAccount, filters.bankAccount));
  }
  if (filters.dealerId) conditions.push(eq(schema.transactions.dealerId, filters.dealerId));

  const transactions = await db
    .select({ tx: schema.transactions, dealerName: schema.dealers.name })
    .from(schema.transactions)
    .innerJoin(schema.dealers, eq(schema.transactions.dealerId, schema.dealers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(schema.transactions.entryDate), asc(schema.transactions.id));

  const lines = await linesByTransaction(
    db,
    transactions.map((t) => t.tx.id),
  );

  return transactions.map(({ tx, dealerName }) => ({
    dealerName,
    entryDate: tx.entryDate,
    type: tx.mode === 'sale' ? 'Sale' : 'Purchase',
    invoiceNo: tx.invoiceNo,
    reference: tx.referenceTag,
    ...lineSummary(lines.get(tx.id) ?? []),
    baseTotalPaise: tx.baseTotalPaise,
    discountPaise: tx.discountPaise,
    freightPaise: tx.freightPaise,
    gstRate: tx.gstRate,
    gstAmountPaise: tx.gstAmountPaise,
    roundOffPaise: tx.roundOffPaise,
    totalPaise: tx.grandTotalPaise,
    bankAccount: tx.bankAccount,
    // A sale debits and a purchase credits (§7); a return note reverses that.
    debitPaise: (tx.mode === 'sale') !== tx.isReturnNote ? tx.grandTotalPaise : 0,
    creditPaise: (tx.mode === 'sale') !== tx.isReturnNote ? 0 : tx.grandTotalPaise,
    status: (tx.isVoided ? 'VOIDED' : '') as RowStatus,
    notes: tx.notes,
  }));
}

/** One row per dealer with the current balance (FR-X3). */
export async function balanceRows(
  db: Db,
  opts: { includeArchived?: boolean } = {},
): Promise<BalanceExportRow[]> {
  const dealers = await db
    .select()
    .from(schema.dealers)
    .where(opts.includeArchived ? undefined : eq(schema.dealers.isArchived, false))
    .orderBy(asc(schema.dealers.name));

  return Promise.all(
    dealers.map(async (d) => {
      const latest = await db
        .select({
          balance: schema.ledgerEntries.runningBalancePaise,
          entryDate: schema.ledgerEntries.entryDate,
        })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.dealerId, d.id))
        .orderBy(desc(schema.ledgerEntries.entryDate), desc(schema.ledgerEntries.id))
        .limit(1);

      const counted = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.dealerId, d.id));

      return {
        dealerName: d.name,
        type: d.type,
        gstin: d.gstin,
        stateCode: d.stateCode,
        balancePaise: latest[0]?.balance ?? 0,
        lastActivity: latest[0]?.entryDate ?? null,
        transactionCount: Number(counted[0]?.n ?? 0),
      };
    }),
  );
}
