/**
 * New payment — SRS §10.7.
 *
 * Direction is presented as two plain-language options, NEVER as debit/credit.
 * Same money input and draft persistence rules as the transaction form.
 */

import { useEffect, useState } from 'react';
import { formatPaise } from '../../money';
import { api, draft, RequestFailed, todayIST, type BankAccount, type Dealer } from '../lib';
import { MoneyInput } from '../components';
import { Button, Card, Field, Labeled, Segmented, inputCls, panelCls } from '../ui';

type Method = 'cash' | 'bank' | 'cheque' | 'upi';

interface FormDraft {
  entryDate: string;
  direction: 'received' | 'paid';
  amountPaise: number | null;
  method: Method | '';
  bankAccount: BankAccount;
  reference: string;
  notes: string;
}

export function PaymentForm({
  dealer,
  onSaved,
  onCancel,
}: {
  dealer: Dealer;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const draftKey = `pay:${dealer.id}`;
  const [form, setForm] = useState<FormDraft>(
    () =>
      draft.load<FormDraft>(draftKey) ?? {
        entryDate: todayIST(),
        direction: 'received',
        amountPaise: null,
        method: '',
        bankAccount: (localStorage.getItem('lastBankAccount') as BankAccount | null) ?? 'od',
        reference: '',
        notes: '',
      },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    draft.save(draftKey, form);
  }, [draftKey, form]);

  const update = (patch: Partial<FormDraft>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setSaving(true);
    setFailure(null);
    setErrors({});
    try {
      const created = await api.post<{ humanId: string }>('/api/payments', {
        dealerId: dealer.id,
        entryDate: form.entryDate,
        direction: form.direction,
        amountPaise: form.amountPaise,
        method: form.method || null,
        // §10.7 — the bank tag is hidden, and omitted, when the method is cash.
        bankAccount: form.method === 'cash' ? null : form.bankAccount,
        reference: form.reference || null,
        notes: form.notes || null,
      });

      draft.clear(draftKey);
      onSaved(`Saved ${created.humanId} — ${formatPaise(form.amountPaise ?? 0)}`);
    } catch (e) {
      if (e instanceof RequestFailed) {
        setErrors(e.detail.fields ?? {});
        setFailure(e.detail.message);
      } else {
        setFailure('Could not save.');
      }
    } finally {
      setSaving(false);
    }
  }

  // An amount is required and must be greater than zero (FR-P1).
  const canSave = form.amountPaise !== null && form.amountPaise > 0 && !saving;

  return (
    <form
      className="mx-auto max-w-2xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <div>
        <h1 className="text-headline-md text-primary">Add money</h1>
        <p className="text-body-md text-on-surface-variant">{dealer.name}</p>
      </div>

      <Card className="space-y-4">
        {/* Plain language, both ways. The words "debit" and "credit" never
            appear anywhere in the interface. */}
        <Segmented
          legend="Direction"
          value={form.direction}
          onChange={(direction) => update({ direction })}
          options={[
            { value: 'received', label: 'Received from dealer' },
            { value: 'paid', label: 'Paid to dealer' },
          ]}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" error={errors.entryDate}>
            {({ id }) => (
              <input
                id={id}
                className={inputCls}
                type="date"
                max={todayIST()}
                value={form.entryDate}
                onChange={(e) => update({ entryDate: e.target.value })}
              />
            )}
          </Field>

          <MoneyInput
            label="Amount"
            required
            value={form.amountPaise}
            onChange={(amountPaise) => update({ amountPaise })}
            error={errors.amountPaise}
          />
        </div>

        <Labeled label="Method" hint="Optional">
          <select
            className={inputCls}
            value={form.method}
            onChange={(e) => update({ method: e.target.value as Method | '' })}
          >
            <option value="">Not recorded</option>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
            <option value="cheque">Cheque</option>
            <option value="upi">UPI</option>
          </select>
        </Labeled>

        {form.method !== 'cash' && (
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
        )}

        <Field label="Reference" hint="Cheque number, UTR">
          {({ id }) => (
            <input
              id={id}
              className={inputCls}
              value={form.reference}
              onChange={(e) => update({ reference: e.target.value })}
            />
          )}
        </Field>

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
      </Card>

      {failure && (
        <p role="alert" className="text-body-md text-negative">
          {failure} Your entry has been kept.
        </p>
      )}

      <div className={`${panelCls} flex gap-2`}>
        <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel}>
          Cancel
        </Button>
        <button
          type="submit"
          disabled={!canSave}
          className="flex-1 rounded-lg bg-primary px-4 py-3 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save payment'}
        </button>
      </div>
    </form>
  );
}
