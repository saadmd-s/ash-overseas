# ASH Overseas — Trading Ledger

A private, single-user web application that replaces the owner's paper ledger for
a metal castings and scrap trading business. It records goods transactions and
money movements with dealers, maintains **one signed running balance per dealer**,
and exports any view to Excel.

It is a faithful digital version of a working notebook — not accounting software.
It does not file taxes, generate legal invoices, or replace the tools used for
statutory filing.

> **Status:** specification and documentation only. No application code yet — no
> `package.json`, no toolchain. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

---

## The idea in one paragraph

The business buys from some dealers and sells to others, often both with the same
dealer, and runs on credit and advances — goods and money rarely settle in a
single exchange. Each dealer therefore has exactly **one** signed balance:
positive means the dealer owes the business, negative means the business owes the
dealer, zero means settled. Goods and money in either direction move that one
number, and it crosses zero with no special handling. Purchase and Sale are
interface labels that filter lists; they never split a dealer's money into two
pots. The OD/Current bank account is a tag for filtering and export subtotals; it
never splits a balance either.

## Documentation

**[SRS.md](SRS.md) is authoritative on every business rule.** Everything else is
derived from it — where they disagree, the SRS wins.

| Document | What it covers |
| --- | --- |
| **[SRS.md](SRS.md)** | The specification. Authoritative. |
| [CLAUDE.md](CLAUDE.md) | Developer rules summary — read this before writing code |
| [docs/PRD.md](docs/PRD.md) | Why it's being built, who for, what counts as done |
| [docs/TRD.md](docs/TRD.md) | Architecture, module contracts, stack, engineering constraints |
| [docs/APP_FLOW.md](docs/APP_FLOW.md) | Screen-by-screen paths, states, validation gates |
| [docs/UIUX.md](docs/UIUX.md) | Components, tokens, copy rules, accessibility |
| [docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md) | DDL, invariants, query patterns, schema gaps |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phased build plan and definition of done |

### ⚠ The specification is incomplete

`SRS.md` is **truncated below §15.4**. The source document was cut in transit, so
these are missing and must be supplied before the affected work starts:

- §15.5 (replay), §16 (security), §17 (non-functional), §18 (**stack decision**),
  §19 (provisioning, incl. credential recovery), §20 (testing), §21–§23
- Appendix A (differences from the earlier dual-valuation spec)
- Appendix B (**money-math reference implementation**)

A marker at the end of `SRS.md` lists this precisely. Throughout the derived
documents, inferences that await those sections are tagged **[PENDING §n]**.
Treat a gap as an unknown requirement, never as an absent one.

## The rules that matter most

Full detail in [CLAUDE.md](CLAUDE.md); the short version:

1. **One balance per dealer.** `running_balance = Σ(debit) − Σ(credit)`. No
   advance buckets, no FIFO matching, no purchase/sale sub-balances.
2. **All money is integer paise.** No floating-point money anywhere — not in the
   database, computation, API bodies, or form state. Exactly two sanctioned
   paise → rupee conversions exist: `formatPaise()` at render, and the Excel
   export boundary. BigInt is not needed.
3. **Nothing is ever deleted.** Corrections are voids: flag the source, post an
   equal and opposite reversing entry, replay, write an audit row.
4. **Every multi-row write is one `db.batch([...])`.** D1 has no interactive
   transactions; a partial write would leave a wrong balance.
5. **The user never sees "debit", "credit", or a bare sign.** Balances read
   "Dealer owes you ₹X" / "You owe dealer ₹X" / "Settled", with icon and text —
   never colour alone.

## Acceptance tests

Six scenarios in SRS §6, A–F. They are the primary acceptance tests and **must be
implemented as automated tests before the ledger is considered complete**,
reproducing every figure exactly:

| | Covers | Key figure |
| --- | --- | --- |
| A | goods and money both ways | ends −3,23,000 |
| B | GST round-off | 2,69,323.20 → posts 2,69,323, round-off −20 paise |
| C | advance against two shipments | ends −3,19,592 |
| D | balance crossing zero | −3,19,592 → +34,408 |
| E | void and replay | returns to −5,39,544 |
| F | bank tag does not split | one headline of +1,77,000 |

## Stack

Cloudflare Workers + D1 (SQLite) + Drizzle ORM, Zod at every route boundary,
single-user password gate, mobile-first PWA, Excel export generated client-side
with SheetJS.

The framework choice — Next.js vs Vite + React + Hono — sits in the untranscribed
SRS §18. [docs/TRD.md §3](docs/TRD.md) carries a provisional recommendation
(Vite + React + Hono) and the reasoning. **Confirm before scaffolding.**

## Getting started

Nothing to run yet. When Phase 1 begins, start at
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — Phase 0 exists
specifically to close the specification gaps listed above before any code depends
on a guess.

## Licence

Private and unlicensed. All rights reserved.
