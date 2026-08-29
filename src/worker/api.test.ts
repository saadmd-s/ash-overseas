/**
 * API-level tests — SRS §20's third row.
 *
 * Covers what the posting tests cannot: that the server boundary actually
 * rejects what §10.9 says it must, and that filtering never moves the headline.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { todayIST } from './schemas';

async function post(path: string, body: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function newDealer(name = 'Kumar Traders'): Promise<number> {
  const res = await post('/api/dealers', { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const sale = (dealerId: number, entryDate: string, ratePaise: number, extra = {}) => ({
  dealerId,
  mode: 'sale',
  entryDate,
  bankAccount: 'od',
  gstRate: 18,
  lines: [{ quantity: 1, ratePaise }],
  ...extra,
});

describe('Money validation at the server boundary (§10.9, §16.3)', () => {
  it('rejects a fractional paise amount', async () => {
    const id = await newDealer();
    const res = await post('/api/transactions', sale(id, '2026-08-01', 100.5));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string; fields: Record<string, string> } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(body.error.fields).join()).toContain('ratePaise');
  });

  it('rejects NaN and Infinity', async () => {
    const id = await newDealer();
    // JSON has no NaN literal, so these arrive as null / a string — both of
    // which must be rejected just as firmly.
    for (const bad of [null, 'NaN', '1e999']) {
      const res = await post('/api/transactions', sale(id, '2026-08-01', bad as never));
      expect(res.status).toBe(400);
    }
  });

  it('rejects a negative rate', async () => {
    const id = await newDealer();
    const res = await post('/api/transactions', sale(id, '2026-08-01', -100));
    expect(res.status).toBe(400);
  });

  it('rejects a payment of zero', async () => {
    const id = await newDealer();
    const res = await post('/api/payments', {
      dealerId: id,
      entryDate: '2026-08-01',
      direction: 'received',
      amountPaise: 0,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a GST rate above 100', async () => {
    const id = await newDealer();
    const res = await post('/api/transactions', sale(id, '2026-08-01', 100, { gstRate: 101 }));
    expect(res.status).toBe(400);
  });

  it('rejects a discount exceeding the base total', async () => {
    const id = await newDealer();
    const res = await post(
      '/api/transactions',
      sale(id, '2026-08-01', 100_000, { discountPaise: 200_000 }),
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { fields: Record<string, string> } };
    expect(body.error.fields.discountPaise).toMatch(/discount/i);
  });

  it('rejects a transaction with no line items', async () => {
    const id = await newDealer();
    const res = await post('/api/transactions', { ...sale(id, '2026-08-01', 100), lines: [] });
    expect(res.status).toBe(400);
  });
});

describe('Date validation against IST, not UTC (§12.4, §10.9)', () => {
  it('rejects a future date', async () => {
    const id = await newDealer();
    const res = await post('/api/transactions', sale(id, '2099-01-01', 100_000));
    expect(res.status).toBe(400);
  });

  it("accepts today's IST date", async () => {
    const id = await newDealer();
    const res = await post('/api/transactions', sale(id, todayIST(), 100_000));
    expect(res.status).toBe(201);
  });

  it('treats 23:00 UTC as already tomorrow in IST', async () => {
    // The bug this guards: at 23:00 UTC on the 1st it is 04:30 on the 2nd in
    // IST, so an entry dated the 2nd is legitimately "today" for the owner. A
    // UTC-based check would reject it.
    const lateUtc = new Date('2026-08-01T23:00:00Z');
    expect(todayIST(lateUtc)).toBe('2026-08-02');

    // And just before the boundary it is still the 1st.
    expect(todayIST(new Date('2026-08-01T18:29:00Z'))).toBe('2026-08-01');
  });

  it('rejects a malformed date', async () => {
    const id = await newDealer();
    for (const bad of ['01-08-2026', '2026-8-1', 'yesterday', '2026-13-01']) {
      const res = await post('/api/transactions', sale(id, bad, 100_000));
      expect(res.status).toBe(400);
    }
  });
});

describe('Dealer guards (§10.9)', () => {
  it('rejects an unknown dealer', async () => {
    const res = await post('/api/transactions', sale(9999, '2026-08-01', 100_000));
    expect(res.status).toBe(404);
  });

  it('requires a name', async () => {
    const res = await post('/api/dealers', { name: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('Filtering is presentational — Scenario F (§6.6, FR-L4)', () => {
  it('never moves the headline or the running balance', async () => {
    const id = await newDealer();
    await post('/api/transactions', {
      ...sale(id, '2026-08-03', 5_000_000),
      bankAccount: 'od',
    });
    await post('/api/transactions', {
      ...sale(id, '2026-08-04', 10_000_000),
      bankAccount: 'current',
    });

    const unfiltered = (await (await SELF.fetch(`https://x/api/dealers/${id}/ledger`)).json()) as {
      entries: unknown[];
      totalCount: number;
      shownCount: number;
      balancePaise: number;
    };

    expect(unfiltered.balancePaise).toBe(17_700_000);
    expect(unfiltered.totalCount).toBe(2);
    expect(unfiltered.shownCount).toBe(2);

    const odOnly = (await (
      await SELF.fetch(`https://x/api/dealers/${id}/ledger?bankAccount=od`)
    ).json()) as {
      entries: { runningBalancePaise: number }[];
      totalCount: number;
      shownCount: number;
      balancePaise: number;
    };

    // One row shown, of two — the "showing N of M" notice the UI must render.
    expect(odOnly.shownCount).toBe(1);
    expect(odOnly.totalCount).toBe(2);
    // The headline is UNCHANGED.
    expect(odOnly.balancePaise).toBe(17_700_000);
    // And the running balance column carries the TRUE running balance, not one
    // recomputed over the filtered subset.
    expect(odOnly.entries[0].runningBalancePaise).toBe(5_900_000);
  });
});

describe('Void over the API', () => {
  it('reverses and returns the restored balance', async () => {
    const id = await newDealer();
    const created = (await (
      await post('/api/transactions', sale(id, '2026-08-03', 5_000_000))
    ).json()) as { id: number };

    const res = await post(`/api/transactions/${created.id}/void`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runningBalancePaise: number }).runningBalancePaise).toBe(0);
  });

  it('refuses a second void with a stable error code', async () => {
    const id = await newDealer();
    const created = (await (
      await post('/api/transactions', sale(id, '2026-08-03', 5_000_000))
    ).json()) as { id: number };

    await post(`/api/transactions/${created.id}/void`, {});
    const res = await post(`/api/transactions/${created.id}/void`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VOID_FAILED');
  });
});

describe('Routing', () => {
  it('returns a JSON 404 for an unknown API path, never the SPA shell', async () => {
    const res = await SELF.fetch('https://x/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
