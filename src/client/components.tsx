/**
 * Domain components — the pieces that know what money and balances mean.
 *
 * The two rules that must never regress here:
 *   - every balance renders through `balanceHeadline()` / `formatPaise()` —
 *     the UI never formats money itself (§10.8);
 *   - no screen shows "debit", "credit", or a bare +/- (§5, §10.8).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Download, FileSpreadsheet, Minus } from 'lucide-react';
import { balanceHeadline, formatPaise, groupIndianDigits, parseRupeesToPaise } from '../money';
import { downloadExport } from './lib';
import { Button, Modal } from './ui';

// ---------------------------------------------------------------------------
// Balance display — the hero of every dealer screen
// ---------------------------------------------------------------------------

type Direction = 'receivable' | 'payable' | 'settled';

function direction(paise: number): Direction {
  if (paise > 0) return 'receivable';
  if (paise < 0) return 'payable';
  return 'settled';
}

/**
 * Direction is carried three ways at once — words, icon, colour — and never by
 * colour alone (§10.10). The words are what carry the meaning; the icon and
 * the colour are reinforcement. See the note on the semantic tokens in
 * styles.css for why that ordering is not negotiable.
 */
const ICON = {
  receivable: ArrowUpRight,
  payable: ArrowDownRight,
  settled: Minus,
} as const;

const TONE: Record<Direction, string> = {
  receivable: 'text-positive',
  payable: 'text-negative',
  settled: 'text-neutral',
};

/**
 * The direction in words, for display at a different type size from the figure.
 *
 * `balanceHeadline` from the money module returns the whole sentence and stays
 * exactly as SRS Appendix B specifies it — it is still what a screen reader
 * hears below. This only splits the same information across two lines so the
 * amount can be the largest thing on the page while the words above it stay at
 * label size. The wording matches the money module deliberately: two different
 * phrasings for one fact would be worse than either.
 */
function directionLabel(paise: number, dealerName: string): string {
  if (paise > 0) return `${dealerName} owes you`;
  if (paise < 0) return `You owe ${dealerName}`;
  return 'Settled';
}

export function BalanceHeadline({ paise, dealerName }: { paise: number; dealerName: string }) {
  const d = direction(paise);
  const Icon = ICON[d];
  return (
    <div className={TONE[d]}>
      {/* The whole sentence, announced once. The split below is visual only. */}
      <span className="sr-only">{balanceHeadline(paise, dealerName)}</span>
      <p aria-hidden="true" className="flex items-center gap-1.5 text-label-caps uppercase">
        <Icon size={18} />
        {directionLabel(paise, dealerName)}
      </p>
      <p aria-hidden="true" className="tnum text-display-lg">
        {formatPaise(Math.abs(paise))}
      </p>
    </div>
  );
}

/** The compact sibling, for a list row. */
export function InlineBalance({ paise, dealerName }: { paise: number; dealerName: string }) {
  const d = direction(paise);
  const Icon = ICON[d];
  return (
    <span className={`flex items-center gap-1 text-body-md font-medium ${TONE[d]}`}>
      <span className="sr-only">{balanceHeadline(paise, dealerName)}</span>
      <Icon size={15} aria-hidden="true" />
      <span aria-hidden="true" className="tnum">
        {formatPaise(Math.abs(paise))}
      </span>
    </span>
  );
}

/** An amount. Wraps `formatPaise` — the only money renderer (§10.8). */
export function Money({ paise }: { paise: number }) {
  return <span className="tnum">{formatPaise(paise)}</span>;
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
 * empty discount is ABSENT, not ₹0.
 *
 * The focus ring lives on the WRAPPER via `focus-within:`, so the ₹ prefix is
 * enclosed by the ring rather than stranded outside it. `inputMode="decimal"`
 * summons the numeric keypad on a phone — a small thing that matters enormously
 * when entering forty amounts in a row.
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
    <div className="space-y-1">
      <label htmlFor={id} className="block text-label-caps uppercase text-on-surface-variant">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 transition-shadow focus-within:ring-2 focus-within:ring-primary">
        <span aria-hidden="true" className="text-on-surface-variant">
          ₹
        </span>
        <input
          id={id}
          className="tnum w-full bg-transparent py-2.5 outline-none"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => handle(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          placeholder="0.00"
        />
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-label-caps text-on-surface-variant">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-body-md text-negative">
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
// Void confirmation — FR-A2
// ---------------------------------------------------------------------------

/**
 * "Voiding requires an explicit confirmation dialog that names the entry and
 * the amount." Both are in the prompt below, deliberately.
 *
 * Two equal-width buttons, destructive on the right, and the dialog cannot be
 * dismissed while the request is in flight.
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
  return (
    <Modal title="Void this entry?" busy={busy} onClose={onCancel}>
      <p className="mb-2 text-body-lg">
        {entryLabel} — this posts an equal and opposite reversing entry for{' '}
        <strong className="font-semibold">
          <Money paise={amountPaise} />
        </strong>
        .
      </p>
      <p className="mb-5 text-on-surface-variant">
        Nothing is deleted. The original stays in the history, struck through, with its reversal
        beside it.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1 py-2.5" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" className="flex-1" onClick={onConfirm} disabled={busy}>
          {busy ? 'Voiding...' : 'Void entry'}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Export menu
// ---------------------------------------------------------------------------

/**
 * Export in either format. Both go through the same row-builder (§11.2).
 *
 * Outlined, never filled: export is secondary to entry, and the primary action
 * on any screen carrying this button is recording something new.
 */
export function ExportMenu({ path, label = 'Export' }: { path: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onAway = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onAway);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onAway);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(format: 'xlsx' | 'csv') {
    setBusy(true);
    setError(null);
    setOpen(false);
    try {
      await downloadExport(path, format);
    } catch {
      setError('Export failed. Nothing was downloaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        className="flex items-center gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <Download size={18} aria-hidden="true" />
        {busy ? 'Preparing...' : label}
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-body-md transition-colors hover:bg-surface-container"
            onClick={() => void run('xlsx')}
          >
            <FileSpreadsheet size={18} aria-hidden="true" />
            Excel (.xlsx)
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 border-t border-outline-variant px-3 py-2.5 text-left text-body-md transition-colors hover:bg-surface-container"
            onClick={() => void run('csv')}
          >
            <FileSpreadsheet size={18} aria-hidden="true" />
            CSV
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1 text-body-md text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
