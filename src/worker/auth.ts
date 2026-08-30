/**
 * The auth gate — SRS §16.1, §16.2, §16.3.
 *
 * Three pieces, in the order a request meets them:
 *
 *   securityHeaders  the six §16.2 headers, on every response including assets
 *   csrfGuard        Origin / Sec-Fetch-Site on state-changing routes (§16.3)
 *   requireSession   the gate itself, in front of every /api route but the
 *                    three public auth routes (§14)
 *
 * Credentials live in D1, not in env secrets, so the owner can change them from
 * inside the application: a Worker cannot rewrite its own secrets, but it can
 * write to its database (§16.1).
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../db/schema';
import { makeDb } from '../posting/post';
import type { Db } from '../posting/db';
import {
  hashPassword,
  SESSION_TTL_SECONDS,
  signSession,
  verifyPassword,
  verifySession,
} from '../auth/crypto';
import { fail, flatten } from './http';
import type { Env } from './index';

export const SESSION_COOKIE = 'ash_session';

/** The deliberate delay before a wrong login's 401 (§16.1). */
const WRONG_PASSWORD_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Layer 2 — transport and headers (§16.2)
// ---------------------------------------------------------------------------

/**
 * Verbatim from §16.2. No inline scripts anywhere, so the CSP needs no nonce or
 * hash; no CDN assets, which is why §18 specifies self-hosted Inter.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':
    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();

  // A Response returned by the ASSETS binding has immutable headers, so the
  // headers cannot simply be set on it. Rewrapping gives a mutable copy and
  // costs nothing — the body is passed through by reference, not buffered.
  c.res = new Response(c.res.body, c.res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
};

// ---------------------------------------------------------------------------
// Layer 3 — CSRF (§16.3)
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reject a state-changing request that a browser tells us came from another
 * site.
 *
 * The rule is "reject a header that disagrees", not "require a header". Every
 * browser capable of mounting a CSRF attack sends `Origin` on a cross-site
 * POST — that is what makes the check work. A request with neither header is
 * not a browser doing cross-site form submission; it is curl, or the test
 * runner, and rejecting it would buy nothing while breaking both. The
 * `SameSite=Strict` cookie is the second line under this one (§16.1).
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return c.json(fail('CSRF_REJECTED', 'That request did not come from this application.'), 403);
  }

  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json(fail('CSRF_REJECTED', 'That request did not come from this application.'), 403);
  }

  return next();
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface Credentials {
  id: number;
  username: string;
  passwordHash: string;
  updatedAt: Date;
}

async function loadCredentials(db: Db): Promise<Credentials | null> {
  // Exactly one row is expected (§13). Newest wins if a recovery script ever
  // leaves two behind, so re-running the setup script cannot lock the owner out.
  const rows = await db
    .select()
    .from(schema.appCredentials)
    .orderBy(desc(schema.appCredentials.updatedAt), desc(schema.appCredentials.id))
    .limit(1);
  return rows[0] ?? null;
}

/** The `v` claim: a session stops verifying the moment credentials change. */
const credentialVersion = (creds: Credentials) => Math.floor(creds.updatedAt.getTime() / 1000);

// ---------------------------------------------------------------------------
// Layer 1 — the gate (§16.1)
// ---------------------------------------------------------------------------

/**
 * Whether the gate is armed at all.
 *
 * `AUTH_SECRET` unset ⇒ DISABLED. That is a local-development convenience and
 * nothing else; `index.ts` refuses to serve a production build without it, so
 * this can never be the state of a deployed Worker.
 */
export const gateEnabled = (env: Env): boolean => !!env.AUTH_SECRET;

/** The verified session for this request, or null. */
export async function readSession(
  c: Context<{ Bindings: Env }>,
): Promise<{ username: string } | null> {
  const secret = c.env.AUTH_SECRET;
  if (!secret) return null;

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const payload = await verifySession(token, secret);
  if (!payload) return null;

  const creds = await loadCredentials(makeDb(c.env.DB));
  if (!creds || payload.v !== credentialVersion(creds)) return null;

  return { username: payload.u };
}

/**
 * The gate. Everything behind it is 401 without a valid session.
 *
 * There is no unauthenticated write path (§16.3): this sits in front of the
 * whole `/api` surface, and the three public auth routes are mounted ahead of
 * it rather than excepted from within it — an exception list is the kind of
 * thing a later route quietly falls off.
 */
export const requireSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!gateEnabled(c.env)) return next();

  const session = await readSession(c);
  if (!session) {
    return c.json(fail('UNAUTHENTICATED', 'Please sign in.'), 401);
  }
  return next();
};

async function mintSession(c: Context<{ Bindings: Env }>, creds: Credentials): Promise<void> {
  const token = await signSession(
    {
      u: creds.username,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      v: credentialVersion(creds),
    },
    c.env.AUTH_SECRET as string,
  );

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict', // §16.1 — Strict, never Lax
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Append-only audit of who got in and who did not (§13, NFR-A1). */
async function auditAuth(db: Db, action: 'login' | 'credential_change', detail: unknown) {
  // The password itself never appears here — §16.3, the audit log stores no
  // secrets.
  await db.insert(schema.auditLog).values({
    action,
    entity: 'app_credentials',
    entityId: null,
    beforeJson: null,
    afterJson: JSON.stringify(detail),
  });
}

// ---------------------------------------------------------------------------
// Routes — §14
// ---------------------------------------------------------------------------

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, underscore and hyphen only.');

// Long enough to matter, short enough that PBKDF2 cannot be turned into a
// denial-of-service by posting a megabyte of "password".
const passwordSchema = z.string().min(8).max(200);

const loginSchema = z.object({ username: z.string().max(200), password: z.string().max(200) });
const changePasswordSchema = z.object({
  currentPassword: z.string().max(200),
  newPassword: passwordSchema,
});
const changeUsernameSchema = z.object({
  currentPassword: z.string().max(200),
  newUsername: usernameSchema,
});

/** Public: login, me, logout. Mounted BEFORE the gate. */
export const publicAuth = new Hono<{ Bindings: Env }>();

publicAuth.get('/auth/me', async (c) => {
  if (!gateEnabled(c.env)) {
    // Honest about the state rather than pretending to be signed in: the client
    // shows a standing warning banner when it sees this.
    return c.json({ authenticated: true, gate: 'disabled', username: null, configured: false });
  }

  const session = await readSession(c);
  const configured = !!(await loadCredentials(makeDb(c.env.DB)));

  return c.json({
    authenticated: !!session,
    gate: 'enabled',
    username: session?.username ?? null,
    // No credentials row yet means the setup script has not been run (§19.2
    // step 7). Saying so is not a leak: it reveals nothing an unauthenticated
    // caller could not learn by failing to log in.
    configured,
  });
});

publicAuth.post('/auth/login', async (c) => {
  if (!gateEnabled(c.env)) return c.json({ ok: true, gate: 'disabled' });

  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    await sleep(WRONG_PASSWORD_DELAY_MS);
    return c.json(fail('BAD_CREDENTIALS', 'Wrong username or password.'), 401);
  }

  const db = makeDb(c.env.DB);
  const creds = await loadCredentials(db);

  // The same generic message and the same delay whether the username was wrong,
  // the password was wrong, or no credentials exist at all. A distinguishable
  // response would let an attacker confirm the username before starting on the
  // password.
  const ok =
    creds !== null &&
    creds.username === parsed.data.username &&
    (await verifyPassword(parsed.data.password, creds.passwordHash));

  if (!ok || !creds) {
    await auditAuth(db, 'login', { result: 'failed' });
    await sleep(WRONG_PASSWORD_DELAY_MS);
    return c.json(fail('BAD_CREDENTIALS', 'Wrong username or password.'), 401);
  }

  await mintSession(c, creds);
  await auditAuth(db, 'login', { result: 'success' });
  return c.json({ ok: true, username: creds.username });
});

publicAuth.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, sameSite: 'Strict' });
  return c.json({ ok: true });
});

/** Behind the gate: credential change. Mounted after `requireSession`. */
export const privateAuth = new Hono<{ Bindings: Env }>();

/**
 * Both change routes re-require the current password (§16.1) and both rewrite
 * `updated_at`, which invalidates every session in existence — including this
 * one. A fresh cookie is minted in the same response so the owner is not signed
 * out by their own password change, while a cookie copied off the device stops
 * working immediately.
 */
async function applyCredentialChange(
  c: Context<{ Bindings: Env }>,
  currentPassword: string,
  patch: { username?: string; passwordHash?: string },
  what: 'password' | 'username',
) {
  const db = makeDb(c.env.DB);
  const creds = await loadCredentials(db);

  if (!creds || !(await verifyPassword(currentPassword, creds.passwordHash))) {
    await sleep(WRONG_PASSWORD_DELAY_MS);
    return c.json(fail('BAD_CREDENTIALS', 'That is not the current password.'), 401);
  }

  // A second-resolution `updated_at` would collide with the existing row if the
  // owner changed both within the same second, leaving the old session valid.
  // Stepping past the current version guarantees the change actually revokes.
  const now = new Date(Math.max(Date.now(), creds.updatedAt.getTime() + 1000));

  await db
    .update(schema.appCredentials)
    .set({ ...patch, updatedAt: now })
    .where(eq(schema.appCredentials.id, creds.id));

  const updated: Credentials = { ...creds, ...patch, updatedAt: now };
  await mintSession(c, updated);
  await auditAuth(db, 'credential_change', { changed: what });

  return c.json({ ok: true, username: updated.username });
}

privateAuth.post('/auth/change-password', async (c) => {
  if (!gateEnabled(c.env)) return c.json(fail('GATE_DISABLED', 'Authentication is off.'), 409);

  const parsed = changePasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(fail('VALIDATION_FAILED', 'Check the details.', flatten(parsed.error)), 400);
  }

  return applyCredentialChange(
    c,
    parsed.data.currentPassword,
    { passwordHash: await hashPassword(parsed.data.newPassword) },
    'password',
  );
});

privateAuth.post('/auth/change-username', async (c) => {
  if (!gateEnabled(c.env)) return c.json(fail('GATE_DISABLED', 'Authentication is off.'), 409);

  const parsed = changeUsernameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(fail('VALIDATION_FAILED', 'Check the details.', flatten(parsed.error)), 400);
  }

  return applyCredentialChange(
    c,
    parsed.data.currentPassword,
    { username: parsed.data.newUsername },
    'username',
  );
});
