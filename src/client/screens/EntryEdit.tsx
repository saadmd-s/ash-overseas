/**
 * The entry detail sheet and its edit form — APP_FLOW §6.1, FR-A6, SRS §14.
 *
 * Two jobs, and the second one is a safety constraint rather than a feature:
 *
 *   1. Show what was actually recorded — the figures, the line items, and this
 *      record's own audit trail (§10.5).
 *   2. Let the owner fix a note, a reference tag, or the spelling of an item,
 *      and NOTHING else.
 *
 * APP_FLOW is explicit that "the edit form must not expose those fields at
 * all — the constraint is enforced in the interface, not just the API". So every
 * figure below is rendered as text, never as an input. There is no disabled
 * amount box to re-enable, because a disabled box still says "this is the kind
 * of thing you edit here" and the answer is that it is not: changing an amount
 * means voiding the entry and entering it again.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, formatDate, formatInstant, RequestFailed, type BankAccount } from '../lib';
import { Money } from '../components';
import { Button, Chip, ErrorState, Loading, Modal, inputCls, panelCls } from '../ui';

interface TransactionRow {
  id: number;
  humanId: string;
  mode: 'purchase' | 'sale';
  entryDate: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  referenceTag: string | null;
  bankAccount: BankAccount;
  gstRate: number;
  baseTotalPaise: number;
  discountPaise: number;
  freightPaise: number;
  gstAmountPaise: number;
  roundOffPaise: number;
  grandTotalPaise: number;
  isReturnNote: boolean;
  notes: string | null;
  isVoided: boolean;
}

interface LineRow {
  id: number;
  lineNo: number;
  itemName: string | null;
  quantity: number;
  unit: string | null;
  ratePaise: number;
  amountPaise: number;
}

interface AuditRow {
  id: number;
  action: string;
  at: string;
}

interface Detail {
  transaction: TransactionRow;
  lines: LineRow[];
  audit: AuditRow[];
}

/** `null` means "clear this field"; a string means "set it to this". */
const trimmedOrNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function EntryEditDialog({
  transactionId,
  onSaved,
  onCancel,
}: {
  transactionId: number;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [referenceTag, setReferenceTag] = useState('');
  const [notes, setNotes] = useState('');
  const [itemNames, setItemNames] = useState<Record<number, string>>({});

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<Detail>(`/api/transactions/${transactionId}`)
      .then((d) => {
        setDetail(d);
        setReferenceTag(d.transaction.referenceTag ?? '');
        setNotes(d.transaction.notes ?? '');
        setItemNames(Object.fromEntries(d.lines.map((l) => [l.id, l.itemName ?? ''])));
      })
      .catch(() => setLoadError('Could not load that entry.'));
  }, [transactionId]);

  useEffect(load, [load]);

  async function save() {
    if (!detail) return;
    const tx = detail.transaction;

    // Only what actually changed. Sending an unchanged field would write an
    // audit row saying "notes: 'x' → 'x'", which makes the trail harder to read
    // for no gain.
    const body: {
      referenceTag?: string | null;
      notes?: string | null;
      lines?: { id: number; itemName: string | null }[];
    } = {};

    const nextTag = trimmedOrNull(referenceTag);
    if (nextTag !== (tx.referenceTag ?? null)) body.referenceTag = nextTag;

    const nextNotes = trimmedOrNull(notes);
    if (nextNotes !== (tx.notes ?? null)) body.notes = nextNotes;

    const changedLines = detail.lines
      .map((l) => ({ id: l.id, itemName: trimmedOrNull(itemNames[l.id] ?? '') }))
      .filter((l, i) => l.itemName !== (detail.lines[i].itemName ?? null));
    if (changedLines.length) body.lines = changedLines;

    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/api/transactions/${tx.id}`, body);
      onSaved('Entry updated. No amount was changed.');
    } catch (error) {
      setSaveError(
        error instanceof RequestFailed
          ? error.detail.message
          : 'Could not save that change. Nothing was altered.',
      );
    } finally {
      setSaving(false);
    }
  }

  const title = detail
    ? `${detail.transaction.mode === 'sale' ? 'Sale' : 'Purchase'}${
        detail.transaction.isReturnNote ? ' return' : ''
      }`
    : 'Entry';

  return (
    <Modal title={title} busy={saving} onClose={onCancel}>
      {loadError && <ErrorState message={loadError} onRetry={load} />}
      {!loadError && !detail && <Loading what="entry" />}

      {detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip>{detail.transaction.humanId}</Chip>
            <Chip>{detail.transaction.bankAccount === 'od' ? 'OD' : 'Current'}</Chip>
            {detail.transaction.isVoided && <Chip tone="negative">Voided</Chip>}
            <span className="text-body-md text-on-surface-variant">
              {formatDate(detail.transaction.entryDate)}
            </span>
          </div>

          {detail.transaction.isVoided && (
            <p className="rounded-lg bg-negative-container p-3 text-body-md text-on-negative-container">
              This entry is voided. Its reversal is in the history; editing the wording here does
              not bring it back.
            </p>
          )}

          <Figures tx={detail.transaction} lines={detail.lines} />

          <div>
            <h3 className="text-label-caps uppercase text-on-surface-variant">
              What you can change
            </h3>
            <p className="mt-1 text-body-md text-on-surface-variant">
              Wording only. To change a date, an amount, a quantity, a rate, the GST rate, the
              dealer, or purchase/sale, void this entry and enter it again — that is what keeps the
              history true.
            </p>
          </div>

          <label className="block space-y-1">
            <span className="text-label-caps uppercase text-on-surface-variant">Reference tag</span>
            <input
              className={inputCls}
              value={referenceTag}
              onChange={(e) => setReferenceTag(e.target.value)}
              placeholder="ASH 39"
            />
          </label>

          {detail.lines.map((line) => (
            <label key={line.id} className="block space-y-1">
              <span className="text-label-caps uppercase text-on-surface-variant">
                Item name — line {line.lineNo}
              </span>
              <input
                className={inputCls}
                value={itemNames[line.id] ?? ''}
                onChange={(e) => setItemNames((names) => ({ ...names, [line.id]: e.target.value }))}
                placeholder="optional"
              />
              <span className="block text-label-caps text-on-surface-variant">
                {line.quantity} {line.unit ?? ''} at <Money paise={line.ratePaise} /> ={' '}
                <Money paise={line.amountPaise} /> — not editable
              </span>
            </label>
          ))}

          <label className="block space-y-1">
            <span className="text-label-caps uppercase text-on-surface-variant">Notes</span>
            <textarea
              className={inputCls}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          {saveError && (
            <p role="alert" className="text-body-md text-negative">
              {saveError}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 py-2.5"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </Button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </div>

          {detail.audit.length > 0 && (
            <details>
              <summary className="cursor-pointer text-body-md font-medium">
                History of this record
              </summary>
              <ul className="mt-2 space-y-1 text-body-md text-on-surface-variant">
                {detail.audit.map((row) => (
                  <li key={row.id}>
                    {ACTION_LABEL[row.action] ?? row.action} · {formatInstant(row.at)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Entered',
  edit: 'Wording edited',
  void: 'Voided',
};

/**
 * The recorded figures, as text.
 *
 * Deliberately not a form. See the note at the top of this file: an input the
 * owner cannot use is a worse answer than no input at all.
 */
function Figures({ tx, lines }: { tx: TransactionRow; lines: LineRow[] }) {
  // The same labels, in the same order, as the live summary on the entry form.
  // The owner should recognise the figures they typed.
  const rows: [string, ReactNode][] = [['Base price', <Money paise={tx.baseTotalPaise} />]];
  // "Less discount", carrying a positive figure: the interface never shows a
  // bare minus sign (§10.8).
  if (tx.discountPaise) rows.push(['Less discount', <Money paise={tx.discountPaise} />]);
  if (tx.freightPaise) rows.push(['Freight', <Money paise={tx.freightPaise} />]);
  rows.push([
    `GST ${tx.gstRate}%`,
    // §8.3 — a zero rate shows an em dash, not the same as a rate that computed
    // to nothing.
    tx.gstRate === 0 ? '—' : <Money paise={tx.gstAmountPaise} />,
  ]);
  // Round off is the one figure that may legitimately be negative (§8).
  if (tx.roundOffPaise) rows.push(['Round off', <Money paise={tx.roundOffPaise} />]);

  return (
    <div className={`${panelCls} space-y-1`}>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between py-0.5">
            <dt className="text-on-surface-variant">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between border-t border-outline-variant pt-1 font-semibold">
          <dt>Full price</dt>
          <dd>
            <Money paise={tx.grandTotalPaise} />
          </dd>
        </div>
      </dl>
      <p className="text-label-caps uppercase text-on-surface-variant">
        {lines.length} line item{lines.length === 1 ? '' : 's'}
        {tx.invoiceNo ? ` · invoice ${tx.invoiceNo}` : ''}
      </p>
    </div>
  );
}
