/**
 * Drizzle schema — SRS §13, transcribed verbatim, plus one addition.
 *
 * All money is integer paise. Quantity and GST rate are real values used for
 * computation and display; the authoritative monetary figures are always the
 * integer paise columns.
 *
 * The `idSequences` table at the foot of this file is NOT in the SRS. §15.3
 * requires the human-ID sequence to be allocated inside the atomic batch and
 * FR-T9 defines the format, but §12 and §13 define nowhere to hold the counter.
 * Owner-approved 29 Aug 2026. See docs/BACKEND_SCHEMA.md §7.
 */

import { sqliteTable, integer, text, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const dealers = sqliteTable(
  'dealers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    contact: text('contact'),
    address: text('address'),
    gstin: text('gstin'),
    stateCode: text('state_code'), // "33" = TN, "07" = Delhi
    type: text('type', { enum: ['supplier', 'buyer', 'both'] })
      .notNull()
      .default('both'), // list filter ONLY — never splits the balance
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index('idx_dealers_archived').on(t.isArchived)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    humanId: text('human_id').notNull().unique(), // "SALE-2026-08-0039"
    mode: text('mode', { enum: ['purchase', 'sale'] }).notNull(),
    dealerId: integer('dealer_id')
      .notNull()
      .references(() => dealers.id),
    entryDate: text('entry_date').notNull(), // 'YYYY-MM-DD', IST calendar date
    invoiceNo: text('invoice_no'),
    invoiceDate: text('invoice_date'), // 'YYYY-MM-DD'
    referenceTag: text('reference_tag'), // owner's tag, e.g. "ASH 39"
    bankAccount: text('bank_account', { enum: ['od', 'current'] })
      .notNull()
      .default('od'), // tag + filter ONLY — never splits the balance
    gstRate: real('gst_rate').notNull().default(18),
    baseTotalPaise: integer('base_total_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    freightPaise: integer('freight_paise').notNull().default(0),
    gstAmountPaise: integer('gst_amount_paise').notNull().default(0),
    roundOffPaise: integer('round_off_paise').notNull().default(0),
    grandTotalPaise: integer('grand_total_paise').notNull(), // what posts to the ledger
    isReturnNote: integer('is_return_note', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    isVoided: integer('is_voided', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index('idx_tx_dealer').on(t.dealerId, t.entryDate), index('idx_tx_date').on(t.entryDate)],
);

export const transactionLines = sqliteTable(
  'transaction_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id),
    lineNo: integer('line_no').notNull().default(1),
    itemName: text('item_name'), // OPTIONAL free text, no master
    quantity: real('quantity').notNull(),
    unit: text('unit'), // free text: kg, pcs, lot...
    ratePaise: integer('rate_paise').notNull(),
    amountPaise: integer('amount_paise').notNull(), // roundPaise(quantity * ratePaise)
  },
  (t) => [index('idx_lines_tx').on(t.transactionId)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    humanId: text('human_id').notNull().unique(), // "RCPT-2026-08-0012" | "PAY-2026-08-0007"
    dealerId: integer('dealer_id')
      .notNull()
      .references(() => dealers.id),
    entryDate: text('entry_date').notNull(), // 'YYYY-MM-DD'
    direction: text('direction', { enum: ['received', 'paid'] }).notNull(), // received = from dealer
    amountPaise: integer('amount_paise').notNull(),
    method: text('method', { enum: ['cash', 'bank', 'cheque', 'upi'] }),
    bankAccount: text('bank_account', { enum: ['od', 'current'] }),
    reference: text('reference'),
    notes: text('notes'),
    isVoided: integer('is_voided', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index('idx_pay_dealer').on(t.dealerId, t.entryDate)],
);

export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dealerId: integer('dealer_id')
      .notNull()
      .references(() => dealers.id),
    entryDate: text('entry_date').notNull(), // 'YYYY-MM-DD'
    sourceType: text('source_type', {
      enum: ['transaction', 'payment', 'opening', 'reversal'],
    }).notNull(),
    sourceId: integer('source_id'),
    reversesEntryId: integer('reverses_entry_id'), // set on reversal rows
    debitPaise: integer('debit_paise').notNull().default(0), // dealer owes the business more
    creditPaise: integer('credit_paise').notNull().default(0), // the business owes the dealer more
    runningBalancePaise: integer('running_balance_paise').notNull(), // + dealer owes, − business owes
    bankAccount: text('bank_account', { enum: ['od', 'current'] }), // copied for filtering only
    label: text('label'), // Sale | Purchase | Received | Paid | Opening | Reversal
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index('idx_ledger_dealer_date').on(t.dealerId, t.entryDate, t.id),
    index('idx_ledger_source').on(t.sourceType, t.sourceId),
  ],
);

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action').notNull(), // create | void | edit | login | credential_change
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  at: integer('at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const appCredentials = sqliteTable('app_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(), // pbkdf2$<iters>$<salt>$<hash>
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * NOT IN THE SRS — owner-approved addition, 29 Aug 2026.
 *
 * Holds the human-ID counter per scope, so FR-T9's `{MODE}-{YYYY}-{MM}-{NNNN}`
 * can be allocated inside the same `db.batch` as the rest of the write (§15.3).
 *
 * Scopes: 'SALE-2026-08', 'PURCHASE-2026-08', 'RCPT-2026-08', 'PAY-2026-08'.
 *
 * A voided transaction keeps its human ID and the sequence never rewinds, so a
 * number is never reused. Deriving the counter from a row count would break
 * exactly here — voided rows are retained, so the count stops matching.
 */
export const idSequences = sqliteTable('id_sequences', {
  scope: text('scope').primaryKey(), // e.g. 'SALE-2026-08'
  nextValue: integer('next_value').notNull().default(1),
});
