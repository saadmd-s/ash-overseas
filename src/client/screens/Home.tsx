/**
 * Home, dealer lists and the cross-dealer transactions view — SRS §10.2–§10.4,
 * FR-N1…N4.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  ListFilter,
  Plus,
  Receipt,
  Search,
  ShoppingCart,
  Tag,
  Users,
} from 'lucide-react';
import { api, formatDate, RequestFailed, toQuery, type Dealer, type DealerType } from '../lib';
import { ExportMenu, InlineBalance, Money } from '../components';
import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Labeled,
  Loading,
  SectionLabel,
  Toast,
  inputCls,
  listCls,
  panelCls,
  rowButtonCls,
} from '../ui';
import { EntryEditDialog } from './EntryEdit';

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/**
 * Two big choices and a list.
 *
 * The action cards are deliberately paired as filled-versus-outlined rather
 * than as two identical buttons: the pairing is what makes them read as a
 * matched set of opposites at a glance. They stay side by side at every width,
 * because these are the two most-used entry points in the application and
 * neither should ever require a scroll.
 */
export function Home({ navigate }: { navigate: (path: string) => void }) {
  return (
    <div className="space-y-6">
      {/*
        The icon sits ABOVE the word rather than beside it.

        Side by side, these two cards are about 150px wide at 360px. "Purchase"
        at headline-md is ~110px of that, and a 28px icon plus padding does not
        fit in what is left — the icon ended up sitting on top of the word.
        Stacking removes the competition for width entirely, and the type steps
        up to headline-md only once there is room for it.
      */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <button
          type="button"
          onClick={() => navigate('/purchase')}
          className="flex flex-col gap-3 rounded-xl bg-primary p-4 text-left text-on-primary transition-all hover:opacity-90 active:scale-[0.98] sm:p-5"
        >
          <ShoppingCart size={24} aria-hidden="true" />
          <span>
            <span className="block text-label-caps uppercase opacity-70">Record a</span>
            <span className="block text-headline-sm font-bold sm:text-headline-md">Purchase</span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => navigate('/sale')}
          className="flex flex-col gap-3 rounded-xl border-2 border-primary p-4 text-left text-primary transition-all hover:bg-surface-container active:scale-[0.98] sm:p-5"
        >
          <Tag size={24} aria-hidden="true" />
          <span>
            <span className="block text-label-caps uppercase opacity-70">Record a</span>
            <span className="block text-headline-sm font-bold sm:text-headline-md">Sale</span>
          </span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="flex items-center gap-2"
          onClick={() => navigate('/transactions')}
        >
          <Receipt size={18} aria-hidden="true" />
          All transactions
        </Button>
        <ExportMenu path="/api/export/balances" label="Balances" />
      </div>

      <div>
        <SectionLabel>Dealers</SectionLabel>
        <DealerRoster navigate={navigate} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The shared dealer list
// ---------------------------------------------------------------------------

/**
 * One component, three uses: Home (all), Purchase (suppliers), Sale (buyers).
 *
 * Purchase and Sale are UI labels and nothing more — they filter which dealers
 * are listed and pre-set the mode on a new entry. They never split a dealer's
 * money into two pots (§5, rule 2).
 */
export function DealerRoster({
  type,
  navigate,
  searchable = true,
}: {
  type?: 'supplier' | 'buyer';
  navigate: (path: string) => void;
  searchable?: boolean;
}) {
  const [dealers, setDealers] = useState<Dealer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // Debounced, so typing a name does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ dealers: Dealer[] }>(`/api/dealers${toQuery({ type, q: debounced || undefined })}`)
      .then((d) => setDealers(d.dealers))
      .catch(() => setError('Could not load dealers.'));
  }, [type, debounced]);

  useEffect(load, [load]);

  return (
    <div className="space-y-3">
      {searchable && (
        // One row, not two. Stacked, the button got a line of its own for a
        // single control — wasted vertical space on the screen that has least
        // of it. The label collapses to the icon below `sm`; `aria-label`
        // keeps the button named either way.
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:max-w-xs">
            <Search
              size={18}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
            />
            <input
              type="search"
              className={`${inputCls} pl-10`}
              placeholder="Search dealers"
              aria-label="Search dealers"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            aria-label="New dealer"
            title="New dealer"
            className="flex shrink-0 items-center gap-2 py-2.5"
            onClick={() => navigate('/dealers/new')}
          >
            <Plus size={18} aria-hidden="true" />
            <span className="hidden sm:inline">New dealer</span>
          </Button>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}
      {!dealers && !error && <Loading what="dealers" />}
      {dealers?.length === 0 && (
        <EmptyState
          icon={<Users size={28} aria-hidden="true" />}
          message={
            debounced
              ? 'No dealers match that search.'
              : type
                ? `No ${type === 'supplier' ? 'suppliers' : 'buyers'} yet.`
                : 'No dealers yet.'
          }
          // "Add your first one" was an instruction with nothing to press.
          // The empty state carries the action itself.
          action={
            !debounced && (
              <Button
                variant="outline"
                className="flex items-center gap-2"
                onClick={() => navigate('/dealers/new')}
              >
                <Plus size={18} aria-hidden="true" />
                Add your first dealer
              </Button>
            )
          }
        />
      )}

      {dealers && dealers.length > 0 && (
        <ul className={listCls}>
          {dealers.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className={rowButtonCls}
                onClick={() => navigate(`/dealers/${d.id}`)}
              >
                <Avatar name={d.name} />
                {/* `min-w-0` is what makes `truncate` actually work inside a
                    flex row — without it a long name blows out the layout
                    instead of ellipsing. */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{d.name}</span>
                  <InlineBalance paise={d.balancePaise} dealerName={d.name} />
                </span>
                <ChevronRight size={18} aria-hidden="true" className="text-on-surface-variant" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** A searchable list filtered by dealer type (§10.4, FR-N2). */
export function DealerList({
  type,
  navigate,
}: {
  type?: 'supplier' | 'buyer';
  navigate: (path: string) => void;
}) {
  return <DealerRoster type={type} navigate={navigate} />;
}

// ---------------------------------------------------------------------------
// All transactions
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
  const [opened, setOpened] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const query = toQuery(filters);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ transactions: CrossDealerTransaction[] }>(`/api/transactions${query}`)
      .then((d) => setRows(d.transactions))
      .catch(() => setError('Could not load transactions.'));
  }, [query]);

  useEffect(load, [load]);

  const active = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-headline-md text-primary">All transactions</h1>
        <ExportMenu path={`/api/export/transactions${query}`} />
      </div>

      <Card className="space-y-3">
        <p className="flex items-center gap-2 text-label-caps uppercase text-on-surface-variant">
          <ListFilter size={18} aria-hidden="true" />
          Filters
        </p>
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
          <Labeled label="Goods">
            <select
              className={inputCls}
              value={filters.mode ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, mode: e.target.value || undefined }))}
            >
              <option value="">All</option>
              <option value="purchase">Purchases</option>
              <option value="sale">Sales</option>
            </select>
          </Labeled>
          <Labeled label="Bank account">
            <select
              className={inputCls}
              value={filters.bankAccount ?? ''}
              onChange={(e) =>
                setFilters((f) => ({ ...f, bankAccount: e.target.value || undefined }))
              }
            >
              <option value="">All</option>
              <option value="od">OD</option>
              <option value="current">Current</option>
            </select>
          </Labeled>
        </div>
        {active && (
          <Button variant="outline" className="w-full" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        )}
      </Card>

      {error && <ErrorState message={error} onRetry={load} />}
      {!rows && !error && <Loading what="transactions" />}
      {rows?.length === 0 && (
        <EmptyState
          icon={<Receipt size={28} aria-hidden="true" />}
          message="No transactions match these filters."
        />
      )}

      {rows && rows.length > 0 && (
        <ul className={listCls}>
          {rows.map((t) => (
            <li key={t.id} className={`px-4 py-3 ${t.isVoided ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Chip>{t.mode === 'sale' ? 'Sale' : 'Purchase'}</Chip>
                    {t.isVoided && <Chip tone="negative">Voided</Chip>}
                    <span className="truncate font-medium">{t.dealerName}</span>
                  </div>
                  <p className="text-label-caps uppercase text-on-surface-variant">
                    {formatDate(t.entryDate)} · {t.humanId} ·{' '}
                    {t.bankAccount === 'od' ? 'OD' : 'Current'}
                  </p>
                </div>
                <div className="text-right">
                  <p
                    className={t.isVoided ? 'text-on-surface-variant line-through' : 'font-medium'}
                  >
                    <Money paise={t.grandTotalPaise} />
                  </p>
                  {/* The entry detail sheet, reachable from here too — a wrong
                      item name is usually spotted while scanning across
                      dealers, not while looking at one. */}
                  <Button variant="text" className="mt-1" onClick={() => setOpened(t.id)}>
                    Details
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {note && <Toast message={note} onDone={() => setNote(null)} />}

      {opened !== null && (
        <EntryEditDialog
          transactionId={opened}
          onSaved={(message) => {
            setOpened(null);
            setNote(message);
            load();
          }}
          onCancel={() => setOpened(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New dealer
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
      className="mx-auto max-w-xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void save();
      }}
    >
      <h1 className="text-headline-md text-primary">New dealer</h1>

      <Card className="space-y-4">
        <Field label="Name" error={error ?? undefined}>
          {({ id }) => (
            <input
              id={id}
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>

        <Field label="Type" hint="Filters the Purchase and Sale lists. Never splits the balance.">
          {({ id }) => (
            <select
              id={id}
              className={inputCls}
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
              className={inputCls}
              value={gstin}
              onChange={(e) => setGstin(e.target.value)}
            />
          )}
        </Field>
      </Card>

      <div className={`${panelCls} flex gap-2`}>
        <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel}>
          Cancel
        </Button>
        <button
          type="submit"
          disabled={!name.trim() || saving}
          className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Create dealer'}
        </button>
      </div>
    </form>
  );
}
