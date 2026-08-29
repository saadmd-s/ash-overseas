# Technical Requirements Document

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Derived from [SRS.md](../SRS.md)

> **[SRS.md](../SRS.md) is authoritative.** This document translates it into
> engineering decisions. Where they disagree, the SRS wins.
>
> **The SRS is now complete** (transcribed in full, 29 Aug 2026). This document
> has been reconciled against §15.5–§23 and both appendices. Where it previously
> carried derived guesses, it now carries the spec's actual answers.

---

## 1. Scope

A single-user, private web application on Cloudflare Workers with a D1 database,
maintaining one signed running balance per dealer and exporting to Excel.

The engineering problem is narrow but unforgiving: **the numbers must be exactly
right, and no partial write may ever exist.** Everything below serves those two
constraints.

## 2. Architectural Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser (mobile-first PWA)                             │
│                                                          │
│  React SPA ──┬── MoneyInput  (rupee text → integer paise)│
│              ├── formatPaise (paise → ₹ display)         │
│              └── export/    (SheetJS + CSV, shared       │
│                              row-builder)                │
└───────────────────────┬─────────────────────────────────┘
                        │  JSON over fetch, session cookie
                        │  ALL money as integer paise
┌───────────────────────▼─────────────────────────────────┐
│  Cloudflare Worker                                       │
│                                                          │
│  routes/       Zod validation at every boundary          │
│      │                                                   │
│      ▼                                                   │
│  posting/      Posting layer — builds db.batch([...])    │
│      │                                                   │
│      ▼                                                   │
│  ledger/       PURE ENGINE — no DB imports               │
│  money/        PURE MONEY MATH — sole owner of paise     │
│      │                                                   │
│      ▼                                                   │
│  db/           Drizzle schema + queries                  │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Cloudflare D1 (SQLite)                                  │
└─────────────────────────────────────────────────────────┘
```

The two innermost modules — `money/` and `ledger/` — are pure, dependency-free,
and directly unit-testable. The §6 acceptance scenarios exercise them without a
database. This is the single most important structural decision in the codebase.

## 3. Technology Stack

> **CONFIRMED by SRS §18: Vite + React (TypeScript, strict) + Hono on Workers.**
> The owner's 29 Aug decision matched the spec exactly, including the reasoning —
> §18 rejects Next.js because `@cloudflare/next-on-pages` is deprecated and must
> not be used, and the supported OpenNext-on-Workers path adds an adapter and
> build pipeline this application does not need.

### 3.1 Vite + React + Hono on Workers

| Layer           | Choice                                                           | Rationale                                                            |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Runtime         | Cloudflare Workers                                               | Stated in SRS §13 (D1 binding), §11.2 (Worker CPU budget)            |
| Database        | Cloudflare D1 (SQLite)                                           | Stated, SRS §13                                                      |
| ORM             | Drizzle                                                          | Stated, SRS §13, with `drizzle-kit generate`                         |
| API framework   | Hono                                                             | Minimal, Workers-native, tiny CPU and bundle cost                    |
| Frontend        | Vite + React (SPA)                                               | Client-rendered; no SEO need; keeps the Worker thin                  |
| Validation      | Zod                                                              | Stated, SRS §10.9, §14                                               |
| Export          | SheetJS (`xlsx`), client-side                                    | Stated, SRS §11.2                                                    |
| Tests           | Vitest + `@cloudflare/vitest-pool-workers`                       | Runs integration tests against real D1 semantics                     |
| Styling         | Tailwind CSS v4, tokens in one `@theme` block                    | §18 — tokens are the single source of truth, no hard-coded hex or px |
| Icons / fonts   | `lucide-react`; self-hosted Inter (`@fontsource-variable/inter`) | §18 — no CDN, the CSP forbids it                                     |
| Package manager | pnpm, lockfile committed, version pinned in `packageManager`     | §18                                                                  |
| CI              | GitHub Actions: typecheck, lint, test, build, `pnpm audit`       | §18, §20                                                             |

**Why not Next.js (§18).** The deprecated `@cloudflare/next-on-pages` path must
not be used, and the supported OpenNext-on-Workers path adds an adapter and a
build pipeline this application does not need. A Vite SPA plus a Hono API is
materially simpler to run, to test, and to hand to a maintainer.

**No E2E framework is specified.** §20's test surface is Vitest for the pure
engine and `@cloudflare/vitest-pool-workers` for D1-backed integration, with the
Phase 2 gate verified by hand on a 360 px phone. Adding Playwright would be an
extension beyond the spec — reasonable, but a scope decision, not an assumption.

`money/`, `ledger/`, and `posting/` are framework-agnostic by construction, so
this decision reaches only the routing layer and the build config.

### 3.2 Repository Layout

```
/
├── SRS.md                     authoritative specification
├── CLAUDE.md                  developer rules summary
├── docs/                      this documentation set
├── src/
│   ├── money/                 PURE: paise arithmetic (Appendix B)
│   │   ├── index.ts
│   │   └── money.test.ts
│   ├── ledger/                PURE: posting decisions, replay
│   │   ├── engine.ts
│   │   ├── replay.ts
│   │   └── scenarios.test.ts  the §6 acceptance tests
│   ├── posting/               DB writes via db.batch
│   ├── db/
│   │   ├── schema.ts          Drizzle (SRS §13, verbatim)
│   │   └── queries.ts
│   ├── routes/                Hono routes + Zod schemas
│   ├── auth/                  pbkdf2, sessions, CSRF checks
│   └── client/                React app
│       ├── components/        MoneyInput, BalanceHeadline, …
│       ├── screens/
│       ├── format/            formatPaise, formatDate
│       └── export/            shared row-builder → xlsx | csv
├── drizzle/migrations/        generated SQL, committed, never hand-edited
└── wrangler.jsonc
```

## 4. Module Contracts

### 4.1 `money/` — the sole owner of paise arithmetic

**No `*`, `/`, or `Math.round` on a monetary value exists anywhere else in the
codebase.** This is enforced by review and by a lint rule.

> **SRS Appendix B is the reference implementation and is authoritative.** The
> signatures below are transcribed from it, not derived. Implement it verbatim.

```ts
type Paise = number; // integer, exact below 2^53 (≈ ₹90 trillion)

/** The only rounding primitive. Math.sign(v) * Math.round(Math.abs(v)). */
function roundPaise(value: number): Paise;

/** To the nearest whole rupee, returned in paise: roundPaise(paise/100)*100. */
function roundToRupee(paise: Paise): Paise;

/** A line's amount: quantity may be fractional, rate is integer paise. */
function lineAmount(quantity: number, ratePaise: Paise): Paise;

/** GST on a taxable amount, at a percentage rate. */
function gstAmount(taxablePaise: Paise, gstRate: number): Paise;

/** The full transaction total, exactly as posted to the ledger. */
function transactionTotals(input: {
  linesPaise: Paise[]; // NOTE: already-computed line amounts, not quantity/rate pairs
  discountPaise: Paise;
  freightPaise: Paise;
  gstRate: number;
}): {
  baseTotalPaise: Paise;
  taxablePaise: Paise;
  gstAmountPaise: Paise;
  roundOffPaise: Paise; // may be negative
  grandTotalPaise: Paise;
}; // NOTE: rawTotalPaise is internal, not returned

/** Display only. Formats from paise so no float artefact can appear. */
function formatPaise(paise: Paise): string;

/** The plain-language headline. Never shows a bare sign. */
function balanceHeadline(paise: Paise, dealerName: string): string;
```

Two notes on the contract, both easy to get wrong:

- **`transactionTotals` consumes `linesPaise`, not quantity/rate pairs.** The
  caller runs `lineAmount()` per line first. This keeps line rounding and total
  rounding as two distinct, separately testable steps.
- **`rawTotalPaise` is computed internally and is not returned.** If a caller
  needs it, derive it as `taxablePaise + gstAmountPaise` rather than changing the
  signature.

`balanceHeadline` lives in the money module, not the UI layer — which is right,
since it is the one place the sign is translated into words, and Appendix B is
explicit that nothing outside this module touches money.

**`parseRupeesToPaise` is required but not in Appendix B.** §20 lists it in the
money module's test surface and §10.6 specifies its behaviour (Indian grouping,
two-decimal cap, empty ≠ zero, rejects floats and negatives). Implement it here
to the §10.6 rules.

#### On the rounding primitive

`Math.sign(value) * Math.round(Math.abs(value))` rounds **half away from zero**,
not half-up in the strict sense — `roundPaise(-0.5)` is `-1`, where a literal
half-up would give `0`. For money this is the better behaviour (it is symmetric,
so a credit and its reversal round identically) and every §6 figure comes out
exact. The naming in §8.1 is loose; the implementation is correct. Do not
"fix" it.

One cosmetic edge: `roundPaise(-0.4)` returns `-0`. It compares equal to `0` and
SQLite stores it as `0`, so it is harmless — but avoid `Object.is(x, 0)` checks
on money, which would treat it as a different value.

**Precision.** `quantity × rate_paise` is the only place a float enters the
computation, and it is immediately rounded to an integer. `9510 × 2400 =
22,824,000` is exact; a fractional quantity such as `9510.5 × 2400` gives
`22,825,200`, also exact. Values remain far below 2^53. **BigInt is not needed
and must not be introduced**; the rule is "never let a fractional money value
persist", not "avoid `number`".

### 4.2 `ledger/` — the pure engine

No database imports. Given a prior balance and an event, it returns the entries
to post. The §6 scenarios exercise it directly, with no D1 in the test.

```ts
type LedgerEvent =
  | {
      kind: 'transaction';
      mode: 'purchase' | 'sale';
      isReturnNote: boolean;
      grandTotalPaise: Paise;
      entryDate: string;
      bankAccount: BankAccount;
    }
  | {
      kind: 'payment';
      direction: 'received' | 'paid';
      amountPaise: Paise;
      entryDate: string;
      bankAccount: BankAccount | null;
    }
  | { kind: 'opening'; direction: 'owes_us' | 'we_owe'; amountPaise: Paise; entryDate: string }
  | { kind: 'reversal'; reversesEntry: PostedEntry };

interface PostedEntry {
  debitPaise: Paise;
  creditPaise: Paise;
  runningBalancePaise: Paise;
  label: 'Sale' | 'Purchase' | 'Received' | 'Paid' | 'Opening' | 'Reversal';
  // …
}

/** The whole of §7, as one pure function. */
function post(priorBalancePaise: Paise, event: LedgerEvent): PostedEntry;

/** §15.5 — replay all non-voided entries from zero in (entry_date, id) order. */
function replay(entries: LedgerEventRow[]): PostedEntry[];
```

**Posting rules implemented here (§7):**

| Event          | Effect                                      |
| -------------- | ------------------------------------------- |
| Sale           | debit `grandTotalPaise`                     |
| Purchase       | credit `grandTotalPaise`                    |
| Money received | credit `amountPaise`                        |
| Money paid     | debit `amountPaise`                         |
| Opening        | debit or credit as entered                  |
| Reversal       | equal and opposite to the entry it reverses |

A transaction flagged `isReturnNote` posts **opposite** to its mode — a sale
return credits, a purchase return debits.

`runningBalancePaise = priorBalancePaise + debitPaise − creditPaise`. Exactly one
of debit/credit is non-zero on any entry.

### 4.3 `posting/` — the thin DB wrapper

Wraps the engine and performs the writes. Contains no arithmetic. Its sole
responsibility is assembling the `db.batch([...])` array in the correct order and
returning the created records.

### 4.4 `routes/` — validation and transport

Zod at every boundary. Server-side validation is authoritative and is re-run in
full even when the client has already checked (§10.9). All money in request and
response bodies is integer paise.

## 5. Atomicity — the `db.batch` requirement

**D1 offers no interactive `BEGIN…COMMIT` over the Workers binding.** Every
multi-row write MUST be issued as a single `db.batch([...])`, which commits
entirely or not at all (§15.3).

Creating a transaction is therefore one batch containing, in order:

1. Allocate/increment the human-ID sequence row (see [BACKEND_SCHEMA.md §7](BACKEND_SCHEMA.md))
2. `INSERT` the `transactions` header
3. `INSERT` each `transaction_lines` row
4. `INSERT` the `ledger_entries` row with its computed `running_balance_paise`
5. `INSERT` the `audit_log` row

**Required test (§15.3):** a forced mid-batch failure must leave **zero** partial
rows. This is an explicit integration test, not an assumption about D1.

### 5.1 Ordering constraint within a batch

Steps 2–4 need IDs that only exist after their inserts. D1's batch does not let a
later statement read an earlier statement's generated key directly, so the
posting layer must either use `RETURNING` and a follow-up batch, or pre-allocate
identifiers. **Still open** — the SRS does not address it. Resolve in Phase 1
(§23) and record the chosen mechanism here; the correctness requirement
(all-or-nothing) is fixed regardless. Pre-allocating primary keys preserves it;
splitting into two batches does not.

## 6. Running Balance Strategy

Per §15.2, the running balance is computed **at write time** and served from the
stored value on read — never recomputed on read. Single-user access makes this
safe; there is no concurrent writer to race with.

```
new.running_balance_paise
    = previous_entry.running_balance_paise + new.debit_paise − new.credit_paise
```

where `previous_entry` is the immediately preceding entry for that dealer in
`(entry_date, id)` order.

### 6.1 Replay

```
recomputeLedger(dealerId)
```

Replays all non-voided entries for the dealer in `(entry_date, id)` order,
recomputing running balances from zero (or from the opening entry). Called:

- after **every** void, and
- after any **back-dated insert** — an entry whose `(entry_date, id)` position is
  not last, meaning every entry after it now carries a stale balance.

**Confirmed by §15.5 and §15.6.** The rule reads: called after every void, "and
after any back-dated insert that lands **before existing entries**". §15.6 adds
that a back-dated entry is legitimate and must be supported — the application
posts the row, then runs `recomputeLedger(dealerId)`, so every subsequent running
balance is rewritten. **The stored balance is never left stale.**

§15.7 further requires that a void's four steps — reversal row, `is_voided` flag,
audit row, replay — occur in **one batch**, with the replay writes batched too.

### 6.2 Ordering key

The replay and display order key is always **`(entry_date, id)`** (§15.4).
Insertion order alone is never relied upon, and money is never sorted by a float.
Because `entry_date` is text in `YYYY-MM-DD` form it sorts lexicographically, so
this works directly in SQL: `ORDER BY entry_date, id`.

### 6.3 Consistency check

A background or on-demand integrity check should assert that replaying a dealer's
entries from zero reproduces every stored `running_balance_paise`. Any divergence
is a defect, not a rounding artefact — the arithmetic is integer and exact.

## 7. Data Handling Rules

### 7.1 Money

Integer paise in the database, in computation, in API bodies, and in form state.
`parseFloat`, `toFixed`, and a bare `number` used as rupees are forbidden in
money paths (§8.5).

Exactly **two** sanctioned paise → rupee conversions exist in the whole system:

1. `formatPaise()` at the render boundary (§10.8)
2. The Excel export boundary, `paise / 100` into a numeric cell (§11.4)

### 7.2 Dates

`entry_date` and `invoice_date` are **text `YYYY-MM-DD`** — an IST calendar date,
not an instant (§12.4). Storing a calendar date as a timestamp invites
off-by-one-day bugs at the timezone boundary. `created_at` and `at` _are_
instants and remain unix epoch integers.

Date validation ("not later than today") must evaluate **today in IST**, not in
the Worker's UTC clock. A Worker running at 23:00 UTC is already tomorrow in IST.

### 7.3 Quantity and GST rate

Real numbers, used for computation and display. The authoritative monetary
figures are always the integer paise columns. Quantity may legitimately be
fractional (9,510.5 kg); it is never money.

## 8. API Design

Full route table in SRS §14. Engineering requirements on top of it:

- Every route except `/api/auth/login`, `/api/auth/me`, and `/api/auth/logout`
  requires a valid session cookie.
- Every request body validated with Zod; server-side validation authoritative.
- Every state-changing route verifies `Origin` / `Sec-Fetch-Site` (§14).
- Error responses carry a stable machine-readable `code` plus a human message.
- **Errors never echo money amounts or dealer details into logs** (§14).
- List endpoints that can grow unbounded (`/api/transactions`, `/api/audit`) are
  cursor-paginated.

### 8.1 Error model

```ts
{ error: { code: 'VALIDATION_FAILED', message: 'Human-readable summary',
           fields?: Record<string, string> } }
```

Stable codes so the client can branch without string-matching prose.

## 9. Authentication & Session

**SRS §16.1 is authoritative and unusually specific. Follow it exactly.**

Password stored as `pbkdf2$<iters>$<salt>$<hash>` in the single-row
`app_credentials` table — **in D1, not in environment secrets**, because a Worker
cannot rewrite its own secrets but can write to its database. That is what makes
in-app password change possible at all.

- PBKDF2-SHA256 via WebCrypto `crypto.subtle.deriveBits`. Node's `crypto` is not
  available in the Workers runtime; Web Crypto runs identically in workerd and in
  the Node test runner.
- **Iterations are capped at 100,000.** Above that the Workers runtime throws
  `NotSupportedError`. Local test runners do **not** — so a higher value passes
  every test and then fails in production. This is the single sharpest trap in
  the spec; pin the constant and assert it in a test.
- Constant-time comparison of the derived hash.
- Session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`, 30-day expiry,
  **HMAC-signed with `AUTH_SECRET`**. Stateless — there is no sessions table.
- A wrong login gets a **deliberate ~½ second delay** before its 401, so the
  endpoint cannot be hammered cheaply. This is §16.1's answer to rate limiting;
  a WAF rule in front of the login endpoint is optional hardening (§19.3) and the
  only item in provisioning that may cost money.
- Credential-change routes sit behind the gate **and** re-require the current
  password (FR-U2), writing a `credential_change` audit row.
- **`AUTH_SECRET` is the only Worker secret, and it is what turns the gate on.
  Unset ⇒ the gate is disabled** — a local-development convenience only. **The
  build must refuse to start in production mode without it.** Implement that
  check early; a silent ungated production deploy is the worst failure this
  application has.

### 9.1 Credential recovery (§19.5)

If the owner forgets the password, recovery is a **maintainer** operation:
re-run the login-setup script against the production database to overwrite the
`app_credentials` row. There is deliberately no email-based reset — it would be
an unauthenticated write path into the only thing protecting the data.

### 9.2 Security headers (§16.2)

Set on **every** response:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
```

No inline scripts (nonces or hashes only if unavoidable). No CDN fonts or
external assets — which is why §18 specifies self-hosted Inter.

### 9.3 Logging (§16.3)

**No money or dealer PII in logs, error traces, or analytics.** A logging helper
redacts amount, name, and GSTIN fields. No third-party analytics or
error-reporting service receives request bodies.

## 10. Export Pipeline

Generated **client-side** from JSON returned by the API, using SheetJS (§11.2).
This keeps a heavy dependency out of the Worker and well inside its CPU limit,
and keeps export logic beside the formatting logic it must match.

```
API (rows, money as integer paise)
        │
        ▼
  shared row-builder  ──┬──→ SheetJS writer → .xlsx
                        └──→ CSV writer     → .csv
```

**The row-builder is shared by both writers**, so the two formats cannot drift
(§11.2). It is also the single place the export-boundary `paise / 100` conversion
happens.

Requirements from §11.4:

- Money as **numeric cells** in rupees, two decimals, number format `#,##0.00`.
  No `₹` character embedded in the value — the header names the unit.
- Negative balances stay **numerically negative** in the Balance column so Excel
  can sum and chart them; the adjacent Direction column carries the plain
  language. This is the one sanctioned place a raw sign appears.
- Dates written as **real Excel dates**, not strings.
- Voided rows are **included**, flagged `VOIDED`, struck through, with their
  reversal on the following row. Never silently omitted.
- Column widths set so nothing renders as `####`; header row frozen and bold.
- A subtitle row states exactly which filters were applied.

For a large range the API paginates and the export module concatenates before
writing.

### 10.1 Backup is not an export

An earlier draft of this document proposed a fourth, in-app "backup export".
**SRS §17.3 supersedes that**: backup is a **SQL dump** taken with
`pnpm db:export` (wrapping `wrangler d1 export`), not an application feature.

That is the better answer, and it closes the gap this document previously
flagged. A SQL dump restores; a workbook does not. The three exports in §11 stay
exactly as specified — human-facing, one-way, non-re-importable per §11.5 — and
recovery is handled entirely outside them. See §13.1.

## 11. Frontend Technical Requirements

### 11.1 MoneyInput

The owner types rupees (`3,13,830` or `313830.50`); the component parses to
integer paise and **emits paise only**. Form state never holds a float rupee
value (§10.6).

- Live-formats to Indian grouping while typing.
- Curtails input beyond two decimal places.
- Treats empty as "not entered", never as zero.

### 11.2 Draft persistence

In-progress form input autosaves to `localStorage` so a dropped mobile connection
or an accidental back-navigation never loses a half-typed entry. Cleared on
successful save. Deliberately **not** full offline sync, which would conflict
with the single source of truth (§10.6).

Drafts hold paise, matching form state.

### 11.3 PWA and caching

Installable — manifest and icon. **Cache the application shell only. Never cache
financial data** (§10.10). A stale balance is a dangerous balance.

Concretely: precache the JS/CSS/HTML shell; use network-only for every `/api/*`
request, with no stale-while-revalidate and no offline fallback that could
display a figure.

### 11.4 Live computation

The transaction form computes base total, GST, grand total, and round-off live as
the owner types (FR-T4), using the **same** `money/` module the server uses. The
client computation is a preview; the server recomputes authoritatively on save
and its figures win.

## 12. Testing Strategy

**SRS §20 is authoritative.** Its gating rule: **all six §6 scenarios must pass
at both the pure and the D1-integration level** before the ledger is considered
complete. CI runs typecheck, lint, the full suite, the build, and `pnpm audit` on
every push.

| Level                       | Target                                                                            | Tool                             |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| **Unit — money**            | Every §8 formula, including the §8.4 worked example and negative round-off        | Vitest                           |
| **Unit — engine**           | All six §6 scenarios A–F, exact figures, against the pure engine with no DB       | Vitest                           |
| **Integration — atomicity** | Forced mid-batch failure leaves zero partial rows (§15.3)                         | Vitest + workers pool + local D1 |
| **Integration — replay**    | `recomputeLedger` reproduces stored balances; void restores the prior position    | Vitest + local D1                |
| **Integration — API**       | Zod rejection of floats, `NaN`, out-of-range; auth gate on every non-public route | Vitest                           |
| **Accessibility**           | AA contrast, no colour-only meaning, labels, focus rings                          | axe + manual                     |

No E2E framework is specified by §20; the Phase 2 gate is verified by hand on a
360 px phone. Playwright would be an extension, not an omission to correct.

**The six §6 scenarios are the primary acceptance tests and must pass before the
ledger is considered complete** (§6 preamble). They are not optional and not
deferrable to a later phase.

## 13. Non-Functional Requirements

**SRS §17 is authoritative** (NFR-I, NFR-S, NFR-B, NFR-P, NFR-U, NFR-A).
Engineering notes on the ones with teeth:

- **NFR-P1** — dealer lists and detail load in under a second at the expected
  volume: a single business, on the order of thousands of transactions per year.
- **NFR-P2** — balance reads come from the **stored** running balance, never
  recomputed on view.
- **NFR-P3** — a full-year Excel export completes in the browser **without
  freezing the page**. At this volume SheetJS is fast enough synchronously, but
  if it ever isn't, the fix is chunking or a worker thread, not a smaller export.
- **NFR-S3** — money and dealer details never reach logs, traces, or analytics.
- **Correctness over availability** (derived) — if a balance cannot be computed
  with certainty, show an error rather than a number.
- **Data durability** — see §13.1.
- **Accessibility.** Semantic HTML, real `<label>`s, visible focus rings, AA
  contrast, no meaning by colour alone, screen-reader text spelling out balance
  direction (§10.10).

### 13.1 Backup and durability (§17.3)

**Resolved by the SRS.** Two layers, both card-free:

| Layer                  | NFR        | Mechanism                                                                                                                          |
| ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Point-in-time recovery | **NFR-B1** | D1 **Time Travel** — 30-day PITR, no cost, no configuration                                                                        |
| Off-store dump         | **NFR-B2** | `pnpm db:export`, wrapping `wrangler d1 export`, on a regular cadence; optionally automated by a GitHub Action to a build artifact |
| Verified restore       | **NFR-B3** | Documented **and actually performed** into a scratch database before handover                                                      |

**R2 is deliberately not used** — it requires a payment card on file, and §17.3
states the arrangement must stay card-free. This matches the owner's 29 Aug
decision exactly.

**The gap this document previously flagged is closed.** A SQL dump is restorable,
so recovery is not limited to Time Travel's 30-day window, and §11.5's
"not re-importable" applies only to the human-facing Excel and CSV exports. No
extension beyond the spec is needed.

**NFR-B3 sets a real bar:** the restore must be _performed and verified_, not
merely documented. Verification means the schema matches **and** a byte-exact
paise round-trip of a known dealer's ledger is confirmed. Treat an unverified
restore procedure as no backup at all.

Where the dump file is kept — locally, or in Google Drive — is the owner's
choice; §17.3 requires only that it is retained off the primary store.

## 14. Deployment & Migrations

- `drizzle-kit generate` authors the migration SQL.
- `wrangler d1 migrations apply` applies it — `--local` for development, remote
  for production.
- **An applied migration is never hand-edited. A new one is added instead** (§13).
- Generated migration SQL is committed to the repository.
- Secrets via `wrangler secret` / `.dev.vars` locally; `.dev.vars` is gitignored.

### 14.1 Provisioning (§19)

The build lives in the maintainer's GitHub and Cloudflare accounts **from day
one**, so there is never a migration later and no credential is ever shared.

- Private GitHub repo under the maintainer's account; developer added as a
  collaborator; **branch protection on `main` requiring CI to pass**; Dependabot
  on for `npm` and `github-actions`.
- Cloudflare free plan, **no payment card required** provided R2 is unused.
  Developer invited as a member with administrator rights.
- **Two D1 databases are mandatory: `ledger-dev` and `ledger-prod`** — dev under
  the default environment, prod under an explicit `env.production` in
  `wrangler.jsonc`. Development never holds real financial data unless protected
  identically (§16.4).
- One secret: `wrangler secret put AUTH_SECRET --env production`, 32 bytes random.
- Deploy to a `*.workers.dev` URL. **No custom domain or DNS is required**,
  because authentication is enforced inside the Worker. A custom domain is
  optional hardening only (§19.3).
- A login-setup script writes the first `app_credentials` row; the owner then
  changes the password from inside the application.

### 14.2 Handover (§19.4)

Deliverables are a README (setup, bindings, deploy, tests) and a **maintainer
runbook** (backup and restore, the replay function, voiding and correcting,
incident basics).

The gate is concrete: **the maintainer can deploy, run the tests, take a backup,
and restore it from the runbook alone**, without the original developer.

## 15. Engineering Constraints — the non-negotiables

A checklist for review. Any violation is a defect regardless of test status.

1. No floating-point money anywhere — DB, computation, API, or form state.
2. All paise arithmetic inside `money/`. No ad-hoc `*`, `/`, `Math.round` on money.
3. `ledger/` imports nothing from `db/`. It stays pure and directly testable.
4. Every multi-row write is exactly one `db.batch([...])`.
5. Nothing financial is hard-deleted or edited into a different figure.
6. Order key is always `(entry_date, id)`.
7. The bank account tag never affects a posting or a headline.
8. `formatPaise()` is the only render-time money formatter.
9. Never cache financial data in the service worker.
10. Server-side Zod validation is authoritative, always re-run.

## 16. Open Technical Items

With the SRS complete, almost everything is answered. What remains:

| #   | Item                                              | Status                                                                                                                                                               |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Batch ID-allocation mechanism (§5.1)              | **Genuinely open** — not addressed by the SRS. Decide in Phase 1.                                                                                                    |
| 2   | `id_sequences` table                              | **Owner-approved addition.** §15.3, §20 and §23 all require human-ID sequence generation, but §12/§13 still define no table for it.                                  |
| 3   | `source_id` convention for `opening` / `reversal` | Still unstated. §15.8 rule 3 requires every entry to trace via `source_type` + `source_id`; the derived table in [BACKEND_SCHEMA.md §4.5](BACKEND_SCHEMA.md) stands. |
| 4   | `reverses_entry_id` has no declared FK            | Recommend a self-referencing FK.                                                                                                                                     |
| 5   | The four §22 open items                           | Owner's call — see [PRD.md §10.2](PRD.md). All non-blocking.                                                                                                         |
| 6   | E2E framework                                     | Not specified by §20. Adding Playwright is a scope decision.                                                                                                         |

### 16.1 Traps worth naming

Three things in the SRS will pass tests and fail in production if missed:

1. **PBKDF2 iterations above 100,000** throw `NotSupportedError` in the Workers
   runtime but not in the Node test runner (§16.1).
2. **`AUTH_SECRET` unset disables the gate entirely.** The build must refuse to
   start in production mode without it (§16.1).
3. **`SameSite=Strict`**, not `Lax` — an earlier draft of this document had it
   wrong.
