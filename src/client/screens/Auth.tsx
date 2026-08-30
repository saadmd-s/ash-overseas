/**
 * Sign-in, settings and the audit view — SRS §16.1, §14.
 *
 * The login screen is the only thing an unauthenticated visitor can reach that
 * renders at all. Everything below it is behind the gate on the server; drawing
 * it here is a courtesy, never the protection.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, formatInstant, RequestFailed } from '../lib';
import { Empty, ErrorState, Field, Loading } from '../components';

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
    <main className="mx-auto max-w-sm p-4">
      <h1 className="mb-1 text-xl font-semibold">ASH Overseas</h1>
      <p className="mb-4 text-sm text-[var(--color-muted)]">Sign in to open the ledger.</p>

      {!auth.configured && (
        <p className="card mb-4 border-[var(--color-payable)] p-3 text-sm">
          No account has been set up on this deployment yet. The maintainer runs the
          credential-setup script once — see the runbook.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (username && password && !busy) void submit();
        }}
      >
        <Field label="Username">
          {({ id }) => (
            <input
              id={id}
              className="field"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>

        <Field label="Password" error={error ?? undefined}>
          {({ id }) => (
            <input
              id={id}
              className="field"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        <button
          type="submit"
          className="btn btn-primary min-h-tap w-full"
          disabled={!username || !password || busy}
        >
          {/* The wrong-password path waits half a second on purpose (§16.1), so
              the button has to say something during it or the app looks stuck. */}
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </main>
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
    <p className="bg-[var(--color-payable)] p-2 text-center text-xs font-medium text-white">
      Authentication is OFF — development mode. Do not enter real data.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Settings — credential change and sign-out
// ---------------------------------------------------------------------------

export function Settings({ auth, onChanged }: { auth: AuthState; onChanged: () => void }) {
  return (
    <div className="p-3">
      <h1 className="mb-3 text-xl font-semibold">Settings</h1>

      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Signed in as <strong>{auth.username ?? '—'}</strong>
      </p>

      <CredentialForm
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
  title,
  fieldLabel,
  fieldType,
  autoComplete,
  hint,
  path,
  payloadKey,
  onDone,
}: {
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
    <form
      className="card mb-4 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (currentPassword && next && !busy) void submit();
      }}
    >
      <h2 className="mb-2 font-medium">{title}</h2>

      {/* §16.1 — the change routes sit behind the gate AND re-require the
          current password. */}
      <Field label="Current password" error={error ?? undefined}>
        {({ id }) => (
          <input
            id={id}
            className="field"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        )}
      </Field>

      <Field label={fieldLabel} hint={hint}>
        {({ id }) => (
          <input
            id={id}
            className="field"
            type={fieldType}
            autoComplete={autoComplete}
            autoCapitalize="none"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        )}
      </Field>

      <button
        type="submit"
        className="btn min-h-tap w-full"
        disabled={!currentPassword || !next || busy}
      >
        {busy ? 'Saving…' : title}
      </button>

      {done && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Saved. Any other device that was signed in has been signed out.
        </p>
      )}
    </form>
  );
}

function SignOut() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api.post('/api/auth/logout', {});
    } finally {
      // A full reload, not a route change: it clears every screen's state along
      // with the cookie, so nothing stays on screen after signing out.
      window.location.href = '/';
    }
  }

  return (
    <button
      type="button"
      className="btn min-h-tap w-full"
      disabled={busy}
      onClick={() => void signOut()}
    >
      {busy ? 'Signing out…' : 'Sign out'}
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

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ entries: AuditEntry[] }>('/api/audit')
      .then((d) => setEntries(d.entries))
      .catch(() => setError('Could not load the audit log.'));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="p-3">
      <h1 className="mb-1 text-xl font-semibold">Audit log</h1>
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Every create, void, edit and sign-in, newest first. Nothing here can be changed or removed.
      </p>

      {error && <ErrorState message={error} onRetry={load} />}
      {!entries && !error && <Loading what="the audit log" />}
      {entries?.length === 0 && <Empty message="Nothing recorded yet." />}

      {entries && entries.length > 0 && (
        <ul className="card divide-y divide-[var(--color-line)]">
          {entries.map((e) => (
            <li key={e.id} className="p-3">
              <div className="flex justify-between gap-2">
                <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                <span className="text-xs text-[var(--color-muted)]">{formatInstant(e.at)}</span>
              </div>
              <p className="text-sm text-[var(--color-muted)]">
                {e.entity}
                {e.entityId !== null && ` #${e.entityId}`}
              </p>
              {(e.beforeJson ?? e.afterJson) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-[var(--color-muted)]">
                    Details
                  </summary>
                  <pre className="mt-1 overflow-x-auto text-xs">
                    {e.beforeJson && `before ${e.beforeJson}\n`}
                    {e.afterJson && `after  ${e.afterJson}`}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
