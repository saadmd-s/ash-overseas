# Product Requirements Document

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Derived from [SRS.md](../SRS.md)

> **[SRS.md](../SRS.md) is authoritative on every business rule.** This PRD
> exists to state _why_ the product is being built, _who_ it is for, and _what
> counts as done_. Where a figure or rule appears in both, the SRS wins.
>
> **The SRS is complete** (transcribed in full, 29 Aug 2026). This document is
> reconciled against it.

---

## 1. Problem

The business trades metal castings, scrap, and similar materials — buying from
some dealers, selling to others, and often both with the same dealer. It runs on
credit and on advances: goods and money almost never settle in one exchange. A
dealer may pre-pay a large advance drawn down over several shipments, or take
delivery first and pay weeks later.

All of this currently lives in a hand-written notebook. That produces three
concrete failures:

1. **No reliable net position.** Answering "what do I owe this dealer right now?"
   means adding up months of entries by hand, and the answer is only as good as
   the arithmetic done in the moment.
2. **Recomputation is manual and error-prone.** Every new shipment or payment
   changes the running balance for that dealer, and the correction has to be
   carried down the page by hand.
3. **Handing figures to the accountant is slow.** Pulling one dealer's history
   together means leafing through the notebook and re-copying it.

The cost is not just time. A wrong balance in a negotiation is money lost.

## 2. Product Vision

A faithful digital version of the owner's working notebook — one that never
drops an entry, never miscarries a running balance, shows the net position with
any dealer instantly, and hands the whole thing to Excel on demand.

Explicitly **not** an accounting package. It does not file taxes, does not
generate legal invoices, and does not replace the software used for statutory
filing.

## 3. Users

| User               | Role                                     | Needs                                                                                                                                             |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The owner**      | The only operational user                | Enter a shipment or payment in under a minute on a phone, mid-conversation. See any dealer's net position at a glance. Export for the accountant. |
| **The maintainer** | Owns the repo and the Cloudflare account | Deploy, migrate, and recover credentials. Does **not** use the app for business.                                                                  |
| **The accountant** | Indirect — receives exports              | A spreadsheet that sorts, filters, and `SUM`s without cleaning.                                                                                   |

There is no sign-up, no multi-user role system, and no public route (FR-U3).

### 3.1 Operating Context

The owner enters records **on a phone, on the move, often in a hurry** — sometimes
standing at a weighbridge, sometimes mid-negotiation. This drives nearly every
interface decision: mobile-first layout, thumb-reachable actions, live-computed
totals so there is no surprise on save, and draft persistence so a dropped
connection never costs a half-typed entry.

## 4. Goals & Non-Goals

### 4.1 Goals

- **G1** One accurate, always-current signed balance per dealer.
- **G2** Record a goods transaction or a money movement in well under a minute on a phone.
- **G3** Make the direction of money unmistakable — never a bare sign, never colour alone.
- **G4** Make every figure traceable: nothing is deleted, every correction is an auditable reversal.
- **G5** Export any view to a real spreadsheet the accountant can use directly.

### 4.2 Non-Goals

These are out of scope for this edition and should not be built "just in case":

- Multi-user access, roles, or permissions.
- Statutory GST filing, e-invoicing, or e-way bills.
- CGST/SGST vs IGST split (§8.3 — a display-only addition later, if ever).
- Inventory or stock levels. The app records movements of goods, not holdings.
- Advance "buckets", FIFO matching, or allocating a payment against a specific invoice.
- Separate purchase and sale sub-balances.
- Full offline sync. Draft persistence only (§10.6) — a stale balance is a dangerous balance.
- Re-importable exports or any integration format (§11.5).
- Scheduled or emailed exports.

## 5. The Three Product Principles

Every feature decision traces back to one of these. They are the SRS §4 core
concepts, restated as product rules.

### P1 — One balance per dealer

Exactly one signed running balance per dealer, from the business's point of
view: **positive means the dealer owes the business**, **negative means the
business owes the dealer**, **zero means settled**.

Goods and money in either direction move this one number. It crosses zero with
no special handling — an advance simply carries the balance negative until
shipments bring it back up and past zero.

### P2 — Purchase and Sale are labels, not ledgers

They organise the interface: they filter the dealer lists and pre-set the mode
on a new entry. They **never** split a dealer's money into two pots. A dealer
the business both buys from and sells to appears in both lists and has one
consolidated balance.

### P3 — The bank account tag is a tag

OD vs Current records which of the _business's own_ accounts the money ran
through, so the owner can ask "what went through the OD this month?" and so
exports can be subtotalled. It never splits a balance, never changes a posting
rule, and never affects the headline figure.

This one is the easiest to get wrong, so it has a dedicated acceptance test
(Scenario F) and a dedicated interface rule: filtering the history by bank
account must leave the headline and the running-balance column untouched, and
must show a "showing N of M entries" notice.

## 6. Feature Set

Grouped by user job. The FR-* identifiers are the authoritative requirement IDs
from SRS §9.

### 6.1 Manage dealers — FR-D1…D6

Create a dealer with name, contact, address, GSTIN, and state code. A dealer
carries a type (supplier / buyer / both) used **only** to filter the two lists.
Dealers can be edited and archived — never deleted — and can be seeded with an
opening position recorded as a proper `opening` ledger entry rather than a
mutable field.

### 6.2 Record goods — FR-T1…T10

A purchase or a sale against one dealer on one date, with one or more line items
(item name optional, quantity and rate required, unit free text). The form shows
the base total, GST amount, and grand total **live as the owner types**,
including the round-off when non-zero. GST rate is per-transaction, pre-filled
at 18%. Bank account is required and defaults to the last used. Optional:
reference tag ("ASH 39"), discount, freight, return/credit-note marker, invoice
number and date, notes.

Every transaction gets a human-readable ID — `SALE-2026-08-0039` — generated
inside the same atomic write.

### 6.3 Record money — FR-P1…P3

Money received from or paid to a dealer, on a date, amount greater than zero.
Optional method (cash / bank / cheque / UPI), reference (cheque no., UTR), bank
account tag (hidden for cash), notes.

### 6.4 See the position — FR-L1…L5, FR-N1…N4

Each dealer leads with a plain-language headline: "Dealer owes you ₹X", "You owe
dealer ₹X", or "Settled". Below it, the full history — transactions and payments
interleaved in date order — with the running balance after every entry. Filters
for date range, type, mode, and bank account, none of which touch the headline.
A cross-dealer "all transactions" view with its own filters.

### 6.5 Correct mistakes — FR-A1…A6

Nothing financial is ever deleted or edited into a different figure. A correction
**voids** the original: the source is flagged, an equal and opposite reversing
entry is posted and linked, the ledger is replayed, and an audit row is written.
Voiding requires a confirmation dialog naming the entry and the amount. Voided
entries show struck through with their reversal adjacent.

Non-financial fields — notes, reference tag, item name spelling — may be edited
in place, and the edit is audited. Any change to a date, amount, quantity, rate,
GST rate, discount, freight, dealer, or mode requires a void and re-entry.

### 6.6 Hand it to the accountant — FR-X1…X5

Three exports — dealer ledger, all transactions, dealer balances — each as a real
`.xlsx` with typed numeric money columns and typed dates, plus a CSV alternative.
Each honours the filters visible on screen and states those filters in a subtitle
row so a file can never be misread out of context. Voided rows are **included**
and flagged, never silently dropped.

### 6.7 Keep it private — FR-U1…U3

The entire application, every page and every API route, sits behind a single-user
username and password gate. The owner can change both from inside the app, each
change re-requiring the current password. Recovery is a maintainer operation.

## 7. Release Scope

**Per SRS §23.** Each phase has a gate; the next does not begin until it is
green. Detail in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

| Phase                 | Contents                                                                  | Done when                                                            |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **1 — Ledger core**   | Money-math module, pure ledger engine, D1 schema, migrations              | All six §6 scenarios pass as automated tests against the pure engine |
| **2 — Posting & API** | Posting layer on `db.batch`, auth gate, dealer/transaction/payment routes | Mid-batch failure leaves zero partial rows (§15.3 integration test)  |
| **3 — Interface**     | Home, dealer list, dealer detail, transaction form, payment form          | Owner can complete Scenario A end-to-end on a phone                  |
| **4 — Export**        | Shared row-builder, SheetJS writer, CSV writer, three exports             | Exported figures reconcile exactly with on-screen figures            |
| **5 — Hardening**     | Audit view, PWA shell, accessibility pass, error states                   | AA contrast, no colour-only meaning, all states defined              |

## 8. Success Criteria

The product is successful when the notebook is closed for good. Concretely:

| #      | Criterion                              | Measure                                                                                  |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| **S1** | Every §6 figure reproduces exactly     | Six automated acceptance tests pass                                                      |
| **S2** | Entry is faster than the notebook      | A single-line transaction saved in under 60s on a phone                                  |
| **S3** | The balance is never wrong             | Replay from zero always equals the stored running balance                                |
| **S4** | No entry is ever lost                  | Zero hard deletes; every correction has a linked reversal and an audit row               |
| **S5** | The accountant does not clean the file | Export opens in Excel with money as numbers and dates as dates, `SUM` works on first try |
| **S6** | Direction is never misread             | Every balance carries icon + text; no colour-only signalling                             |

## 9. Risks

| Risk                                             | Impact                                                                         | Mitigation                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| A float creeps into money handling               | Silent, compounding corruption of every balance                                | Integer paise everywhere; one money-math module owns all arithmetic; lint rule banning `parseFloat`/`toFixed` in money paths |
| D1 has no interactive transactions               | A half-written transaction leaves an orphaned ledger entry and a wrong balance | Every multi-row write is one `db.batch([...])`; forced mid-batch failure is an explicit test (§15.3)                         |
| Bank tag is mistaken for a second ledger         | Balances split; the core promise breaks                                        | Scenario F as a test; filter shows "N of M" notice; headline computed over all entries always                                |
| PWA caches a stale balance                       | Owner negotiates on a wrong figure                                             | Cache the app shell **only**; never cache financial data (§10.10)                                                            |
| Back-dated entry inserted after later entries    | Running balances below it are stale                                            | §15.6: post the row, then `recomputeLedger(dealerId)`. The stored balance is never left stale                                |
| Backup exists but was never restored             | Discovering at the worst moment that it does not work                          | NFR-B3 makes a **verified** restore the gate, not a document                                                                 |
| PBKDF2 iterations pass tests, fail in production | The app cannot be deployed, or worse, ships ungated                            | §16.1 caps iterations at 100,000; assert the constant in a test                                                              |

## 10. Open Product Questions

### 10.1 Answered

| Question                  | Answer                                                                                | Source                                         |
| ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Framework                 | **Vite + React + Hono on Workers**                                                    | Owner 29 Aug; **confirmed by SRS §18**         |
| Human-ID sequence storage | **Dedicated `id_sequences` table**                                                    | Owner 29 Aug; still absent from the SRS        |
| Backup and retention      | **D1 Time Travel + `wrangler d1 export` SQL dumps. No R2 — it needs a card on file.** | Owner 29 Aug; **confirmed by §17.3 NFR-B1–B3** |
| Session lifetime          | **30-day cookie, no inactivity lock**                                                 | Owner 29 Aug; **confirmed by §16.1**           |
| Login throttling          | **~½ second delay before a wrong login's 401.** No lockout.                           | §16.1                                          |
| Credential recovery       | **Maintainer re-runs the login-setup script** against production. No email reset.     | §19.5                                          |

The restore gap this document previously raised is **closed**: §17.3 specifies a
SQL dump, which restores. §11.5's "not re-importable" applies only to the
human-facing Excel and CSV exports.

One trade-off remains worth stating plainly: the session decision accepts that an
unlocked, unattended phone gives full access, including voiding entries. §16.5
puts this explicitly out of the threat model, mitigated only by the 30-day expiry
and the sign-out action.

### 10.2 Open — the four items from SRS §22

All non-blocking, all the owner's call, all confirmable during the build:

1. **Should the bank account tag be required on cash payments**, or stay omitted
   as specified?
2. **Should dealer history default to newest-first or oldest-first?** Both are
   supported; only the default is in question.
3. **Should the "All transactions" export include payments**, or stay
   transactions-only as specified?
4. **Business name, logo, and colour accent** for the login screen and the export
   title block.

### 10.3 Open — engineering

1. **Batch ID-allocation mechanism** — the SRS does not address it. Decide in
   Phase 1; see [TRD.md §5.1](TRD.md).
2. **`source_id` convention for `opening` and `reversal`** — still unstated even
   in the complete SRS. Derived reading in [BACKEND_SCHEMA.md §4.5](BACKEND_SCHEMA.md).

---

## Traceability

| PRD section         | SRS source                       |
| ------------------- | -------------------------------- |
| §1 Problem          | §3.1, §3.2                       |
| §3 Users            | §1.3, §3.3                       |
| §5 Principles       | §4.1, §4.2, §4.3, §5             |
| §6.1 Dealers        | §9.1 (FR-D1…D6)                  |
| §6.2 Goods          | §9.2 (FR-T1…T10), §8             |
| §6.3 Money          | §9.3 (FR-P1…P3)                  |
| §6.4 Position       | §9.4 (FR-L1…L5), §9.6 (FR-N1…N4) |
| §6.5 Corrections    | §9.5 (FR-A1…A6)                  |
| §6.6 Export         | §9.7 (FR-X1…X5), §11             |
| §6.7 Auth           | §9.8 (FR-U1…U3)                  |
| §8 Success criteria | §6 scenarios A–F                 |
