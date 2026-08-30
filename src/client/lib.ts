/**
 * Client helpers — API access, date display, and draft persistence.
 */

import type { AnyExport } from '../export/types';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class RequestFailed extends Error {
  constructor(readonly detail: ApiError) {
    super(detail.message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: ApiError } | null;
    throw new RequestFailed(
      body?.error ?? { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' },
    );
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
};

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type BankAccount = 'od' | 'current';
export type DealerType = 'supplier' | 'buyer' | 'both';

export interface Dealer {
  id: number;
  name: string;
  contact: string | null;
  gstin: string | null;
  stateCode: string | null;
  type: DealerType;
  isArchived: boolean;
  balancePaise: number;
}

export interface LedgerEntry {
  id: number;
  entryDate: string;
  sourceType: 'transaction' | 'payment' | 'opening' | 'reversal';
  sourceId: number | null;
  reversesEntryId: number | null;
  debitPaise: number;
  creditPaise: number;
  runningBalancePaise: number;
  bankAccount: BankAccount | null;
  label: string | null;
  description: string | null;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  totalCount: number;
  shownCount: number;
  balancePaise: number;
}

export interface Filters {
  from?: string;
  to?: string;
  type?: 'transaction' | 'payment';
  mode?: 'purchase' | 'sale';
  bankAccount?: BankAccount;
}

export function toQuery(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const q = params.toString();
  return q ? `?${q}` : '';
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `DD MMM YYYY` — §10.8.
 *
 * The text date is sliced, never parsed into a `Date`. It is an IST calendar
 * date, not an instant (§12.4), and constructing a Date from it is how an
 * off-by-one-day bug gets in.
 */
export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Today in IST, for the date input's default and max (§10.9). */
export function todayIST(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Draft persistence — §10.6
// ---------------------------------------------------------------------------

/**
 * In-progress form input autosaves, so a dropped mobile connection or an
 * accidental back-navigation never loses a half-typed entry. Cleared on
 * successful save.
 *
 * Deliberately NOT offline sync, which would conflict with the single source of
 * truth. Drafts hold integer paise, matching form state — a draft that stored
 * rupee strings would reintroduce the float this whole design avoids.
 */
export const draft = {
  save(key: string, value: unknown): void {
    try {
      localStorage.setItem(`draft:${key}`, JSON.stringify(value));
    } catch {
      // A full or unavailable localStorage must never block an entry.
    }
  },

  load<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(`draft:${key}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },

  clear(key: string): void {
    try {
      localStorage.removeItem(`draft:${key}`);
    } catch {
      // ignore
    }
  },
};

// ---------------------------------------------------------------------------
// Export download
// ---------------------------------------------------------------------------

/**
 * Fetch export rows and hand the browser a file.
 *
 * §11.2 — the workbook is generated here, in the browser, from JSON with money
 * as integer paise. SheetJS is loaded lazily so its weight never lands in the
 * initial bundle for a screen that may never export.
 */
export async function downloadExport(path: string, format: 'xlsx' | 'csv'): Promise<void> {
  const data = await api.get<AnyExport>(path);
  const { buildSheet } = await import('../export/build');
  const sheet = buildSheet(data, todayIST());

  let blob: Blob;
  if (format === 'csv') {
    const { toCsv } = await import('./export/csv');
    blob = new Blob([toCsv(sheet)], { type: 'text/csv;charset=utf-8' });
  } else {
    const { toXlsxBlob } = await import('./export/xlsx');
    blob = toXlsxBlob(sheet);
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sheet.fileName}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
