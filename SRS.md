# Trading Ledger — Simplified Edition

## Software Requirements Specification

**Prepared by:** Suhaib
**Version:** 1.0 — Simplified scope
**Date:** 29 August 2026
**Status:** Approved scope — ready for development
**Target accounts:** maintainer's GitHub organisation/account (private repo) and maintainer's Cloudflare account

> This document is **self-contained and authoritative** for the simplified application. It supersedes the earlier dual-valuation specification for this build. Appendix A lists exactly what changed and why, for anyone who has seen the earlier document.

---

## Table of Contents

1. Introduction
2. Glossary
3. Business Context
4. Core Concepts
5. Sign Convention & Balance Behaviour
6. Worked Scenarios (Acceptance Tests)
7. Posting Rules
8. Amounts, GST & Rounding
9. Functional Requirements
10. User Interface Specification
11. Excel Export Specification
12. Data Model
13. Database Schema (Cloudflare D1 / Drizzle)
14. API Specification
15. Ledger Computation & Integrity
16. Security Requirements
17. Non-Functional Requirements
18. Technology Stack & Deployment
19. Provisioning in the Maintainer's Accounts
20. Testing Strategy
21. Scope Boundaries
22. Assumptions & Open Items
23. Delivery Plan
- Appendix A — Differences from the dual-valuation specification
- Appendix B — Money-math reference implementation

---

## 1. Introduction

### 1.1 Purpose

This document specifies, in full, the requirements for a private web application that records the day-to-day buying and selling activity of the business with its dealers. It replaces hand-written note records and paper ledgers with a searchable, always-current digital ledger, and it can export any part of that ledger to Excel.

It is the single source of definition for the application's behaviour, data model, and technology. Where any question of business rule arises during development, this document is authoritative.

### 1.2 Scope

The application maintains, for every dealer, a chronological record of:

- **Transactions** — goods purchased from or sold to that dealer, with quantity, rate, GST and total; and
- **Payments** — money received from or paid to that dealer.

From these it maintains **one signed running balance per dealer** and presents, at any moment, the net position: how much that dealer owes the business, or how much the business owes that dealer. Every view can be exported to Excel.

The application does **not** file taxes, generate legal invoices, or replace accounting software used for statutory filing. It is a faithful digital version of the owner's working notebook.

### 1.3 Intended Users

A **single user** — the business owner — operates the application. A separate **technical maintainer** owns the repository and the hosting account but does not use the application for business operations. There is no public sign-up and no multi-user role system.

### 1.4 Document Conventions

All monetary values in this document are written in rupees for readability. Internally, every monetary value is stored as an **integer number of paise** (₹1 = 100 paise). Rupee formatting happens only at display and export time.

The words "debit" and "credit" are defined in Section 5, always from the business's point of view. The user never sees those words in the interface.

---

## 2. Glossary

| Term | Meaning |
| --- | --- |
| **Dealer** | Any party the business buys from or sells to. A dealer may be a supplier, a buyer, or both. |
| **Transaction** | A movement of goods — a purchase from a dealer, or a sale to a dealer. Carries one or more item lines, a GST rate, and a total. |
| **Line item** | A single row within a transaction: item name (optional), quantity, unit, rate, and the resulting amount. |
| **Payment** | A movement of money — an advance, a part-payment, or a settlement — recorded independently of any single transaction. |
| **Bank account tag** | A label on each entry recording which of the **business's own** bank accounts the money runs through: **OD** (overdraft account) or **Current** (current account). It is a tag and a filter only; it never splits a dealer's balance. |
| **Running balance** | The single signed net position with a dealer after every entry, in date order. |
| **Reference tag** | The owner's own shipment label (for example "ASH 39"), recorded alongside the system identifier. |
| **Void** | Cancelling an entry by posting an equal and opposite reversing entry. Nothing is ever deleted. |
| **Paise** | One-hundredth of a rupee; the integer unit in which all money is stored. |

---

## 3. Business Context

### 3.1 What the Business Does

The business trades materials — metal castings, scrap, and similar goods — buying from some dealers and selling to others. Some dealers are both suppliers and buyers at different times. The business runs on credit and on advances: money and goods rarely settle in a single immediate exchange. A dealer may pre-pay a large advance against which goods are delivered over time; equally, goods may be delivered first and paid for later.

### 3.2 The Central Problem

On paper, this becomes hard to manage. There is no single reliable view of the net position with each dealer; recomputing the running balance after every shipment and payment is manual and error-prone; and pulling a dealer's history together for a discussion or for the accountant means leafing through months of notes.

The application exists to hold every entry accurately, keep the running balance correct automatically, present the net position with each dealer instantly, and hand the whole thing to Excel on demand.

### 3.3 Operating Pattern

The owner thinks in terms of two top-level activities — **Purchase** and **Sale** — and, under each, the list of dealers he transacts with for that activity. Selecting a dealer reveals that dealer's single account: every transaction and payment in date order, with the running balance after each.

---

## 4. Core Concepts

The application rests on three ideas. Everything else serves them.

### 4.1 One Balance Per Dealer

Each dealer has **exactly one** signed running balance. Goods and money flowing in either direction move this one number up or down. There are no advance "buckets" to allocate shipments against, no first-in-first-out matching, and no separate purchase and sale sub-balances.

A dealer who has given an advance simply has a balance saying the business owes them; as goods are delivered, that balance moves toward zero and may cross it. A dealer the business both buys from and sells to appears in both lists and still has **one** balance covering everything.

### 4.2 Purchase and Sale Are Labels, Not Separate Ledgers

Purchase and Sale organise the interface — they filter the dealer lists and pre-set the type of a new entry — but they do **not** split a dealer's money into two pots.

### 4.3 The Bank Account Tag Is a Tag

Every transaction (and, where relevant, every payment) records whether it runs through the business's **overdraft (OD)** account or its **current** account. This exists so the owner can answer "what went through the OD this month?" and so the Excel export can be filtered or subtotalled by account.

It is **not** a second ledger. It never splits a dealer's balance, never changes a posting rule, and never affects the headline figure. A dealer with one OD sale and one Current sale has one balance covering both.

---

## 5. Sign Convention & Balance Behaviour

Each dealer has one signed running balance. The sign is defined from the business's point of view:

- **Positive balance → the dealer owes the business** (a receivable).
- **Negative balance → the business owes the dealer** (a payable; for example, the dealer is holding an advance with the business).
- **Zero → settled.**

Two ledger movements drive the balance:

- A **debit** increases what the dealer owes the business (moves the balance up, toward positive).
- A **credit** increases what the business owes the dealer (moves the balance down, toward negative).

```
running_balance = Σ(debit) − Σ(credit)
```

The user never sees the words "debit" and "credit", and never sees a bare `+` or `−`. The interface always translates the signed balance into plain language:

- **"Dealer owes you ₹X"** when positive
- **"You owe dealer ₹X"** when negative
- **"Settled"** at zero

The direction must also be conveyed by an icon and by text, never by colour alone.

---

## 6. Worked Scenarios (Acceptance Tests)

These scenarios define correct behaviour precisely. The ledger engine must reproduce **every figure below exactly**. They are the application's primary acceptance tests and must be implemented as automated tests before the ledger is considered complete.

### 6.1 Scenario A — Money and goods moving both ways

A dealer the business both buys from and sells to. GST 18% throughout.

| Step | Date | Event | Calculation | Posting | Balance |
| --- | --- | --- | --- | --- | --- |
| 1 | 01 Aug | Money received from dealer ₹6,00,000 | — | credit 6,00,000 | −6,00,000 |
| 2 | 05 Aug | **Sale** 1,000 kg × ₹200 | base 2,00,000 + GST 36,000 = 2,36,000 | debit 2,36,000 | −3,64,000 |
| 3 | 10 Aug | **Purchase** 500 kg × ₹100 | base 50,000 + GST 9,000 = 59,000 | credit 59,000 | −4,23,000 |
| 4 | 15 Aug | Money paid to dealer ₹1,00,000 | — | debit 1,00,000 | −3,23,000 |

Final headline: **"You owe dealer ₹3,23,000."**
A single number moves in both directions with no special handling.

### 6.2 Scenario B — GST and invoice round-off

A single sale, 9,510 kg × ₹24.00, GST 18%.

```
base    = 9,510 × ₹24.00        = ₹2,28,240.00   (22,824,000 paise)
gst     = ₹2,28,240.00 × 18%    =   ₹41,083.20   ( 4,108,320 paise)
raw     = base + gst            = ₹2,69,323.20   (26,932,320 paise)
posted  = round to nearest ₹1   = ₹2,69,323.00   (26,932,300 paise)
round_off = posted − raw        =      −₹0.20    (       −20 paise)
```

The transaction stores `round_off_paise = −20`. The ledger is debited **₹2,69,323.00** — the rounded figure, so balances always match the owner's rupee-based working figures.

### 6.3 Scenario C — Advance against two shipments

| Step | Date | Event | Calculation | Posting | Balance |
| --- | --- | --- | --- | --- | --- |
| 1 | 02 Jul | Advance received | — | credit 8,08,867 | −8,08,867 |
| 2 | 09 Jul | Sale, ref "ASH 39" | 9,510 × ₹24 = 2,28,240; GST 41,083.20; total 2,69,323.20 → **2,69,323** (round-off −0.20) | debit 2,69,323 | −5,39,544 |
| 3 | 21 Jul | Sale, ref "ASH 42" | 11,650 × ₹16 = 1,86,400; GST 33,552.00; total **2,19,952** (round-off 0) | debit 2,19,952 | **−3,19,592** |

Final headline: **"You owe dealer ₹3,19,592."** This is the returnable balance the owner needs to see at a glance.

### 6.4 Scenario D — Balance crossing zero

Continuing Scenario C, a further sale with base ₹3,00,000 at 18% GST:

```
base 3,00,000 + GST 54,000 = 3,54,000  → debit 3,54,000
balance: −3,19,592 + 3,54,000 = +34,408
```

The headline flips to **"Dealer owes you ₹34,408."** The same balance represents both directions without any special handling.

### 6.5 Scenario E — Void and replay

Starting from the end of Scenario C (balance −3,19,592), the owner voids the "ASH 42" sale:

1. The source transaction is flagged `is_voided = true` (its rows are retained).
2. A reversing ledger entry is posted: **credit 2,19,952**, labelled as a reversal and linked to the original.
3. `recomputeLedger(dealerId)` replays all non-voided entries in `(entry_date, id)` order.
4. The balance returns to exactly **−3,19,592 + 2,19,952 → −5,39,544**, i.e. the position before the voided sale.
5. An `audit_log` row records the void with before/after state.

The dealer's history shows the original entry struck through with its reversal displayed adjacent.

### 6.6 Scenario F — The bank account tag does not split the balance

| Step | Event | Bank tag | Posting | Balance |
| --- | --- | --- | --- | --- |
| 1 | Sale, base ₹50,000 + GST ₹9,000 | **OD** | debit 59,000 | +59,000 |
| 2 | Sale, base ₹1,00,000 + GST ₹18,000 | **Current** | debit 1,18,000 | **+1,77,000** |

The headline reads **"Dealer owes you ₹1,77,000"** — one figure. Filtering the history to "OD only" shows step 1 alone, but the headline balance and the running balance column are always computed over **all** entries, never over the filtered subset. The filter is presentational; a filtered view must display a clear "filtered — showing 1 of 2 entries" notice so this can never be misread.

---

## 7. Posting Rules

For each kind of event the application writes exactly **one** ledger entry.

| Event | Ledger effect | Amount posted |
| --- | --- | --- |
| **Sale** (goods to dealer) | **debit** | rounded grand total (base − discount + freight + GST) |
| **Purchase** (goods from dealer) | **credit** | rounded grand total (base − discount + freight + GST) |
| **Money received** from dealer | **credit** | amount |
| **Money paid** to dealer | **debit** | amount |
| **Opening position** (dealer seeded) | debit or credit as entered | opening amount |
| **Void / correction** | reversing entry, equal and opposite | the original posted amount |

Notes:

- A transaction posts **once**. There is no second account.
- A transaction marked as a **credit/debit note or return** posts in the opposite direction to its mode (a sale return credits; a purchase return debits) and is labelled as such in the history.
- Discount and freight adjust the grand total **before** rounding and before the ledger entry is written (Section 8).
- The bank account tag is copied onto the ledger entry for filtering and export, and has **no** effect on the posting.

---

## 8. Amounts, GST & Rounding

### 8.1 Line Amounts

For each line item:

```
line_amount_paise = roundPaise(quantity × rate_paise)
```

`quantity` is a real number (a shipment may be 9,510.5 kg); `rate_paise` is an integer. Rounding is **half-up to the nearest paise** via one shared `roundPaise(x)` helper. No other code performs arithmetic on money.

### 8.2 Transaction Totals

```
base_total_paise  = Σ line_amount_paise
taxable_paise     = base_total_paise − discount_paise + freight_paise
gst_amount_paise  = roundPaise(taxable_paise × gst_rate / 100)
raw_total_paise   = taxable_paise + gst_amount_paise
grand_total_paise = roundToRupee(raw_total_paise)        // half-up to the nearest ₹1
round_off_paise   = grand_total_paise − raw_total_paise  // may be negative
```

`grand_total_paise` is what posts to the ledger. `discount_paise` and `freight_paise` default to 0 and are optional in the interface.

### 8.3 GST Rate

- The GST rate is a **per-transaction** field, pre-filled at **18%** and editable by the owner (typical alternatives: 0, 5, 12, 28).
- The rate is stored per transaction, so historical entries keep the rate they were saved with; changing the default never alters existing records.
- Valid range: 0 to 100 inclusive. `0` means no GST — the GST row is then shown as `—` in the interface rather than as `₹0.00`.
- There is **no** GST rate master and **no** HSN master. The rate is a number on the form.
- There is **no** CGST/SGST versus IGST split in this edition (see Appendix A). The application records and displays a single GST amount. If the split is later required it is a display-only addition and does not change the ledger.

### 8.4 Worked Example (must appear as a unit test)

```
1 line: 9,510 kg × ₹24.00   → base    ₹2,28,240.00
discount 0, freight 0       → taxable ₹2,28,240.00
GST 18%                     → gst       ₹41,083.20
                              raw     ₹2,69,323.20
                              posted  ₹2,69,323.00
                              round_off  −₹0.20
```

### 8.5 The Money Rule

**All monetary values are stored, transported, and computed as integer paise.** No floating-point money exists anywhere in the system — not in the database, not in computation, not in API responses, not in form state.

`parseFloat`, `toFixed`, and a bare `number` used as rupees are forbidden for money. The only permitted paise → rupee conversion is at the display/render boundary (`formatPaise`) and at the Excel export boundary (Section 11.4), both of which are explicitly specified.

Integer paise fits comfortably in a JavaScript `number` (exact integers below 2^53 ≈ ₹90 trillion in paise). **BigInt is unnecessary.** The rule is not "avoid `number`" — it is "never let a fractional money value exist."

---

## 9. Functional Requirements

### 9.1 Dealer Management

- **FR-D1** Create a dealer with name (required), contact, address, GSTIN, and state code.
- **FR-D2** A dealer carries a type — supplier, buyer, or both — used **only** to filter the Purchase and Sale lists. The type never splits the balance.
- **FR-D3** Edit a dealer's details. Editing identity fields never alters any posted figure.
- **FR-D4** Archive a dealer without deleting their history. Archived dealers are hidden from the pickers and lists by default but remain openable and exportable.
- **FR-D5** Optionally seed a dealer with an **opening position** — an amount plus a direction ("dealer owes us" / "we owe dealer") — recorded as an `opening` ledger entry, never as a mutable field on the dealer row.
- **FR-D6** A dealer may appear in both the Purchase and Sale lists and retains one consolidated balance.

### 9.2 Transactions (Goods)

- **FR-T1** Record a transaction as either a **purchase** or a **sale**, against exactly one dealer, on a given date.
- **FR-T2** Record an **invoice number** (optional free text) and, if it differs from the entry date, an invoice date.
- **FR-T3** Add **one or more** line items. Each line has: item name (**optional** free text), quantity (required), unit (optional free text — kg, pcs, lot…), and rate (required). The form shows a single line by default with an "add another item" action; the majority of entries will use one line.
- **FR-T4** The form computes and displays, live as the owner types: each line amount, the **base total**, the **GST amount** at the chosen rate, and the **grand total** — including the round-off when it is non-zero.
- **FR-T5** Choose the **GST rate**, pre-filled at 18%.
- **FR-T6** Choose the **bank account** the entry runs through: **OD** or **Current**. Required; defaults to the last value used.
- **FR-T7** Optionally record: the owner's reference tag (for example "ASH 39"), a discount, freight, a credit/debit-note or return marker, and free-text notes.
- **FR-T8** On save, post one ledger entry per Section 7 and update the dealer's running balance, atomically.
- **FR-T9** Assign every transaction a human-readable identifier of the form `{MODE}-{YYYY}-{MM}-{NNNN}` (for example `SALE-2026-08-0039`), a zero-padded sequence scoped to mode and month, generated inside the same atomic write.
- **FR-T10** Offer autocomplete suggestions for item name and unit drawn from previously saved entries. Suggestions are never required and never constrain input.

### 9.3 Payments (Money)

- **FR-P1** Record money **received** from a dealer or **paid** to a dealer, on a given date, with an amount greater than zero.
- **FR-P2** Optionally record a method (cash, bank, cheque, UPI), a reference (cheque number, UTR), the bank account tag (OD / Current — omitted for cash), and notes.
- **FR-P3** On save, post one ledger entry per Section 7 and update the running balance, atomically.

### 9.4 Ledger & Balances

- **FR-L1** Maintain exactly one signed running balance per dealer, served from the **stored** value — never recomputed on read.
- **FR-L2** Display that balance as the dealer's headline in plain language (owes you / you owe / settled).
- **FR-L3** Show each dealer's full chronological history — transactions and payments interleaved — with the running balance after every entry.
- **FR-L4** Filter the history by date range, entry type (transaction / payment), mode (purchase / sale), and bank account tag. Filtering never changes the headline or the running-balance column (Scenario F).
- **FR-L5** The balance must cross zero seamlessly with no special handling.

### 9.5 Corrections & Audit

- **FR-A1** No financial record is ever hard-deleted or edited in a way that changes its monetary effect. A correction **voids** the original: it posts an equal and opposite reversing entry, flags the source `is_voided`, and writes an audit row.
- **FR-A2** Voiding requires an explicit confirmation dialog that names the entry and the amount.
- **FR-A3** A voided entry is displayed struck through with its reversing entry shown adjacent.
- **FR-A4** Every create, void, and edit is written to an append-only audit log with before/after JSON and a timestamp.
- **FR-A5** A read-only audit view is available in the application.
- **FR-A6** Non-financial fields (notes, reference tag, item name spelling) may be edited in place; the edit is audited. Any change to a date, amount, quantity, rate, GST rate, discount, freight, dealer, or mode requires a void and re-entry.

### 9.6 Search & Navigation

- **FR-N1** From the home screen, choose **Purchase** or **Sale** to open the relevant dealer list.
- **FR-N2** Search dealers by name within a list, with each dealer's balance and direction shown inline.
- **FR-N3** Open a dealer to view their full account.
- **FR-N4** A global "all transactions" view lists every transaction across dealers, with filters for date range, mode, dealer, and bank account.

### 9.7 Export

- **FR-X1** Export a single dealer's ledger to Excel (`.xlsx`).
- **FR-X2** Export all transactions across dealers, honouring the active filters, to Excel.
- **FR-X3** Export the dealer balance summary (every dealer with their current balance) to Excel.
- **FR-X4** Every export is a real spreadsheet with typed numeric money columns and typed dates, so the accountant can sort, filter, and `SUM` without cleaning the file.
- **FR-X5** A CSV alternative is offered for each export.

Full detail in Section 11.

### 9.8 Authentication

- **FR-U1** The entire application — every page and every API route — is behind a single-user username and password gate.
- **FR-U2** The owner can change the username and password from inside the application, each change re-requiring the current password.
- **FR-U3** There is no sign-up, no password reset by email, and no public route. Recovery is a maintainer operation (Section 19.5).

---

## 10. User Interface Specification

### 10.1 Design Priorities

The owner enters records on a phone, on the move, often in a hurry. The interface must be fast, unambiguous about money direction, and hard to fat-finger into a wrong figure.

- **Mobile-first, thumb-first.** Design for a 360 px-wide phone first; desktop is the enhancement. Primary actions sit within thumb reach with tap targets ≥ 44 px.
- **The balance is the hero.** Every dealer screen leads with the plain-language headline in large type, with an icon and a text label — never colour alone.
- **Show the math live.** The transaction form shows the running base total, GST and grand total as the owner types. No surprises on save.

### 10.2 Navigation Map

```
[ Home ]
   ├── [ PURCHASE ] ──→ Dealer list (suppliers)  ──→ [ Dealer ]
   ├── [ SALE ]     ──→ Dealer list (buyers)     ──→ [ Dealer ]
   ├── [ All transactions ]  (cross-dealer view + filters + export)
   ├── [ Audit log ]
   └── [ Account ]  (change username / password, sign out)

[ Dealer ]
   ├── Balance headline — "Dealer owes you ₹X" / "You owe dealer ₹X" / "Settled"
   ├── History (transactions + payments, date order, running balance per row)
   ├── Filters: date range · type · mode · bank account
   ├── [ + Transaction ]   [ + Payment ]   [ Export ▾ ]
   └── Row actions: view detail · void
```

### 10.3 Home

- Two large primary buttons: **Purchase** and **Sale**.
- A list of dealers with their current balance and direction inline, most recently active first.
- Quick access to **New dealer** and to **All transactions**.

### 10.4 Dealer List (per activity)

A searchable list filtered by dealer type, each row showing name and current balance with direction. Selecting a dealer opens their detail. A "new entry" action from this screen pre-sets the mode.

### 10.5 Dealer Detail

- **Headline:** the plain-language balance, large, with icon and screen-reader text spelling out the direction.
- **History:** one row per entry, newest first (with an option to reverse the order), each showing date, label (Sale / Purchase / Received / Paid), invoice no. or reference, amount, bank account tag, and the **running balance after that entry**.
- Voided rows are struck through with their reversal shown adjacent.
- **Actions:** add transaction, add payment, export, void.
- Tapping a row opens a detail sheet with the full breakdown: every line item, base, discount, freight, GST rate and amount, round-off, grand total, notes, and the audit trail for that record.

### 10.6 New Transaction Form

Field order, top to bottom, matching how the owner reads a docket:

| # | Field | Notes |
| --- | --- | --- |
| 1 | Mode | Purchase / Sale — pre-set from the entry point |
| 2 | Dealer | Searchable picker; pre-set when entered from a dealer screen |
| 3 | **Date** | Defaults to today; future dates blocked |
| 4 | **Invoice No.** | Optional free text |
| 5 | **Item** | Optional free text, with autocomplete |
| 6 | **Quantity** | Required, non-negative; unit is an optional free-text field beside it |
| 7 | **Rate** | Required, non-negative, in rupees |
| 8 | **Base total** | **Computed, read-only** — quantity × rate, summed over lines |
| 9 | *(+ add another item)* | Repeats fields 5–7 |
| 10 | **GST %** | Pre-filled 18, editable, 0–100 |
| 11 | GST amount | **Computed, read-only** |
| 12 | **Total amount** | **Computed, read-only** — grand total, with round-off shown when non-zero |
| 13 | **Bank account** | **OD** / **Current** segmented control; required; defaults to last used |
| 14 | *More options* (collapsed) | Reference tag, discount, freight, credit/debit-note marker, invoice date, notes |

- **Money input:** the owner types rupees (`3,13,830` or `313830.50`); a shared `MoneyInput` component parses to integer paise and emits paise only. Form state never holds a float rupee value. The field live-formats to Indian grouping while typing, curtails input beyond two decimal places, and treats empty as "not entered", never as zero.
- **Draft persistence:** in-progress input autosaves to `localStorage`, so a dropped mobile connection or an accidental back-navigation never loses a half-typed entry. The draft is cleared on successful save. This is deliberately *not* full offline sync, which would conflict with the single source of truth.
- On save failure the user's input is preserved and an actionable error is shown.

### 10.7 New Payment Form

Fields: dealer, date, **direction** (Received from dealer / Paid to dealer — presented as two plain-language options, never as debit/credit), amount, method, reference, bank account tag (hidden when method is cash), notes. Same money input and draft persistence rules.

### 10.8 Display Rules

- All amounts display in rupees with Indian grouping — `₹1,23,456.78` — via a single `formatPaise()` utility using `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`, formatted **from paise**. No ad-hoc formatting anywhere.
- Balances always carry a plain-language direction, never a bare sign.
- Dates display as `DD MMM YYYY`.
- Voided entries are struck through with their reversal adjacent.

### 10.9 Validation Rules (enforced on both client and server)

| Rule | Detail |
| --- | --- |
| Quantity | Required, a number ≥ 0 |
| Rate | Required, integer paise ≥ 0 |
| Line count | At least one line item per transaction |
| GST rate | A number from 0 to 100 inclusive |
| Payment amount | Integer paise, strictly greater than 0 |
| Discount / freight | Integer paise ≥ 0; discount may not exceed the base total |
| Date | Required; not later than today (IST) |
| Dealer | Must exist and not be archived |
| Bank account | Required on transactions; one of `od`, `current` |
| Money fields | Integer paise only — floats, `NaN`, and out-of-range values are rejected at the server boundary |

Server-side validation is authoritative and is re-run in full even when the client has already checked. Zod schemas at every route boundary.

### 10.10 States, Feedback & Accessibility

- Every screen defines **loading**, **empty**, and **error** states explicitly.
- Saves give clear success feedback (a toast naming what was saved).
- Semantic HTML, real `<label>` elements, visible focus rings, AA contrast, no meaning conveyed by colour alone, and screen-reader text spelling out the balance direction.
- Installable **PWA** — manifest and icon — so the owner launches it like an app. Cache the application shell **only**; never cache financial data, because a stale balance is a dangerous balance.

---

## 11. Excel Export Specification

Export is a first-class feature of this edition, not an afterthought. It is how the owner hands figures to the accountant.

### 11.1 Where Exports Are Offered

| Export | Entry point | Contents |
| --- | --- | --- |
| **Dealer ledger** | Dealer detail → Export | That dealer's full history with running balance |
| **All transactions** | All transactions view → Export | Every transaction across dealers, honouring the active filters |
| **Dealer balances** | Home → Export | One row per dealer with the current balance |

Each export respects the filters visible on screen at the time (date range, mode, bank account, dealer type). A subtitle row in the sheet states exactly which filters were applied, so a file can never be misread out of context.

### 11.2 Generation Approach

Generate the workbook **client-side in the browser** from JSON returned by the API, using SheetJS (`xlsx`). This keeps the Worker free of a heavy dependency and well inside its CPU limit, and keeps the export logic beside the formatting logic it must match.

- The API returns raw rows with money as **integer paise**; the export module performs the single paise → rupee conversion at the boundary (Section 11.4).
- A CSV writer shares the same row-builder, so the two formats can never drift.
- For a very large range the API paginates and the export module concatenates before writing.

### 11.3 Sheet Layouts

**Dealer ledger** — file `<Dealer>-ledger-<YYYY-MM-DD>.xlsx`, sheet `Ledger`:

| Col | Header | Type | Notes |
| --- | --- | --- | --- |
| A | Date | date | `DD-MMM-YYYY` display format |
| B | Type | text | Sale / Purchase / Received / Paid / Opening / Reversal |
| C | Invoice No. | text | |
| D | Reference | text | Owner's tag, e.g. "ASH 39" |
| E | Item(s) | text | Line items joined with `; `; blank if not entered |
| F | Quantity | number | Blank for payments |
| G | Unit | text | |
| H | Rate (₹) | number | Blank for multi-line transactions |
| I | Base Total (₹) | number | |
| J | Discount (₹) | number | |
| K | Freight (₹) | number | |
| L | GST % | number | |
| M | GST Amount (₹) | number | |
| N | Round Off (₹) | number | |
| O | Total (₹) | number | Grand total |
| P | Bank A/c | text | OD / Current |
| Q | Debit (₹) | number | Blank when zero |
| R | Credit (₹) | number | Blank when zero |
| S | Balance (₹) | number | Running balance, signed |
| T | Direction | text | "Dealer owes you" / "You owe dealer" / "Settled" |
| U | Status | text | Blank, or "VOIDED", or "REVERSAL" |
| V | Notes | text | |

Above the header: a title block with the business name, the dealer name, the applied filters, the closing balance in plain language, and the generation timestamp. Below the last row: a **totals row** summing Debit, Credit, Base, GST and Total.

**All transactions** — file `transactions-<YYYY-MM-DD>.xlsx`, sheet `Transactions`: the same columns with **Dealer** inserted after Date, and without the running Balance and Direction columns (a cross-dealer running balance is meaningless). Totals row retained.

**Dealer balances** — file `dealer-balances-<YYYY-MM-DD>.xlsx`, sheet `Balances`: Dealer, Type, GSTIN, State, Balance (₹, signed), Direction, Last Activity, Transaction Count. A totals row sums the net position.

### 11.4 Money and Date Handling in Exports

- Money is written as a **numeric cell**, in rupees, exactly two decimal places, derived from integer paise as `paise / 100`. This division is exact for any value the business will encounter and is the one sanctioned crossing of the money boundary. The cell carries the Excel number format `#,##0.00` and the header names the unit ("Total (₹)"), so no `₹` character is embedded in the value.
- Negative balances stay **numerically negative** in column S (so Excel can chart and sum them) while column T carries the plain-language direction. This is the one place a raw sign is acceptable, because a spreadsheet needs an arithmetic value; the adjacent Direction column removes any ambiguity for a human reader.
- Dates are written as real Excel dates, not strings.
- Voided rows are **included**, flagged `VOIDED` in the Status column and struck through, with their reversal on the following row. They are never silently omitted — a spreadsheet that quietly drops records is worse than one that shows them.
- Column widths are set so nothing renders as `####`; the header row is frozen and bold.

### 11.5 Export Non-Requirements

Exports are a snapshot for a human and their accountant. They are explicitly **not** an integration format, **not** re-importable, and carry no machine-readable identifiers beyond the human transaction ID. There is no scheduled or emailed export.

---

## 12. Data Model

### 12.1 Entity Overview

| Table | Holds |
| --- | --- |
| `dealers` | Identity and contact details; a type used only for list filtering |
| `transactions` | One goods deal (purchase or sale): header, GST rate, totals, bank account tag |
| `transaction_lines` | The per-item quantity, unit, rate and amount |
| `payments` | Money received from and paid to dealers |
| `ledger_entries` | The append-only posted ledger with running balances — the digital khata |
| `audit_log` | Every create, void, and edit, with before/after JSON |
| `app_credentials` | The single user's username and password hash |

### 12.2 Relationships

```
dealers 1──n transactions 1──n transaction_lines
dealers 1──n payments
dealers 1──n ledger_entries        (source_type + source_id → transactions | payments | opening)
```

Every `ledger_entries` row traces back to its source record. Nothing in `ledger_entries` exists without a source.

### 12.3 Field Dictionary

**dealers**

| Field | Type | Notes |
| --- | --- | --- |
| id | integer PK | |
| name | text, required | |
| contact | text | |
| address | text | |
| gstin | text | Dealer's GST number |
| state_code | text | e.g. "33" (TN), "07" (Delhi) |
| type | enum(supplier, buyer, both) | List filter only; never splits the balance |
| is_archived | boolean | Default false |
| created_at | timestamp | |

**transactions**

| Field | Type | Notes |
| --- | --- | --- |
| id | integer PK | |
| human_id | text, unique | e.g. "SALE-2026-08-0039" |
| mode | enum(purchase, sale) | |
| dealer_id | integer FK → dealers | |
| entry_date | text `YYYY-MM-DD` | The ledger date (IST calendar date) |
| invoice_no | text | Optional |
| invoice_date | text `YYYY-MM-DD` | Optional; only when it differs from entry_date |
| reference_tag | text | Owner's own label, e.g. "ASH 39" |
| bank_account | enum(od, current) | Tag and filter only |
| gst_rate | real | Percent, default 18 |
| base_total_paise | integer | Σ line amounts |
| discount_paise | integer | Default 0 |
| freight_paise | integer | Default 0 |
| gst_amount_paise | integer | Computed on (base − discount + freight) |
| round_off_paise | integer | Default 0; may be negative |
| grand_total_paise | integer | What posted to the ledger |
| is_return_note | boolean | Credit/debit note or return — posts in reverse |
| notes | text | |
| is_voided | boolean | Default false |
| created_at | timestamp | |

**transaction_lines**

| Field | Type | Notes |
| --- | --- | --- |
| id | integer PK | |
| transaction_id | integer FK → transactions | |
| item_name | text | **Optional** free text; no master |
| quantity | real, required | |
| unit | text | Free text: kg, pcs, lot… |
| rate_paise | integer, required | |
| amount_paise | integer | roundPaise(quantity × rate_paise) |
| line_no | integer | Display order within the transaction |

**payments**

| Field | Type | Notes |
| --- | --- | --- |
| id | integer PK | |
| human_id | text, unique | e.g. "RCPT-2026-08-0012" / "PAY-2026-08-0007" |
| dealer_id | integer FK → dealers | |
| entry_date | text `YYYY-MM-DD` | |
| direction | enum(received, paid) | received = money from the dealer |
| amount_paise | integer | > 0 |
| method | enum(cash, bank, cheque, upi) | Optional |
| bank_account | enum(od, current) | Optional; omitted for cash |
| reference | text | Cheque number, UTR, etc. |
| notes | text | |
| is_voided | boolean | Default false |
| created_at | timestamp | |

**ledger_entries**

| Field | Type | Notes |
| --- | --- | --- |
| id | integer PK | |
| dealer_id | integer FK → dealers | |
| entry_date | text `YYYY-MM-DD` | |
| source_type | enum(transaction, payment, opening, reversal) | |
| source_id | integer | The originating record |
| reverses_entry_id | integer | Set on reversal rows; points at the entry being undone |
| debit_paise | integer | Default 0 — dealer owes the business more |
| credit_paise | integer | Default 0 — the business owes the dealer more |
| running_balance_paise | integer | + dealer owes; − business owes |
| bank_account | enum(od, current) | Copied from the source for filtering; nullable |
| label | text | Sale / Purchase / Received / Paid / Opening / Reversal |
| description | text | |
| created_at | timestamp | |

**audit_log**

| Field | Type | Notes |
| --- | --- | --- |
| id | integer PK | |
| action | text | create / void / edit / login / credential_change |
| entity | text | Table name |
| entity_id | integer | |
| before_json | text | Prior state |
| after_json | text | New state |
| at | timestamp | |

**app_credentials** — exactly one row: `id`, `username`, `password_hash` (`pbkdf2$<iters>$<salt>$<hash>`), `updated_at`.

### 12.4 Dates

`entry_date` and `invoice_date` are stored as **text in `YYYY-MM-DD`** form, representing the IST calendar date the owner selected. This is deliberate: a calendar date is not an instant, and storing it as a timestamp invites off-by-one-day bugs at the timezone boundary. Text dates in this format also sort lexicographically, so the `(entry_date, id)` order key works directly in SQL. `created_at` and `at`, which *are* instants, remain unix epoch integers.

### 12.5 Indexes

```sql
CREATE INDEX idx_ledger_dealer_date  ON ledger_entries (dealer_id, entry_date, id);
CREATE INDEX idx_ledger_source       ON ledger_entries (source_type, source_id);
CREATE INDEX idx_tx_dealer           ON transactions   (dealer_id, entry_date);
CREATE INDEX idx_tx_date             ON transactions   (entry_date);
CREATE INDEX idx_pay_dealer          ON payments       (dealer_id, entry_date);
CREATE INDEX idx_dealers_archived    ON dealers        (is_archived);
CREATE INDEX idx_lines_tx            ON transaction_lines (transaction_id);
```

---

## 13. Database Schema (Cloudflare D1 / Drizzle)

All money is integer paise. Quantity and GST rate are real values used for computation and display; the authoritative monetary figures are always the integer paise columns.

```ts
import { sqliteTable, integer, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const dealers = sqliteTable(
  'dealers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    contact: text('contact'),
    address: text('address'),
    gstin: text('gstin'),
    stateCode: text('state_code'), // "33" = TN, "07" = Delhi
    type: text('type', { enum: ['supplier', 'buyer', 'both'] })
      .notNull()
      .default('both'), // list filter ONLY — never splits the balance
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index('idx_dealers_archived').on(t.isArchived)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    humanId: text('human_id').notNull().unique(), // "SALE-2026-08-0039"
    mode: text('mode', { enum: ['purchase', 'sale'] }).notNull(),
    dealerId: integer('dealer_id')
      .notNull()
      .references(() => dealers.id),
    entryDate: text('entry_date').notNull(), // 'YYYY-MM-DD', IST calendar date
    invoiceNo: text('invoice_no'),
    invoiceDate: text('invoice_date'), // 'YYYY-MM-DD'
    referenceTag: text('reference_tag'), // owner's tag, e.g. "ASH 39"
    bankAccount: text('bank_account', { enum: ['od', 'current'] })
      .notNull()
      .default('od'), // tag + filter ONLY — never splits the balance
    gstRate: real('gst_rate').notNull().default(18),
    baseTotalPaise: integer('base_total_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    freightPaise: integer('freight_paise').notNull().default(0),
    gstAmountPaise: integer('gst_amount_paise').notNull().default(0),
    roundOffPaise: integer('round_off_paise').notNull().default(0),
    grandTotalPaise: integer('grand_total_paise').notNull(), // what posts to the ledger
    isReturnNote: integer('is_return_note', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    isVoided: integer('is_voided', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index('idx_tx_dealer').on(t.dealerId, t.entryDate),
    index('idx_tx_date').on(t.entryDate),
  ],
);

export const transactionLines = sqliteTable(
  'transaction_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id),
    lineNo: integer('line_no').notNull().default(1),
    itemName: text('item_name'), // OPTIONAL free text, no master
    quantity: real('quantity').notNull(),
    unit: text('unit'), // free text: kg, pcs, lot...
    ratePaise: integer('rate_paise').notNull(),
    amountPaise: integer('amount_paise').notNull(), // roundPaise(quantity * ratePaise)
  },
  (t) => [index('idx_lines_tx').on(t.transactionId)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    humanId: text('human_id').notNull().unique(), // "RCPT-2026-08-0012" | "PAY-2026-08-0007"
    dealerId: integer('dealer_id')
      .notNull()
      .references(() => dealers.id),
    entryDate: text('entry_date').notNull(), // 'YYYY-MM-DD'
    direction: text('direction', { enum: ['received', 'paid'] }).notNull(), // received = from dealer
    amountPaise: integer('amount_paise').notNull(),
    method: text('method', { enum: ['cash', 'bank', 'cheque', 'upi'] }),
    bankAccount: text('bank_account', { enum: ['od', 'current'] }),
    reference: text('reference'),
    notes: text('notes'),
    isVoided: integer('is_voided', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index('idx_pay_dealer').on(t.dealerId, t.entryDate)],
);

export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dealerId: integer('dealer_id')
      .notNull()
      .references(() => dealers.id),
    entryDate: text('entry_date').notNull(), // 'YYYY-MM-DD'
    sourceType: text('source_type', {
      enum: ['transaction', 'payment', 'opening', 'reversal'],
    }).notNull(),
    sourceId: integer('source_id'),
    reversesEntryId: integer('reverses_entry_id'), // set on reversal rows
    debitPaise: integer('debit_paise').notNull().default(0), // dealer owes the business more
    creditPaise: integer('credit_paise').notNull().default(0), // the business owes the dealer more
    runningBalancePaise: integer('running_balance_paise').notNull(), // + dealer owes, − business owes
    bankAccount: text('bank_account', { enum: ['od', 'current'] }), // copied for filtering only
    label: text('label'), // Sale | Purchase | Received | Paid | Opening | Reversal
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index('idx_ledger_dealer_date').on(t.dealerId, t.entryDate, t.id),
    index('idx_ledger_source').on(t.sourceType, t.sourceId),
  ],
);

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action').notNull(), // create | void | edit | login | credential_change
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  at: integer('at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const appCredentials = sqliteTable('app_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(), // pbkdf2$<iters>$<salt>$<hash>
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});
```

**Migrations:** `drizzle-kit generate` authors the SQL; **`wrangler d1 migrations apply`** applies it (`--local` for development, remote for production). An already-applied migration is never hand-edited; a new one is added instead.

---

## 14. API Specification

A small, explicit JSON API. Every route except the three public auth routes requires a valid session cookie. Every request body is validated with Zod. All money in request and response bodies is **integer paise**.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Public. Username + password → session cookie |
| `GET` | `/api/auth/me` | Public. Returns whether a session is valid |
| `POST` | `/api/auth/logout` | Public. Clears the session cookie |
| `POST` | `/api/auth/change-password` | Behind the gate; re-requires the current password |
| `POST` | `/api/auth/change-username` | Behind the gate; re-requires the current password |
| `GET` | `/api/dealers?type=&q=&includeArchived=` | Dealer list with inline balances |
| `POST` | `/api/dealers` | Create a dealer, optionally with an opening position |
| `GET` | `/api/dealers/:id` | Dealer detail + current balance |
| `PATCH` | `/api/dealers/:id` | Edit identity fields; archive / unarchive |
| `GET` | `/api/dealers/:id/ledger?from=&to=&type=&mode=&bankAccount=` | The dealer's history rows with running balances |
| `POST` | `/api/transactions` | Create a transaction (posts atomically) |
| `GET` | `/api/transactions?from=&to=&dealerId=&mode=&bankAccount=&cursor=` | Cross-dealer list, paginated |
| `GET` | `/api/transactions/:id` | Full detail with line items |
| `PATCH` | `/api/transactions/:id` | Non-financial fields only (notes, reference tag, item name) |
| `POST` | `/api/transactions/:id/void` | Post the reversal, flag, replay, audit |
| `POST` | `/api/payments` | Create a payment (posts atomically) |
| `POST` | `/api/payments/:id/void` | Post the reversal, flag, replay, audit |
| `GET` | `/api/suggestions?field=item\|unit` | Distinct past values for autocomplete |
| `GET` | `/api/audit?cursor=` | Read-only audit log, newest first |
| `GET` | `/api/export/dealer/:id?…` | Rows for the dealer-ledger export |
| `GET` | `/api/export/transactions?…` | Rows for the all-transactions export |
| `GET` | `/api/export/balances` | Rows for the dealer-balances export |

Error responses carry a stable `code` and a human message, and never echo money or dealer details into logs. Every state-changing route verifies `Origin` / `Sec-Fetch-Site`.

---

## 15. Ledger Computation & Integrity

### 15.1 Engine Shape

- The **ledger engine is a pure module with no database imports**: given a prior balance and an event, it returns the entries to post. The Section 6 scenarios exercise it directly.
- A thin **posting layer** wraps the engine and performs the database writes.
- One **money-math module** owns every arithmetic operation on paise. No ad-hoc `*`, `/`, or `Math.round` on money exists anywhere else in the codebase.

### 15.2 Posting on Write

When a transaction or payment is saved, the application writes its `ledger_entries` row with `running_balance_paise` = the previous entry's running balance for that dealer, plus the new debit, minus the new credit. Because the application is single-user, write-time computation of the running balance is correct and is the recommended approach; reads are then served from the stored value.

### 15.3 Atomicity

D1 does **not** offer interactive `BEGIN…COMMIT` transactions over the Workers binding. Every multi-row write — the transaction header, its lines, the ledger entry, the human-ID sequence, and the audit row — MUST be issued as a single **`db.batch([...])`**, so it commits entirely or not at all. A forced mid-batch failure must leave **no** partial rows; this is an explicit integration test.

### 15.4 Ordering

The replay and display order key is **`(entry_date, id)`** — a stable tiebreak for entries sharing a date. Insertion order alone is never relied upon, and money is never sorted by a float.

---

> ## ⚠ DOCUMENT INCOMPLETE — TRANSCRIPTION CUT HERE
>
> The source document was truncated in transit at the 50,000-character limit,
> mid-way through **§15.5 Replay**. Everything above this line is verbatim and
> complete. Everything below is **missing** and must be pasted in before this
> file can be treated as authoritative:
>
> - §15.5 Replay (`recomputeLedger`) — partial sentence: *"…called after **every** void, and after any back-dated insert that lands bef…"*
> - §15.6 onward (if any) — remainder of Ledger Computation & Integrity
> - §16 Security Requirements
> - §17 Non-Functional Requirements
> - §18 Technology Stack & Deployment
> - §19 Provisioning in the Maintainer's Accounts (incl. §19.5 credential recovery, referenced by FR-U3)
> - §20 Testing Strategy
> - §21 Scope Boundaries
> - §22 Assumptions & Open Items
> - §23 Delivery Plan
> - Appendix A — Differences from the dual-valuation specification
> - Appendix B — Money-math reference implementation (referenced by §8.5 and §15.1)
>
> Until this is filled in, do not treat the absence of a rule below §15.4 as
> the absence of a requirement.
