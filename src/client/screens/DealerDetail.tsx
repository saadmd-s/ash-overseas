/**
 * Dealer detail — SRS §10.5.
 *
 * The balance is the hero. Below it, the full history with the running balance
 * after every entry, and filters that are strictly presentational: they never
 * touch the headline or the running-balance column (§6.6, FR-L4).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  formatDate,
  toQuery,
  type Dealer,
  type Filters,
  type LedgerEntry,
  type LedgerPage,
} from '../lib';
import {
  BalanceHeadline,
  Empty,
  ErrorState,
  ExportMenu,
  Loading,
  Money,
  VoidDialog,
} from '../components';

export function DealerDetail({
  dealer,
  onAddTransaction,
  onAddPayment,
  onChanged,
  toast,
}: {
  dealer: Dealer;
  onAddTransaction: (mode: 'purchase' | 'sale') => void;
  onAddPayment: () => void;
  onChanged: () => void;
  toast: (message: string) => void;
}) {
  const [page, setPage] = useState<LedgerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [newestFirst, setNewestFirst] = useState(true);
  const [voiding, setVoiding] = useState<LedgerEntry | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<LedgerPage>(
        `/api/dealers/${dealer.id}/ledger${toQuery(filters as Record<string, string>)}`,
      )
      .then(setPage)
      .catch(() => setError('Could not load this dealer’s history.'));
  }, [dealer.id, filters]);

  useEffect(load, [load]);

  async function confirmVoid() {
    if (!voiding) return;
    setVoidBusy(true);
    try {
      const path =
        voiding.sourceType === 'transaction'
          ? `/api/transactions/${voiding.sourceId}/void`
          : `/api/payments/${voiding.sourceId}/void`;
      await api.post(path, {});
      toast('Entry voided. A reversing entry has been posted.');
      setVoiding(null);
      load();
      onChanged();
    } catch {
      setError('Could not void that entry. Nothing was changed.');
    } finally {
      setVoidBusy(false);
    }
  }

  // If the balance cannot be computed with certainty, show an error — never a
  // guessed number (§10.10).
  if (error && !page) return <ErrorState message={error} onRetry={load} />;
  if (!page) return <Loading what="history" />;

  const rows = newestFirst ? [...page.entries].reverse() : page.entries;
  const filtered = page.shownCount !== page.totalCount;
  const voidedEntryIds = new Set(
    page.entries.filter((e) => e.reversesEntryId !== null).map((e) => e.reversesEntryId),
  );

  return (
    <div className="p-3 pb-28">
      <h1 className="text-xl font-semibold">{dealer.name}</h1>
      <BalanceHeadline paise={page.balancePaise} dealerName={dealer.name} />

      <details className="card mb-3 p-3">
        <summary className="cursor-pointer text-sm font-medium">Filters</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
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
            Type
            <select
              className="field"
              value={filters.type ?? ''}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  type: (e.target.value || undefined) as Filters['type'],
                }))
              }
            >
              <option value="">All</option>
              <option value="transaction">Goods</option>
              <option value="payment">Money</option>
            </select>
          </label>
          <label className="text-sm">
            Bank account
            <select
              className="field"
              value={filters.bankAccount ?? ''}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  bankAccount: (e.target.value || undefined) as Filters['bankAccount'],
                }))
              }
            >
              <option value="">All</option>
              <option value="od">OD</option>
              <option value="current">Current</option>
            </select>
          </label>
        </div>
        {filtered && (
          <button type="button" className="btn mt-2 w-full" onClick={() => setFilters({})}>
            Clear filters
          </button>
        )}
      </details>

      {/*
        §6.6 — a filtered view must say so, unmissably. The headline above is
        computed over ALL entries; without this notice a filtered screen could
        be misread as the full position.
      */}
      {filtered && (
        <p role="status" className="card mb-3 p-3 text-sm">
          <strong>Filtered</strong> — showing {page.shownCount} of {page.totalCount} entries. The
          balance above is your full position with {dealer.name}.
        </p>
      )}

      <div className="mb-3 flex items-center justify-between gap-2">
        <ExportMenu
          path={`/api/export/dealer/${dealer.id}${toQuery(filters as Record<string, string>)}`}
        />
        <button type="button" className="btn" onClick={() => setNewestFirst((v) => !v)}>
          {newestFirst ? 'Oldest first' : 'Newest first'}
        </button>
      </div>

      {rows.length === 0 ? (
        <Empty message={filtered ? 'No entries match these filters.' : 'No entries yet.'} />
      ) : (
        <ul className="card divide-y divide-[var(--color-line)]">
          {rows.map((entry) => {
            const isVoided = voidedEntryIds.has(entry.id);
            const isReversal = entry.sourceType === 'reversal';
            const amount = entry.debitPaise !== 0 ? entry.debitPaise : entry.creditPaise;
            const canVoid =
              !isVoided &&
              !isReversal &&
              (entry.sourceType === 'transaction' || entry.sourceType === 'payment');

            return (
              <li key={entry.id} className={`p-3 ${isVoided ? 'opacity-55' : ''}`}>
                <div className={`flex justify-between gap-2 ${isVoided ? 'line-through' : ''}`}>
                  <div>
                    <p className="font-medium">
                      {entry.label}
                      {entry.bankAccount && (
                        <span className="text-[var(--color-muted)]">
                          {' · '}
                          {entry.bankAccount === 'od' ? 'OD' : 'Current'}
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-[var(--color-muted)]">
                      {formatDate(entry.entryDate)}
                      {entry.description ? ` · ${entry.description}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p>
                      <Money paise={amount} />
                    </p>
                    <p className="text-sm text-[var(--color-muted)]">
                      <span className="sr-only">Balance after this entry: </span>
                      <Money paise={Math.abs(entry.runningBalancePaise)} />
                      <span className="block text-xs">
                        {entry.runningBalancePaise > 0
                          ? 'owed to you'
                          : entry.runningBalancePaise < 0
                            ? 'you owe'
                            : 'settled'}
                      </span>
                    </p>
                  </div>
                </div>

                {isVoided && (
                  <p className="mt-1 text-xs font-medium text-[var(--color-payable)]">VOIDED</p>
                )}
                {canVoid && (
                  <button
                    type="button"
                    className="btn mt-2 text-sm"
                    onClick={() => setVoiding(entry)}
                  >
                    Void
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="fixed inset-x-0 bottom-0 flex gap-2 border-t border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <button
          type="button"
          className="btn btn-primary flex-1"
          onClick={() => onAddTransaction(dealer.type === 'supplier' ? 'purchase' : 'sale')}
        >
          + Transaction
        </button>
        <button type="button" className="btn flex-1" onClick={onAddPayment}>
          + Payment
        </button>
      </div>

      {voiding && (
        <VoidDialog
          entryLabel={`${voiding.label} of ${formatDate(voiding.entryDate)}`}
          amountPaise={voiding.debitPaise !== 0 ? voiding.debitPaise : voiding.creditPaise}
          busy={voidBusy}
          onConfirm={() => void confirmVoid()}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  );
}
