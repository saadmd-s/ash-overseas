/**
 * The design system, as code.
 *
 * Every class string in this file is the canonical one. Screens import these
 * primitives rather than assembling utilities themselves, which is what stops
 * the interface drifting into six slightly different buttons.
 *
 * THE RULE THAT GOVERNS THIS FILE: if a value is not a token, it does not
 * belong in a component. No raw hex, no raw px font sizes, no ad-hoc colours.
 * There are exactly two acknowledged exceptions, both documented at the point
 * of use: the bottom-tab label size and the audit-log JSON size.
 *
 * Radius carries meaning here, applied by role rather than by taste:
 *   rounded-lg (8px)   interactive controls — buttons, inputs, chips
 *   rounded-xl (12px)  containers — cards, lists, modals
 *   rounded-full       identity and status — avatars, pills
 * Applied consistently, radius alone tells you what kind of element you are
 * looking at.
 */

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * A card has NO shadow. It is distinguished by a hairline border plus a
 * lighter surface than the page behind it — depth as tint, not as elevation.
 * That is what keeps the application feeling like a document rather than a
 * stack of floating panels.
 */
export const cardCls = 'rounded-xl border border-outline-variant bg-surface-container-lowest p-5';

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`${cardCls} ${className}`}>{children}</div>;
}

/** The tinted inset panel: summaries, expanded rows, progressive disclosure. */
export const panelCls = 'rounded-lg bg-surface-container-low p-3';

/**
 * The overline. Only ever used with `uppercase` — the token supplies the size,
 * weight and the +0.05em tracking that makes uppercase legible, and the
 * `uppercase` utility is applied here so the pairing cannot be forgotten.
 *
 * This single combination is what visually unifies the form labels, the ledger
 * chips and the section headers: they are all the same 12px letterspaced caps
 * in the same muted grey.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-label-caps uppercase text-on-surface-variant">{children}</h2>;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'filled' | 'outline' | 'destructive' | 'text';

/**
 * Hover on a filled button is `opacity-90`, NOT a different colour. One hover
 * treatment for every filled button means there is no second set of hover
 * tokens to keep in step with the first.
 *
 * Vertical padding is `py-2.5` on top of a text line-height, which lands the
 * control at 44px — the minimum tap target, and the reason this is a padding
 * value rather than a height.
 */
const VARIANT: Record<Variant, string> = {
  filled:
    'rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary ' +
    'transition-opacity hover:opacity-90 disabled:opacity-50',
  outline:
    'rounded-lg border border-outline-variant px-3 py-2 text-label-caps font-semibold ' +
    'transition-colors hover:bg-surface-container disabled:opacity-50',
  destructive:
    'rounded-lg bg-negative px-4 py-2.5 text-label-caps font-semibold text-on-negative ' +
    'transition-opacity hover:opacity-90 disabled:opacity-50',
  text: 'rounded-lg px-2 py-1.5 text-body-md font-medium text-primary transition-colors hover:bg-surface-container disabled:opacity-50',
};

export function Button({
  variant = 'outline',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button type="button" className={`${VARIANT[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/**
 * An icon-only control. `aria-label` is required by the type, not optional —
 * an unnamed icon button is invisible to a screen reader, and making it a
 * required prop is the only way to guarantee it is never forgotten.
 */
export function IconButton({
  label,
  active,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`grid size-10 place-items-center rounded-lg transition-colors ${
        active
          ? 'bg-surface-container text-primary'
          : 'text-on-surface-variant hover:bg-surface-container-low'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * `outline-none` PAIRED WITH `focus:ring-2`. The native outline is replaced,
 * never merely removed — see the note in styles.css.
 */
export const inputCls =
  'w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 ' +
  'outline-none transition-shadow focus:ring-2 focus:ring-primary';

/**
 * A field label wrapping its input.
 *
 * The `<label>` WRAPS rather than using `htmlFor`, so the association cannot be
 * broken by a later refactor that moves the input and forgets the id. Where an
 * explicit id is genuinely needed, `useId()` supplies it and `htmlFor` is set —
 * see `Field` below.
 */
export function Labeled({
  label,
  hint,
  error,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-label-caps uppercase text-on-surface-variant">{label}</span>
      {children}
      {hint && !error && (
        <span className="block text-label-caps text-on-surface-variant">{hint}</span>
      )}
      {error && <span className="block text-body-md text-negative">{error}</span>}
    </label>
  );
}

/**
 * The same pairing where the input needs its own id — because it carries
 * `aria-describedby`, or because a datalist points at it.
 */
export function Field({
  label,
  hint,
  error,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: (props: { id: string; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`space-y-1 ${className}`}>
      <label htmlFor={id} className="block text-label-caps uppercase text-on-surface-variant">
        {label}
      </label>
      {children({ id, describedBy })}
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

// ---------------------------------------------------------------------------
// Chips, avatars, lists
// ---------------------------------------------------------------------------

type ChipTone = 'neutral' | 'negative' | 'primary';

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: 'bg-surface-container text-on-surface-variant',
  negative: 'bg-negative-container text-on-negative-container',
  primary: 'bg-primary-container text-on-primary-container',
};

export function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-label-caps uppercase ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  );
}

/**
 * Deliberately plain: the first two letters, uppercased. No image uploads and
 * no colour hashing — a ledger does not need avatars that look like a contacts
 * app, it needs a stable shape the eye can lock onto down a list.
 */
export function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-container text-body-md font-semibold text-on-primary-container"
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/**
 * `divide-y` on the container plus `overflow-hidden` gives hairline separators
 * that stop cleanly at the rounded corners, with no border under the last row
 * and no `:last-child` handling anywhere.
 */
export const listCls =
  'divide-y divide-outline-variant overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest';

/** Every clickable row is a real `<button>`, never a `<div onClick>`. */
export const rowButtonCls =
  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-container';

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

/**
 * An inset track with the active thumb lifted in white. `rounded-md` inside
 * `rounded-lg` is what makes the thumb sit INSIDE the track rather than on
 * top of it.
 *
 * `tone` exists for one specific reason (§14). The OD / Current bank-account
 * toggle reuses this control, and it must NOT read as a second balance — the
 * bank tag is a tag, it never splits a balance and never changes a posting
 * rule. So it renders in the neutral secondary pair, never in the balance
 * semantics.
 */
export function Segmented<T extends string>({
  legend,
  options,
  value,
  onChange,
  tone = 'primary',
  hint,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  tone?: 'primary' | 'neutral';
  hint?: string;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-label-caps uppercase text-on-surface-variant">{legend}</legend>
      <div
        className={`inline-flex rounded-lg border border-outline-variant p-1 ${
          tone === 'neutral' ? 'bg-secondary-container' : 'bg-surface-container-low'
        }`}
      >
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={`rounded-md px-4 py-1.5 text-body-md font-medium transition-colors ${
                active
                  ? tone === 'neutral'
                    ? 'bg-surface-bright text-on-secondary-container shadow-sm'
                    : 'bg-surface-bright text-primary shadow-sm'
                  : 'text-on-surface-variant'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {hint && <p className="text-label-caps text-on-surface-variant">{hint}</p>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Modal — bottom sheet on mobile, centred dialog from sm up
// ---------------------------------------------------------------------------

/**
 * One component, two presentations. `items-end` + `rounded-t-xl` gives a bottom
 * sheet on a phone; `sm:items-center` + `sm:rounded-xl` gives a centred dialog
 * on a larger screen.
 *
 * `max-h-[92dvh]` with `overflow-y-auto` means a long form scrolls inside the
 * sheet instead of running off-screen — and `dvh` rather than `vh` so it stays
 * correct when a mobile browser collapses its URL bar.
 *
 * Closing is wired three ways: the X, the scrim, and Escape. `busy` disables
 * all three, because a dialog dismissed mid-request leaves the owner with no
 * idea whether the write landed.
 */
export function Modal({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // The scrim closes the modal; a click inside it must not bubble up to
        // that handler, or every button in the sheet would also dismiss it.
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-xl bg-surface-bright p-5 outline-none sm:rounded-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-headline-sm text-on-surface">{title}</h2>
          <IconButton label="Close" onClick={onClose} disabled={busy}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

/**
 * Sits above the mobile tab bar, low on desktop. The container is
 * `pointer-events-none` so a toast can never swallow a tap meant for the page
 * beneath it.
 */
export function Toast({
  message,
  tone = 'success',
  onDone,
}: {
  message: string;
  tone?: 'success' | 'error';
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, [onDone]);

  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 lg:bottom-6">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`flex items-center gap-2 rounded-lg px-4 py-3 text-body-md shadow-lg ${
          tone === 'success' ? 'bg-positive text-on-positive' : 'bg-negative text-on-negative'
        }`}
      >
        <Icon size={18} aria-hidden="true" />
        {message}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three states every list-bearing screen defines
// ---------------------------------------------------------------------------

/** A centred muted sentence — never a skeleton, never a spinner. */
export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="py-8 text-center text-on-surface-variant">
      Loading {what}...
    </p>
  );
}

/**
 * The dashed border is the application's consistent "this is a placeholder,
 * not a thing" signal. Never an illustration, never a cartoon.
 */
export function EmptyState({
  icon,
  message,
  action,
}: {
  icon?: ReactNode;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-outline-variant py-12 text-center text-on-surface-variant">
      {icon}
      <p>{message}</p>
      {action}
    </div>
  );
}

/** An inline banner, for an error that does not replace the whole screen. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-negative-container p-3 text-body-md text-on-negative-container"
    >
      {message}
    </p>
  );
}

/** A whole-screen failure, with the retry that goes with it. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className={`${cardCls} m-4 space-y-3`}>
      <p>{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
