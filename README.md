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

| Document                                                   | What it covers                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| **[SRS.md](SRS.md)**                                       | The specification. Authoritative.                              |
| [CLAUDE.md](CLAUDE.md)                                     | Developer rules summary — read this before writing code        |
| [docs/PRD.md](docs/PRD.md)                                 | Why it's being built, who for, what counts as done             |
| [docs/TRD.md](docs/TRD.md)                                 | Architecture, module contracts, stack, engineering constraints |
| [docs/APP_FLOW.md](docs/APP_FLOW.md)                       | Screen-by-screen paths, states, validation gates               |
| [docs/UIUX.md](docs/UIUX.md)                               | Components, tokens, copy rules, accessibility                  |
| [docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md)           | DDL, invariants, query patterns, schema gaps                   |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phased build plan and definition of done                       |

## Documentation status

`SRS.md` is **complete** — all 23 sections plus Appendix A (differences from the
earlier dual-valuation spec) and Appendix B (the money-math reference
implementation). Every derived document in `docs/` has been reconciled against it.

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

|     | Covers                        | Key figure                                        |
| --- | ----------------------------- | ------------------------------------------------- |
| A   | goods and money both ways     | ends −3,23,000                                    |
| B   | GST round-off                 | 2,69,323.20 → posts 2,69,323, round-off −20 paise |
| C   | advance against two shipments | ends −3,19,592                                    |
| D   | balance crossing zero         | −3,19,592 → +34,408                               |
| E   | void and replay               | returns to −5,39,544                              |
| F   | bank tag does not split       | one headline of +1,77,000                         |

## Stack

**Vite + React + Hono** on Cloudflare Workers, with D1 (SQLite) + Drizzle ORM,
Zod at every route boundary, a single-user password gate, a mobile-first PWA, and
Excel export generated client-side with SheetJS.

Styling is Tailwind CSS v4 with all tokens in one `@theme` block; icons are
`lucide-react`; Inter is self-hosted because the CSP forbids CDN assets. Package
manager is pnpm; CI runs typecheck, lint, tests, build and `pnpm audit`.

Backup is D1 Time Travel (30-day PITR) plus `wrangler d1 export` SQL dumps.
**R2 is deliberately unused** — it requires a payment card, and the arrangement
stays card-free. A restore must be **performed and verified**, not merely
documented (NFR-B3).

## Getting started

Nothing to run yet. Start at
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), which follows the
four-phase delivery plan in SRS §23. Phase 0 builds the toolchain, both D1
databases, the money-math module, and the schema — and ends with the six §6
acceptance scenarios encoded and **failing for the right reason**.

Three traps in the spec are worth knowing before you write auth code:

- **PBKDF2 iterations are capped at 100,000** — above that the Workers runtime
  throws `NotSupportedError`, but the Node test runner does not, so a higher
  value passes every test and then fails in production (§16.1).
- **`AUTH_SECRET` unset disables the gate entirely.** The build must refuse to
  start in production mode without it (§16.1).
- The session cookie is **`SameSite=Strict`**, not `Lax`.

## Licence

Private and unlicensed. All rights reserved.
