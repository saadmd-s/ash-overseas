/**
 * Shared components.
 *
 * The two rules that must never regress here:
 *   - every balance renders through `balanceHeadline()` / `formatPaise()` —
 *     the UI never formats money itself (§10.8);
 *   - no screen shows "debit", "credit", or a bare +/− (§5, §10.8).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { balanceHeadline, formatPaise, groupIndianDigits, parseRupeesToPaise } from '../money';
import { downloadExport } from './lib';

// ---------------------------------------------------------------------------
// Balance display
// ---------------------------------------------------------------------------

function direction(paise: number): 'receivable' | 'payable' | 'settled' {
  if (paise > 0) return 'receivable';
  if (paise < 0) return 'payable';
  return 'settled';
}

const ICON = { receivable: '↑', payable: '↓', settled: '•' } as const;
const TONE = {
  receivable: 'text-[var(--color-receivable)]',
  payable: 'text-[var(--color-payable)]',
  settled: 'text-[var(--color-settled)]',
} as const;

/**
 * The hero balance (§10.1).
 *
 * Direction is carried by an icon AND the words themselves; colour is only ever
 * a third, redundant signal (§10.10).
 */
export function BalanceHeadline({ paise, dealerName }: { paise: number; dealerName: string }) {
  const d = direction(paise);
  return (
    <p className={`text-headline font-bold ${TONE[d]}`}>
      <span aria-hidden="true">{ICON[d]} </span>
      <span className="tabular">{balanceHeadline(paise, dealerName)}</span>
    </p>
  );
}

/** The same language, compact, for a list row. */
export function BalanceInline({ paise, dealerName }: { paise: number; dealerName: string }) {
  const d = direction(paise);
  return (
    <span className={`tabular text-sm ${TONE[d]}`}>
      <span aria-hidden="true">{ICON[d]} </span>
      {balanceHeadline(paise, dealerName)}
    </span>
  );
}

/** An amount. Wraps `formatPaise` — the only money renderer (§10.8). */
export function Money({ paise }: { paise: number }) {
  return <span className="tabular">{formatPaise(paise)}</span>;
}

// ---------------------------------------------------------------------------
// MoneyInput — the most safety-critical component in the interface
// ---------------------------------------------------------------------------

interface MoneyInputProps {
  label: string;
  /** Integer paise, or null for "not entered" — never 0 (§10.6). */
  value: number | null;
  onChange: (paise: number | null) => void;
  required?: boolean;
  error?: string;
  hint?: string;
}

/**
 * The owner types rupees; this emits integer paise and nothing else.
 *
 * §10.6 — form state never holds a float rupee value. The component keeps the
 * raw typed text only so the caret and grouping behave; the value it reports is
 * always the parsed integer, and `null` when the field is empty, because an
 * empty discount is *absent*, not ₹0.
 */
export function MoneyInput({ label, value, onChange, required, error, hint }: MoneyInputProps) {
  const id = useId();
  const [text, setText] = useState(() => (value === null ? '' : renderPaise(value)));

  // Reflect a value set from outside (a restored draft), without fighting the
  // owner mid-keystroke.
  useEffect(() => {
    if (value === null && text === '') return;
    if (parseRupeesToPaise(text) !== value) {
      setText(value === null ? '' : renderPaise(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handle(raw: string) {
    // Keep digits, commas and one decimal point; curtail beyond two decimals.
    const cleaned = raw.replace(/[^\d.,]/g, '');
    const [whole, ...rest] = cleaned.replace(/,/g, '').split('.');
    const decimals = rest.join('').slice(0, 2);
    const grouped = groupIndianDigits(whole);
    const next = rest.length > 0 ? `${grouped}.${decimals}` : grouped;

    setText(next);
    onChange(next.trim() === '' ? null : parseRupeesToPaise(next));
  }

  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        className="field tabular"
        // A numeric keypad on a phone, while still allowing grouping commas.
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => handle(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        placeholder="0.00"
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--color-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-[var(--color-payable)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** Paise → the plain digits the input echoes. No symbol, no forced decimals. */
function renderPaise(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const fraction = paise % 100;
  const grouped = groupIndianDigits(String(whole));
  return fraction === 0 ? grouped : `${grouped}.${String(fraction).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

export function Field({
  label,
  children,
  error,
  hint,
}: {
  label: string;
  children: (props: { id: string; describedBy?: string }) => ReactNode;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--color-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-[var(--color-payable)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** A segmented control. Used for mode, bank account and payment direction. */
export function Segmented<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`btn flex-1 ${value === o.value ? 'btn-primary' : ''}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Feedback and dialogs
// ---------------------------------------------------------------------------

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      role="status"
      className="card fixed inset-x-3 bottom-3 z-50 p-3 shadow-lg"
      style={{ borderColor: 'var(--color-receivable)' }}
    >
      {message}
    </div>
  );
}

/**
 * Void confirmation — FR-A2.
 *
 * "Voiding requires an explicit confirmation dialog that names the entry and
 * the amount." Both are in the prompt below, deliberately.
 */
export function VoidDialog({
  entryLabel,
  amountPaise,
  busy,
  onConfirm,
  onCancel,
}: {
  entryLabel: string;
  amountPaise: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="void-title"
        className="card w-full max-w-md p-4"
      >
        <h2 id="void-title" className="mb-2 text-lg font-semibold">
          Void {entryLabel}?
        </h2>
        <p className="mb-1">
          This posts an equal and opposite reversing entry for{' '}
          <strong>
            <Money paise={amountPaise} />
          </strong>
          .
        </p>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          Nothing is deleted. The original stays in the history, struck through, with its reversal
          beside it.
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn flex-1" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary flex-1"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Voiding…' : 'Void entry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export menu
// ---------------------------------------------------------------------------

/** Export in either format. Both go through the same row-builder (§11.2). */
export function ExportMenu({ path, label = 'Export' }: { path: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(format: 'xlsx' | 'csv') {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(path, format);
    } catch {
      setError('Export failed. Nothing was downloaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={() => run('xlsx')} disabled={busy}>
          {busy ? 'Preparing…' : `${label} (Excel)`}
        </button>
        <button type="button" className="btn" onClick={() => run('csv')} disabled={busy}>
          CSV
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-payable)]">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="p-4 text-[var(--color-muted)]">
      Loading {what}…
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card m-3 p-4">
      <p className="mb-2">{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="p-4 text-center text-[var(--color-muted)]">
      <p className="mb-2">{message}</p>
      {action}
    </div>
  );
}
