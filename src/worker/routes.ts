/**
 * API routes — SRS §14.
 *
 * Phase 1 covers the subset the minimal dealer screen needs: dealers,
 * transactions, payments, voids. The rest (suggestions, audit, exports,
 * cross-dealer transactions, PATCH) arrives with Phase 2.
 *
 * ⚠ NOT YET GATED. §16.3 requires every ledger-mutating endpoint to sit behind
 * the session check, with no unauthenticated write path. The auth gate is
 * Phase 3 (§23) and MUST be in place before any real data is entered.
 */

import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../db/schema';
import {
  createDealer,
  createPayment,
  createTransaction,
  currentBalance,
  makeDb,
} from '../posting/post';
import { voidPayment, voidTransaction } from '../posting/recompute';
import {
  createDealerSchema,
  createPaymentSchema,
  createTransactionSchema,
  ledgerQuerySchema,
} from './schemas';
import type { Env } from './index';

export const api = new Hono<{ Bindings: Env }>();

/** A stable machine-readable `code` plus a human message (§14). */
function fail(code: string, message: string, fields?: Record<string, string>) {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}

function flatten(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

const idParam = z.coerce.number().int().positive();

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
  const filtered = all.filter((e) => {
    if (f.from && e.entryDate < f.from) return false;
    if (f.to && e.entryDate > f.to) return false;
    if (f.bankAccount && e.bankAccount !== f.bankAccount) return false;
    if (f.type && e.sourceType !== f.type) return false;
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
