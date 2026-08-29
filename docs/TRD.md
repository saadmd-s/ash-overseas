# Technical Requirements Document

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Derived from [SRS.md](../SRS.md)

> **[SRS.md](../SRS.md) is authoritative.** This document translates it into
> engineering decisions. Where they disagree, the SRS wins.
>
> The SRS is truncated below §15.4. Anything marked **[PENDING §n]** is a
> derived decision awaiting confirmation from the untranscribed sections —
> notably §18 (stack), §16 (security), §17 (non-functional), and Appendix B
> (money-math reference implementation).

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

> **DECIDED — owner, 29 Aug 2026: Vite + React + Hono on Workers.**
> SRS §18 is untranscribed; the owner chose to settle the question rather than
> wait for it. If §18 turns out to say otherwise, reconcile then — the module
> boundaries in §4 are framework-agnostic, so the cost is confined to the routing
> layer and the build config.

### 3.1 Vite + React + Hono on Workers

| Layer | Choice | Rationale |
| --- | --- | --- |
| Runtime | Cloudflare Workers | Stated in SRS §13 (D1 binding), §11.2 (Worker CPU budget) |
| Database | Cloudflare D1 (SQLite) | Stated, SRS §13 |
| ORM | Drizzle | Stated, SRS §13, with `drizzle-kit generate` |
| API framework | Hono | Minimal, Workers-native, tiny CPU and bundle cost |
| Frontend | Vite + React (SPA) | Client-rendered; no SEO need; keeps the Worker thin |
| Validation | Zod | Stated, SRS §10.9, §14 |
| Export | SheetJS (`xlsx`), client-side | Stated, SRS §11.2 |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Runs integration tests against real D1 semantics |
| E2E | Playwright | Mobile viewport flows |

**Why this over Next.js.** The SRS describes an SPA in all but name: a plain JSON
API with cookie sessions (§14), client-side workbook generation explicitly to
keep the Worker light (§11.2), and a PWA that caches the app shell only (§10.10).
Next.js would add RSC and SSR machinery that this product never uses — no SEO
requirement, no public pages, one user — while consuming Worker CPU on every
navigation. Vite + React + Hono is the smaller, faster, more directly testable
fit.

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

> **[PENDING Appendix B]** — the SRS holds a reference implementation that has
> not been transcribed. The signatures below are derived from §8 and must be
> reconciled with it.

```ts
type Paise = number;  // integer, exact below 2^53 (≈ ₹90 trillion)

/** Half-up to the nearest paise. The only rounding entry point for line math. */
function roundPaise(value: number): Paise;

/** Half-up to the nearest whole rupee (100 paise). Used for the grand total. */
function roundToRupee(value: Paise): Paise;

/** quantity is a real number (9,510.5 kg); rate is integer paise. */
function lineAmount(quantity: number, ratePaise: Paise): Paise;

/** Returns every derived figure for a transaction, per §8.2. */
function transactionTotals(input: {
  lines: { quantity: number; ratePaise: Paise }[];
  gstRate: number;          // percent, 0–100
  discountPaise: Paise;
  freightPaise: Paise;
}): {
  baseTotalPaise: Paise;
  taxablePaise: Paise;
  gstAmountPaise: Paise;
  rawTotalPaise: Paise;
  grandTotalPaise: Paise;
  roundOffPaise: Paise;     // may be negative
};

/** Rupee text from the user → integer paise. Rejects anything ambiguous. */
function parseRupeesToPaise(input: string): Paise | null;

/** The render boundary. Intl.NumberFormat('en-IN', …) from paise. */
function formatPaise(paise: Paise): string;
```

**Half-up rounding.** JavaScript's `Math.round` is half-up for positive values
but rounds `-0.5` to `-0` rather than `-1`. Round-off values are legitimately
negative (§6.2 gives `−20` paise), so the helpers must round the magnitude and
reapply the sign, not delegate to `Math.round` directly.

**Precision.** `quantity × rate_paise` is the only place a float enters the
computation, and it is immediately rounded to an integer. `9510 × 2400 =
22,824,000` is exact. A fractional quantity such as `9510.5 × 2400` yields
`22,825,200` — also exact. Values remain far below 2^53. **BigInt is not needed
and must not be introduced**; the rule is "never let a fractional money value
persist", not "avoid `number`".

### 4.2 `ledger/` — the pure engine

No database imports. Given a prior balance and an event, it returns the entries
to post. The §6 scenarios exercise it directly, with no D1 in the test.

```ts
type LedgerEvent =
  | { kind: 'transaction'; mode: 'purchase' | 'sale'; isReturnNote: boolean;
      grandTotalPaise: Paise; entryDate: string; bankAccount: BankAccount }
  | { kind: 'payment'; direction: 'received' | 'paid';
      amountPaise: Paise; entryDate: string; bankAccount: BankAccount | null }
  | { kind: 'opening'; direction: 'owes_us' | 'we_owe'; amountPaise: Paise;
      entryDate: string }
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

| Event | Effect |
| --- | --- |
| Sale | debit `grandTotalPaise` |
| Purchase | credit `grandTotalPaise` |
| Money received | credit `amountPaise` |
| Money paid | debit `amountPaise` |
| Opening | debit or credit as entered |
| Reversal | equal and opposite to the entry it reverses |

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
identifiers. **[PENDING]** — resolve during Phase 2 and record the chosen
mechanism here; the correctness requirement (all-or-nothing) is fixed regardless.

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

> **[PENDING §15.5]** — the SRS text cuts off mid-sentence at *"called after
> **every** void, and after any back-dated insert that lands bef…"*. The
> back-dated rule above is the obvious completion but must be confirmed.

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
off-by-one-day bugs at the timezone boundary. `created_at` and `at` *are*
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

Single-user gate. Password stored as `pbkdf2$<iters>$<salt>$<hash>` in the
single-row `app_credentials` table (§12.3).

- Hashing via WebCrypto `crypto.subtle.deriveBits` (PBKDF2-SHA256). Node's
  `crypto` module is not available in the Workers runtime.
- Constant-time comparison of the derived hash.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Changing the username or password re-requires the current password (FR-U2) and
  writes a `credential_change` audit row.
- No sign-up, no email reset, no public route (FR-U3).

### 9.1 Session lifetime

**DECIDED — owner, 29 Aug 2026: a long session with no inactivity lock.**

- Cookie `Max-Age` of 30 days, refreshed on use.
- **No inactivity timeout and no re-authentication prompt inside the app.**

The reasoning is deliberate: the phone's own lock screen is the real security
boundary here, and a password prompt at a weighbridge is friction that pushes the
owner back toward the paper notebook. The threat this app actually faces is a lost
balance, not a lost password.

Consequence: an unlocked, unattended phone gives full access, including the
ability to void entries. That is accepted. It is recorded here so the trade-off is
visible rather than implicit.

> **[PENDING §16, §19.5]** — login rate limiting, lockout policy, and the
> maintainer credential-recovery procedure remain untranscribed. Rate limiting on
> `/api/auth/login` should be implemented regardless, since it costs little and
> the route is the only public attack surface.

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

### 10.1 The backup export — a fourth export

Beyond the three accountant-facing exports in §11.1, the backup posture (§13.1)
needs a **full data export**: every dealer, transaction, transaction line,
payment, ledger entry, and audit row — not merely what the three filtered views
happen to cover.

| | Three §11 exports | Backup export |
| --- | --- | --- |
| Audience | The accountant, a human | The owner's archive; possibly a restore |
| Scope | Filtered view on screen | **Everything, unfiltered** |
| Money | Rupees, `paise / 100` | **Integer paise, unconverted** |
| Format | `.xlsx` / `.csv` | JSON (recommended) or `.xlsx` |
| Re-importable | No, by §11.5 | **Yes, if the recommendation in §13.1 is accepted** |

Keeping money as integer paise in the backup matters: converting to rupees and
back is exactly the boundary crossing the money rule exists to prevent, and a
backup that round-trips through a float is not a backup.

Delivery: a browser download. Saving it to Google Drive is the owner's manual
step — see §13.1.

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

> **[PENDING §20]** — SRS §20 holds the authoritative testing strategy. This is
> the derived minimum.

| Level | Target | Tool |
| --- | --- | --- |
| **Unit — money** | Every §8 formula, including the §8.4 worked example and negative round-off | Vitest |
| **Unit — engine** | All six §6 scenarios A–F, exact figures, against the pure engine with no DB | Vitest |
| **Integration — atomicity** | Forced mid-batch failure leaves zero partial rows (§15.3) | Vitest + workers pool + local D1 |
| **Integration — replay** | `recomputeLedger` reproduces stored balances; void restores the prior position | Vitest + local D1 |
| **Integration — API** | Zod rejection of floats, `NaN`, out-of-range; auth gate on every non-public route | Vitest |
| **E2E** | Scenario A end-to-end on a 360 px viewport; export downloads and reconciles | Playwright |
| **Accessibility** | AA contrast, no colour-only meaning, labels, focus rings | axe + manual |

**The six §6 scenarios are the primary acceptance tests and must pass before the
ledger is considered complete** (§6 preamble). They are not optional and not
deferrable to a later phase.

## 13. Non-Functional Requirements

> **[PENDING §17]** — the authoritative NFRs are untranscribed. Derived targets:

- **Performance.** Dealer detail renders in under 1s on a mid-range phone over
  4G. Worker CPU well inside the limit — the export dependency lives in the
  browser precisely to keep it there.
- **Correctness over availability.** If a balance cannot be computed with
  certainty, show an error rather than a number.
- **Data durability.** See §13.1 — decided posture, with one gap flagged.
- **Accessibility.** Semantic HTML, real `<label>`s, visible focus rings, AA
  contrast, no meaning by colour alone, screen-reader text spelling out balance
  direction (§10.10).

### 13.1 Backup and durability

**DECIDED — owner, 29 Aug 2026: D1 Time Travel, plus an owner-triggered full
data export downloaded locally or saved to Google Drive. No R2.**

Two layers, covering different failure modes:

| Layer | Covers | Mechanism |
| --- | --- | --- |
| **D1 Time Travel** | Accidental damage caught within the retention window | Built in; restore via `wrangler d1 time-travel restore`. A maintainer operation, not an in-app feature. |
| **Full data export** | Long-horizon archive; a copy the owner physically holds | New in-app export (§10.1 below), downloaded or saved to Google Drive |

#### The gap, stated plainly

Time Travel's window is roughly 30 days. SRS §11.5 declares exports **not
re-importable**. Taken together, damage discovered after the Time Travel window
leaves a readable archive but **no path back to a working database** — someone
would re-key the ledger by hand.

**Recommendation:** make the *backup* export a machine-readable JSON dump — every
table, money still in integer paise, no rupee conversion — and write a restore
script that loads it. The three accountant-facing exports in §11 stay exactly as
specified; §11.5's "not an integration format" is about those, and a backup
serves a different purpose. This needs the owner's agreement since it is a
deliberate extension beyond §11.

Without that, the honest position is: **restore capability is 30 days**, and the
downloaded workbooks are a record for humans, not a recovery mechanism.

#### Google Drive

Two ways to land a file in Drive, with very different costs:

1. **Download, then the owner saves it to Drive.** Zero integration code, no
   OAuth, no stored tokens, works offline-ish. Recommended default.
2. **Direct upload via the Drive API.** Requires an OAuth client, a consent
   flow, and refresh-token storage inside a single-user app that currently has
   no third-party integration at all — a meaningful increase in surface area and
   in what a leaked session grants.

Start with (1). Add (2) only if the manual step proves to be the thing that stops
backups happening.

## 14. Deployment & Migrations

- `drizzle-kit generate` authors the migration SQL.
- `wrangler d1 migrations apply` applies it — `--local` for development, remote
  for production.
- **An applied migration is never hand-edited. A new one is added instead** (§13).
- Generated migration SQL is committed to the repository.
- Secrets via `wrangler secret` / `.dev.vars` locally; `.dev.vars` is gitignored.

> **[PENDING §19]** — provisioning in the maintainer's Cloudflare account,
> including environment setup and the §19.5 recovery procedure.

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

### 16.1 Resolved — owner decisions, 29 Aug 2026

| Item | Decision |
| --- | --- |
| Framework | **Vite + React + Hono on Workers** (§3) |
| Human-ID sequence | **Dedicated `id_sequences` table** ([BACKEND_SCHEMA.md §7](BACKEND_SCHEMA.md)) |
| Backup posture | **D1 Time Travel + owner-triggered full export, no R2** (§13.1) |
| Session lifetime | **30-day cookie, no inactivity lock** (§9.1) |

### 16.2 Still open

| # | Item | Blocked SRS section | Blocks |
| --- | --- | --- | --- |
| 1 | Money-math reference implementation | Appendix B | `money/` sign-off |
| 2 | Replay trigger on back-dated insert | §15.5 | Replay correctness |
| 3 | Replay's exact row-exclusion rule | §15.5 | Replay correctness |
| 4 | Batch ID-allocation mechanism | — (implementation) | Posting layer |
| 5 | `source_id` convention for `opening` / `reversal` | §12.3 (unstated) | Schema queries |
| 6 | Backup export re-importable? | §11.5 vs §13.1 | Real restore capability |
| 7 | Login rate limiting, lockout policy | §16 | Auth hardening |
| 8 | Credential recovery procedure | §19.5 | FR-U3 completion |
| 9 | Authoritative testing strategy | §20 | Test plan sign-off |
| 10 | Delivery plan | §23 | Reconciling the implementation plan |
