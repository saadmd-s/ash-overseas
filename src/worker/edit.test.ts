/**
 * Editing without voiding, the mode filter, and page cursors — SRS §14, FR-A6,
 * APP_FLOW §6.1 and §7.
 *
 * The load-bearing assertion in this file is the one that compares every
 * monetary column before and after an edit. `PATCH` is the only route that
 * writes to a posted transaction without going through the ledger engine, so it
 * is the only place a figure could move without a reversing entry — which is
 * the one thing this application must never do.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const url = (path: string) => `https://x${path}`;

function send(method: string, path: string, body?: unknown) {
  return SELF.fetch(url(path), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const post = (path: string, body: unknown) => send('POST', path, body);
const patch = (path: string, body: unknown) => send('PATCH', path, body);
const get = (path: string) => SELF.fetch(url(path));

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function newDealer(name = 'Kumar Traders'): Promise<number> {
  const res = await post('/api/dealers', { name });
  expect(res.status).toBe(201);
  return (await json<{ id: number }>(res)).id;
}

interface TxBody {
  dealerId: number;
  mode: 'purchase' | 'sale';
  entryDate: string;
  bankAccount: 'od' | 'current';
  gstRate: number;
  lines: { itemName?: string; quantity: number; ratePaise: number }[];
  [key: string]: unknown;
}

function txBody(dealerId: number, over: Partial<TxBody> = {}): TxBody {
  return {
    dealerId,
    mode: 'sale',
    entryDate: '2026-08-03',
    bankAccount: 'od',
    gstRate: 18,
    lines: [{ itemName: 'CI Bores', quantity: 100, ratePaise: 5_000 }],
    ...over,
  } as TxBody;
}

async function newTransaction(dealerId: number, over: Partial<TxBody> = {}): Promise<number> {
  const res = await post('/api/transactions', txBody(dealerId, over));
  expect(res.status).toBe(201);
  return (await json<{ id: number }>(res)).id;
}

interface TxDetail {
  transaction: Record<string, unknown>;
  lines: { id: number; lineNo: number; itemName: string | null }[];
  audit: { action: string; beforeJson: string | null; afterJson: string | null }[];
}

const detail = (id: number) => get(`/api/transactions/${id}`).then(json<TxDetail>);

/** Every column that carries money, a date, or a posting decision. */
const FROZEN = [
  'mode',
  'dealerId',
  'entryDate',
  'gstRate',
  'baseTotalPaise',
  'discountPaise',
  'freightPaise',
  'gstAmountPaise',
  'roundOffPaise',
  'grandTotalPaise',
  'isReturnNote',
  'isVoided',
] as const;

const frozenOf = (tx: Record<string, unknown>) =>
  Object.fromEntries(FROZEN.map((k) => [k, tx[k]])) as Record<string, unknown>;

// ---------------------------------------------------------------------------

describe('PATCH /api/transactions/:id — the editable fields (§14, FR-A6)', () => {
  it('edits notes and the reference tag and moves no figure at all', async () => {
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId, { notes: 'first note', referenceTag: 'ASH 39' });

    const before = await detail(id);
    const balanceBefore = await json<{ balancePaise: number }>(
      await get(`/api/dealers/${dealerId}/ledger`),
    );

    const res = await patch(`/api/transactions/${id}`, {
      notes: 'weighed at the yard',
      referenceTag: 'ASH 40',
    });
    expect(res.status).toBe(200);

    const after = await detail(id);
    expect(after.transaction.notes).toBe('weighed at the yard');
    expect(after.transaction.referenceTag).toBe('ASH 40');

    // The whole point of the route: not one monetary or posting field moved.
    expect(frozenOf(after.transaction)).toEqual(frozenOf(before.transaction));

    const balanceAfter = await json<{ balancePaise: number }>(
      await get(`/api/dealers/${dealerId}/ledger`),
    );
    expect(balanceAfter.balancePaise).toBe(balanceBefore.balancePaise);
  });

  it('clears a note when sent null, and leaves an unsent field alone', async () => {
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId, { notes: 'to remove', referenceTag: 'ASH 41' });

    expect((await patch(`/api/transactions/${id}`, { notes: null })).status).toBe(200);

    const after = await detail(id);
    expect(after.transaction.notes).toBeNull();
    // referenceTag was not in the body at all, so it must be untouched — the
    // difference between "sent as null" and "not sent".
    expect(after.transaction.referenceTag).toBe('ASH 41');
  });

  it('corrects an item name by line id', async () => {
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId, {
      lines: [
        { itemName: 'CI Boers', quantity: 100, ratePaise: 5_000 },
        { itemName: 'Scrap', quantity: 50, ratePaise: 2_000 },
      ],
    });

    const before = await detail(id);
    const typo = before.lines.find((l) => l.itemName === 'CI Boers');
    expect(typo).toBeDefined();

    const res = await patch(`/api/transactions/${id}`, {
      lines: [{ id: typo!.id, itemName: 'CI Bores' }],
    });
    expect(res.status).toBe(200);

    const after = await detail(id);
    expect(after.lines.find((l) => l.id === typo!.id)?.itemName).toBe('CI Bores');
    // The other line is untouched, and so is every figure.
    expect(after.lines.find((l) => l.itemName === 'Scrap')).toBeDefined();
    expect(frozenOf(after.transaction)).toEqual(frozenOf(before.transaction));
  });

  it('updates the ledger row display text when the reference tag changes', async () => {
    // Otherwise the dealer's history shows the old tag while the entry itself
    // shows the new one — one record disagreeing with itself.
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId, { referenceTag: 'ASH 39' });

    const ledgerBefore = await json<{
      entries: { description: string | null; runningBalancePaise: number }[];
    }>(await get(`/api/dealers/${dealerId}/ledger`));
    expect(ledgerBefore.entries[0].description).toBe('ASH 39');

    expect((await patch(`/api/transactions/${id}`, { referenceTag: 'ASH 40' })).status).toBe(200);

    const ledgerAfter = await json<{
      entries: { description: string | null; runningBalancePaise: number }[];
    }>(await get(`/api/dealers/${dealerId}/ledger`));

    expect(ledgerAfter.entries[0].description).toBe('ASH 40');
    // Display text only — the balance column is untouched.
    expect(ledgerAfter.entries[0].runningBalancePaise).toBe(
      ledgerBefore.entries[0].runningBalancePaise,
    );
  });

  it('writes an audit row carrying the before and after, and no money', async () => {
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId, { notes: 'old' });

    await patch(`/api/transactions/${id}`, { notes: 'new' });

    const after = await detail(id);
    const edit = after.audit.find((a) => a.action === 'edit');
    expect(edit).toBeDefined();
    expect(JSON.parse(edit!.beforeJson!)).toEqual({ notes: 'old' });
    expect(JSON.parse(edit!.afterJson!)).toEqual({ notes: 'new' });

    // FR-A4 and §16.3 — an audit row is not a place to copy amounts.
    const written = `${edit!.beforeJson}${edit!.afterJson}`;
    expect(written).not.toMatch(/Paise/);
    expect(written).not.toMatch(/5000|590000/);
  });
});

describe('PATCH /api/transactions/:id — what it must refuse', () => {
  it('rejects every financial field rather than silently ignoring it', async () => {
    // Zod's default is to STRIP an unknown key, which would answer 200 to
    // "change the amount to ₹1" and change nothing. On a ledger, being told the
    // amount changed when it did not is worse than an error.
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId);

    const forbidden: Record<string, unknown>[] = [
      { grandTotalPaise: 1 },
      { entryDate: '2026-08-04' },
      { dealerId: 2 },
      { mode: 'purchase' },
      { gstRate: 0 },
      { discountPaise: 1 },
      { freightPaise: 1 },
      { isVoided: true },
      { notes: 'ok', grandTotalPaise: 1 },
    ];

    for (const body of forbidden) {
      const res = await patch(`/api/transactions/${id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('VALIDATION_FAILED');
    }

    // And a rate hidden inside a line edit.
    const lines = (await detail(id)).lines;
    const res = await patch(`/api/transactions/${id}`, {
      lines: [{ id: lines[0].id, itemName: 'x', ratePaise: 1 }],
    });
    expect(res.status).toBe(400);

    // Nothing moved through any of it.
    expect(frozenOf((await detail(id)).transaction)).toEqual({
      mode: 'sale',
      dealerId,
      entryDate: '2026-08-03',
      gstRate: 18,
      baseTotalPaise: 500_000,
      discountPaise: 0,
      freightPaise: 0,
      gstAmountPaise: 90_000,
      roundOffPaise: 0,
      grandTotalPaise: 590_000,
      isReturnNote: false,
      isVoided: false,
    });
  });

  it('refuses a line id belonging to another transaction', async () => {
    const dealerId = await newDealer();
    const mine = await newTransaction(dealerId);
    const theirs = await newTransaction(dealerId, {
      lines: [{ itemName: 'Not yours', quantity: 1, ratePaise: 100 }],
    });

    const strayLine = (await detail(theirs)).lines[0];
    const res = await patch(`/api/transactions/${mine}`, {
      lines: [{ id: strayLine.id, itemName: 'hijacked' }],
    });

    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('LINE_NOT_FOUND');
    // The other transaction's line is exactly as it was.
    expect((await detail(theirs)).lines[0].itemName).toBe('Not yours');
  });

  it('404s an unknown transaction and 400s an empty body', async () => {
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId);

    expect((await patch('/api/transactions/999999', { notes: 'x' })).status).toBe(404);
    expect((await patch(`/api/transactions/${id}`, {})).status).toBe(400);
    expect((await patch(`/api/transactions/${id}`, null)).status).toBe(400);
  });
});

describe('The mode filter — SRS §14, APP_FLOW §7', () => {
  it('actually filters, instead of accepting the parameter and ignoring it', async () => {
    const dealerId = await newDealer();
    await newTransaction(dealerId, { mode: 'sale', entryDate: '2026-08-01' });
    await newTransaction(dealerId, { mode: 'purchase', entryDate: '2026-08-02' });
    await post('/api/payments', {
      dealerId,
      entryDate: '2026-08-03',
      direction: 'received',
      amountPaise: 100_000,
    });

    const all = await json<{ totalCount: number; balancePaise: number }>(
      await get(`/api/dealers/${dealerId}/ledger`),
    );
    expect(all.totalCount).toBe(3);

    const sales = await json<{
      entries: { label: string | null }[];
      shownCount: number;
      totalCount: number;
      balancePaise: number;
    }>(await get(`/api/dealers/${dealerId}/ledger?mode=sale`));

    // The regression: this used to come back with shownCount === totalCount,
    // a filter reporting that it had done nothing while looking as if it worked.
    expect(sales.shownCount).toBe(1);
    expect(sales.totalCount).toBe(3);
    expect(sales.entries.map((e) => e.label)).toEqual(['Sale']);

    // §6.6 — the headline is over ALL entries, filter or no filter.
    expect(sales.balancePaise).toBe(all.balancePaise);
  });

  it('excludes payments and openings, which are neither a purchase nor a sale', async () => {
    const dealerId = await newDealer();
    await post('/api/payments', {
      dealerId,
      entryDate: '2026-08-03',
      direction: 'paid',
      amountPaise: 100_000,
    });

    const filtered = await json<{ shownCount: number; totalCount: number }>(
      await get(`/api/dealers/${dealerId}/ledger?mode=purchase`),
    );
    expect(filtered.totalCount).toBe(1);
    expect(filtered.shownCount).toBe(0);
  });

  it('keeps a reversal with the entry it reverses, not with the opposite mode', async () => {
    // A reversal row names its source id but not which table it came from, and
    // the two tables number independently — so this has to resolve through
    // reverses_entry_id or it will guess wrong.
    const dealerId = await newDealer();
    const saleId = await newTransaction(dealerId, { mode: 'sale', entryDate: '2026-08-01' });
    await newTransaction(dealerId, { mode: 'purchase', entryDate: '2026-08-02' });
    await post(`/api/transactions/${saleId}/void`, {});

    const sales = await json<{ entries: { label: string | null }[] }>(
      await get(`/api/dealers/${dealerId}/ledger?mode=sale`),
    );
    expect(sales.entries.map((e) => e.label)).toEqual(['Sale', 'Reversal']);

    const purchases = await json<{ entries: { label: string | null }[] }>(
      await get(`/api/dealers/${dealerId}/ledger?mode=purchase`),
    );
    expect(purchases.entries.map((e) => e.label)).toEqual(['Purchase']);
  });
});

describe('Page cursors are validated, never coerced', () => {
  it('rejects a garbled cursor instead of returning an empty page', async () => {
    // Number('abc') is NaN, SQLite binds NaN as NULL, and `id < NULL` is NULL —
    // so this used to answer 200 with zero rows over a database full of them.
    const dealerId = await newDealer();
    await newTransaction(dealerId);

    for (const path of [
      '/api/transactions?cursor=abc',
      '/api/transactions?cursor=0',
      '/api/transactions?dealerId=abc',
      '/api/audit?cursor=abc',
      '/api/export/transactions?dealerId=abc',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('still accepts a real cursor', async () => {
    const dealerId = await newDealer();
    const id = await newTransaction(dealerId);

    const res = await get(`/api/transactions?cursor=${id + 1}&dealerId=${dealerId}`);
    expect(res.status).toBe(200);
    expect((await json<{ transactions: unknown[] }>(res)).transactions).toHaveLength(1);
  });
});

describe('Export filters are validated too', () => {
  it('refuses a filter it does not understand, rather than heading a sheet with it', async () => {
    // Every export sheet prints its own filter line. Passing an unrecognised
    // value through produced a workbook headed "Mode: garbage" over rows that
    // had never been filtered by mode — a spreadsheet misdescribing itself.
    const dealerId = await newDealer();
    await newTransaction(dealerId);

    for (const path of [
      `/api/export/dealer/${dealerId}?mode=garbage`,
      `/api/export/dealer/${dealerId}?bankAccount=savings`,
      `/api/export/dealer/${dealerId}?from=01-08-2026`,
      '/api/export/transactions?mode=garbage',
      '/api/export/balances?dealerType=nonsense',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(400);
    }
  });

  it('still accepts the filters the screens actually send', async () => {
    const dealerId = await newDealer();
    await newTransaction(dealerId, { mode: 'sale' });

    for (const path of [
      `/api/export/dealer/${dealerId}?mode=sale&bankAccount=od&from=2026-08-01&to=2026-08-31`,
      `/api/export/dealer/${dealerId}?type=transaction`,
      `/api/export/transactions?mode=sale&dealerId=${dealerId}`,
      '/api/export/balances?includeArchived=true',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
  });
});
