# Implementation Plan

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Proposed — SRS §23 (Delivery Plan) is untranscribed

> **[PENDING §23]** — the SRS holds an authoritative delivery plan that has not
> been transcribed. **This document is a proposal, not a transcription.** Replace
> or reconcile it when §23 is available.
>
> Phase 0 exists specifically to close the specification gaps that block
> everything else.

---

## Sequencing Principle

Build **inside out**: the pure arithmetic first, then the pure ledger decisions,
then persistence, then transport, then interface, then export.

The reason is testability. `money/` and `ledger/` have no dependencies, so the
six §6 acceptance scenarios can pass before a database exists. If the numbers are
wrong, everything downstream is wrong, and no amount of interface work will
surface it. Getting the engine right first means every later phase builds on
something already proven.

---

## Phase 0 — Unblock the specification

**Goal:** eliminate the gaps that make later phases guesswork.
**Nothing in Phases 1–6 should start on a guess where an answer exists in the
untranscribed SRS.**

### 0.1 Settled — owner decisions, 29 Aug 2026

| Question | Answer | Recorded in |
| --- | --- | --- |
| Framework | **Vite + React + Hono on Workers** | [TRD.md §3](TRD.md) |
| Human-ID sequence | **Dedicated `id_sequences` table** | [BACKEND_SCHEMA.md §7](BACKEND_SCHEMA.md) |
| Backup posture | **D1 Time Travel + owner-triggered full export; no R2** | [TRD.md §13.1](TRD.md) |
| Session | **30-day cookie, no inactivity lock** | [TRD.md §9.1](TRD.md) |

**Phase 1 is unblocked.** Scaffolding can begin.

### 0.2 Outstanding

| # | Task | Blocks | Source |
| --- | --- | --- | --- |
| a | Obtain SRS §15.5–§23 and both appendices | Several items below | Owner — the paste was truncated at 50,000 chars |
| b | Reconcile money-math signatures with the reference implementation | **Phase 1 sign-off** | Appendix B |
| c | Confirm the replay trigger on back-dated inserts | Phase 2 | §15.5 |
| d | Confirm replay's exact row-exclusion rule | Phase 2 | §15.5 |
| e | Confirm `source_id` conventions for `opening` / `reversal` | Phase 2 | §12.3 |
| f | Decide the batch ID-allocation mechanism | Phase 2 | Implementation |
| g | Decide whether the backup export is re-importable | Phase 5/6 | §11.5 vs [TRD.md §13.1](TRD.md) |
| h | Obtain login rate limiting and lockout policy | Phase 3 | §16 |
| i | Obtain credential recovery procedure | Phase 3 | §19.5 |
| j | Obtain authoritative testing strategy and delivery plan | Phase 6 | §20, §23 |

**None of these blocks Phase 1 from starting.** Item (b) blocks Phase 1 being
*signed off*: the money module can be built from §8 and validated against the
§6 figures, but its signatures should be reconciled with Appendix B before the
phase is called done.

**Exit criteria:** every **[PENDING]** marker in [TRD.md §16.2](TRD.md) and
[BACKEND_SCHEMA.md §10](BACKEND_SCHEMA.md) is resolved, or explicitly accepted as
a documented assumption with the owner's sign-off.

---

## Phase 1 — Ledger core

**Goal:** the numbers are provably right, with no database in sight.

### 1.1 Scaffold

- Vite + React + Hono on Workers (0.1); TypeScript strict mode.
- Vitest configured.
- ESLint with a **custom rule banning `parseFloat`, `toFixed`, and bare
  `Math.round` outside `src/money/`**. This is the single most valuable piece of
  automation in the project — it makes the §8.5 money rule mechanically
  enforceable rather than a matter of reviewer vigilance.

### 1.2 `src/money/`

Implement per [TRD.md §4.1](TRD.md): `roundPaise`, `roundToRupee`, `lineAmount`,
`transactionTotals`, `parseRupeesToPaise`, `formatPaise`.

**Watch the sign.** `Math.round(-0.5)` is `-0`, not `-1`. Round-off values are
legitimately negative (§6.2 gives `−20`), so round the magnitude and reapply the
sign rather than delegating to `Math.round`.

### 1.3 `src/ledger/`

Implement `post()` and `replay()` per [TRD.md §4.2](TRD.md). **No imports from
`src/db/`** — this is checked in review and is what keeps the scenarios testable
without infrastructure.

### 1.4 Tests — the gate for this phase

| Test | Must produce |
| --- | --- |
| §8.4 worked example | base 22,824,000 → gst 4,108,320 → raw 26,932,320 → posted 26,932,300, round-off **−20** |
| Scenario A | ends **−3,23,000** |
| Scenario B | posts 2,69,323, `round_off_paise` **−20** |
| Scenario C | ends **−3,19,592** |
| Scenario D | −3,19,592 → **+34,408** |
| Scenario E | void returns to **−5,39,544** |
| Scenario F | one headline of **+1,77,000** |
| Return note | sale return credits; purchase return debits |
| Property | replay from zero always equals sequential posting |

**Exit criteria:** all six §6 scenarios pass against the pure engine, in rupees
matching the SRS **exactly**. Per the §6 preamble these are the primary
acceptance tests and are not deferrable.

---

## Phase 2 — Persistence and posting

**Goal:** writes are atomic, and a failure leaves nothing behind.

### 2.1 Schema

- `src/db/schema.ts` transcribed from SRS §13 **verbatim**.
- `id_sequences` added (confirmed 0.1).
- Optional CHECK constraints per [BACKEND_SCHEMA.md §5.1](BACKEND_SCHEMA.md).
- `drizzle-kit generate`; commit the SQL; apply with
  `wrangler d1 migrations apply --local`.

### 2.2 Posting layer

`src/posting/` builds the `db.batch([...])` arrays per
[BACKEND_SCHEMA.md §6](BACKEND_SCHEMA.md). **Contains no arithmetic** — it calls
the engine and writes what it returns.

Resolve the ID-ordering problem (0.2f / [BACKEND_SCHEMA.md §6.1](BACKEND_SCHEMA.md))
here, and record the chosen mechanism in the TRD.

### 2.3 Replay

`recomputeLedger(dealerId)` — read entries, feed the pure `replay()`, write back
in one batch. Called after every void and after any back-dated insert.

### 2.4 Tests — the gate for this phase

- **Forced mid-batch failure leaves zero partial rows.** This is the explicit
  §15.3 integration test and the reason this phase exists.
- Replay reproduces stored balances for every dealer.
- Void restores the exact pre-void position (Scenario E, now against real D1).
- Back-dated insert triggers replay; all later balances corrected.
- Human IDs increment correctly across a month boundary and **do not reuse a
  number after a void**.

**Exit criteria:** the atomicity test passes, and Scenario E round-trips through
the database with the same figures it produced in Phase 1.

---

## Phase 3 — API and auth

**Goal:** every route validated, every route gated.

### 3.1 Auth

- PBKDF2 via WebCrypto `crypto.subtle.deriveBits` — **Node's `crypto` is not
  available in the Workers runtime**.
- Constant-time hash comparison.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Credential change re-requires the current password; writes an audit row.
- **Session: 30-day cookie, no inactivity lock** (0.1). Rate limiting on
  `/api/auth/login` regardless of 0.2h — it is the only public attack surface.

### 3.2 Routes

All of SRS §14. Zod at every boundary, **server-side validation authoritative and
re-run in full**. `Origin` / `Sec-Fetch-Site` verified on every state-changing
route. Cursor pagination on `/api/transactions` and `/api/audit`.

**Errors never echo money amounts or dealer details into logs** (§14).

### 3.3 Tests

- Every non-public route rejects an unauthenticated request.
- Zod rejects floats, `NaN`, negative payments, `gst_rate` > 100, discount
  exceeding base total.
- Future-dated entry rejected **against IST**, not UTC.
- Archived dealer rejected as a transaction target.
- CSRF check rejects a cross-origin state change.

**Exit criteria:** the full §14 surface is implemented and gated, and a float sent
in any money field is rejected at the server boundary.

---

## Phase 4 — Interface

**Goal:** the owner can run Scenario A end-to-end on a phone.

### 4.1 Foundation

- `formatPaise` / `formatDate` in `src/client/format/`.
- **`MoneyInput`** — rupee text in, integer paise out, Indian grouping while
  typing, two-decimal cap, empty ≠ zero. Build and test this before any form
  uses it; it is the most safety-critical component in the interface.
- `BalanceHeadline` / `BalanceInline` — icon + text + plain language, with
  screen-reader text spelling out direction.
- Draft persistence to `localStorage`, storing paise.

### 4.2 Screens

In dependency order: Login → Home → Dealer list → Dealer detail → Transaction
form → Payment form → Entry detail → Void dialog → All transactions → Audit log →
Account.

### 4.3 The rules that get tested, not just reviewed

- Live totals use the **same** `money/` module as the server (FR-T4).
- Filtering **never** changes the headline or the running-balance column, and
  always shows the "N of M" notice (Scenario F, §6.6).
- No screen renders the words "debit" or "credit", or a bare sign.
- The edit form does not expose date, amount, quantity, rate, GST rate, discount,
  freight, dealer, or mode (FR-A6).

### 4.4 Tests

- E2E Scenario A on a 360 px viewport.
- Filter test: apply OD filter, assert headline unchanged and notice present.
- Draft survives a simulated navigation away and back.
- Save failure preserves input and keeps the draft.

**Exit criteria:** Scenario A completed on a phone-sized viewport in under 60
seconds, with every figure matching the SRS.

---

## Phase 5 — Export

**Goal:** the accountant opens the file and does not clean it.

### 5.1 Build

- **Shared row-builder** first — both writers consume it so the formats cannot
  drift (§11.2).
- The single sanctioned `paise / 100` conversion lives here and nowhere else.
- SheetJS writer: numeric money cells with format `#,##0.00`, **real Excel
  dates**, frozen bold header, column widths set so nothing renders `####`.
- CSV writer over the same rows.
- Three exports: dealer ledger, all transactions, dealer balances (§11.3).
- **Fourth export — the full data backup** ([TRD.md §10.1](TRD.md)): every table,
  unfiltered, money left as **integer paise**. Downloaded; the owner saves it to
  Google Drive manually. Whether it is re-importable is open item 0.2g.
- Title block with business name, filters applied, closing balance in plain
  language, generation timestamp. Totals row beneath.
- Pagination handling for large ranges.

### 5.2 Tests

- Exported figures reconcile **exactly** with on-screen figures.
- Money cells are numeric, not text; `SUM` works.
- Dates are real Excel dates.
- **Voided rows are present**, flagged `VOIDED`, with the reversal on the next
  row — never silently dropped.
- Column S is numerically negative for a payable while column T reads "You owe
  dealer".
- CSV and XLSX produce identical row content.

**Exit criteria:** a dealer-ledger export of Scenario C opens in Excel, sums
correctly, and shows −3,19,592 in column S with "You owe dealer" in column T.

---

## Phase 6 — Hardening and release

**Goal:** safe to trust with the only copy of the business ledger.

### 6.1 Tasks

- **PWA**: manifest, icons, service worker precaching the **app shell only**.
  Network-only for every `/api/*` request — no stale-while-revalidate, no
  offline fallback that could render a figure (§10.10).
- **Accessibility pass**: axe clean, AA contrast, focus rings, real labels, no
  colour-only meaning, dialog focus trapping.
- **All states**: loading, empty, error defined on every screen — including the
  dealer detail rule that an uncertain balance shows **an error, never a number**.
- **Integrity check**: on-demand replay-and-compare across all dealers.
- **Backup**: D1 Time Travel verified by an actual restore, plus the full data
  export of Phase 5.1 (0.1). No R2.
- Production D1 provisioning, secrets, first credential seed (§19).

### 6.2 Release gate

The full checklist from [TRD.md §15](TRD.md), verified rather than assumed:

1. No floating-point money anywhere.
2. All paise arithmetic inside `money/`.
3. `ledger/` imports nothing from `db/`.
4. Every multi-row write is one `db.batch([...])`.
5. Nothing financial is hard-deleted.
6. Order key is always `(entry_date, id)`.
7. The bank tag never affects a posting or a headline.
8. `formatPaise()` is the only money formatter.
9. No financial data cached in the service worker.
10. Server-side Zod validation always re-run.

Plus: **all six §6 scenarios green**, and the §15.3 atomicity test green.

---

## Risk Register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Building on guessed spec | 0 | Phase 0 exists for this; every assumption marked and signed off |
| A float reaches a money path | 1 | Lint rule + `money/` isolation + server-boundary rejection |
| D1 batch cannot resolve generated ids | 2 | Pre-allocate primary keys; never split the batch |
| Back-dated entry leaves stale balances | 2 | Replay trigger + integrity check |
| Bank tag misread as a second ledger | 4 | Scenario F test + the mandatory "N of M" notice |
| Service worker caches a balance | 6 | Network-only `/api/*`; explicit test |
| D1 is the only copy of the ledger | 6 | Backup posture required before production use |

---

## Definition of Done

The product is done when all of the following hold:

- [ ] All six §6 acceptance scenarios pass, reproducing every figure exactly
- [ ] The §15.3 forced-mid-batch-failure test passes with zero partial rows
- [ ] Replay from zero reproduces every stored running balance for every dealer
- [ ] No `parseFloat` / `toFixed` / bare `Math.round` exists outside `src/money/`
- [ ] The interface contains no "debit", no "credit", and no bare sign
- [ ] Filtering never alters a headline or a running-balance column
- [ ] Exports open in Excel with numeric money and real dates; `SUM` works
- [ ] Voided entries appear in exports, flagged, with their reversals
- [ ] Every non-public route rejects an unauthenticated request
- [ ] Accessibility: AA contrast, no colour-only meaning, screen-reader direction
- [ ] The service worker caches no financial data
- [ ] A backup posture exists and has been tested by restoring
