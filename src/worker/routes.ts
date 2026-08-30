/**
 * API routes — SRS §14.
 *
 * Dealers, transactions, payments and voids. Reporting, exports and the audit
 * view are in routes-reporting.ts; authentication is in auth.ts.
 *
 * Every route here is behind the session gate — index.ts mounts
 * `requireSession` on `/api/*` ABOVE this router, so a route added to this file
 * is gated by default and nothing has to be remembered. auth.test.ts sweeps
 * Hono's own route table and fails if any route escapes it.
 *
 * §14 is now complete: `PATCH /api/transactions/:id` at the foot of this file
 * edits the non-financial fields (notes, reference tag, item name) in place.
 */

import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  createDealer,
  createPayment,
  createTransaction,
  currentBalance,
  makeDb,
} from '../posting/post';
import { voidPayment, voidTransaction } from '../posting/recompute';
import type { BatchItem } from '../posting/db';
import {
  createDealerSchema,
  createPaymentSchema,
  createTransactionSchema,
  ledgerQuerySchema,
  patchTransactionSchema,
} from './schemas';
import { modeMatcher } from './export-query';
import { fail, flatten, idParam } from './http';
import type { Env } from './index';

export const api = new Hono<{ Bindings: Env }>();

// Shared with routes-reporting.ts so both surfaces answer identically.

// ---------------------------------------------------------------------------
// Dealers
// ---------------------------------------------------------------------------

api.get('/dealers', async (c) => {
  const db = makeDb(c.env.DB);
  const includeArchived = c.req.query('includeArchived') === 'true';
  const type = c.req.query('type');
  const q = c.req.query('q');

  const conditions = [];
  if (!includeArchived) conditions.push(eq(schema.dealers.isArchived, false));
  // A dealer of type 'both' appears in BOTH lists — the type is a list filter
  // only and never splits the balance (§4.2, FR-D2).
  if (type === 'supplier' || type === 'buyer') {
    conditions.push(sql`${schema.dealers.type} IN (${type}, 'both')`);
  }
  if (q) conditions.push(sql`lower(${schema.dealers.name}) LIKE lower(${`%${q}%`})`);

  const dealers = await db
    .select()
    .from(schema.dealers)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(schema.dealers.name));

  // Inline balances (FR-N2), served from the STORED running balance and never
  // recomputed on read (FR-L1).
  const withBalances = await Promise.all(
    dealers.map(async (d) => ({ ...d, balancePaise: await currentBalance(db, d.id) })),
  );

  return c.json({ dealers: withBalances });
});

api.post('/dealers', async (c) => {
  const parsed = createDealerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      fail('VALIDATION_FAILED', 'Check the dealer details.', flatten(parsed.error)),
      400,
    );
  }

  const created = await createDealer(makeDb(c.env.DB), parsed.data);
  return c.json({ id: created.id }, 201);
});

api.get('/dealers/:id', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  const db = makeDb(c.env.DB);
  const rows = await db.select().from(schema.dealers).where(eq(schema.dealers.id, id.data));
  const dealer = rows[0];
  if (!dealer) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  return c.json({ dealer: { ...dealer, balancePaise: await currentBalance(db, dealer.id) } });
});

/**
 * The dealer's history.
 *
 * §6.6 and FR-L4: filtering is PRESENTATIONAL. The headline balance and the
 * running-balance column are always computed over ALL entries, never over the
 * filtered subset. So this returns the true balance plus both counts, and the
 * client shows "showing N of M entries" — the notice that makes a filtered view
 * impossible to misread as the full position.
 */
api.get('/dealers/:id/ledger', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such dealer.'), 404);

  const query = ledgerQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!query.success) {
    return c.json(fail('VALIDATION_FAILED', 'Invalid filters.', flatten(query.error)), 400);
  }

  const db = makeDb(c.env.DB);
  const dealerId = id.data;

  const all = await db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.dealerId, dealerId))
    .orderBy(asc(schema.ledgerEntries.entryDate), asc(schema.ledgerEntries.id));

  const f = query.data;

  // `mode` is the one filter that cannot be answered from the ledger row alone:
  // a purchase/sale is a property of the transaction behind it. It was accepted
  // by the query schema and then silently ignored, so a mode-filtered request
  // came back UNFILTERED with shownCount === totalCount - a filter that says it
  // did nothing while appearing to have worked. Resolved through the same
  // matcher the export uses, so screen and spreadsheet cannot disagree.
  let matchesMode: ((e: (typeof all)[number]) => boolean) | null = null;
  if (f.mode) {
    const modes = await db
      .select({ id: schema.transactions.id, mode: schema.transactions.mode })
      .from(schema.transactions)
      .where(eq(schema.transactions.dealerId, dealerId));
    matchesMode = modeMatcher(all, new Map(modes.map((t) => [t.id, t.mode])), f.mode);
  }

  const filtered = all.filter((e) => {
    if (f.from && e.entryDate < f.from) return false;
    if (f.to && e.entryDate > f.to) return false;
    if (f.bankAccount && e.bankAccount !== f.bankAccount) return false;
    if (f.type && e.sourceType !== f.type) return false;
    if (matchesMode && !matchesMode(e)) return false;
    return true;
  });

  return c.json({
    entries: filtered,
    totalCount: all.length,
    shownCount: filtered.length,
    // The headline, over ALL entries. This is the figure Scenario F protects.
    balancePaise: await currentBalance(db, dealerId),
  });
});

// ---------------------------------------------------------------------------
// Transactions and payments
// ---------------------------------------------------------------------------

/** §10.9 — the dealer must exist and must not be archived. */
async function assertPostableDealer(
  db: ReturnType<typeof makeDb>,
  dealerId: number,
): Promise<{ code: string; message: string; status: 404 | 409 } | null> {
  const rows = await db
    .select({ id: schema.dealers.id, isArchived: schema.dealers.isArchived })
    .from(schema.dealers)
    .where(eq(schema.dealers.id, dealerId));

  if (!rows[0]) return { code: 'NOT_FOUND', message: 'No such dealer.', status: 404 };
  if (rows[0].isArchived) {
    return { code: 'DEALER_ARCHIVED', message: 'That dealer is archived.', status: 409 };
  }
  return null;
}

api.post('/transactions', async (c) => {
  const parsed = createTransactionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(fail('VALIDATION_FAILED', 'Check the entry.', flatten(parsed.error)), 400);
  }

  const db = makeDb(c.env.DB);
  const problem = await assertPostableDealer(db, parsed.data.dealerId);
  if (problem) return c.json(fail(problem.code, problem.message), problem.status);

  return c.json(await createTransaction(db, parsed.data), 201);
});

api.post('/payments', async (c) => {
  const parsed = createPaymentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(fail('VALIDATION_FAILED', 'Check the entry.', flatten(parsed.error)), 400);
  }

  const db = makeDb(c.env.DB);
  const problem = await assertPostableDealer(db, parsed.data.dealerId);
  if (problem) return c.json(fail(problem.code, problem.message), problem.status);

  return c.json(await createPayment(db, parsed.data), 201);
});

api.post('/transactions/:id/void', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such transaction.'), 404);

  try {
    return c.json(await voidTransaction(makeDb(c.env.DB), id.data));
  } catch (error) {
    // The messages thrown by the void path name no amount and no dealer, so
    // this is safe to return verbatim (§16.3).
    return c.json(fail('VOID_FAILED', (error as Error).message), 409);
  }
});

api.post('/payments/:id/void', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such payment.'), 404);

  try {
    return c.json(await voidPayment(makeDb(c.env.DB), id.data));
  } catch (error) {
    return c.json(fail('VOID_FAILED', (error as Error).message), 409);
  }
});

/**
 * Edit the non-financial fields of a transaction — SRS §14, FR-A6.
 *
 * Notes, the reference tag, and the spelling of an item name. None of them can
 * move a figure, which is exactly why they are editable in place while a change
 * to a date, amount, quantity, rate, GST rate, discount, freight, dealer or
 * mode still needs a void and a re-entry. The request schema has no such field,
 * and it is `.strict()`, so sending one is a 400 rather than a silent no-op.
 *
 * Every write is one `db.batch` (§15.3): the header, any line, the ledger row's
 * display text, and the audit row land together or not at all.
 *
 * A VOIDED transaction can still be edited here. Nothing about it is financial,
 * the void is not undone, and correcting the wording on a record that has to be
 * kept forever is the reason the field exists. Refusing would be a rule the
 * specification does not have.
 */
api.patch('/transactions/:id', async (c) => {
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('NOT_FOUND', 'No such transaction.'), 404);

  const parsed = patchTransactionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(fail('VALIDATION_FAILED', 'Check the details.', flatten(parsed.error)), 400);
  }

  const db = makeDb(c.env.DB);
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id.data))
    .limit(1);

  const tx = rows[0];
  if (!tx) return c.json(fail('NOT_FOUND', 'No such transaction.'), 404);

  const edits = parsed.data;
  const statements: BatchItem[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  // --- the header -----------------------------------------------------------
  // `'notes' in edits` rather than a truthiness check: Zod drops an absent key
  // entirely, so this distinguishes "not sent" from "sent as null to clear it".
  const headerPatch: { notes?: string | null; referenceTag?: string | null } = {};
  if ('notes' in edits) {
    headerPatch.notes = edits.notes ?? null;
    before.notes = tx.notes;
    after.notes = headerPatch.notes;
  }
  if ('referenceTag' in edits) {
    headerPatch.referenceTag = edits.referenceTag ?? null;
    before.referenceTag = tx.referenceTag;
    after.referenceTag = headerPatch.referenceTag;
  }

  if (Object.keys(headerPatch).length > 0) {
    statements.push(
      db.update(schema.transactions).set(headerPatch).where(eq(schema.transactions.id, tx.id)),
    );
  }

  /*
   * The ledger row carries the reference tag as its display text, copied at
   * create time. Leaving it behind would show the old tag in the dealer's
   * history and the new one on the entry itself — the same record disagreeing
   * with itself, which on a ledger reads as corruption. It is display text, not
   * a figure; no amount and no balance is touched here.
   */
  if ('referenceTag' in edits) {
    statements.push(
      db
        .update(schema.ledgerEntries)
        .set({ description: headerPatch.referenceTag ?? tx.invoiceNo ?? null })
        .where(
          and(
            eq(schema.ledgerEntries.sourceType, 'transaction'),
            eq(schema.ledgerEntries.sourceId, tx.id),
          ),
        ),
    );
  }

  // --- the lines ------------------------------------------------------------
  if (edits.lines?.length) {
    const existing = await db
      .select({ id: schema.transactionLines.id, itemName: schema.transactionLines.itemName })
      .from(schema.transactionLines)
      .where(eq(schema.transactionLines.transactionId, tx.id));

    // Addressed by primary key, and every one is checked to belong to THIS
    // transaction — an id from another transaction must not be reachable
    // through this route.
    const known = new Map(existing.map((l) => [l.id, l]));
    const stray = edits.lines.find((l) => !known.has(l.id));
    if (stray) {
      return c.json(fail('LINE_NOT_FOUND', 'That line is not part of this entry.'), 400);
    }

    const lineBefore: Record<number, string | null> = {};
    const lineAfter: Record<number, string | null> = {};

    for (const line of edits.lines) {
      const itemName = line.itemName ?? null;
      lineBefore[line.id] = known.get(line.id)?.itemName ?? null;
      lineAfter[line.id] = itemName;
      statements.push(
        db
          .update(schema.transactionLines)
          .set({ itemName })
          .where(eq(schema.transactionLines.id, line.id)),
      );
    }

    before.lines = lineBefore;
    after.lines = lineAfter;
  }

  if (statements.length === 0) {
    return c.json(fail('VALIDATION_FAILED', 'Nothing to change.'), 400);
  }

  // The audit row (FR-A4). Only the fields that actually changed, and not one
  // of them is monetary — an audit trail is not a place to copy amounts (§16.3).
  statements.push(
    db.insert(schema.auditLog).values({
      action: 'edit',
      entity: 'transactions',
      entityId: tx.id,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
    }),
  );

  await db.batch(statements as [BatchItem, ...BatchItem[]]);
  return c.json({ ok: true });
});
