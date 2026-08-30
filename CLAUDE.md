# ASH Overseas — Trading Ledger

Private, single-user web app replacing the owner's paper ledger for a metal
castings / scrap trading business. Records goods transactions and money
movements with dealers, maintains one running balance per dealer, exports to
Excel.

**[SRS.md](SRS.md) is authoritative on every business rule.** This file is the
working summary — when the two disagree, the SRS wins. SRS.md is **complete**:
all 23 sections plus Appendix A and Appendix B.

## Status

**Phases 0, 1 and 2 complete (SRS §23).** Money module, pure ledger engine,
posting layer, full API, the real mobile-first interface (forms with
`MoneyInput` and draft persistence, void dialog, filters, cross-dealer view),
all three exports in Excel and CSV, and the PWA shell. 146 tests green: the six
§6 scenarios at **both** the pure and D1-integration level, the §15.3 atomicity
test, and the Phase 2 reconciliation gate. **Phase 3 (hardening and handoff) is
next.**

⚠ **There is no auth gate yet** — it is Phase 3 (§16.1, §23). The Worker now has
write paths, so the gate must be in place before any real data is entered.

## Documentation set

All derived from the SRS and reconciled against the complete text. Where any of
them disagrees with SRS.md, the SRS wins.

| Document                                                   | Read it when                                              |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| [docs/PRD.md](docs/PRD.md)                                 | You need the why, the users, or the success criteria      |
| [docs/TRD.md](docs/TRD.md)                                 | Architecture, module contracts, the non-negotiables list  |
| [docs/APP_FLOW.md](docs/APP_FLOW.md)                       | Building a screen or a route; states and validation gates |
| [docs/UIUX.md](docs/UIUX.md)                               | Building UI; components, copy rules, accessibility        |
| [docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md)           | Touching the database; DDL, invariants, queries           |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Deciding what to build next                               |

---

## The rules that matter most

### 1. One balance per dealer

Exactly one signed running balance per dealer, from the business's point of view:

- **positive** → the dealer owes the business
- **negative** → the business owes the dealer
- **zero** → settled

`running_balance = Σ(debit) − Σ(credit)`. It crosses zero with no special
handling. There are no advance buckets, no FIFO matching, no purchase/sale
sub-balances.

### 2. Purchase and Sale are UI labels

They filter dealer lists and pre-set the mode on a new entry. They **never**
split a dealer's money into two pots. A dealer can be both supplier and buyer
and still has one balance.

### 3. The bank account tag (OD / Current) is a tag

It records which of the _business's own_ accounts the money ran through, for
filtering and export subtotals. It never splits a balance, never changes a
posting rule, never affects the headline. Filtering the history by it must not
change the headline or the running-balance column — show a "showing N of M
entries" notice instead. (SRS §6.6)

### 4. All money is integer paise

No floating-point money anywhere — not in the DB, not in computation, not in
API bodies, not in form state. `parseFloat` and `toFixed` are forbidden for
money. Exactly two sanctioned paise → rupee conversions exist:

- `formatPaise()` at the render boundary
- the Excel export boundary (`paise / 100` into a numeric cell), SRS §11.4

Integer paise fits exactly in a JS `number` below 2^53 (≈ ₹90 trillion).
**BigInt is not needed.** The rule is "never let a fractional money value
exist", not "avoid `number`".

One money-math module owns every arithmetic operation on paise. No ad-hoc `*`,
`/`, or `Math.round` on money anywhere else.

### 5. Nothing is ever deleted

Corrections are **voids**: flag the source `is_voided`, post an equal and
opposite reversing entry linked to the original, replay, write an audit row.
Non-financial fields (notes, reference tag, item name spelling) may be edited
in place and are audited. Any change to date, amount, quantity, rate, GST rate,
discount, freight, dealer, or mode requires void + re-entry.

### 6. Every multi-row write is one `db.batch([...])`

D1 has no interactive `BEGIN…COMMIT` over the Workers binding. The transaction
header, its lines, the ledger entry, the human-ID sequence, and the audit row
commit together or not at all. A forced mid-batch failure leaving zero partial
rows is an explicit integration test. (SRS §15.3)

---

## Posting rules (SRS §7)

| Event                        | Effect          | Amount                     |
| ---------------------------- | --------------- | -------------------------- |
| Sale (goods to dealer)       | debit           | rounded grand total        |
| Purchase (goods from dealer) | credit          | rounded grand total        |
| Money received from dealer   | credit          | amount                     |
| Money paid to dealer         | debit           | amount                     |
| Opening position             | as entered      | opening amount             |
| Void                         | reversing entry | the original posted amount |

A return / credit-debit note posts **opposite** to its mode: a sale return
credits, a purchase return debits.

## Money math (SRS §8)

```
line_amount_paise = roundPaise(quantity × rate_paise)      // half away from zero

base_total_paise  = Σ line_amount_paise
taxable_paise     = base_total_paise − discount_paise + freight_paise
gst_amount_paise  = roundPaise(taxable_paise × gst_rate / 100)
raw_total_paise   = taxable_paise + gst_amount_paise
grand_total_paise = roundToRupee(raw_total_paise)          // to the nearest ₹1
round_off_paise   = grand_total_paise − raw_total_paise    // may be negative
```

`grand_total_paise` is what posts to the ledger. GST rate is a per-transaction
field defaulting to 18, range 0–100, stored per row so history never shifts.
No GST master, no HSN master, no CGST/SGST/IGST split in this edition.

## Acceptance tests — SRS §6

Six scenarios, A–F. **Implement them as automated tests before the ledger is
considered complete**, and reproduce every figure exactly:

|     | Covers                        | Key figure                                            |
| --- | ----------------------------- | ----------------------------------------------------- |
| A   | goods and money both ways     | ends −3,23,000                                        |
| B   | GST round-off                 | 2,69,323.20 → posts 2,69,323, `round_off_paise = −20` |
| C   | advance against two shipments | ends −3,19,592                                        |
| D   | balance crossing zero         | −3,19,592 → +34,408                                   |
| E   | void and replay               | returns to −5,39,544                                  |
| F   | bank tag does not split       | one headline of +1,77,000                             |

## Architecture

- **Ledger engine** — a pure module, no DB imports. Given a prior balance and an
  event it returns the entries to post. The §6 scenarios exercise it directly.
- **Posting layer** — thin wrapper that does the DB writes via `db.batch`.
- **Money-math module** — sole owner of paise arithmetic.
- Running balance is computed **at write time** and served from the stored
  value on read, never recomputed on read. Single-user, so this is safe.
- Replay/display order key is always `(entry_date, id)`. Never insertion order,
  never a float.
- `recomputeLedger(dealerId)` replays all non-voided entries from zero (or the
  opening entry) after every void and after any back-dated insert.

## Stack (SRS §18)

**Vite + React (TypeScript strict) + Hono on Cloudflare Workers**, D1 (SQLite),
Drizzle ORM, Zod at every route boundary with server-side validation
authoritative. Tailwind v4 with all tokens in one `@theme` block. `lucide-react`;
self-hosted Inter. pnpm. SheetJS client-side for export.

**Not Next.js** — `@cloudflare/next-on-pages` is deprecated and OpenNext adds a
pipeline this app does not need.

**Two D1 databases are mandatory**: `ledger-dev` and `ledger-prod`. Development
never holds real financial data unless protected identically (§16.4).

Migrations: `drizzle-kit generate` authors the SQL, `wrangler d1 migrations
apply` applies it. Never hand-edit an applied migration; add a new one.

Mobile-first PWA — cache the app shell only, **never** financial data, because a
stale balance is a dangerous balance.

## Auth traps (SRS §16.1) — read before touching auth

1. **PBKDF2 iterations are capped at 100,000.** Above that, the Workers runtime
   throws `NotSupportedError`; the Node test runner does not. A higher value
   passes every test and then fails in production.
2. **`AUTH_SECRET` unset disables the gate entirely.** Local convenience only —
   the build must refuse to start in production mode without it.
3. **`SameSite=Strict`**, not `Lax`. Cookie is HMAC-signed, 30-day expiry.
4. Credentials live in **D1, not env secrets** — a Worker cannot rewrite its own
   secrets, which is what makes in-app password change possible.
5. A wrong login gets a deliberate **~½ second delay** before its 401.

## Money module

**SRS Appendix B is the reference implementation — copy it verbatim.** Two easy
mistakes: `transactionTotals` takes `linesPaise: number[]` (already-computed line
amounts, not quantity/rate pairs), and it does **not** return `rawTotalPaise`.
`roundPaise` rounds half _away from zero_, which is deliberate — do not "fix" it.

`parseRupeesToPaise` is required by §20 but absent from Appendix B; implement it
to the §10.6 rules.

## Dates

`entry_date` / `invoice_date` are **text `YYYY-MM-DD`** — an IST calendar date,
not an instant. This sorts lexicographically so `(entry_date, id)` works in SQL
directly, and avoids off-by-one-day timezone bugs. `created_at` / `at` are real
instants and stay unix epoch integers.

## Interface language

The user never sees "debit", "credit", or a bare `+`/`−`. Balances always read
"Dealer owes you ₹X" / "You owe dealer ₹X" / "Settled", with an icon and text —
never colour alone. Amounts format through a single `formatPaise()` using
`Intl.NumberFormat('en-IN', …)` **from paise**. Dates display `DD MMM YYYY`.

The one exception is the Excel export: column S carries a numerically signed
balance so Excel can sum and chart it, with the plain-language direction in the
adjacent column T.
