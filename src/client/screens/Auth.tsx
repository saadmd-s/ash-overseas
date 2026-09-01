/**
 * Sign-in, account settings and the audit view — SRS §16.1, §14.
 *
 * The login screen is the only thing an unauthenticated visitor can reach that
 * renders at all, and the only page outside the application shell. Everything
 * below it is behind the gate on the server; drawing it here is a courtesy,
 * never the protection.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  KeyRound,
  Landmark,
  Lock,
  LogOut,
  ScrollText,
  User,
  UserCog,
} from 'lucide-react';
import { api, formatInstant, RequestFailed } from '../lib';
import { Card, Chip, EmptyState, ErrorState, Loading, listCls } from '../ui';

export interface AuthState {
  authenticated: boolean;
  gate: 'enabled' | 'disabled';
  username: string | null;
  configured: boolean;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function Login({ auth, onSignedIn }: { auth: AuthState; onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { username, password });
      // Never keep the password in component state a moment longer than the
      // request needs it.
      setPassword('');
      onSignedIn();
    } catch (e) {
      setError(e instanceof RequestFailed ? e.detail.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* The brand panel. On mobile everything but the lockup is hidden,
          collapsing it to a compact branded header. */}
      <div className="relative overflow-hidden bg-primary p-6 lg:flex lg:flex-col lg:justify-between lg:p-10">
        {/*
          THE ONE DECORATIVE ELEMENT IN THE ENTIRE APPLICATION: a soft glow
          bleeding off the corner. `pointer-events-none` so it can never
          intercept a click on the form beside it.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-on-primary/5 blur-2xl"
        />

        <div className="relative flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 shrink-0 place-items-center rounded-xl bg-on-primary/10 text-on-primary ring-1 ring-on-primary/15"
          >
            <Landmark size={24} />
          </span>
          <span>
            <span className="block text-headline-sm text-on-primary">ASH Overseas</span>
            <span className="block text-label-caps uppercase text-on-primary/60">
              Trading ledger
            </span>
          </span>
        </div>

        <div className="relative hidden lg:block">
          <h1 className="text-display-lg text-on-primary">Your ledger, always in balance.</h1>
          <p className="mt-3 max-w-sm text-body-lg text-on-primary/70">
            One running balance for every dealer, in plain language. Nothing is ever deleted —
            corrections are recorded, not erased.
          </p>
        </div>

        <p className="relative hidden text-label-caps uppercase text-on-primary/40 lg:block">
          Authorised access only
        </p>
      </div>

      {/* The form panel. */}
      <div className="flex items-center justify-center bg-surface p-6">
        <form
          className="w-full max-w-sm space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (username && password && !busy) void submit();
          }}
        >
          <div>
            <h2 className="text-headline-md text-on-surface">Sign in</h2>
            <p className="text-body-md text-on-surface-variant">Sign in to open the ledger.</p>
          </div>

          {!auth.configured && (
            <p className="rounded-lg bg-negative-container p-3 text-body-md text-on-negative-container">
              No account has been set up on this deployment yet. The maintainer runs the
              credential-setup script once — see the runbook.
            </p>
          )}

          <IconField
            label="Username"
            icon={<User size={18} aria-hidden="true" />}
            type="text"
            autoComplete="username"
            value={username}
            onChange={setUsername}
          />

          <IconField
            label="Password"
            icon={<Lock size={18} aria-hidden="true" />}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={error ?? undefined}
          />

          <button
            type="submit"
            disabled={!username || !password || busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {/* The wrong-password path waits half a second on purpose (§16.1),
                so the button has to say something during it or the application
                looks stuck. */}
            {busy ? 'Signing in...' : 'Sign in'}
            {!busy && <ArrowRight size={18} aria-hidden="true" />}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * A credential field with its icon inside the border.
 *
 * These sit on `surface-bright` rather than `surface-container-lowest`, which
 * makes them stand forward against the soft-white page. The Account screen uses
 * the same treatment, because both are credential entry and should feel like
 * the same act.
 */
function IconField({
  label,
  icon,
  type,
  autoComplete,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  icon: React.ReactNode;
  type: 'text' | 'password';
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-label-caps uppercase text-on-surface-variant">{label}</span>
      <span className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-bright px-3 transition-shadow focus-within:ring-2 focus-within:ring-primary">
        <span className="text-on-surface-variant">{icon}</span>
        <input
          className="w-full bg-transparent py-2.5 outline-none"
          type={type}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
      {hint && !error && (
        <span className="block text-label-caps text-on-surface-variant">{hint}</span>
      )}
      {error && (
        <span role="alert" className="block text-body-md text-negative">
          {error}
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// The standing warning when the gate is off
// ---------------------------------------------------------------------------

/**
 * §16.1 allows an unset `AUTH_SECRET` as a local-development convenience, and
 * production refuses to serve without it. Between those two is a laptop with
 * real data on it, so the state is never silent.
 */
export function GateDisabledBanner() {
  return (
    <p className="flex items-center justify-center gap-2 bg-negative px-3 py-2 text-center text-label-caps uppercase text-on-negative">
      <AlertTriangle size={18} aria-hidden="true" />
      Authentication is OFF — development mode. Do not enter real data.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Account — credential change and sign-out
// ---------------------------------------------------------------------------

/**
 * `max-w-xl` — the only constrained measure in the application, because this is
 * a settings form and a full-width text field at 1440px is unusable.
 */
export function Settings({ auth, onChanged }: { auth: AuthState; onChanged: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-headline-md text-primary">Account</h1>
        <p className="text-body-md text-on-surface-variant">
          Signed in as <strong className="font-semibold">{auth.username ?? '—'}</strong>
        </p>
      </div>

      {auth.gate === 'disabled' && (
        <div className="flex items-start gap-2 rounded-lg bg-surface-container-low p-3 text-body-md">
          <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-negative" />
          <p>
            <code className="font-mono">AUTH_SECRET</code> is not set, so the sign-in gate is
            disabled. This is a local-development convenience only — production refuses to serve
            without it.
          </p>
        </div>
      )}

      <CredentialForm
        icon={<KeyRound size={20} aria-hidden="true" />}
        title="Change password"
        fieldLabel="New password"
        fieldType="password"
        autoComplete="new-password"
        hint="At least 8 characters."
        path="/api/auth/change-password"
        payloadKey="newPassword"
        onDone={onChanged}
      />

      <CredentialForm
        icon={<UserCog size={20} aria-hidden="true" />}
        title="Change username"
        fieldLabel="New username"
        fieldType="text"
        autoComplete="username"
        hint="Letters, digits, dot, underscore and hyphen. 3–32 characters."
        path="/api/auth/change-username"
        payloadKey="newUsername"
        onDone={onChanged}
      />

      <SignOut />
    </div>
  );
}

function CredentialForm({
  icon,
  title,
  fieldLabel,
  fieldType,
  autoComplete,
  hint,
  path,
  payloadKey,
  onDone,
}: {
  icon: React.ReactNode;
  title: string;
  fieldLabel: string;
  fieldType: 'password' | 'text';
  autoComplete: string;
  hint: string;
  path: string;
  payloadKey: 'newPassword' | 'newUsername';
  onDone: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, { currentPassword, [payloadKey]: next });
      setCurrentPassword('');
      setNext('');
      setDone(true);
      onDone();
    } catch (e) {
      setError(e instanceof RequestFailed ? e.detail.message : 'Could not save that change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (currentPassword && next && !busy) void submit();
        }}
      >
        <h2 className="flex items-center gap-2 text-headline-sm text-on-surface">
          {icon}
          {title}
        </h2>

        {/* §16.1 — the change routes sit behind the gate AND re-require the
            current password. The field is simply always there: a security
            decision made visible in the design. */}
        <IconField
          label="Current password"
          icon={<Lock size={18} aria-hidden="true" />}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={error ?? undefined}
        />

        <IconField
          label={fieldLabel}
          icon={fieldType === 'password' ? <KeyRound size={18} /> : <User size={18} />}
          type={fieldType}
          autoComplete={autoComplete}
          value={next}
          onChange={setNext}
          hint={hint}
        />

        <button
          type="submit"
          disabled={!currentPassword || !next || busy}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Saving...' : title}
        </button>

        {done && (
          <p className="text-body-md text-on-surface-variant">
            Saved. Any other device that was signed in has been signed out.
          </p>
        )}
      </form>
    </Card>
  );
}

/** A full reload, not a route change: it clears every screen's state along with
 *  the cookie, so nothing stays on screen after signing out. */
export async function signOut(): Promise<void> {
  try {
    await api.post('/api/auth/logout', {});
  } finally {
    window.location.href = '/';
  }
}

function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    // A text link, not a button — deliberately understated so it is never hit
    // by accident on the way past.
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut();
      }}
      className="flex items-center gap-2 text-body-md font-medium text-negative disabled:opacity-50"
    >
      <LogOut size={18} aria-hidden="true" />
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Audit view — §14, NFR-A1
// ---------------------------------------------------------------------------

interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entityId: number | null;
  beforeJson: string | null;
  afterJson: string | null;
  at: string;
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  void: 'Voided',
  edit: 'Edited',
  login: 'Sign-in',
  credential_change: 'Credentials changed',
};

/** Read-only. There is no route anywhere that edits or deletes an audit row. */
export function AuditView() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ entries: AuditEntry[] }>('/api/audit')
      .then((d) => setEntries(d.entries))
      .catch(() => setError('Could not load the audit log.'));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-headline-md text-primary">
          <ScrollText size={22} aria-hidden="true" />
          Audit log
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Every create, void, edit and sign-in, newest first. Nothing here can be changed or
          removed.
        </p>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!entries && !error && <Loading what="the audit log" />}
      {entries?.length === 0 && (
        <EmptyState
          icon={<ScrollText size={28} aria-hidden="true" />}
          message="Nothing recorded yet."
        />
      )}

      {entries && entries.length > 0 && (
        <ul className={listCls}>
          {entries.map((e) => {
            const expanded = open === e.id;
            const hasDetail = Boolean(e.beforeJson ?? e.afterJson);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  disabled={!hasDetail}
                  aria-expanded={hasDetail ? expanded : undefined}
                  onClick={() => setOpen(expanded ? null : e.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-container disabled:hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Chip tone={e.action === 'void' ? 'negative' : 'neutral'}>
                        {ACTION_LABEL[e.action] ?? e.action}
                      </Chip>
                      <span className="truncate text-body-md">
                        {e.entity}
                        {e.entityId !== null && ` #${e.entityId}`}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-label-caps uppercase text-on-surface-variant">
                    {formatInstant(e.at)}
                  </span>
                  {hasDetail && (
                    <ChevronDown
                      size={18}
                      aria-hidden="true"
                      className={`shrink-0 text-on-surface-variant transition-transform ${
                        expanded ? 'rotate-180' : ''
                      }`}
                    />
                  )}
                </button>

                {expanded && hasDetail && (
                  <div className="grid gap-3 border-t border-outline-variant bg-surface-container-low p-4 sm:grid-cols-2">
                    <JsonBlock title="Before" json={e.beforeJson} />
                    <JsonBlock title="After" json={e.afterJson} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function JsonBlock({ title, json }: { title: string; json: string | null }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-label-caps uppercase text-on-surface-variant">{title}</p>
      {/*
        ACKNOWLEDGED EXCEPTION to the "no raw sizes" rule, the second of two in
        the application: JSON at 14px wraps badly on a phone. `overflow-x-auto`
        keeps a wide object scrolling inside its own box rather than breaking
        the page.
      */}
      <pre className="overflow-x-auto rounded-lg bg-surface-container-lowest p-2 text-[12px] leading-4">
        {json ? pretty(json) : '—'}
      </pre>
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // An audit row is never rewritten to make it parse. If it is not JSON,
    // show exactly what was stored.
    return json;
  }
}
