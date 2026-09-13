/**
 * Dealer detail — SRS §10.5. The densest and most important screen.
 *
 * The balance is the hero. Below it, the full history with the running balance
 * after every entry, and filters that are strictly presentational: they never
 * touch the headline or the running-balance column (§6.6, FR-L4).
 *
 * WRITTEN FOR THE OWNER, who is not technical. Every action is a word on a
 * button rather than an icon to decode, and the accounting vocabulary is gone
 * from the surface: an entry is "deleted", not voided, and the reversing entry
 * that makes a delete safe is hidden unless asked for (see `hiddenIds`).
 *
 * ONE DELIBERATE DEPARTURE FROM THE DESIGN SPEC. Its §9.4 draws the movement
 * amount with an explicit `+` / `-` prefix. SRS §10.8 forbids that outright —
 * "the user never sees a bare +/-" — and where the two disagree the SRS wins.
 * The direction is carried instead by the label chip and by colour. The running
 * balance beneath keeps its own icon and words.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  HandCoins,
  ListFilter,
  Pencil,
  Plus,
  ScrollText,
  ShoppingCart,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react';
import { balanceHeadline } from '../../money';
import {
  api,
  deleteEntry,
  entryLabel,
  formatDate,
  RequestFailed,
  todayIST,
  toQuery,
  type Dealer,
  type DealerType,
  type Filters,
  type LedgerEntry,
  type LedgerPage,
} from '../lib';
import {
  BalanceHeadline,
  DeleteEntryDialog,
  ExportMenu,
  InlineBalance,
  Money,
  MoneyInput,
} from '../components';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorBanner,
  ErrorState,
  Field,
  Labeled,
  Loading,
  Modal,
  Segmented,
  inputCls,
  listCls,
} from '../ui';
import { EntryEditDialog } from './EntryEdit';

/** The one "Show" filter the owner sees, mapped onto the API's type + mode. */
type Show = '' | 'purchase' | 'sale' | 'payment';

function showOf(f: Filters): Show {
  if (f.type === 'payment') return 'payment';
  return f.mode ?? '';
}

function withShow(f: Filters, show: Show): Filters {
  const { type: _t, mode: _m, ...rest } = f;
  if (show === 'payment') return { ...rest, type: 'payment' };
  // `mode` alone: a purchase or sale is already a goods entry, and `mode` is
  // the filter that keeps a cancellation beside the entry it cancels.
  if (show === 'purchase' || show === 'sale') return { ...rest, mode: show };
  return rest;
}

/**
 * Which rows to leave out while deleted entries are hidden.
 *
 * A deleted entry and the entry that cancels it are hidden TOGETHER, and only
 * when nothing sits between them in `(entry_date, id)` order. That condition is
 * what keeps every visible running balance honest: each stored balance is the
 * sum of everything above it, and a pair that nets to zero with no row between
 * its halves contributes nothing to any row that is still shown. If an entry
 * was recorded between the two, the pair stays visible, so no balance on screen
 * ever silently includes an amount the owner cannot see.
 */
function hiddenIds(entries: LedgerEntry[]): { ids: Set<number>; deletedCount: number } {
  const ids = new Set<number>();
  const present = new Set(entries.map((e) => e.id));
  let deletedCount = 0;

  entries.forEach((e, i) => {
    if (e.reversesEntryId === null) return;
    deletedCount += 1;
    const prev = entries[i - 1];
    if (prev?.id === e.reversesEntryId) {
      ids.add(prev.id);
      ids.add(e.id);
    } else if (!present.has(e.reversesEntryId)) {
      // A filtered view that kept the cancellation but not its original.
      ids.add(e.id);
    }
  });

  return { ids, deletedCount };
}

export function DealerDetail({
  dealer,
  navigate,
  onAddTransaction,
  onAddPayment,
  onChanged,
  toast,
}: {
  dealer: Dealer;
  navigate: (path: string, replace?: boolean) => void;
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
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleting, setDeleting] = useState<LedgerEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);
  const [editingDealer, setEditingDealer] = useState(false);
  const [removingDealer, setRemovingDealer] = useState(false);
  const [addingOpening, setAddingOpening] = useState(false);

  const query = toQuery(filters as Record<string, string>);

  const load = useCallback(() => {
    setError(null);
    api
      .get<LedgerPage>(`/api/dealers/${dealer.id}/ledger${query}`)
      .then(setPage)
      .catch(() => setError('Could not load this dealer’s history.'));
  }, [dealer.id, query]);

  useEffect(load, [load]);

  async function confirmDelete() {
    if (!deleting) return;
    const { sourceType, sourceId } = deleting;
    if (sourceType === 'reversal') return;
    const id = sourceType === 'opening' ? dealer.id : sourceId;
    if (id === null) return;
    setDeleteBusy(true);
    try {
      await deleteEntry(sourceType, id);
      toast('Entry deleted.');
      setDeleting(null);
      load();
      onChanged();
    } catch (e) {
      setDeleting(null);
      setError(
        e instanceof RequestFailed
          ? e.detail.message
          : 'Could not delete that entry. Nothing was changed.',
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  async function restoreDealer() {
    try {
      await api.patch(`/api/dealers/${dealer.id}`, { isArchived: false });
      toast('Dealer restored.');
      onChanged();
    } catch {
      setError('Could not restore this dealer. Please try again.');
    }
  }

  // If the balance cannot be computed with certainty, show an error — never a
  // guessed number (§10.10).
  if (error && !page) return <ErrorState message={error} onRetry={load} />;
  if (!page) return <Loading what="history" />;

  const filtered = page.shownCount !== page.totalCount;
  const hidden = hiddenIds(page.entries);
  const visible = showDeleted ? page.entries : page.entries.filter((e) => !hidden.ids.has(e.id));

  // Display order flips for reading; this reverses the ARRAY only. Each row
  // still shows the running balance stored against it, computed in
  // (entry_date, id) order at write time. Nothing is recomputed here.
  const rows = newestFirst ? [...visible].reverse() : visible;
  const deletedEntryIds = new Set(
    page.entries.filter((e) => e.reversesEntryId !== null).map((e) => e.reversesEntryId),
  );
  // Offered only on the unfiltered history, where an opening that exists is
  // certain to be in the list.
  const canAddOpening =
    !dealer.isArchived &&
    !filtered &&
    !page.entries.some((e) => e.sourceType === 'opening' && !deletedEntryIds.has(e.id));

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => navigate('/dealers')}
        className="flex min-h-11 items-center gap-1 py-1 text-body-md text-on-surface-variant transition-colors hover:text-primary"
      >
        <ArrowLeft size={18} aria-hidden="true" />
        All dealers
      </button>

      {error && <ErrorBanner message={error} />}

      {dealer.isArchived && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-negative-container p-3 text-on-negative-container">
          <p className="text-body-md">
            This dealer has been deleted. Their entries are kept, but nothing new can be added until
            you restore them.
          </p>
          <Button
            variant="filled"
            className="flex items-center gap-2"
            onClick={() => void restoreDealer()}
          >
            <Undo2 size={18} aria-hidden="true" />
            Restore dealer
          </Button>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-headline-md text-primary">{dealer.name}</h1>
          {dealer.gstin && (
            <p className="text-body-md text-on-surface-variant">GSTIN {dealer.gstin}</p>
          )}
        </div>
        <Button
          variant="text"
          className="flex shrink-0 items-center gap-1"
          onClick={() => setEditingDealer(true)}
        >
          <Pencil size={16} aria-hidden="true" />
          Edit
        </Button>
      </div>

      {/*
        Three labelled buttons, one per thing that can be recorded, instead of
        "Add transaction" (which guessed purchase or sale from the dealer type)
        and "Add money" (which did not say it covered paying out as well).
      */}
      {!dealer.isArchived && (
        <div className="grid grid-cols-3 gap-2">
          <RecordButton
            icon={<ShoppingCart size={20} aria-hidden="true" />}
            label="Purchase"
            onClick={() => onAddTransaction('purchase')}
          />
          <RecordButton
            icon={<Tag size={20} aria-hidden="true" />}
            label="Sale"
            onClick={() => onAddTransaction('sale')}
          />
          <RecordButton
            icon={<HandCoins size={20} aria-hidden="true" />}
            label="Payment"
            onClick={onAddPayment}
          />
        </div>
      )}

      <Card>
        <BalanceHeadline paise={page.balancePaise} dealerName={dealer.name} />
        {canAddOpening && (
          <Button
            variant="text"
            className="-ml-2 mt-2 flex items-center gap-1"
            onClick={() => setAddingOpening(true)}
          >
            <Plus size={16} aria-hidden="true" />
            Add balance from old book
          </Button>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          className="flex items-center gap-2"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <ListFilter size={18} aria-hidden="true" />
          {showFilters ? 'Hide filters' : 'Filter and sort'}
        </Button>
        <ExportMenu path={`/api/export/dealer/${dealer.id}${query}`} />
      </div>

      {showFilters && (
        <Card className="space-y-4">
          <Segmented
            legend="Order"
            value={newestFirst ? 'newest' : 'oldest'}
            onChange={(v) => setNewestFirst(v === 'newest')}
            options={[
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="From date">
              <input
                className={inputCls}
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value || undefined }))}
              />
            </Labeled>
            <Labeled label="To date">
              <input
                className={inputCls}
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value || undefined }))}
              />
            </Labeled>
            <Labeled label="Show">
              <select
                className={inputCls}
                value={showOf(filters)}
                onChange={(e) => setFilters((f) => withShow(f, e.target.value as Show))}
              >
                <option value="">Everything</option>
                <option value="purchase">Purchases</option>
                <option value="sale">Sales</option>
                <option value="payment">Payments</option>
              </select>
            </Labeled>
            <Labeled label="Bank account">
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
                <option value="">Both</option>
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
          <strong className="font-semibold">Filtered:</strong> showing {page.shownCount} of{' '}
          {page.totalCount} entries. The balance above still counts everything.
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
            const isDeleted = deletedEntryIds.has(entry.id);
            const isCancellation = entry.sourceType === 'reversal';
            const isDebit = entry.debitPaise !== 0;
            const amount = isDebit ? entry.debitPaise : entry.creditPaise;
            const canDelete =
              !dealer.isArchived &&
              !isDeleted &&
              (entry.sourceType === 'opening' ||
                (entry.sourceId !== null &&
                  (entry.sourceType === 'transaction' || entry.sourceType === 'payment')));
            const canOpen = entry.sourceType === 'transaction' && entry.sourceId !== null;

            return (
              // Three simultaneous signals on a deleted row — dimmed, struck,
              // and chip-labelled. A deleted financial row misread as live is
              // the worst failure this screen can have.
              <li
                key={entry.id}
                className={`px-4 py-3 ${isDeleted || isCancellation ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Chip>{entryLabel(entry.label)}</Chip>
                      {isDeleted && <Chip tone="negative">Deleted</Chip>}
                      {entry.bankAccount && (
                        <Chip>{entry.bankAccount === 'od' ? 'OD' : 'Current'}</Chip>
                      )}
                    </div>
                    {/* A cancellation's stored description is internal
                        wording; its chip already says what it is. */}
                    {entry.description && !isCancellation && (
                      <p className="truncate text-body-md">{entry.description}</p>
                    )}
                    <p className="text-body-md text-on-surface-variant">
                      {formatDate(entry.entryDate)}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p
                      className={
                        isDeleted || isCancellation
                          ? 'text-on-surface-variant line-through'
                          : 'font-medium text-on-surface'
                      }
                    >
                      <Money paise={amount} />
                    </p>
                    <span className="sr-only">Balance after this entry: </span>
                    <InlineBalance paise={entry.runningBalancePaise} dealerName={dealer.name} />
                  </div>
                </div>

                {(canOpen || canDelete) && (
                  <div className="mt-2 flex items-center justify-end gap-1">
                    {canOpen && (
                      <Button variant="text" onClick={() => setOpened(entry.sourceId)}>
                        {isDeleted ? 'View' : 'View or edit'}
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="danger-text"
                        className="flex items-center gap-1"
                        onClick={() => setDeleting(entry)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hidden.deletedCount > 0 && (
        <Button variant="text" onClick={() => setShowDeleted((v) => !v)}>
          {showDeleted ? 'Hide deleted entries' : `Show deleted entries (${hidden.deletedCount})`}
        </Button>
      )}

      {!dealer.isArchived && (
        <div className="border-t border-outline-variant pt-4">
          <Button
            variant="danger-text"
            className="flex items-center gap-1"
            onClick={() => setRemovingDealer(true)}
          >
            <Trash2 size={16} aria-hidden="true" />
            Delete this dealer
          </Button>
        </div>
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
          onDelete={
            dealer.isArchived
              ? undefined
              : () => {
                  const entry = page.entries.find(
                    (e) => e.sourceType === 'transaction' && e.sourceId === opened,
                  );
                  setOpened(null);
                  if (entry) setDeleting(entry);
                }
          }
          onCancel={() => setOpened(null)}
        />
      )}

      {deleting && (
        <DeleteEntryDialog
          entryLabel={`${entryLabel(deleting.label)} of ${formatDate(deleting.entryDate)}`}
          amountPaise={deleting.debitPaise !== 0 ? deleting.debitPaise : deleting.creditPaise}
          busy={deleteBusy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}

      {addingOpening && (
        <AddOpeningDialog
          dealer={dealer}
          onSaved={() => {
            setAddingOpening(false);
            toast('Balance from old book saved.');
            load();
            onChanged();
          }}
          onCancel={() => setAddingOpening(false)}
        />
      )}

      {editingDealer && (
        <EditDealerDialog
          dealer={dealer}
          onSaved={() => {
            setEditingDealer(false);
            toast('Dealer details saved.');
            onChanged();
          }}
          onCancel={() => setEditingDealer(false)}
        />
      )}

      {removingDealer && (
        <DeleteDealerDialog
          dealer={dealer}
          balancePaise={page.balancePaise}
          onDeleted={() => {
            setRemovingDealer(false);
            toast('Dealer deleted.');
            navigate('/dealers', true);
          }}
          onCancel={() => setRemovingDealer(false)}
        />
      )}
    </div>
  );
}

function RecordButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 min-h-11 rounded-lg bg-primary px-2 py-3 text-on-primary transition-opacity hover:opacity-90 active:scale-[0.98]"
    >
      {icon}
      <span className="text-body-md font-semibold">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dealer edit and delete — FR-D3, FR-D4
// ---------------------------------------------------------------------------

/** Name, type and GSTIN. Changing them never alters a posted figure (FR-D3). */
function EditDealerDialog({
  dealer,
  onSaved,
  onCancel,
}: {
  dealer: Dealer;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(dealer.name);
  const [type, setType] = useState<DealerType>(dealer.type);
  const [gstin, setGstin] = useState(dealer.gstin ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/dealers/${dealer.id}`, {
        name: name.trim(),
        type,
        gstin: gstin.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof RequestFailed ? e.detail.message : 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit dealer" busy={busy} onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !busy) void save();
        }}
      >
        <DealerFields
          name={name}
          setName={setName}
          type={type}
          setType={setType}
          gstin={gstin}
          setGstin={setGstin}
          error={error}
        />
        <p className="text-body-md text-on-surface-variant">
          Changing these does not change any amount or the balance.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="flex-1 min-h-11 rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Balance from the old book — FR-D5
// ---------------------------------------------------------------------------

export interface OpeningDraft {
  direction: 'owes_us' | 'we_owe';
  amountPaise: number | null;
  entryDate: string;
}

export const emptyOpening = (): OpeningDraft => ({
  direction: 'owes_us',
  amountPaise: null,
  entryDate: todayIST(),
});

/** Shared by New dealer and the dealer page. */
export function OpeningFields({
  value,
  onChange,
  errors = {},
}: {
  value: OpeningDraft;
  onChange: (patch: Partial<OpeningDraft>) => void;
  errors?: Record<string, string>;
}) {
  return (
    <>
      <Segmented
        legend="In your old book"
        value={value.direction}
        onChange={(direction) => onChange({ direction })}
        options={[
          { value: 'owes_us', label: 'They owe me' },
          { value: 'we_owe', label: 'I owe them' },
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        <MoneyInput
          label="Amount"
          value={value.amountPaise}
          onChange={(amountPaise) => onChange({ amountPaise })}
          error={errors['opening.amountPaise'] ?? errors.amountPaise}
        />
        <Field
          label="As on date"
          error={errors['opening.entryDate'] ?? errors.entryDate}
          hint="The date of this figure in your book"
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              className={inputCls}
              type="date"
              max={todayIST()}
              value={value.entryDate}
              onChange={(e) => onChange({ entryDate: e.target.value })}
            />
          )}
        </Field>
      </div>
    </>
  );
}

function AddOpeningDialog({
  dealer,
  onSaved,
  onCancel,
}: {
  dealer: Dealer;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<OpeningDraft>(emptyOpening);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSave = value.amountPaise !== null && value.amountPaise > 0 && !busy;

  async function save() {
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      await api.post(`/api/dealers/${dealer.id}/opening`, value);
      onSaved();
    } catch (e) {
      if (e instanceof RequestFailed) {
        setErrors(e.detail.fields ?? {});
        setFailure(e.detail.message);
      } else {
        setFailure('Could not save. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <Modal title="Balance from old book" busy={busy} onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <p className="text-body-md text-on-surface-variant">
          What {dealer.name} and you owed each other before you started using this app. It is added
          to their balance like any other entry.
        </p>
        <OpeningFields
          value={value}
          onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
          errors={errors}
        />
        {failure && <ErrorBanner message={failure} />}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <button
            type="submit"
            disabled={!canSave}
            className="flex-1 min-h-11 rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The dealer fields, shared by New dealer and Edit dealer. */
export function DealerFields({
  name,
  setName,
  type,
  setType,
  gstin,
  setGstin,
  error,
}: {
  name: string;
  setName: (v: string) => void;
  type: DealerType;
  setType: (v: DealerType) => void;
  gstin: string;
  setGstin: (v: string) => void;
  error: string | null;
}) {
  return (
    <>
      <Field label="Name" error={error ?? undefined}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>

      <Field
        label="Do you buy from them or sell to them?"
        hint="This only decides which list they appear in. They always have one balance."
      >
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy}
            className={inputCls}
            value={type}
            onChange={(e) => setType(e.target.value as DealerType)}
          >
            <option value="both">Both</option>
            <option value="supplier">I buy from them (supplier)</option>
            <option value="buyer">I sell to them (buyer)</option>
          </select>
        )}
      </Field>

      <Field label="GSTIN (optional)">
        {({ id }) => (
          <input
            id={id}
            className={inputCls}
            value={gstin}
            onChange={(e) => setGstin(e.target.value)}
          />
        )}
      </Field>
    </>
  );
}

/**
 * "Deleting" a dealer ARCHIVES them (FR-D4): off every list, every entry kept,
 * restorable from the Dealers screen. A dealer with money outstanding can
 * still be deleted, but the dialog says so plainly first — deleting settles
 * nothing.
 */
function DeleteDealerDialog({
  dealer,
  balancePaise,
  onDeleted,
  onCancel,
}: {
  dealer: Dealer;
  balancePaise: number;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/dealers/${dealer.id}`, { isArchived: true });
      onDeleted();
    } catch {
      setError('Could not delete this dealer. Nothing was changed.');
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete ${dealer.name}?`} busy={busy} onClose={onCancel}>
      <div className="space-y-3">
        {balancePaise !== 0 && (
          <p className="rounded-lg bg-negative-container p-3 text-body-md text-on-negative-container">
            <strong className="font-semibold">The balance is not settled.</strong>{' '}
            {balanceHeadline(balancePaise, dealer.name)}. Deleting the dealer does not change this.
          </p>
        )}
        <p className="text-body-lg">{dealer.name} will be removed from your dealer lists.</p>
        <p className="text-on-surface-variant">
          All their entries are kept. You can bring them back from Dealers, using “Show deleted
          dealers”.
        </p>
        {error && <ErrorBanner message={error} />}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel} disabled={busy}>
            Keep dealer
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? 'Deleting...' : 'Delete dealer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
