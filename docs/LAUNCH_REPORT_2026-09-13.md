# Launch report — ASH Overseas Trading Ledger

**Audited:** 13 Sep 2026 · **Target:** https://ash.ashoverseas.workers.dev (production) and a local build of the same code · **Stack:** Vite + React SPA, Hono Worker on Cloudflare Workers, D1

**Scope:** a private, single-user financial app behind a login. Security, mobile, accessibility and feedback states were in scope. **Search and sharing items were deliberately inverted:** this app should _not_ be indexed, previewed or discoverable, so missing og:image, sitemap, canonical, JSON-LD, analytics, privacy policy and terms are not defects here (see "Not applicable").

## Verdict

**GO** — no P0 is open. The one real P0 (plain http served the login form unencrypted) is fixed and verified on production.

|                        | Found                       | Fixed | Open                                 |
| ---------------------- | --------------------------- | ----- | ------------------------------------ |
| P0 — blocker           | 1 real (+5 false positives) | 1     | 0                                    |
| P1 — before announcing | 7                           | 6     | 1 (extensionless soft 404, accepted) |
| P2 — this week         | 4                           | 4     | 0                                    |
| P3 — backlog           | 3                           | 3     | 0                                    |

---

## Fixed

### Security

- `src/worker/index.ts` — **plain `http://` now 301s to `https://`** in production, path and query kept. Before: http served the app with a 200, so a first visit typed without https could post the password in the clear (HSTS only protects a browser that has already visited over https). Verified live: `http://…/dealers/1?x=1` → `301 https://…/dealers/1?x=1`.
- `src/worker/auth.ts`, `wrangler.jsonc` — **per-IP cap on sign-in attempts** (Cloudflare rate-limit binding, 10/min per IP), checked before any password work; 429 with `Retry-After: 60`. Per IP rather than a global lockout, so nobody can lock the owner out. `scripts/deploy-prod.ts` now refuses a production build without the binding. Verified live: a 180-request burst got 24 × 429. **The limit is approximate** (see Open).
- `src/worker/index.ts` — **requests for files that do not exist are real 404s.** `/.env`, `/.env.local`, `/.git/HEAD`, `/.git/config`, `/db.sqlite`, `/backup.zip`, `/phpinfo.php`, `/.DS_Store` previously returned the app shell with a 200. None of them ever exposed anything (verified: every one was the same 822-byte `index.html`), but every scanner reports that as a leak. Verified live: all 404.
- `package.json` — **drizzle-orm 0.44.7 → 0.45.2** (GHSA-gpj5-g38j-94v9, high, SQL injection via identifiers). Not reachable here — every table and column name is fixed in code — but it was in the request path. `pnpm audit --prod` now clean; 226 tests pass; no schema change.
- `src/worker/auth.ts`, `public/robots.txt`, `index.html` — **kept out of search indexes**: `X-Robots-Tag: noindex, nofollow` on every response, `<meta name="robots">`, and `Disallow: /`. Verified live.

### Accessibility and mobile

- `index.html`, `src/client/ui.tsx`, `components.tsx`, `screens/Auth.tsx` — **pinch-zoom no longer blocked** (was `maximum-scale=1.0`, a WCAG 1.4.4 failure — on an app for an elderly owner). Field text raised 14 → 16px, which is what stops iOS zooming on every field tap, the reason the block was there.
- `src/client/ui.tsx` and 7 screens — **44px minimum touch target** on every button variant, icon button, input, segmented control, menu item, "More options", "Sign out" and the back link. Before: 16 controls per screen measured 20–42px.
- `src/client/AppShell.tsx`, `screens/Home.tsx`, `screens/Auth.tsx` — **exactly one `<h1>` per screen.** Home, the dealer lists and the phone-width login had none; desktop screens had two (the header title was also an h1).
- `src/client/AppShell.tsx` — **skip-to-content link**, first Tab stop, `main` focusable.
- `src/client/AppShell.tsx` — bottom tab labels 11 → 12px; still fits at 360px.
- `src/client/styles.css` — date fields kept their full year at 360px after the 16px change (Chrome was clipping the last digit).
- `public/apple-touch-icon.png` (new, 180×180) — iOS ignores an SVG touch icon, so "Add to Home Screen" had no icon.
- Keyboard focus: tabbed through the dealer page and payment form — every stop shows a visible ring.

### Performance

- `src/worker/index.ts` — content-hashed `/assets/*` now `Cache-Control: public, max-age=31536000, immutable` (was `max-age=0, must-revalidate`, a revalidation round trip per file per load). HTML stays `max-age=0`. Verified live.

### Disclosure

- `src/worker/index.ts` — `/.well-known/security.txt` (RFC 9116) with the maintainer's contact, a rolling `Expires` under a year out, and a canonical URL. Tested in `src/worker/security-txt.test.ts`.

### Content

- `screens/Auth.tsx` — the login panel said "Nothing is ever deleted — corrections are recorded, not erased", contradicting the new **Delete** button. Now "Nothing is ever lost — a deleted entry is kept for your records."

---

## Open — needs a decision

None. **Error alerting was skipped by the owner on 13 Sep 2026.** Cloudflare has no free notification for Worker errors; the free options (a Sentry free-plan project, or an in-app error notice) remain available if wanted later. Worker logs are on in the meantime.

---

## Open — found, not fixed

| Severity | Finding                                                                                        | Why not fixed                                                                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | An unknown app-style URL (`/nope`, `/server-status`) returns the app shell with 200 (soft 404) | The client already falls back to Home for a mistyped route. Returning 404 would mean duplicating the client route table in the Worker, which can drift. For a private, noindexed app the SEO cost of a soft 404 is nil. File-like paths _are_ now real 404s.                                                  |
| —        | The login rate limit is approximate                                                            | Cloudflare documents the binding as "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system", counted per location. Measured: 24 of 180 burst requests refused. It stops a flood; the ½-second delay, PBKDF2 and the audit trail still carry the rest. |
| P2       | 2 dev-only advisories: `sharp` (inside Miniflare) and `esbuild` (inside the Vite dev server)   | Neither ships to production or runs in the request path. They clear when wrangler/vite release updates.                                                                                                                                                                                                       |

**Scanner findings confirmed as false positives:** the five P0 "exposed paths" (app shell, not files — now 404 anyway); "no compression" (production serves brotli, verified); "focus outline removed" (verified visible by tabbing); "js-heavy 545 KB" (only the main bundle loads on first view, 82 KB brotli; the Excel library loads only on download); "secret assignment in `auth.test.ts`" (a test fixture password); "AUTH_SECRET in the client bundle" (the words, in a dev-mode help message); "30 console calls" (README, scripts and tests — none in shipped code); "hardcoded copyright year" (inside generated Cloudflare type definitions); "layout wider than device at 1280" (headless-browser screen size).

## Not applicable (private, single-user app)

og:image, Open Graph and Twitter cards, sitemap.xml, canonical, JSON-LD, llms.txt, analytics, privacy policy, terms, cookie consent, spam protection on public forms (there are none — the only unauthenticated form is the login, which is rate-limited), LICENSE. If the app ever becomes multi-user or public, revisit these.

---

## Not tested

- **A real phone.** Every screen was checked at 360, 375, 768 and 1280px in headless Chrome, not on a device. One-handed use, touch feel, the iOS keyboard and Safari's date picker need a real phone.
- **Screen reader.** Headings, labels and landmarks were checked automatically; a five-minute TalkBack or VoiceOver pass was not done.
- **Excel/CSV downloads saving under the production CSP** and **the PWA installing and loading offline** — both need a real browser session signed in to production (RUNBOOK §Checks that still need a real browser).
- **Signed-in production screens.** The probe ran on the live login page; signed-in screens were probed on a local build of the same commit, because I do not hold the owner's password.
- **Restore drill against `ledger-prod`** — still waiting for real entries (CLAUDE.md, What is NOT done).

---

## After deploy

1. `curl -sI http://ash.ashoverseas.workers.dev` → expect `301` to https. _(done)_
2. `curl -s https://ash.ashoverseas.workers.dev/robots.txt` → `Disallow: /` — correct for this app. _(done)_
3. `curl -so /dev/null -w "%{http_code}" https://ash.ashoverseas.workers.dev/.env` → `404`. _(done)_
4. Sign in on the owner's phone, record one entry, download it as Excel, and add the app to the home screen.
