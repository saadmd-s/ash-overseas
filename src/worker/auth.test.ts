/**
 * The Phase 3 gate, as a test — SRS §23.
 *
 * "Unauthenticated API requests are rejected; a wrong password is rejected and
 *  throttled; a correct password mints a working session; the §16 checklist is
 *  fully green."
 *
 * Everything here runs against the real Worker in workerd, through SELF, with
 * the real D1 — because the failure this is guarding against is precisely the
 * one that only shows up in the runtime.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/crypto';
import app from './index';
import { DUMMY_PASSWORD_RECORD } from './auth';
import { PBKDF2_ITERATIONS, verifyPassword } from '../auth/crypto';

/**
 * Every concrete /api route the Worker actually registers, read off Hono's own
 * route table rather than written out by hand.
 *
 * A hand-written list only covers the routes someone remembered to add to it,
 * and the failure mode being guarded against here IS forgetting. Adding a route
 * below the gate now needs no change to this file; adding one ABOVE the gate
 * fails it.
 */
const API_ROUTES = (app as unknown as { routes: { path: string; method: string }[] }).routes
  .filter((r) => r.path.startsWith('/api/') && !r.path.includes('*') && r.method !== 'ALL')
  .map((r) => ({ method: r.method, path: r.path.replace(/:[A-Za-z]+/g, '1') }));

/** The three public routes of §14 — the only exceptions there may ever be. */
const PUBLIC = new Set(['GET /api/auth/me', 'POST /api/auth/login', 'POST /api/auth/logout']);

const SECRET = 'test-secret-32-bytes-of-entropy!';
const USERNAME = 'owner';
const PASSWORD = 'a-good-passphrase';

/** Arms the gate for one test. Unset again afterwards, so the rest of the
 *  suite keeps running against the ungated Worker it was written for. */
function armGate() {
  (env as { AUTH_SECRET?: string }).AUTH_SECRET = SECRET;
}

async function seedCredentials(password = PASSWORD) {
  await env.DB.prepare('INSERT INTO app_credentials (username, password_hash) VALUES (?, ?)')
    .bind(USERNAME, await hashPassword(password))
    .run();
}

const url = (path: string) => `https://x${path}`;

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  return SELF.fetch(url(path), {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

const postJson = (path: string, body: unknown, cookie?: string) =>
  req(path, { method: 'POST', body: JSON.stringify(body), cookie });

/** The `name=value` pair from a Set-Cookie, ready to send back. */
function cookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie');
  if (!header) throw new Error('no Set-Cookie on that response');
  return header.split(';')[0];
}

async function login(password = PASSWORD): Promise<string> {
  const res = await postJson('/api/auth/login', { username: USERNAME, password });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return cookieFrom(res);
}

beforeEach(armGate);

afterEach(() => {
  delete (env as { AUTH_SECRET?: string }).AUTH_SECRET;
});

// ---------------------------------------------------------------------------

describe('The gate — no unauthenticated access (§16.3)', () => {
  beforeEach(() => seedCredentials());

  it('finds the route table, so the sweep below is not vacuously passing', () => {
    // If the filter above ever stops matching, every assertion in the next test
    // would run over an empty list and report success.
    expect(API_ROUTES.length).toBeGreaterThan(15);
    expect(API_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'GET /api/dealers',
        'POST /api/transactions',
        'POST /api/transactions/1/void',
        'GET /api/export/balances',
        'GET /api/audit',
      ]),
    );
  });

  it('rejects EVERY registered route but the three public ones', async () => {
    // §16.3: "Every ledger-mutating endpoint is behind the session check. There
    // is no unauthenticated write path." Reads matter just as much — the whole
    // financial position is readable through them.
    for (const { method, path } of API_ROUTES) {
      if (PUBLIC.has(`${method} ${path}`)) continue;

      const res = await req(path, {
        method,
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect(res.status, `${method} ${path} must require a session`).toBe(401);
    }

    // And nothing was written by any of them.
    const { results } = await env.DB.prepare('SELECT count(*) AS n FROM dealers').all<{
      n: number;
    }>();
    expect(results[0].n).toBe(0);
  });

  it('leaves the three public auth routes reachable', async () => {
    expect((await req('/api/auth/me')).status).toBe(200);
    expect((await postJson('/api/auth/logout', {})).status).toBe(200);
    // Login is reachable; the wrong password still fails, which the next block
    // covers.
    expect((await postJson('/api/auth/login', { username: 'x', password: 'y' })).status).toBe(401);
  });

  it('reports an unauthenticated caller honestly', async () => {
    const me = (await (await req('/api/auth/me')).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ authenticated: false, gate: 'enabled', configured: true });
  });
});

// ---------------------------------------------------------------------------

describe('Login (§16.1)', () => {
  beforeEach(() => seedCredentials());

  it('mints a session for the right password', async () => {
    const res = await postJson('/api/auth/login', { username: USERNAME, password: PASSWORD });
    expect(res.status).toBe(200);

    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // §16.1 is explicit: Strict, not Lax. Lax would let a top-level cross-site
    // navigation carry the session.
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    // 30 days.
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it('lets that session through the gate', async () => {
    const cookie = await login();

    const res = await req('/api/dealers', { cookie });
    expect(res.status).toBe(200);

    const me = (await (await req('/api/auth/me', { cookie })).json()) as { username: string };
    expect(me.username).toBe(USERNAME);
  });

  it('rejects a wrong password, and throttles it', async () => {
    const started = Date.now();
    const res = await postJson('/api/auth/login', { username: USERNAME, password: 'wrong' });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    // ~½ second before the 401, so the endpoint cannot be hammered cheaply.
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });

  it('rejects a wrong username with the same message, revealing nothing', async () => {
    const wrongUser = await postJson('/api/auth/login', { username: 'nobody', password: PASSWORD });
    const wrongPass = await postJson('/api/auth/login', { username: USERNAME, password: 'nope' });

    expect(wrongUser.status).toBe(401);
    expect(await wrongUser.json()).toEqual(await wrongPass.json());
  });

  it('refuses a forged cookie', async () => {
    for (const forged of [
      'ash_session=garbage',
      'ash_session=eyJ1Ijoib3duZXIifQ.signature',
      'ash_session=',
    ]) {
      expect((await req('/api/dealers', { cookie: forged })).status).toBe(401);
    }
  });

  it('signs out', async () => {
    const cookie = await login();
    const res = await postJson('/api/auth/logout', {}, cookie);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

// ---------------------------------------------------------------------------

describe('Credential change (§16.1)', () => {
  beforeEach(() => seedCredentials());

  it('re-requires the current password', async () => {
    const cookie = await login();
    const res = await postJson(
      '/api/auth/change-password',
      { currentPassword: 'not-it', newPassword: 'a-new-passphrase' },
      cookie,
    );
    expect(res.status).toBe(401);
  });

  it('changes the password and keeps the current session working', async () => {
    const cookie = await login();
    const res = await postJson(
      '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'a-new-passphrase' },
      cookie,
    );
    expect(res.status).toBe(200);

    // The response carries a freshly minted cookie, so the owner is not signed
    // out by their own password change.
    const refreshed = cookieFrom(res);
    expect((await req('/api/dealers', { cookie: refreshed })).status).toBe(200);

    // And the new password is what logs in from now on.
    expect(
      (await postJson('/api/auth/login', { username: USERNAME, password: PASSWORD })).status,
    ).toBe(401);
    expect(
      (await postJson('/api/auth/login', { username: USERNAME, password: 'a-new-passphrase' }))
        .status,
    ).toBe(200);
  });

  it('revokes sessions held elsewhere', async () => {
    // A second device — or a cookie copied off a stolen phone. §16.5 puts that
    // out of the threat model with only expiry and sign-out as mitigations, and
    // sign-out cannot reach a cookie someone else is holding. A password change
    // can, and this is the assertion that keeps it doing so.
    const stolen = await login();
    const mine = await login();

    await postJson(
      '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'a-new-passphrase' },
      mine,
    );

    expect((await req('/api/dealers', { cookie: stolen })).status).toBe(401);
  });

  it('changes the username, re-requiring the current password', async () => {
    const cookie = await login();
    const res = await postJson(
      '/api/auth/change-username',
      { currentPassword: PASSWORD, newUsername: 'ash.owner' },
      cookie,
    );
    expect(res.status).toBe(200);

    expect(
      (await postJson('/api/auth/login', { username: 'ash.owner', password: PASSWORD })).status,
    ).toBe(200);
    expect(
      (await postJson('/api/auth/login', { username: USERNAME, password: PASSWORD })).status,
    ).toBe(401);
  });

  it('rejects a username that is not a username', async () => {
    const cookie = await login();
    for (const newUsername of ['ab', 'has space', 'x'.repeat(40), 'drop; table']) {
      const res = await postJson(
        '/api/auth/change-username',
        { currentPassword: PASSWORD, newUsername },
        cookie,
      );
      expect(res.status, newUsername).toBe(400);
    }
  });

  it('rejects a short new password', async () => {
    const cookie = await login();
    const res = await postJson(
      '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'short' },
      cookie,
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('Audit of authentication (§13, NFR-A1)', () => {
  beforeEach(() => seedCredentials());

  it('records successful logins, failed logins and credential changes', async () => {
    await postJson('/api/auth/login', { username: USERNAME, password: 'wrong' });
    const cookie = await login();
    await postJson(
      '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'a-new-passphrase' },
      cookie,
    );

    const { results } = await env.DB.prepare(
      'SELECT action, after_json FROM audit_log ORDER BY id',
    ).all<{ action: string; after_json: string }>();

    expect(results.map((r) => r.action)).toEqual(['login', 'login', 'credential_change']);
    expect(results[0].after_json).toContain('failed');
    expect(results[1].after_json).toContain('success');

    // No password, hash or salt is ever written to the audit log (§16.3).
    const everything = JSON.stringify(results);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('pbkdf2');
  });

  it('serves the read-only audit view, newest first', async () => {
    const cookie = await login();
    const page = (await (await req('/api/audit', { cookie })).json()) as {
      entries: { action: string; id: number }[];
    };

    expect(page.entries.length).toBeGreaterThan(0);
    // Newest first.
    expect(page.entries[0].id).toBeGreaterThanOrEqual(page.entries[page.entries.length - 1].id);
  });
});

// ---------------------------------------------------------------------------

describe('Security headers — §16.2', () => {
  it('sets all six on an API response', async () => {
    const res = await req('/api/auth/me');

    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    );
  });

  it('sets them on a 401 as well, not only on a success', async () => {
    const res = await req('/api/dealers');
    expect(res.status).toBe(401);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets them on a 404', async () => {
    // The unknown route has to be reached WITH a session: the gate sits ahead
    // of the catch-all, so an unauthenticated caller gets 401 rather than 404
    // and cannot enumerate the route table.
    await seedCredentials();
    const res = await req('/api/no-such-route', { cookie: await login() });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

// ---------------------------------------------------------------------------

describe('CSRF — §16.3', () => {
  beforeEach(() => seedCredentials());

  it('refuses a state-changing request from another origin', async () => {
    const cookie = await login();

    const res = await req('/api/dealers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Injected', type: 'both' }),
      headers: { origin: 'https://evil.example' },
    });

    expect(res.status).toBe(403);
  });

  it('refuses one a browser labels cross-site', async () => {
    const cookie = await login();

    const res = await req('/api/dealers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Injected', type: 'both' }),
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(res.status).toBe(403);
  });

  it('allows a same-origin request', async () => {
    const cookie = await login();

    const res = await req('/api/dealers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Kumar Traders', type: 'both' }),
      headers: { origin: 'https://x', 'sec-fetch-site': 'same-origin' },
    });

    expect(res.status).toBe(201);
  });

  it('refuses before checking the session, so it is not a login oracle', async () => {
    const res = await req('/api/dealers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Injected', type: 'both' }),
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('Gate disabled — local development only (§16.1)', () => {
  beforeEach(() => {
    delete (env as { AUTH_SECRET?: string }).AUTH_SECRET;
  });

  it('lets requests through and says so plainly', async () => {
    expect((await req('/api/dealers')).status).toBe(200);

    const me = (await (await req('/api/auth/me')).json()) as { gate: string };
    expect(me.gate).toBe('disabled');

    const health = (await (await req('/api/health')).json()) as { authGate: string };
    expect(health.authGate).toContain('DISABLED');
  });

  it('still refuses a credential change, which would be a silent write path', async () => {
    const res = await postJson('/api/auth/change-password', {
      currentPassword: 'x',
      newPassword: 'yyyyyyyy',
    });
    expect(res.status).toBe(409);
  });

  it('still sets the security headers', async () => {
    expect((await req('/api/health')).headers.get('x-frame-options')).toBe('DENY');
  });
});

// ---------------------------------------------------------------------------

describe('Production refuses to serve unprotected — §16.1', () => {
  beforeEach(() => {
    (env as { APP_ENV?: string }).APP_ENV = 'production';
    delete (env as { AUTH_SECRET?: string }).AUTH_SECRET;
  });

  afterEach(() => {
    (env as { APP_ENV?: string }).APP_ENV = 'development';
  });

  it('serves NOTHING at all rather than serving the ledger ungated', async () => {
    // The worst failure this application has is a silently ungated production
    // deploy. A missing secret disables the gate, so production must fail
    // closed — including on the SPA shell, which the assets service would
    // otherwise answer before the Worker ever ran (hence run_worker_first).
    for (const path of ['/api/dealers', '/api/auth/me', '/api/auth/login', '/', '/dealers/1']) {
      const res = await req(path);
      expect(res.status, path).toBe(503);
      expect(await res.text()).toContain('AUTH_SECRET');
    }
  });

  it('serves normally once the secret is present', async () => {
    armGate();
    await seedCredentials();
    expect((await req('/api/auth/me')).status).toBe(200);
  });
});

describe('The wrong-username path costs the same as the wrong-password path', () => {
  /*
   * Short-circuiting on the username would answer a wrong username faster than
   * a wrong password - by a whole PBKDF2 derivation - and hand an attacker the
   * username oracle that the generic "Wrong username or password." message
   * exists to deny. The login route defends against that by verifying against
   * DUMMY_PASSWORD_RECORD when there is no matching credential.
   *
   * A wall-clock comparison would be flaky. What is asserted instead is the
   * property the defence actually rests on: that the dummy record is well
   * formed, so verifyPassword DERIVES rather than bailing out at the format
   * check in microseconds.
   */
  it('uses a dummy record that is well formed enough to cost a real derivation', async () => {
    const [scheme, iterations, salt, hash] = DUMMY_PASSWORD_RECORD.split('$');

    expect(scheme).toBe('pbkdf2');
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
    // Both must decode, or `deriveBits` throws and verifyPassword returns early.
    expect(() => atob(salt)).not.toThrow();
    expect(() => atob(hash)).not.toThrow();
    expect(atob(salt).length).toBe(16);
    expect(atob(hash).length).toBe(32);
  });

  it('accepts no password at all', async () => {
    for (const guess of ['', 'password', PASSWORD, 'a'.repeat(200)]) {
      expect(await verifyPassword(guess, DUMMY_PASSWORD_RECORD)).toBe(false);
    }
  });

  it('answers a login against an unconfigured database identically, and slowly', async () => {
    armGate();
    // No credentials row seeded — the branch that has no real hash to verify.
    const started = Date.now();
    const res = await postJson('/api/auth/login', { username: 'owner', password: 'guess' });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_CREDENTIALS');
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });
});
