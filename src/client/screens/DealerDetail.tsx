/**
 * Dealer detail — SRS §10.5. The densest and most important screen.
 *
 * The balance is the hero. Below it, the full history with the running balance
 * after every entry, and filters that are strictly presentational: they never
 * touch the headline or the running-balance column (§6.6, FR-L4).
 *
 * ONE DELIBERATE DEPARTURE FROM THE DESIGN SPEC. Its §9.4 draws the movement
 * amount with an explicit `+` / `-` prefix. SRS §10.8 forbids that outright —
 * "the user never sees a bare +/-" — and where the two disagree the SRS wins.
 * The direction is carried instead by the label chip (SALE / RECEIPT / …) and
 * by colour, which is the same information without the sign the owner has told
 * us never to show. The running balance beneath keeps its own icon and words.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Ban, HandCoins, ListFilter, Plus, ScrollText } from 'lucide-react';
import {
  api,
  formatDate,
  toQuery,
  type Dealer,
  type Filters,
  type LedgerEntry,
  type LedgerPage,
} from '../lib';
import { BalanceHeadline, ExportMenu, InlineBalance, Money, VoidDialog } from '../components';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorBanner,
  ErrorState,
  IconButton,
  Labeled,
  Loading,
  inputCls,
  listCls,
} from '../ui';
import { EntryEditDialog } from './EntryEdit';

export function DealerDetail({
  dealer,
  navigate,
  onAddTransaction,
  onAddPayment,
  onChanged,
  toast,
}: {
  dealer: Dealer;
  navigate: (path: string) => void;
  onAddTransaction: (mode: 'purchase' | 'sale') => void;
  onAddPayment: () => void;
  onChanged: () => void;
  toast: (message: string) => void;
}) {
  const [page, setPage] = useState<LedgerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [voiding, setVoiding] = useState<LedgerEntry | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);

  const query = toQuery(filters as Record<string, string>);

  const load = useCallback(() => {
    setError(null);
    api
      .get<LedgerPage>(`/api/dealers/${dealer.id}/ledger${query}`)
      .then(setPage)
      .catch(() => setError('Could not load this dealer’s history.'));
  }, [dealer.id, query]);

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

  // Display order flips for reading; this reverses the ARRAY only. Each row
  // still shows the running balance stored against it, computed in
  // (entry_date, id) order at write time. Nothing is recomputed here.
  const rows = newestFirst ? [...page.entries].reverse() : page.entries;
  const filtered = page.shownCount !== page.totalCount;
  const voidedEntryIds = new Set(
    page.entries.filter((e) => e.reversesEntryId !== null).map((e) => e.reversesEntryId),
  );

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => navigate('/dealers')}
        className="flex items-center gap-1 text-body-md text-on-surface-variant transition-colors hover:text-primary"
      >
        <ArrowLeft size={18} aria-hidden="true" />
        Dealers
      </button>

      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-headline-md text-primary">{dealer.name}</h1>
          {dealer.gstin && <p className="text-body-md text-on-surface-variant">{dealer.gstin}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="flex items-center gap-2" onClick={onAddPayment}>
            <HandCoins size={18} aria-hidden="true" />
            Add money
          </Button>
          <button
            type="button"
            onClick={() => onAddTransaction(dealer.type === 'supplier' ? 'purchase' : 'sale')}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90"
          >
            <Plus size={18} aria-hidden="true" />
            Add transaction
          </button>
        </div>
      </div>

      <Card>
        <BalanceHeadline paise={page.balancePaise} dealerName={dealer.name} />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          className="flex items-center gap-2"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <ListFilter size={18} aria-hidden="true" />
          Filters
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setNewestFirst((v) => !v)}>
            {newestFirst ? 'Oldest first' : 'Newest first'}
          </Button>
          <ExportMenu path={`/api/export/dealer/${dealer.id}${query}`} />
        </div>
      </div>

      {showFilters && (
        <Card className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="From">
              <input
                className={inputCls}
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value || undefined }))}
              />
            </Labeled>
            <Labeled label="To">
              <input
                className={inputCls}
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value || undefined }))}
              />
            </Labeled>
            <Labeled label="Type">
              <select
                className={inputCls}
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
            </Labeled>
            <Labeled label="Goods">
              <select
                className={inputCls}
                value={filters.mode ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    mode: (e.target.value || undefined) as Filters['mode'],
                  }))
                }
              >
                <option value="">All</option>
                <option value="purchase">Purchases</option>
                <option value="sale">Sales</option>
              </select>
            </Labeled>
            <Labeled
              label="Bank account"
              className="col-span-2"
              hint="A tag on the business’s own account. Filtering by it never changes the balance above."
            >
              <select
                className={inputCls}
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
            </Labeled>
          </div>
          {filtered && (
            <Button variant="outline" className="w-full" onClick={() => setFilters({})}>
              Clear filters
            </Button>
          )}
        </Card>
      )}

      {/*
        §6.6 — a filtered view must say so, unmissably. The headline above is
        computed over ALL entries; without this notice a filtered screen could
        be misread as the full position.
      */}
      {filtered && (
        <p
          role="status"
          className="rounded-lg bg-surface-container-low p-3 text-body-md text-on-surface"
        >
          <strong className="font-semibold">Filtered</strong> — showing {page.shownCount} of{' '}
          {page.totalCount} entries. The balance above is your full position with {dealer.name}.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={28} aria-hidden="true" />}
          message={filtered ? 'No entries match these filters.' : 'No entries yet.'}
        />
      ) : (
        <ul className={listCls}>
          {rows.map((entry) => {
            const isVoided = voidedEntryIds.has(entry.id);
            const isReversal = entry.sourceType === 'reversal';
            const isDebit = entry.debitPaise !== 0;
            const amount = isDebit ? entry.debitPaise : entry.creditPaise;
            const canVoid =
              !isVoided &&
              !isReversal &&
              (entry.sourceType === 'transaction' || entry.sourceType === 'payment');

            return (
              // Three simultaneous signals on a voided row — dimmed, struck,
              // and chip-labelled. A voided financial row misread as live is
              // the worst failure this screen can have, and it matters MORE in
              // a single-balance ledger, not less: there is no second account
              // to cross-check against.
              <li key={entry.id} className={`px-4 py-3 ${isVoided ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Chip>{entry.label}</Chip>
                      {isVoided && <Chip tone="negative">Voided</Chip>}
                      {entry.bankAccount && (
                        <Chip>{entry.bankAccount === 'od' ? 'OD' : 'Current'}</Chip>
                      )}
                    </div>
                    {entry.description && (
                      <p className="truncate text-body-md">{entry.description}</p>
                    )}
                    <p className="text-label-caps uppercase text-on-surface-variant">
                      {formatDate(entry.entryDate)}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p
                      className={
                        isVoided
                          ? 'text-on-surface-variant line-through'
                          : `font-medium ${isDebit ? 'text-positive' : 'text-negative'}`
                      }
                    >
                      <Money paise={amount} />
                    </p>
                    <span className="sr-only">Balance after this entry: </span>
                    <InlineBalance paise={entry.runningBalancePaise} dealerName={dealer.name} />
                  </div>
                </div>

                {(canVoid || entry.sourceType === 'transaction') && (
                  <div className="mt-2 flex items-center justify-end gap-2">
                    {/* The entry detail sheet (APP_FLOW §6.1) — the figures,
                        this record's own history, and the three fields that may
                        be corrected without a void. Offered on voided rows too:
                        a voided entry is kept forever and is still worth
                        reading. */}
                    {entry.sourceType === 'transaction' && entry.sourceId !== null && (
                      <Button variant="text" onClick={() => setOpened(entry.sourceId)}>
                        Details
                      </Button>
                    )}
                    {canVoid && (
                      // Turns red only on hover, so it is discoverable without
                      // being alarming at rest.
                      <IconButton
                        label="Void this entry"
                        className="hover:bg-negative-container hover:text-on-negative-container"
                        onClick={() => setVoiding(entry)}
                      >
                        <Ban size={18} />
                      </IconButton>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {opened !== null && (
        <EntryEditDialog
          transactionId={opened}
          onSaved={(message) => {
            setOpened(null);
            toast(message);
            // The reference tag is the ledger row's display text, so the
            // history has to be re-read. No balance moved.
            load();
          }}
          onCancel={() => setOpened(null)}
        />
      )}

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
