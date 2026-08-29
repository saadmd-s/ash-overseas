# Implementation Plan

**Product:** ASH Overseas Trading Ledger
**Version:** 1.1 — reconciled to SRS §23
**Date:** 29 August 2026
**Status:** Follows the authoritative delivery plan in [SRS.md](../SRS.md) §23

> **SRS §23 is authoritative on phasing.** An earlier version of this document
> proposed a six-phase plan written before §23 was available; it has been
> replaced by the spec's four phases. The engineering detail below expands each
> phase — it does not add phases or move gates.
>
> **Each phase has a gate. Do not begin the next phase until the current gate is
> green.**

---

## Sequencing Principle

§23 builds **inside out**: the pure arithmetic first, then the pure ledger
decisions, then persistence, then the real interface, then hardening.

The reason is testability. `money/` and `ledger/` have no dependencies, so the
six §6 scenarios can be *encoded* in Phase 0 and *passed* in Phase 1 before a
screen exists. If the numbers are wrong, everything downstream is wrong, and no
amount of interface work surfaces it.

Note the shape of the Phase 0 gate — the scenario suite must run and **fail for
the right reason**. Encoding the expected figures before the engine exists is
what stops the engine being written to match whatever it happens to produce.

---

## Phase 0 — Foundations

**Goal:** the toolchain works, the money math is proven, and the acceptance tests
exist and fail honestly.

### 0.1 Repository and toolchain

- TypeScript **strict**, ESLint, Prettier, committed lockfile, `.gitignore`
  covering `.dev.vars`, `.wrangler`, `node_modules`, build output, `*.sqlite`
  (§19.1) — already in place.
- **pnpm**, with the version pinned in `packageManager` (§18).
- Vite + React + Hono + Workers scaffold; `pnpm dev` serves locally; a preview
  deploy succeeds.
- **ESLint rule banning `parseFloat`, `toFixed`, and bare `Math.round` outside
  `src/money/`.** Not in the SRS, but it is what makes §8.5 mechanically
  enforceable rather than a matter of reviewer vigilance.

### 0.2 Databases

- Create `ledger-dev` and `ledger-prod` (§19.2). **Two databases is mandatory**,
  not a nicety — §16.4 forbids development holding real financial data unless
  protected identically.
- Record both IDs in `wrangler.jsonc`: dev under the default environment, prod
  under an explicit `env.production`.

### 0.3 Money-math module

Implement **SRS Appendix B verbatim** — `roundPaise`, `roundToRupee`,
`lineAmount`, `gstAmount`, `transactionTotals`, `formatPaise`, `balanceHeadline`
— plus `parseRupeesToPaise` to the §10.6 rules (required by §20, absent from
Appendix B).

Three things to watch, all detailed in [TRD.md §4.1](TRD.md):

- `transactionTotals` takes **`linesPaise: number[]`**, not quantity/rate pairs.
- It does **not** return `rawTotalPaise`.
- `roundPaise` rounds half **away from zero**; that is deliberate and correct.

Exhaustive unit tests including the §8.4 worked example (round-off **−₹0.20**),
and `formatPaise` / `parseRupeesToPaise` tests for Indian grouping, two decimal
places, and rejection of floats and negatives.

### 0.4 Schema

Drizzle schema per §13, plus the owner-approved `id_sequences` table
([BACKEND_SCHEMA.md §7](BACKEND_SCHEMA.md)). First migration generated and
applied to **both** databases.

### 0.5 Test harness

The six §6 scenarios encoded as fixtures — **expected red**.

> **Gate:** the build succeeds, migrations apply cleanly to a fresh database, and
> the §6 suite runs and **fails for the right reason**.

---

## Phase 1 — Core Ledger

**Goal:** the numbers are right, through the real database, atomically.

### 1.1 Pure ledger engine

Posting rules per §7, reversing entries, and `recomputeLedger` on the
`(entry_date, id)` key. **No imports from `src/db/`** — this is what keeps the
scenarios testable without infrastructure.

### 1.2 Posting layer

`db.batch` atomicity per §15.3, write-time running balance per §15.2, human-ID
generation per FR-T9.

**Resolve the batch ID-allocation problem here** ([TRD.md §5.1](TRD.md)). The
SRS does not address it. Pre-allocating primary keys preserves the all-or-nothing
guarantee; splitting into two batches does not.

Replay per §15.5 and §15.6: after every void, and after any back-dated insert
that lands before existing entries. §15.7 requires a void's four steps —
reversal, `is_voided` flag, audit row, replay — to occur in one batch, with the
replay writes batched too.

### 1.3 Data operations

- Dealer create / edit / archive, with the optional opening position (as an
  `opening` ledger entry, never a mutable dealer field — §15.8 rule 4).
- Transaction create with line items, GST, discount, freight, round-off, bank tag.
- Payment create.

### 1.4 Minimal dealer detail

Headline plus chronological history. **Function over form** — §23 is explicit
that the real interface is Phase 2.

> **Gate:** all six §6 scenarios pass at **both** the pure and the D1-integration
> level; a forced mid-batch failure leaves **no** partial rows; balances read from
> stored values; nothing hard-deletes a financial row.

---

## Phase 2 — The Real Application

**Goal:** the owner can actually run the business on it, from a phone.

### 2.1 Navigation and screens

Home, dealer lists, search, navigation per §10.2.

### 2.2 The transaction form

Per §10.6, with `MoneyInput`, the live summary, autocomplete, and draft
persistence. Build `MoneyInput` **before** any form consumes it — rupee text in,
integer paise out, Indian grouping while typing, two-decimal cap, empty ≠ zero.
It is the most safety-critical component in the interface.

The payment form follows, with direction as two plain-language options.

### 2.3 Void

Confirmation dialog naming the entry **and the amount** (FR-A2), reversal,
replay, struck-through display with the reversal adjacent.

### 2.4 Filters and cross-dealer view

History filters (date range, type, mode, bank account) **with the "filtered"
notice**. The headline and running-balance column are always computed over all
entries — Scenario F is the test.

Then the "All transactions" cross-dealer view.

### 2.5 Export

**All three exports** per §11 — dealer ledger, all transactions, dealer balances
— in Excel and CSV, over a **shared row-builder** so the formats cannot drift.

### 2.6 Polish

Loading, empty, and error states; toasts; accessibility pass; PWA install
(shell only — **never** financial data).

> **Gate:** a full purchase and a full sale — including discount, freight,
> round-off, and **both** bank account tags — can be entered, voided, and
> exported on a 360 px phone; the exported figures reconcile **exactly** with the
> screen.

---

## Phase 3 — Hardening & Handoff

**Goal:** safe to trust with the only copy of the business ledger, and
maintainable by someone else.

### 3.1 Authentication (§16.1)

Three traps that pass tests and fail in production:

1. **PBKDF2 iterations are capped at 100,000.** Above that the Workers runtime
   throws `NotSupportedError`; the Node test runner does not. Pin the constant
   and assert it.
2. **`AUTH_SECRET` unset disables the gate entirely.** The build must refuse to
   start in production mode without it. Implement that check early — a silent
   ungated production deploy is the worst failure this application has.
3. **`SameSite=Strict`**, not `Lax`.

Plus: credentials in D1 (not env secrets, so the owner can change them in-app),
HMAC-signed session cookie with 30-day expiry, ~½ second delay before a wrong
login's 401, Web Crypto throughout, in-application credential change re-requiring
the current password.

### 3.2 Security headers (§16.2)

The full six-header set on every response. No inline scripts. No CDN assets —
which is why §18 specifies self-hosted Inter.

### 3.3 Backups (§17.3)

- Time Travel confirmed on (NFR-B1).
- `pnpm db:export` working, wrapping `wrangler d1 export` (NFR-B2).
- **A restore performed and verified into a scratch database** (NFR-B3) — schema
  matches, and a byte-exact paise round-trip of a known dealer's ledger is
  confirmed. An unverified restore procedure is not a backup.

**No R2** — it requires a card on file, and the arrangement stays card-free.

### 3.4 Audit view and CI

Read-only audit view. CI green: typecheck, lint, tests, build, `pnpm audit`.
Dependabot on. Secrets confirmed absent from the repository.

### 3.5 Handover (§19.4)

README and maintainer runbook; production deploy; first credentials set via the
login-setup script; the owner walked through the application once.

> **Gate:** unauthenticated API requests are rejected; a wrong password is
> rejected and throttled; a correct password mints a working session; the §16
> checklist is fully green; **the maintainer can deploy, test, back up, and
> restore from the runbook alone.**

---

## Risk Register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| A float reaches a money path | 0 | Lint rule + `money/` isolation + server-boundary rejection |
| Engine written to match its own output | 0 | Scenarios encoded before the engine exists; gate requires failing for the right reason |
| D1 batch cannot resolve generated ids | 1 | Pre-allocate primary keys; never split the batch |
| Back-dated entry leaves stale balances | 1 | §15.6 replay trigger + integrity check |
| Bank tag misread as a second ledger | 2 | Scenario F test + the mandatory "N of M" notice |
| PBKDF2 iterations pass tests, fail production | 3 | Cap at 100,000; assert the constant in a test |
| `AUTH_SECRET` unset in production | 3 | Build refuses to start; verify on the first prod deploy |
| Service worker caches a balance | 2 | Network-only `/api/*`; explicit test |
| Backup exists but was never restored | 3 | NFR-B3 makes a verified restore the gate, not a document |

---

## Definition of Done

- [ ] All six §6 scenarios pass at **both** pure and D1-integration level
- [ ] Forced mid-batch failure leaves zero partial rows (§15.3)
- [ ] Replay from zero reproduces every stored running balance
- [ ] No `parseFloat` / `toFixed` / bare `Math.round` outside `src/money/`
- [ ] Money module matches Appendix B exactly
- [ ] The interface contains no "debit", no "credit", and no bare sign
- [ ] Filtering never alters a headline or a running-balance column
- [ ] Exports open in Excel with numeric money and real dates; `SUM` works
- [ ] Voided entries appear in exports, flagged, with their reversals
- [ ] Every non-public route rejects an unauthenticated request
- [ ] Wrong password throttled ~½s; PBKDF2 iterations ≤ 100,000
- [ ] Production build refuses to start without `AUTH_SECRET`
- [ ] All six §16.2 security headers present on every response
- [ ] Accessibility: AA contrast, no colour-only meaning, screen-reader direction
- [ ] The service worker caches no financial data
- [ ] **A restore has been performed and verified** into a scratch database
- [ ] The maintainer can deploy, test, back up, and restore from the runbook alone
