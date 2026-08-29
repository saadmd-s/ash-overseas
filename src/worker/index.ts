/**
 * The Worker — Hono API.
 *
 * PHASE 0: scaffold only. One unauthenticated health route so `pnpm dev` and a
 * preview deploy can be verified end to end.
 *
 * Still to come:
 *  - Phase 1: dealer, transaction and payment routes over the posting layer.
 *  - Phase 3: the auth gate (§16.1) in front of everything, and the six
 *    security headers (§16.2) on every response.
 *
 * SRS §16.3: every ledger-mutating endpoint sits behind the session check —
 * there is no unauthenticated write path. Nothing here writes yet.
 */

import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  /** The built SPA. Unmatched paths fall back to index.html. */
  ASSETS: Fetcher;
  /** Signs the session cookie. Unset ⇒ the gate is disabled (§16.1). */
  AUTH_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    phase: 0,
    // Never echo money or dealer details into a response body that could be
    // logged (§16.3). A health check carries neither.
    authGate: c.env.AUTH_SECRET ? 'enabled' : 'DISABLED — local development only',
  }),
);

// An unknown /api path is a JSON 404 — never the SPA shell, which would hand a
// fetch() an HTML body and produce a confusing parse error instead of a clear
// one. Error responses carry a stable `code` (§14).
app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'No such route.' } }, 404));

// Everything else is the SPA. `not_found_handling: single-page-application`
// means the assets binding returns index.html for any path that is not a built
// file, so client-side routes like /dealers/1 resolve (§10.2).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
