/**
 * Reporting and export routes — SRS §14.
 *
 * The cross-dealer transaction list, transaction detail, autocomplete, dealer
 * edit/archive, and the three exports.
 *
 * Every export returns money as **integer paise** (§11.2); the browser performs
 * the single conversion at the boundary.
 *
 * Behind the session gate, like everything else under /api — see index.ts.
 */

import { Hono } from 'hono';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { currentBalance, makeDb } from '../posting/post';
import { balanceRows, dealerLedgerRows, transactionRows } from './export-query';
import { cursorParam, exportFilterSchema, patchDealerSchema } from './schemas';
import { fail, flatten, idParam } from './http';
import type { ExportFilters } from '../export/types';
import type { Env } from './index';

export const reporting = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Cross-dealer transactions — FR-N4
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

reporting.get('/transactions', async (c) => {
  const db = makeDb(c.env.DB);
  const q = new URL(c.req.url).searchParams;

  const conditions = [];
  const from = q.get('from');
  const to = q.get('to');
  const mode = q.get('mode');
  const bank = q.get('bankAccount');
  const dealerId = q.get('dealerId');
  const cursor = q.get('cursor');

  if (from) conditions.push(gte(schema.transactions.entryDate, from));
  if (to) conditions.push(lte(schema.transactions.entryDate, to));
  if (mode === 'purchase' || mode === 'sale') conditions.push(eq(schema.transactions.mode, mode));
  if (bank === 'od' || bank === 'current') {
    conditions.push(eq(schema.transactions.bankAccount, bank));
  }
  /*
   * Both of these used to go through a bare `Number()`. `Number('abc')` is NaN,
   * SQLite binds NaN as NULL, and `id < NULL` is NULL - so a garbled cursor
   * came back as an EMPTY page with a 200, and the screen said "no
   * transactions" over a database full of them. Silently showing nothing is the
   * one answer this application must never give, so a bad value is now a 400.
   */
  if (dealerId !== null) {
    const parsed = idParam.safeParse(dealerId);
    if (!parsed.success) return c.json(fail('VALIDATION_FAILED', 'Invalid dealer.'), 400);
    conditions.push(eq(schema.transactions.dealerId, parsed.data));
  }
  // The cursor is the last id of the previous page. Newest first, so the next
  // page continues below it.
  if (cursor !== null) {
    const parsed = cursorParam.safeParse(cursor);
    if (!parsed.success) return c.json(fail('VALIDATION_FAILED', 'Invalid page cursor.'), 400);
    conditions.push(sql`${schema.transactions.id} < ${parsed.data}`);
  }

  const rows = await db
    .select({ tx: schema.transactions, dealerName: schema.dealers.name })
    .from(schema.transactions)
    .innerJoin(schema.dealers, eq(schema.transactions.dealerId, schema.dealers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.transactions.entryDate), desc(schema.transactions.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  return c.json({
    transactions: page.map((r) => ({ ...r.tx, dealerName: r.dealerName })),
    nextCursor: rows.length > PAGE_SIZE ? (page[page.length - 1]?.tx.id ?? null) : null,
  });
});

/** Full detail with line items and this record's audit trail (§10.5). */
reporting.get('/transactions/:id', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such transaction.'), 404);

  const db = makeDb(c.env.DB);
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id.data));
  const tx = rows[0];
  if (!tx) return c.json(fail('NOT_FOUND', 'No such transaction.'), 404);

  const [lines, audit] = await Promise.all([
    db
      .select()
      .from(schema.transactionLines)
      .where(eq(schema.transactionLines.transactionId, tx.id))
      .orderBy(asc(schema.transactionLines.lineNo)),
    db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, 'transactions'), eq(schema.auditLog.entityId, tx.id)))
      .orderBy(desc(schema.auditLog.at)),
  ]);

  return c.json({ transaction: tx, lines, audit });
});

// ---------------------------------------------------------------------------
// Dealer edit / archive — FR-D3, FR-D4
// ---------------------------------------------------------------------------

reporting.patch('/dealers/:id', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  const parsed = patchDealerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(fail('VALIDATION_FAILED', 'Check the details.', flatten(parsed.error)), 400);
  }

  const db = makeDb(c.env.DB);
  const existing = await db.select().from(schema.dealers).where(eq(schema.dealers.id, id.data));
  if (!existing[0]) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  // Identity fields and the archive flag only — editing them never alters a
  // posted figure (FR-D3), and archiving retains every entry (FR-D4).
  await db.batch([
    db.update(schema.dealers).set(parsed.data).where(eq(schema.dealers.id, id.data)),
    db.insert(schema.auditLog).values({
      action: 'edit',
      entity: 'dealers',
      entityId: id.data,
      beforeJson: JSON.stringify({
        name: existing[0].name,
        type: existing[0].type,
        isArchived: existing[0].isArchived,
      }),
      afterJson: JSON.stringify(parsed.data),
    }),
  ]);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Autocomplete — FR-T10
// ---------------------------------------------------------------------------

/**
 * Distinct past values for item name and unit.
 *
 * Suggestions are never required and never constrain input (FR-T10): this is a
 * convenience drawn from what has been typed before, not a master list.
 */
reporting.get('/suggestions', async (c) => {
  const field = c.req.query('field');
  if (field !== 'item' && field !== 'unit') {
    return c.json(fail('VALIDATION_FAILED', "field must be 'item' or 'unit'."), 400);
  }

  const db = makeDb(c.env.DB);
  const column = field === 'item' ? schema.transactionLines.itemName : schema.transactionLines.unit;

  const rows = await db
    .selectDistinct({ value: column })
    .from(schema.transactionLines)
    .where(sql`${column} IS NOT NULL AND trim(${column}) != ''`)
    .orderBy(asc(column))
    .limit(100);

  return c.json({ suggestions: rows.map((r) => r.value).filter((v): v is string => v !== null) });
});

// ---------------------------------------------------------------------------
// Exports — SRS §11
// ---------------------------------------------------------------------------

/**
 * The active filters, validated.
 *
 * Returns `null` for an unrecognised value rather than passing it through: each
 * export sheet prints its own filter line, so a value the query layer does not
 * understand would head the workbook with a filter that was never applied.
 */
function filtersFrom(url: string): ExportFilters | null {
  const parsed = exportFilterSchema.safeParse(Object.fromEntries(new URL(url).searchParams));
  return parsed.success ? parsed.data : null;
}

const badFilters = () => fail('VALIDATION_FAILED', 'One of those filters is not recognised.');

reporting.get('/export/dealer/:id', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  const db = makeDb(c.env.DB);
  const dealer = await db.select().from(schema.dealers).where(eq(schema.dealers.id, id.data));
  if (!dealer[0]) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  const filters = filtersFrom(c.req.url);
  if (!filters) return c.json(badFilters(), 400);

  return c.json({
    kind: 'dealer-ledger',
    dealerName: dealer[0].name,
    // Over ALL entries, never the filtered subset (§6.6).
    closingBalancePaise: await currentBalance(db, id.data),
    filters,
    rows: await dealerLedgerRows(db, id.data, filters),
  });
});

reporting.get('/export/transactions', async (c) => {
  const db = makeDb(c.env.DB);
  const filters = filtersFrom(c.req.url);
  if (!filters) return c.json(badFilters(), 400);

  const dealerId = new URL(c.req.url).searchParams.get('dealerId');

  const scoped = dealerId === null ? null : idParam.safeParse(dealerId);
  if (scoped && !scoped.success) {
    return c.json(fail('VALIDATION_FAILED', 'Invalid dealer.'), 400);
  }

  return c.json({
    kind: 'transactions',
    filters,
    rows: await transactionRows(db, {
      ...filters,
      ...(scoped?.success ? { dealerId: scoped.data } : {}),
    }),
  });
});

reporting.get('/export/balances', async (c) => {
  const db = makeDb(c.env.DB);
  const filters = filtersFrom(c.req.url);
  if (!filters) return c.json(badFilters(), 400);

  return c.json({
    kind: 'balances',
    filters,
    rows: await balanceRows(db, { includeArchived: c.req.query('includeArchived') === 'true' }),
  });
});

// ---------------------------------------------------------------------------
// Audit log — SRS §14, NFR-A1
// ---------------------------------------------------------------------------

/**
 * The read-only audit view, newest first.
 *
 * Read-only in the strongest sense: there is no route anywhere that updates or
 * deletes an audit row. The table is append-only, and this is the only way to
 * look at it (§16.3).
 */
reporting.get('/audit', async (c) => {
  const db = makeDb(c.env.DB);
  const cursor = c.req.query('cursor');

  // Validated, not coerced - see the note on the transactions cursor above.
  const after = cursor === undefined ? null : cursorParam.safeParse(cursor);
  if (after && !after.success) {
    return c.json(fail('VALIDATION_FAILED', 'Invalid page cursor.'), 400);
  }

  const rows = await db
    .select()
    .from(schema.auditLog)
    // Ordered by id, not by `at`: several rows written inside one db.batch share
    // a timestamp to the second, and only the id separates them reliably.
    .where(after?.success ? sql`${schema.auditLog.id} < ${after.data}` : undefined)
    .orderBy(desc(schema.auditLog.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  return c.json({
    entries: page,
    nextCursor: rows.length > PAGE_SIZE ? (page[page.length - 1]?.id ?? null) : null,
  });
});
