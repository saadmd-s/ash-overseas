/**
 * The Phase 2 gate, as a test — SRS §23.
 *
 * "A full purchase and a full sale — including discount, freight, round-off,
 *  and both bank account tags — can be entered, voided, and exported […]; the
 *  exported figures reconcile EXACTLY with the screen."
 *
 * The reconciliation is the part worth automating: it drives the real API, then
 * runs the real row-builder over the real export payload, and compares the
 * result against the figures the ledger endpoint reports.
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSheet } from '../export/build';
import type { AnyExport, DealerLedgerExport } from '../export/types';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const get = async <T>(path: string): Promise<T> =>
  (await (await SELF.fetch(`https://x${path}`)).json()) as T;

let dealerId: number;
let purchaseId: number;
let saleId: number;

beforeEach(async () => {
  ({ id: dealerId } = await post<{ id: number }>('/api/dealers', {
    name: 'Kumar Traders',
    type: 'both',
    gstin: '33ABCDE1234F1Z5',
    stateCode: '33',
  }));

  // A full purchase: two lines, a discount, freight, OD.
  ({ id: purchaseId } = await post<{ id: number }>('/api/transactions', {
    dealerId,
    mode: 'purchase',
    entryDate: '2026-08-03',
    invoiceNo: 'INV-77',
    referenceTag: 'ASH 30',
    bankAccount: 'od',
    gstRate: 18,
    discountPaise: 500_000,
    freightPaise: 200_000,
    notes: 'Two lots',
    lines: [
      { itemName: 'Castings', quantity: 500, unit: 'kg', ratePaise: 10_000 },
      { itemName: 'Scrap', quantity: 100, unit: 'kg', ratePaise: 50_000 },
    ],
  }));

  // A full sale that produces a round-off, on the Current account.
  ({ id: saleId } = await post<{ id: number }>('/api/transactions', {
    dealerId,
    mode: 'sale',
    entryDate: '2026-08-09',
    referenceTag: 'ASH 39',
    bankAccount: 'current',
    gstRate: 18,
    lines: [{ itemName: 'Castings', quantity: 9510, unit: 'kg', ratePaise: 2400 }],
  }));
});

describe('Phase 2 gate — enter, void, export, reconcile', () => {
  it('records both bank tags without splitting the balance', async () => {
    const ledger = await get<{ entries: { bankAccount: string }[]; balancePaise: number }>(
      `/api/dealers/${dealerId}/ledger`,
    );
    expect(ledger.entries.map((e) => e.bankAccount)).toEqual(['od', 'current']);
    // One balance across both accounts (§4.3).
    expect(typeof ledger.balancePaise).toBe('number');
  });

  it('carries discount, freight and round-off into the export', async () => {
    const data = await get<DealerLedgerExport>(`/api/export/dealer/${dealerId}`);
    const sheet = buildSheet(data, '2026-08-29');

    const purchase = sheet.rows.find((r) => r[3] === 'ASH 30')!;
    expect(purchase[9]).toBe(5_000); // Discount ₹5,000.00
    expect(purchase[10]).toBe(2_000); // Freight ₹2,000.00

    const sale = sheet.rows.find((r) => r[3] === 'ASH 39')!;
    expect(sale[8]).toBe(228_240); // Base  ₹2,28,240.00
    expect(sale[12]).toBe(41_083.2); // GST   ₹41,083.20
    expect(sale[13]).toBe(-0.2); // Round off −₹0.20
    expect(sale[14]).toBe(269_323); // Total ₹2,69,323.00
  });

  it('reconciles every exported figure with the ledger endpoint', async () => {
    // This is the gate. The screen reads from /ledger; the export reads from
    // /export/dealer. If those two ever disagree, the owner hands the
    // accountant a file that contradicts what they were just looking at.
    const ledger = await get<{
      entries: { runningBalancePaise: number; entryDate: string }[];
      balancePaise: number;
    }>(`/api/dealers/${dealerId}/ledger`);

    const data = await get<DealerLedgerExport>(`/api/export/dealer/${dealerId}`);
    const sheet = buildSheet(data, '2026-08-29');

    expect(sheet.rows).toHaveLength(ledger.entries.length);

    sheet.rows.forEach((row, i) => {
      // Column S (index 18) is the running balance, in rupees.
      expect(row[18]).toBe(ledger.entries[i].runningBalancePaise / 100);
    });

    expect(data.closingBalancePaise).toBe(ledger.balancePaise);
  });

  it('includes the voided entry and its reversal, flagged, never dropped', async () => {
    await post(`/api/transactions/${saleId}/void`, {});

    const data = await get<DealerLedgerExport>(`/api/export/dealer/${dealerId}`);
    const sheet = buildSheet(data, '2026-08-29');

    // Three rows now: purchase, the voided sale, and its reversal.
    expect(sheet.rows).toHaveLength(3);

    const statuses = sheet.rows.map((r) => r[20]);
    expect(statuses).toContain('VOIDED');
    expect(statuses).toContain('REVERSAL');

    // The voided row is marked for strike-through, not removed (§11.4).
    expect(sheet.struckRows.length).toBe(1);

    // And the reversal sits on the row after the entry it undoes.
    const voidedIndex = statuses.indexOf('VOIDED');
    expect(statuses[voidedIndex + 1]).toBe('REVERSAL');
  });

  it('still reconciles after the void', async () => {
    await post(`/api/transactions/${saleId}/void`, {});

    const ledger = await get<{
      entries: { runningBalancePaise: number }[];
      balancePaise: number;
    }>(`/api/dealers/${dealerId}/ledger`);
    const data = await get<DealerLedgerExport>(`/api/export/dealer/${dealerId}`);
    const sheet = buildSheet(data, '2026-08-29');

    sheet.rows.forEach((row, i) => {
      expect(row[18]).toBe(ledger.entries[i].runningBalancePaise / 100);
    });
    expect(data.closingBalancePaise).toBe(ledger.balancePaise);
  });

  it('states the applied filters in the sheet, so a file cannot be misread', async () => {
    const data = await get<DealerLedgerExport>(`/api/export/dealer/${dealerId}?bankAccount=od`);
    const sheet = buildSheet(data, '2026-08-29');

    expect(sheet.title.some((line) => line.includes('Bank account: OD'))).toBe(true);
    // Filtered to one row...
    expect(sheet.rows).toHaveLength(1);
    // ...but the closing balance is still the FULL position (§6.6).
    const unfiltered = await get<{ balancePaise: number }>(`/api/dealers/${dealerId}/ledger`);
    expect(data.closingBalancePaise).toBe(unfiltered.balancePaise);
  });
});

describe('All-transactions and balances exports', () => {
  it('exports every transaction with its dealer', async () => {
    const data = await get<AnyExport>('/api/export/transactions');
    const sheet = buildSheet(data, '2026-08-29');

    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows.every((r) => r[1] === 'Kumar Traders')).toBe(true);
    expect(sheet.header[1]).toBe('Dealer');
  });

  it('honours a mode filter', async () => {
    const data = await get<AnyExport>('/api/export/transactions?mode=sale');
    const sheet = buildSheet(data, '2026-08-29');
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0][2]).toBe('Sale');
  });

  it('exports one row per dealer with a signed balance and its direction', async () => {
    const data = await get<AnyExport>('/api/export/balances');
    const sheet = buildSheet(data, '2026-08-29');

    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0][0]).toBe('Kumar Traders');
    expect(sheet.rows[0][2]).toBe('33ABCDE1234F1Z5');
    expect(typeof sheet.rows[0][4]).toBe('number');
    expect(['Dealer owes you', 'You owe dealer', 'Settled']).toContain(sheet.rows[0][5]);
    expect(sheet.rows[0][7]).toBe(2); // transaction count
  });
});

describe('Autocomplete — FR-T10', () => {
  it('offers item names and units drawn from past entries', async () => {
    const items = await get<{ suggestions: string[] }>('/api/suggestions?field=item');
    const units = await get<{ suggestions: string[] }>('/api/suggestions?field=unit');

    expect(items.suggestions).toContain('Castings');
    expect(items.suggestions).toContain('Scrap');
    expect(units.suggestions).toEqual(['kg']);
  });

  it('rejects an unknown field', async () => {
    const res = await SELF.fetch('https://x/api/suggestions?field=colour');
    expect(res.status).toBe(400);
  });
});

describe('Transaction detail — §10.5', () => {
  it('returns the full breakdown with line items and the audit trail', async () => {
    const detail = await get<{
      transaction: { grandTotalPaise: number; discountPaise: number };
      lines: { itemName: string; lineNo: number }[];
      audit: { action: string }[];
    }>(`/api/transactions/${purchaseId}`);

    expect(detail.lines).toHaveLength(2);
    expect(detail.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(detail.transaction.discountPaise).toBe(500_000);
    expect(detail.audit.some((a) => a.action === 'create')).toBe(true);
  });
});

describe('Dealer archive — FR-D4', () => {
  it('hides the dealer from the list but keeps the history', async () => {
    await SELF.fetch(`https://x/api/dealers/${dealerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    });

    const list = await get<{ dealers: unknown[] }>('/api/dealers');
    expect(list.dealers).toHaveLength(0);

    const withArchived = await get<{ dealers: unknown[] }>('/api/dealers?includeArchived=true');
    expect(withArchived.dealers).toHaveLength(1);

    // The history is untouched and still exportable.
    const data = await get<DealerLedgerExport>(`/api/export/dealer/${dealerId}`);
    expect(data.rows).toHaveLength(2);
  });

  it('refuses to post against an archived dealer', async () => {
    await SELF.fetch(`https://x/api/dealers/${dealerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    });

    const res = await SELF.fetch('https://x/api/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dealerId,
        mode: 'sale',
        entryDate: '2026-08-10',
        bankAccount: 'od',
        gstRate: 18,
        lines: [{ quantity: 1, ratePaise: 100 }],
      }),
    });
    expect(res.status).toBe(409);
  });
});
