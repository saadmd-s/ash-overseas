/**
 * Home, dealer lists and the cross-dealer transactions view — SRS §10.2–§10.4,
 * FR-N1…N4.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, RequestFailed, toQuery, type Dealer, type DealerType } from '../lib';
import { Money } from '../components';
import { BalanceInline, Empty, ErrorState, ExportMenu, Field, Loading } from '../components';

// ---------------------------------------------------------------------------

export function Home({
  onOpenList,
  onOpenAll,
  onNewDealer,
}: {
  onOpenList: (type: 'supplier' | 'buyer') => void;
  onOpenAll: () => void;
  onNewDealer: () => void;
}) {
  const [dealers, setDealers] = useState<Dealer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ dealers: Dealer[] }>('/api/dealers')
      .then((d) => setDealers(d.dealers))
      .catch(() => setError('Could not load dealers.'));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="p-3">
      <h1 className="mb-3 text-xl font-semibold">ASH Overseas</h1>

      {/* Two large primary buttons (§10.3). */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          className="btn btn-primary h-24 text-lg"
          onClick={() => onOpenList('supplier')}
        >
          Purchase
        </button>
        <button
          type="button"
          className="btn btn-primary h-24 text-lg"
          onClick={() => onOpenList('buyer')}
        >
          Sale
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={onNewDealer}>
          + New dealer
        </button>
        <button type="button" className="btn" onClick={onOpenAll}>
          All transactions
        </button>
        <ExportMenu path="/api/export/balances" label="Balances" />
      </div>

      <h2 className="mb-2 text-sm font-medium text-[var(--color-muted)]">Dealers</h2>
      {error && <ErrorState message={error} onRetry={load} />}
      {!dealers && !error && <Loading what="dealers" />}
      {dealers?.length === 0 && <Empty message="No dealers yet." />}
      {dealers && dealers.length > 0 && <DealerRows dealers={dealers} />}
    </div>
  );
}

function DealerRows({ dealers }: { dealers: Dealer[] }) {
  return (
    <ul className="card divide-y divide-[var(--color-line)]">
      {dealers.map((d) => (
        <li key={d.id}>
          <a
            href={`/dealers/${d.id}`}
            className="flex min-h-tap items-center justify-between gap-2 p-3"
          >
            <span className="font-medium">{d.name}</span>
            <BalanceInline paise={d.balancePaise} dealerName={d.name} />
          </a>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

/** A searchable list filtered by dealer type (§10.4, FR-N2). */
export function DealerList({ type }: { type: 'supplier' | 'buyer' }) {
  const [dealers, setDealers] = useState<Dealer[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ dealers: Dealer[] }>(`/api/dealers${toQuery({ type, q: query || undefined })}`)
      .then((d) => setDealers(d.dealers))
      .catch(() => setError('Could not load dealers.'));
  }, [type, query]);

  useEffect(load, [load]);

  return (
    <div className="p-3">
      <h1 className="mb-3 text-xl font-semibold">{type === 'supplier' ? 'Purchase' : 'Sale'}</h1>

      <Field label="Search dealers">
        {({ id }) => (
          <input
            id={id}
            className="field"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name"
          />
        )}
      </Field>

      {error && <ErrorState message={error} onRetry={load} />}
      {!dealers && !error && <Loading what="dealers" />}
      {dealers?.length === 0 && (
        <Empty message={`No ${type === 'supplier' ? 'suppliers' : 'buyers'} match.`} />
      )}
      {dealers && dealers.length > 0 && <DealerRows dealers={dealers} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CrossDealerTransaction {
  id: number;
  humanId: string;
  dealerName: string;
  mode: 'purchase' | 'sale';
  entryDate: string;
  grandTotalPaise: number;
  bankAccount: 'od' | 'current';
  isVoided: boolean;
}

/** FR-N4 — every transaction across dealers, with filters and export. */
export function AllTransactions() {
  const [rows, setRows] = useState<CrossDealerTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<{
    mode?: string;
    bankAccount?: string;
    from?: string;
    to?: string;
  }>({});

  const query = toQuery(filters);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ transactions: CrossDealerTransaction[] }>(`/api/transactions${query}`)
      .then((d) => setRows(d.transactions))
      .catch(() => setError('Could not load transactions.'));
  }, [query]);

  useEffect(load, [load]);

  return (
    <div className="p-3">
      <h1 className="mb-3 text-xl font-semibold">All transactions</h1>

      <div className="card mb-3 grid grid-cols-2 gap-2 p-3">
        <label className="text-sm">
          From
          <input
            className="field"
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value || undefined }))}
          />
        </label>
        <label className="text-sm">
          To
          <input
            className="field"
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value || undefined }))}
          />
        </label>
        <label className="text-sm">
          Mode
          <select
            className="field"
            value={filters.mode ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, mode: e.target.value || undefined }))}
          >
            <option value="">All</option>
            <option value="purchase">Purchase</option>
            <option value="sale">Sale</option>
          </select>
        </label>
        <label className="text-sm">
          Bank account
          <select
            className="field"
            value={filters.bankAccount ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, bankAccount: e.target.value || undefined }))
            }
          >
            <option value="">All</option>
            <option value="od">OD</option>
            <option value="current">Current</option>
          </select>
        </label>
      </div>

      <div className="mb-3">
        <ExportMenu path={`/api/export/transactions${query}`} />
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!rows && !error && <Loading what="transactions" />}
      {rows?.length === 0 && <Empty message="No transactions match these filters." />}

      {rows && rows.length > 0 && (
        <ul className="card divide-y divide-[var(--color-line)]">
          {rows.map((t) => (
            <li key={t.id} className={`p-3 ${t.isVoided ? 'opacity-55 line-through' : ''}`}>
              <div className="flex justify-between gap-2">
                <div>
                  <p className="font-medium">{t.dealerName}</p>
                  <p className="text-sm text-[var(--color-muted)]">
                    {t.mode === 'sale' ? 'Sale' : 'Purchase'} · {formatDate(t.entryDate)} ·{' '}
                    {t.bankAccount === 'od' ? 'OD' : 'Current'}
                  </p>
                  <p className="text-xs text-[var(--color-muted)]">{t.humanId}</p>
                </div>
                <Money paise={t.grandTotalPaise} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Create a dealer, optionally with an opening position (FR-D1, FR-D5). */
export function NewDealer({
  onSaved,
  onCancel,
}: {
  onSaved: (id: number) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<DealerType>('both');
  const [gstin, setGstin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<{ id: number }>('/api/dealers', {
        name,
        type,
        gstin: gstin || null,
      });
      onSaved(created.id);
    } catch (e) {
      setError(e instanceof RequestFailed ? e.detail.message : 'Could not create the dealer.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void save();
      }}
    >
      <h1 className="mb-3 text-xl font-semibold">New dealer</h1>

      <Field label="Name" error={error ?? undefined}>
        {({ id }) => (
          <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>

      <Field label="Type" hint="Filters the Purchase and Sale lists. Never splits the balance.">
        {({ id }) => (
          <select
            id={id}
            className="field"
            value={type}
            onChange={(e) => setType(e.target.value as DealerType)}
          >
            <option value="both">Both</option>
            <option value="supplier">Supplier</option>
            <option value="buyer">Buyer</option>
          </select>
        )}
      </Field>

      <Field label="GSTIN" hint="Optional">
        {({ id }) => (
          <input
            id={id}
            className="field"
            value={gstin}
            onChange={(e) => setGstin(e.target.value)}
          />
        )}
      </Field>

      <div className="flex gap-2">
        <button type="button" className="btn flex-1" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary flex-1" disabled={!name.trim() || saving}>
          {saving ? 'Saving…' : 'Create dealer'}
        </button>
      </div>
    </form>
  );
}
