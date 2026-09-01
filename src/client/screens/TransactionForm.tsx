/**
 * New transaction — SRS §10.6. The most complex screen, and the one where the
 * design does the most work.
 *
 * Field order matches how the owner reads a docket. Totals recompute live on
 * every keystroke, through the SAME money module the server uses (FR-T4), so
 * there is no surprise on save. The server recomputes authoritatively and its
 * figures win.
 *
 * THE SINGLE MOST IMPORTANT USABILITY DECISION HERE is the "More options"
 * disclosure. The common path is six fields; the complete path is fourteen.
 * Hiding the eight rare ones behind one tap is what makes this form usable
 * one-handed, standing in a yard.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { formatPaise, lineAmount, transactionTotals } from '../../money';
import { api, draft, RequestFailed, todayIST, type BankAccount, type Dealer } from '../lib';
import { Money, MoneyInput } from '../components';
import { Button, Card, Field, Labeled, Segmented, inputCls, panelCls } from '../ui';

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
      className="mx-auto max-w-2xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <div>
        <h1 className="text-headline-md text-primary">
          New {form.mode === 'sale' ? 'sale' : 'purchase'}
        </h1>
        <p className="text-body-md text-on-surface-variant">{dealer.name}</p>
      </div>

      <Card className="space-y-4">
        {/* Three short controls across, even at 360px, because they are short. */}
        <div className="grid grid-cols-3 gap-3">
          <Labeled label="Mode">
            <select
              className={inputCls}
              value={form.mode}
              onChange={(e) => update({ mode: e.target.value as 'purchase' | 'sale' })}
            >
              <option value="purchase">Purchase</option>
              <option value="sale">Sale</option>
            </select>
          </Labeled>

          <Field label="GST %" error={errors.gstRate}>
            {({ id }) => (
              <input
                id={id}
                className={`${inputCls} tnum`}
                inputMode="decimal"
                value={form.gstRate}
                onChange={(e) => update({ gstRate: e.target.value })}
              />
            )}
          </Field>

          <Field label="Date" error={errors.entryDate}>
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className={inputCls}
                type="date"
                value={form.entryDate}
                max={todayIST()}
                onChange={(e) => update({ entryDate: e.target.value })}
              />
            )}
          </Field>
        </div>

        {/*
          The bank account tag renders in the NEUTRAL pair, never in the balance
          semantics (§14, change 2). It records which of the business's own
          accounts the money ran through. It never splits a balance, never
          changes a posting rule, and must not look like it might.
        */}
        <Segmented
          legend="Bank account"
          tone="neutral"
          value={form.bankAccount}
          onChange={(bankAccount) => update({ bankAccount })}
          options={[
            { value: 'od', label: 'OD' },
            { value: 'current', label: 'Current' },
          ]}
          hint="A tag on your own account. It never splits the dealer’s balance."
        />
      </Card>

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
        <div key={i} className="space-y-3 rounded-lg border border-outline-variant p-3">
          <div className="flex items-center justify-between">
            <span className="text-label-caps uppercase text-on-surface-variant">Line {i + 1}</span>
            {form.lines.length > 1 && (
              <button
                type="button"
                aria-label={`Remove line ${i + 1}`}
                title={`Remove line ${i + 1}`}
                className="grid size-8 place-items-center rounded-lg text-negative transition-colors hover:bg-negative-container"
                onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Item" hint="Optional">
              {({ id }) => (
                <input
                  id={id}
                  className={inputCls}
                  list="item-suggestions"
                  value={line.itemName}
                  onChange={(e) => updateLine(i, { itemName: e.target.value })}
                />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Qty" error={errors[`lines.${i}.quantity`]}>
                {({ id }) => (
                  <input
                    id={id}
                    className={`${inputCls} tnum`}
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Unit">
                {({ id }) => (
                  <input
                    id={id}
                    className={inputCls}
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

          <p className="text-body-md text-on-surface-variant">
            Line amount: <Money paise={totals.linesPaise[i] ?? 0} />
          </p>
        </div>
      ))}

      {/* A bare text button, deliberately not a filled one: this is a secondary
          action inside a form whose primary action is Save. */}
      <Button
        variant="text"
        className="flex items-center gap-1"
        onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
      >
        <Plus size={18} aria-hidden="true" />
        Add line
      </Button>

      <Field label="Reference tag" hint="Your own label — the one you actually search by.">
        {({ id }) => (
          <input
            id={id}
            className={inputCls}
            placeholder="ASH 39"
            value={form.referenceTag}
            onChange={(e) => update({ referenceTag: e.target.value })}
          />
        )}
      </Field>

      <button
        type="button"
        aria-expanded={showMore}
        onClick={() => setShowMore((v) => !v)}
        className="flex items-center gap-1 text-body-md font-medium text-primary"
      >
        <ChevronDown
          size={18}
          aria-hidden="true"
          className={`transition-transform ${showMore ? 'rotate-180' : ''}`}
        />
        More options
      </button>

      {showMore && (
        <div className={`${panelCls} space-y-4`}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Invoice no." hint="Optional">
              {({ id }) => (
                <input
                  id={id}
                  className={inputCls}
                  value={form.invoiceNo}
                  onChange={(e) => update({ invoiceNo: e.target.value })}
                />
              )}
            </Field>
            <Field label="Invoice date" hint="Only if it differs">
              {({ id }) => (
                <input
                  id={id}
                  className={inputCls}
                  type="date"
                  max={todayIST()}
                  value={form.invoiceDate}
                  onChange={(e) => update({ invoiceDate: e.target.value })}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
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
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.isReturnNote}
              onChange={(e) => update({ isReturnNote: e.target.checked })}
            />
            <span className="text-body-md">
              This is a return or credit/debit note
              <span className="block text-label-caps text-on-surface-variant">
                Posts the opposite way to its mode
              </span>
            </span>
          </label>

          <Field label="Notes">
            {({ id }) => (
              <textarea
                id={id}
                className={inputCls}
                rows={2}
                value={form.notes}
                onChange={(e) => update({ notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {/* The live summary — no surprises on save (§10.1, FR-T4). */}
      <div className={`${panelCls} space-y-1`} aria-live="polite">
        <Row label="Base total" value={<Money paise={totals.baseTotalPaise} />} />
        {form.discountPaise !== null && form.discountPaise !== 0 && (
          // "Less discount" carrying a POSITIVE figure — the interface never
          // shows a bare minus sign (§10.8).
          <Row label="Less discount" value={<Money paise={form.discountPaise} />} />
        )}
        {form.freightPaise !== null && form.freightPaise !== 0 && (
          <Row label="Freight" value={<Money paise={form.freightPaise} />} />
        )}
        <Row
          label={`GST ${form.gstRate || 0}%`}
          // §8.3 — a zero rate shows an em dash, not ₹0.00. The two mean
          // different things and the owner needs to tell them apart.
          value={Number(form.gstRate) === 0 ? '—' : <Money paise={totals.gstAmountPaise} />}
        />
        {totals.roundOffPaise !== 0 && (
          <Row label="Round off" value={<Money paise={totals.roundOffPaise} />} />
        )}
        <div className="flex items-center justify-between border-t border-outline-variant pt-1">
          <span className="font-semibold">Total amount</span>
          <span className="font-semibold">
            <Money paise={totals.grandTotalPaise} />
          </span>
        </div>
      </div>

      {failure && (
        <p role="alert" className="text-body-md text-negative">
          {failure} Your entry has been kept.
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel}>
          Cancel
        </Button>
        <button
          type="submit"
          disabled={!canSave}
          className="flex-1 rounded-lg bg-primary px-4 py-3 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving...' : `Save ${form.mode}`}
        </button>
      </div>
    </form>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
