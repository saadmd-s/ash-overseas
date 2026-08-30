/**
 * New transaction — SRS §10.6.
 *
 * Field order matches how the owner reads a docket. Totals recompute live on
 * every keystroke, through the SAME money module the server uses (FR-T4), so
 * there is no surprise on save. The server recomputes authoritatively and its
 * figures win.
 */

import { useEffect, useMemo, useState } from 'react';
import { formatPaise, lineAmount, transactionTotals } from '../../money';
import { api, draft, RequestFailed, todayIST, type BankAccount, type Dealer } from '../lib';
import { Field, MoneyInput, Money, Segmented } from '../components';

interface LineDraft {
  itemName: string;
  quantity: string;
  unit: string;
  ratePaise: number | null;
}

interface FormDraft {
  mode: 'purchase' | 'sale';
  entryDate: string;
  invoiceNo: string;
  invoiceDate: string;
  referenceTag: string;
  bankAccount: BankAccount;
  gstRate: string;
  discountPaise: number | null;
  freightPaise: number | null;
  isReturnNote: boolean;
  notes: string;
  lines: LineDraft[];
}

const emptyLine = (): LineDraft => ({ itemName: '', quantity: '', unit: '', ratePaise: null });

/** The last bank account used, so it can default (FR-T6). */
const LAST_BANK_KEY = 'lastBankAccount';

function initial(mode: 'purchase' | 'sale'): FormDraft {
  const lastBank = (localStorage.getItem(LAST_BANK_KEY) as BankAccount | null) ?? 'od';
  return {
    mode,
    entryDate: todayIST(),
    invoiceNo: '',
    invoiceDate: '',
    referenceTag: '',
    bankAccount: lastBank,
    gstRate: '18',
    discountPaise: null,
    freightPaise: null,
    isReturnNote: false,
    notes: '',
    lines: [emptyLine()],
  };
}

export function TransactionForm({
  dealer,
  mode,
  onSaved,
  onCancel,
}: {
  dealer: Dealer;
  mode: 'purchase' | 'sale';
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const draftKey = `tx:${dealer.id}:${mode}`;
  const [form, setForm] = useState<FormDraft>(
    () => draft.load<FormDraft>(draftKey) ?? initial(mode),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [suggestions, setSuggestions] = useState<{ item: string[]; unit: string[] }>({
    item: [],
    unit: [],
  });

  // Autosave every change (§10.6) — a dropped connection must not cost the entry.
  useEffect(() => {
    draft.save(draftKey, form);
  }, [draftKey, form]);

  // FR-T10 — suggestions are never required and never constrain input.
  useEffect(() => {
    Promise.all([
      api.get<{ suggestions: string[] }>('/api/suggestions?field=item').catch(() => ({
        suggestions: [],
      })),
      api.get<{ suggestions: string[] }>('/api/suggestions?field=unit').catch(() => ({
        suggestions: [],
      })),
    ]).then(([item, unit]) => setSuggestions({ item: item.suggestions, unit: unit.suggestions }));
  }, []);

  const update = (patch: Partial<FormDraft>) => setForm((f) => ({ ...f, ...patch }));

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  }

  /**
   * The live summary (FR-T4).
   *
   * Uses the same `transactionTotals` the posting layer calls, so what the
   * owner sees while typing is what gets posted — including the round-off.
   */
  const totals = useMemo(() => {
    const linesPaise = form.lines.map((l) => {
      const quantity = Number(l.quantity);
      if (!Number.isFinite(quantity) || l.ratePaise === null) return 0;
      return lineAmount(quantity, l.ratePaise);
    });
    const gstRate = Number(form.gstRate);
    return {
      linesPaise,
      ...transactionTotals({
        linesPaise,
        discountPaise: form.discountPaise ?? 0,
        freightPaise: form.freightPaise ?? 0,
        gstRate: Number.isFinite(gstRate) ? gstRate : 0,
      }),
    };
  }, [form.lines, form.discountPaise, form.freightPaise, form.gstRate]);

  async function save() {
    setSaving(true);
    setFailure(null);
    setErrors({});

    try {
      const created = await api.post<{ humanId: string; grandTotalPaise: number }>(
        '/api/transactions',
        {
          dealerId: dealer.id,
          mode: form.mode,
          entryDate: form.entryDate,
          invoiceNo: form.invoiceNo || null,
          invoiceDate: form.invoiceDate || null,
          referenceTag: form.referenceTag || null,
          bankAccount: form.bankAccount,
          gstRate: Number(form.gstRate),
          discountPaise: form.discountPaise ?? 0,
          freightPaise: form.freightPaise ?? 0,
          isReturnNote: form.isReturnNote,
          notes: form.notes || null,
          lines: form.lines.map((l) => ({
            itemName: l.itemName || null,
            quantity: Number(l.quantity),
            unit: l.unit || null,
            ratePaise: l.ratePaise ?? 0,
          })),
        },
      );

      localStorage.setItem(LAST_BANK_KEY, form.bankAccount);
      draft.clear(draftKey); // cleared only on SUCCESS
      onSaved(`Saved ${created.humanId} — ${formatPaise(created.grandTotalPaise)}`);
    } catch (e) {
      // On failure the input is preserved and the draft is kept (§10.6).
      if (e instanceof RequestFailed) {
        setErrors(e.detail.fields ?? {});
        setFailure(e.detail.message);
      } else {
        setFailure('Could not save. Your entry has been kept.');
      }
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    form.lines.length > 0 &&
    form.lines.every((l) => l.quantity.trim() !== '' && l.ratePaise !== null) &&
    !saving;

  return (
    <form
      className="p-3 pb-28"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <h1 className="mb-1 text-xl font-semibold">
        New {form.mode === 'sale' ? 'sale' : 'purchase'}
      </h1>
      <p className="mb-4 text-sm text-[var(--color-muted)]">{dealer.name}</p>

      <Segmented
        legend="Mode"
        value={form.mode}
        onChange={(mode_) => update({ mode: mode_ })}
        options={[
          { value: 'purchase', label: 'Purchase' },
          { value: 'sale', label: 'Sale' },
        ]}
      />

      <Field label="Date" error={errors.entryDate}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            className="field"
            type="date"
            value={form.entryDate}
            max={todayIST()}
            onChange={(e) => update({ entryDate: e.target.value })}
          />
        )}
      </Field>

      <Field label="Invoice No." hint="Optional">
        {({ id }) => (
          <input
            id={id}
            className="field"
            value={form.invoiceNo}
            onChange={(e) => update({ invoiceNo: e.target.value })}
          />
        )}
      </Field>

      <datalist id="item-suggestions">
        {suggestions.item.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id="unit-suggestions">
        {suggestions.unit.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {form.lines.map((line, i) => (
        <fieldset key={i} className="card mb-3 p-3">
          <legend className="px-1 text-sm font-medium">Item {i + 1}</legend>

          <Field label="Item" hint="Optional">
            {({ id }) => (
              <input
                id={id}
                className="field"
                list="item-suggestions"
                value={line.itemName}
                onChange={(e) => updateLine(i, { itemName: e.target.value })}
              />
            )}
          </Field>

          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Quantity" error={errors[`lines.${i}.quantity`]}>
                {({ id }) => (
                  <input
                    id={id}
                    className="field tabular"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <div className="w-24">
              <Field label="Unit">
                {({ id }) => (
                  <input
                    id={id}
                    className="field"
                    list="unit-suggestions"
                    placeholder="kg"
                    value={line.unit}
                    onChange={(e) => updateLine(i, { unit: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>

          <MoneyInput
            label="Rate"
            required
            value={line.ratePaise}
            onChange={(ratePaise) => updateLine(i, { ratePaise })}
            error={errors[`lines.${i}.ratePaise`]}
          />

          <p className="text-sm text-[var(--color-muted)]">
            Line amount: <Money paise={totals.linesPaise[i] ?? 0} />
          </p>

          {form.lines.length > 1 && (
            <button
              type="button"
              className="btn mt-2"
              onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}
            >
              Remove item {i + 1}
            </button>
          )}
        </fieldset>
      ))}

      {/* One line by default; adding more is an action, not a pre-expanded list. */}
      <button
        type="button"
        className="btn mb-3 w-full"
        onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
      >
        + Add another item
      </button>

      <Field label="GST %" error={errors.gstRate} hint="0–100">
        {({ id }) => (
          <input
            id={id}
            className="field tabular"
            inputMode="decimal"
            value={form.gstRate}
            onChange={(e) => update({ gstRate: e.target.value })}
          />
        )}
      </Field>

      <Segmented
        legend="Bank account"
        value={form.bankAccount}
        onChange={(bankAccount) => update({ bankAccount })}
        options={[
          { value: 'od', label: 'OD' },
          { value: 'current', label: 'Current' },
        ]}
      />

      <button type="button" className="btn mb-3 w-full" onClick={() => setShowMore((v) => !v)}>
        {showMore ? 'Hide' : 'More'} options
      </button>

      {showMore && (
        <div className="card mb-3 p-3">
          <Field label="Reference tag" hint='Your own label, e.g. "ASH 39"'>
            {({ id }) => (
              <input
                id={id}
                className="field"
                value={form.referenceTag}
                onChange={(e) => update({ referenceTag: e.target.value })}
              />
            )}
          </Field>

          <MoneyInput
            label="Discount"
            value={form.discountPaise}
            onChange={(discountPaise) => update({ discountPaise })}
            error={errors.discountPaise}
            hint="Cannot exceed the base total"
          />
          <MoneyInput
            label="Freight"
            value={form.freightPaise}
            onChange={(freightPaise) => update({ freightPaise })}
          />

          <Field label="Invoice date" hint="Only if it differs from the entry date">
            {({ id }) => (
              <input
                id={id}
                className="field"
                type="date"
                max={todayIST()}
                value={form.invoiceDate}
                onChange={(e) => update({ invoiceDate: e.target.value })}
              />
            )}
          </Field>

          <label className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isReturnNote}
              onChange={(e) => update({ isReturnNote: e.target.checked })}
            />
            <span className="text-sm">
              This is a return or credit/debit note
              <span className="block text-xs text-[var(--color-muted)]">
                Posts the opposite way to its mode
              </span>
            </span>
          </label>

          <Field label="Notes">
            {({ id }) => (
              <textarea
                id={id}
                className="field"
                rows={2}
                value={form.notes}
                onChange={(e) => update({ notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {/* The live summary — no surprises on save (§10.1, FR-T4). */}
      <div className="card mb-3 p-3" aria-live="polite">
        <dl className="grid grid-cols-2 gap-1 text-sm">
          <dt>Base total</dt>
          <dd className="text-right">
            <Money paise={totals.baseTotalPaise} />
          </dd>

          <dt>GST {form.gstRate || 0}%</dt>
          <dd className="text-right">
            {/* §8.3 — a zero rate shows an em dash, not ₹0.00. */}
            {Number(form.gstRate) === 0 ? '—' : <Money paise={totals.gstAmountPaise} />}
          </dd>

          {totals.roundOffPaise !== 0 && (
            <>
              <dt>Round off</dt>
              <dd className="text-right">
                <Money paise={totals.roundOffPaise} />
              </dd>
            </>
          )}

          <dt className="text-base font-semibold">Total</dt>
          <dd className="text-right text-base font-semibold">
            <Money paise={totals.grandTotalPaise} />
          </dd>
        </dl>
      </div>

      {failure && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-payable)]">
          {failure} Your entry has been kept.
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 flex gap-2 border-t border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <button type="button" className="btn flex-1" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary flex-1" disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
