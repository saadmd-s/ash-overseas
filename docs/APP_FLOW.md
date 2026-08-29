# Application Flow

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Derived from [SRS.md](../SRS.md) §10

> **[SRS.md](../SRS.md) is authoritative.** This document traces the paths a user
> takes through the application, the state each screen can be in, and what
> happens on the server at each step.
>
> **The SRS is complete**; this document is reconciled against it.

---

## 1. Navigation Map

From SRS §10.2:

```
[ Login ]
    │  (session cookie set)
    ▼
[ Home ]
   ├── [ PURCHASE ] ──→ Dealer list (suppliers)  ──→ [ Dealer ]
   ├── [ SALE ]     ──→ Dealer list (buyers)     ──→ [ Dealer ]
   ├── [ All transactions ]  (cross-dealer view + filters + export)
   ├── [ New dealer ]
   ├── [ Audit log ]
   └── [ Account ]  (change username / password, sign out)

[ Dealer ]
   ├── Balance headline — "Dealer owes you ₹X" / "You owe dealer ₹X" / "Settled"
   ├── History (transactions + payments, date order, running balance per row)
   ├── Filters: date range · type · mode · bank account
   ├── [ + Transaction ]   [ + Payment ]   [ Export ▾ ]
   └── Row tap ──→ [ Entry detail ] ──→ [ Void ]
```

Every route is behind the auth gate. There is no public page (FR-U3).

## 2. Entry Points

| Entry | Lands on | Notes |
| --- | --- | --- |
| App icon (installed PWA) | Home, or Login if no valid session | Shell served from cache; data always from network |
| Direct URL | Requested screen, or Login with a return path | |
| Session expiry mid-use | Login, with unsaved form draft preserved in `localStorage` | Draft survives; see §7.2 |

## 3. Authentication Flow

```
   ┌──────────┐
   │  Login   │◄──────────── 401 from any API call
   └────┬─────┘
        │ username + password
        ▼
  POST /api/auth/login
        │
        ├── invalid ──→ ~½s deliberate delay, THEN a generic 401
        │                (no hint about which field was wrong)
        │
        └── valid ──→ Set-Cookie (HttpOnly; Secure; SameSite=Strict)
                      HMAC-signed with AUTH_SECRET, 30-day expiry
                      audit_log: action='login'
                      ──→ Home (or the originally requested screen)
```

On load, the client calls `GET /api/auth/me` to decide between Login and Home.

**Sign out** clears the cookie via `POST /api/auth/logout` and returns to Login.

**Changing credentials** (Account screen) re-requires the current password for
both username and password changes (FR-U2), and writes a `credential_change`
audit row.

**Session lifetime — decided by the owner, 29 Aug 2026:** a 30-day cookie,
refreshed on use, with **no inactivity lock and no re-authentication prompt
inside the app**. The app opens straight to Home; the phone's own lock screen is
the security boundary. See [TRD.md §9.1](TRD.md) for the reasoning and the
accepted trade-off.

**§16.1 answers the throttling question:** a wrong login gets a **deliberate
~½ second delay** before its 401, so the endpoint cannot be hammered cheaply.
There is no lockout — a lockout on a single-user app is a self-denial-of-service
waiting to happen. A WAF rate-limit rule in front of the login endpoint is
optional hardening (§19.3) and needs a custom domain.

Note also **§16.1's development escape hatch**: if `AUTH_SECRET` is unset the
gate is **disabled entirely**. That is a local convenience only, and the build
must refuse to start in production mode without it.

## 4. Primary Flow — Record a Sale

The most frequent path in the product. Target: under 60 seconds on a phone.

```
[ Home ]
   │ tap SALE
   ▼
[ Dealer list — buyers ]        GET /api/dealers?type=buyer
   │ search, tap dealer          each row shows balance + direction inline
   ▼
[ Dealer detail ]               GET /api/dealers/:id
   │                            GET /api/dealers/:id/ledger
   │ tap [ + Transaction ]       mode pre-set to 'sale', dealer pre-set
   ▼
[ New transaction form ]
   │
   │  Date defaults to today (IST). Future dates blocked.
   │  Item / Quantity / Rate entered.
   │  ── base total, GST, grand total recompute LIVE on every keystroke ──
   │  GST % pre-filled 18. Bank account defaults to last used.
   │  Draft autosaves to localStorage on every change.
   │
   │ tap Save
   ▼
POST /api/transactions           body: all money as integer paise
   │
   │  Server: Zod validation (authoritative, re-run in full)
   │          money/ recomputes totals — server figures win
   │          ledger/ decides the posting: SALE → debit grand total
   │          posting/ issues ONE db.batch([...]):
   │              1. allocate human-ID sequence
   │              2. insert transactions header
   │              3. insert transaction_lines
   │              4. insert ledger_entries (running balance computed)
   │              5. insert audit_log
   │
   ├── failure ──→ input preserved, actionable error shown, draft kept
   │
   └── success ──→ draft cleared
                   toast naming what was saved
                   ▼
              [ Dealer detail ]  headline and history refreshed
```

### 4.1 If the entry is back-dated

If the saved entry's `(entry_date, id)` position is **not** last for that dealer,
every later entry now carries a stale running balance. The server runs
`recomputeLedger(dealerId)` before responding, so the client always receives
correct figures.

**Confirmed by §15.5 and §15.6.** Replay runs after any back-dated insert "that
lands before existing entries", and §15.6 states plainly that a back-dated entry
is legitimate and must be supported: the application posts the row, then runs
`recomputeLedger(dealerId)`. **The stored balance is never left stale.**

## 5. Primary Flow — Record a Payment

```
[ Dealer detail ]
   │ tap [ + Payment ]
   ▼
[ New payment form ]
   │  Direction shown as two plain-language options:
   │      "Received from dealer"  /  "Paid to dealer"
   │  NEVER as debit/credit.
   │  Amount > 0. Method optional. Bank tag hidden when method = cash.
   │
   │ tap Save
   ▼
POST /api/payments
   │  received → credit    paid → debit
   │  ONE db.batch: payment row + ledger entry + audit row
   │
   └── success ──→ [ Dealer detail ], headline refreshed
```

## 6. Flow — Void a Correction

Nothing is ever deleted (FR-A1). The full correction path:

```
[ Dealer detail ]
   │ tap a history row
   ▼
[ Entry detail sheet ]
   │  Full breakdown: every line item, base, discount, freight,
   │  GST rate and amount, round-off, grand total, notes, audit trail.
   │
   │ tap [ Void ]
   ▼
[ Confirmation dialog ]          names the entry AND the amount (FR-A2)
   │                             e.g. "Void SALE-2026-08-0039 for ₹2,19,952?"
   │ confirm
   ▼
POST /api/transactions/:id/void   (or /api/payments/:id/void)
   │
   │  ONE db.batch([...]):
   │      1. UPDATE source SET is_voided = true      (rows retained)
   │      2. INSERT reversing ledger_entries row
   │             equal and opposite, source_type='reversal',
   │             reverses_entry_id → the original entry
   │      3. INSERT audit_log with before/after JSON
   │  Then: recomputeLedger(dealerId) — replay in (entry_date, id) order
   │
   └── success ──→ [ Dealer detail ]
                   original row struck through
                   reversal row displayed adjacent
                   headline back to the pre-void position
```

Worked example (Scenario E): voiding the ₹2,19,952 "ASH 42" sale from a balance
of −3,19,592 posts a credit of 2,19,952 and returns the balance to −5,39,544.

### 6.1 Editing without voiding

Non-financial fields — notes, reference tag, item name spelling — may be edited
in place (FR-A6):

```
[ Entry detail sheet ] → tap Edit → PATCH /api/transactions/:id
                                    → audit_log row written
```

**Any** change to a date, amount, quantity, rate, GST rate, discount, freight,
dealer, or mode requires void + re-entry. The edit form must not expose those
fields at all — the constraint is enforced in the interface, not just the API.

## 7. Flow — Filter the History

This flow carries the product's most easily-broken promise (Principle P3), so it
gets its own explicit path.

```
[ Dealer detail ]
   │ open Filters
   ▼
Apply: date range · type · mode · bank account
   │
   ▼
GET /api/dealers/:id/ledger?from=&to=&type=&mode=&bankAccount=
   │
   ▼
[ Dealer detail — filtered ]
   │
   │  ✓ History shows the matching subset
   │  ✓ Headline balance UNCHANGED — computed over ALL entries
   │  ✓ Running balance column UNCHANGED — the true running balance,
   │      not a re-run over the subset
   │  ✓ Notice displayed: "Filtered — showing 1 of 2 entries"
   │
   └── clear filters ──→ full history restored
```

Scenario F is the test: an OD sale of 59,000 and a Current sale of 1,18,000 give
one headline of **+1,77,000**. Filtering to "OD only" shows one row, and the
headline still reads ₹1,77,000.

## 8. Flow — Export

```
[ Dealer detail ]  or  [ All transactions ]  or  [ Home ]
   │ tap [ Export ▾ ]
   ▼
Choose format: Excel (.xlsx) | CSV
   │
   ▼
GET /api/export/dealer/:id?…    (filters from the current screen)
   │  returns rows with money as INTEGER PAISE
   │  paginates if the range is large — client concatenates
   ▼
Client-side export module
   │  shared row-builder  ──┬──→ SheetJS  → .xlsx
   │                        └──→ CSV writer → .csv
   │  the ONE sanctioned paise ÷ 100 conversion happens here
   │  subtitle row records exactly which filters were applied
   │  voided rows INCLUDED, flagged VOIDED, reversal on the next row
   ▼
Browser download: <Dealer>-ledger-<YYYY-MM-DD>.xlsx
```

## 9. Screen States

Every screen defines loading, empty, and error states explicitly (§10.10).

| Screen | Loading | Empty | Error |
| --- | --- | --- | --- |
| Home | Skeleton dealer rows | "No dealers yet" + New dealer CTA | Retry, no figures shown |
| Dealer list | Skeleton rows | "No suppliers yet" / "No buyers yet" | Retry |
| Dealer detail | Skeleton headline + rows | Headline "Settled" + "No entries yet" | **Error instead of a number** — never a guessed balance |
| Transaction form | Disabled save | n/a | Inline field errors; input preserved |
| Payment form | Disabled save | n/a | Inline field errors; input preserved |
| All transactions | Skeleton rows | "No transactions match these filters" | Retry |
| Audit log | Skeleton rows | "No activity yet" | Retry |
| Export | Progress indicator | "Nothing to export in this range" | Actionable error, no partial file |

**The dealer detail error state matters most.** If the balance cannot be computed
with certainty, the screen shows an error, never a number. A wrong figure shown
confidently is worse than no figure.

## 10. Validation Gates

Client-side validation gives fast feedback; **server-side validation is
authoritative and re-runs in full** (§10.9).

| Field | Rule | Where it fails |
| --- | --- | --- |
| Quantity | Required, number ≥ 0 | Inline, on blur |
| Rate | Required, integer paise ≥ 0 | Inline, on blur |
| Line count | ≥ 1 per transaction | Save blocked |
| GST rate | 0–100 inclusive | Inline |
| Payment amount | Integer paise, strictly > 0 | Inline |
| Discount | Integer paise ≥ 0, **may not exceed base total** | On totals recompute |
| Freight | Integer paise ≥ 0 | Inline |
| Date | Required, not later than today **in IST** | Date picker max |
| Dealer | Must exist and not be archived | Picker excludes archived |
| Bank account | Required on transactions; `od` or `current` | Save blocked |
| Money fields | Integer paise only — floats, `NaN`, out-of-range rejected | **Server boundary, always** |

## 11. Error and Recovery Paths

| Situation | Behaviour |
| --- | --- |
| Network drops mid-form | Draft persists in `localStorage`; form restores on return |
| Save fails | Input preserved, actionable error, draft **not** cleared |
| Session expires mid-form | Redirect to Login; draft survives; returns to the form after sign-in |
| Batch write fails | **Zero partial rows** — no transaction header without its ledger entry (§15.3) |
| Stale running balance suspected | `recomputeLedger(dealerId)` replays from zero; divergence is a defect, not a rounding artefact |
| Offline launch | Shell loads from cache; **no financial data shown** — network-only for `/api/*` |

## 12. Data Freshness

The service worker precaches the application shell only. Every `/api/*` request
is **network-only** — no stale-while-revalidate, no offline fallback that could
render a figure (§10.10).

The reasoning is stated plainly in the SRS and is worth repeating: *a stale
balance is a dangerous balance.* The owner may be standing in front of the dealer
when they read it.
