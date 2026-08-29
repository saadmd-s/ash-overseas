# Backend Schema

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Derived from [SRS.md](../SRS.md) §12 and §13

> **[SRS.md](../SRS.md) §13 holds the authoritative Drizzle schema.** This
> document is the reference companion: the SQL those definitions generate, the
> invariants the schema cannot express, the query patterns, and the gaps found
> while working through it.
>
> §7 below proposes a table that **does not exist in the SRS** but is required by
> §15.3. It is marked clearly and needs confirmation.

---

## 1. Overview

Seven tables in the SRS, plus one proposed (§7):

| Table | Holds |
| --- | --- |
| `dealers` | Identity and contact details; a type used only for list filtering |
| `transactions` | One goods deal (purchase or sale): header, GST rate, totals, bank tag |
| `transaction_lines` | Per-item quantity, unit, rate, amount |
| `payments` | Money received from and paid to dealers |
| `ledger_entries` | The append-only posted ledger with running balances — the digital khata |
| `audit_log` | Every create, void, and edit with before/after JSON |
| `app_credentials` | The single user's username and password hash |
| `id_sequences` **(proposed)** | Human-ID counters, allocated inside the atomic batch |

### 1.1 Relationships

```
dealers 1──n transactions 1──n transaction_lines
dealers 1──n payments
dealers 1──n ledger_entries   (source_type + source_id → transactions | payments | opening)

ledger_entries.reverses_entry_id ──→ ledger_entries.id   (self-reference, reversals)
```

**Every `ledger_entries` row traces back to its source record. Nothing in
`ledger_entries` exists without a source.**

### 1.2 The money rule at the storage layer

Every monetary column is `INTEGER`, holding **paise**. There is no `REAL` money
column anywhere and there must never be one. `quantity` and `gst_rate` are `REAL`
because they are not money — they are inputs to a computation whose result is
rounded to integer paise immediately.

## 2. Generated DDL

What Drizzle emits from SRS §13. Committed under `drizzle/migrations/`; never
hand-edited once applied.

```sql
CREATE TABLE dealers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  contact      TEXT,
  address      TEXT,
  gstin        TEXT,
  state_code   TEXT,                                  -- "33" = TN, "07" = Delhi
  type         TEXT    NOT NULL DEFAULT 'both',       -- supplier | buyer | both
  is_archived  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  human_id           TEXT    NOT NULL UNIQUE,         -- "SALE-2026-08-0039"
  mode               TEXT    NOT NULL,                -- purchase | sale
  dealer_id          INTEGER NOT NULL REFERENCES dealers(id),
  entry_date         TEXT    NOT NULL,                -- 'YYYY-MM-DD', IST calendar date
  invoice_no         TEXT,
  invoice_date       TEXT,
  reference_tag      TEXT,                            -- owner's tag, e.g. "ASH 39"
  bank_account       TEXT    NOT NULL DEFAULT 'od',   -- od | current — TAG ONLY
  gst_rate           REAL    NOT NULL DEFAULT 18,
  base_total_paise   INTEGER NOT NULL,
  discount_paise     INTEGER NOT NULL DEFAULT 0,
  freight_paise      INTEGER NOT NULL DEFAULT 0,
  gst_amount_paise   INTEGER NOT NULL DEFAULT 0,
  round_off_paise    INTEGER NOT NULL DEFAULT 0,      -- may be negative
  grand_total_paise  INTEGER NOT NULL,                -- what posts to the ledger
  is_return_note     INTEGER NOT NULL DEFAULT 0,      -- posts in reverse
  notes              TEXT,
  is_voided          INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE transaction_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id),
  line_no         INTEGER NOT NULL DEFAULT 1,
  item_name       TEXT,                               -- OPTIONAL, no master
  quantity        REAL    NOT NULL,                   -- not money
  unit            TEXT,                               -- free text: kg, pcs, lot
  rate_paise      INTEGER NOT NULL,
  amount_paise    INTEGER NOT NULL                    -- roundPaise(quantity * rate_paise)
);

CREATE TABLE payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  human_id      TEXT    NOT NULL UNIQUE,              -- "RCPT-…" | "PAY-…"
  dealer_id     INTEGER NOT NULL REFERENCES dealers(id),
  entry_date    TEXT    NOT NULL,
  direction     TEXT    NOT NULL,                     -- received | paid
  amount_paise  INTEGER NOT NULL,                     -- > 0
  method        TEXT,                                 -- cash | bank | cheque | upi
  bank_account  TEXT,                                 -- omitted for cash
  reference     TEXT,
  notes         TEXT,
  is_voided     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE ledger_entries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id              INTEGER NOT NULL REFERENCES dealers(id),
  entry_date             TEXT    NOT NULL,
  source_type            TEXT    NOT NULL,            -- transaction|payment|opening|reversal
  source_id              INTEGER,
  reverses_entry_id      INTEGER,                     -- set on reversal rows
  debit_paise            INTEGER NOT NULL DEFAULT 0,  -- dealer owes the business more
  credit_paise           INTEGER NOT NULL DEFAULT 0,  -- the business owes the dealer more
  running_balance_paise  INTEGER NOT NULL,            -- + dealer owes, − business owes
  bank_account           TEXT,                        -- copied for filtering ONLY
  label                  TEXT,                        -- Sale|Purchase|Received|Paid|Opening|Reversal
  description            TEXT,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action       TEXT    NOT NULL,   -- create|void|edit|login|credential_change
  entity       TEXT    NOT NULL,
  entity_id    INTEGER,
  before_json  TEXT,
  after_json   TEXT,
  at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE app_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,  -- pbkdf2$<iters>$<salt>$<hash>
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
```

## 3. Indexes (§12.5)

```sql
CREATE INDEX idx_ledger_dealer_date  ON ledger_entries    (dealer_id, entry_date, id);
CREATE INDEX idx_ledger_source       ON ledger_entries    (source_type, source_id);
CREATE INDEX idx_tx_dealer           ON transactions      (dealer_id, entry_date);
CREATE INDEX idx_tx_date             ON transactions      (entry_date);
CREATE INDEX idx_pay_dealer          ON payments          (dealer_id, entry_date);
CREATE INDEX idx_dealers_archived    ON dealers           (is_archived);
CREATE INDEX idx_lines_tx            ON transaction_lines (transaction_id);
```

`idx_ledger_dealer_date` is the workhorse. It covers the two hottest paths —
rendering a dealer's history and replaying it — because its column order matches
the `(entry_date, id)` order key exactly.

## 4. Field Notes

### 4.1 Why dates are text

`entry_date` and `invoice_date` are **text `YYYY-MM-DD`**, representing the IST
calendar date the owner selected (§12.4). Three reasons:

1. A calendar date is not an instant. Storing it as a timestamp invites
   off-by-one-day bugs at the timezone boundary.
2. This format sorts **lexicographically**, so `ORDER BY entry_date, id` works
   directly in SQL with no conversion.
3. It round-trips through JSON unchanged.

`created_at` and `at` *are* instants and stay unix epoch integers.

**Consequence for validation:** "not later than today" must be evaluated against
**today in IST**, not the Worker's UTC clock. At 23:00 UTC it is already tomorrow
in IST, and a legitimate entry would be wrongly rejected — or an illegitimate one
accepted.

### 4.2 Booleans

SQLite has no boolean type; Drizzle maps `{ mode: 'boolean' }` onto `INTEGER`
0/1. Raw SQL must compare against `0`/`1`, never `false`/`true`.

### 4.3 `bank_account` is nullable on ledger entries and payments

Nullable on `payments` because cash payments have no bank account (FR-P2), and
nullable on `ledger_entries` because it is copied from the source. It is **NOT
NULL with a default on `transactions`**, where it is required (FR-T6).

It is copied onto the ledger entry **for filtering and export only** and has no
effect on any posting. See §5, invariant I7.

### 4.4 `round_off_paise` may be negative

Scenario B stores `−20`. Any check constraint or validation must permit negative
values here. It is the only monetary column that is routinely negative apart from
`running_balance_paise`.

### 4.5 `source_id` semantics per `source_type`

| `source_type` | `source_id` points at | `reverses_entry_id` |
| --- | --- | --- |
| `transaction` | `transactions.id` | NULL |
| `payment` | `payments.id` | NULL |
| `opening` | NULL — the dealer is already on the row | NULL |
| `reversal` | the original source record's id | **the `ledger_entries.id` being reversed** |

> **[PENDING]** — the SRS declares the columns but does not state the `opening`
> and `reversal` conventions explicitly. The table above is the derived reading;
> confirm before implementation.

## 5. Invariants

The schema cannot express these. They are enforced by the posting layer and
verified by tests.

| # | Invariant | Enforced by |
| --- | --- | --- |
| **I1** | Exactly one of `debit_paise` / `credit_paise` is non-zero on any ledger entry | Posting layer + test |
| **I2** | `running_balance_paise` = previous entry's balance + `debit_paise` − `credit_paise`, in `(entry_date, id)` order | Posting layer; verified by replay |
| **I3** | Replaying all non-voided entries from zero reproduces every stored running balance exactly | `recomputeLedger` integrity check |
| **I4** | Every `ledger_entries` row has a resolvable source | FK + posting layer |
| **I5** | A voided source has exactly one reversal entry pointing at its original ledger entry | Void handler + test |
| **I6** | No row is ever hard-deleted from `transactions`, `payments`, or `ledger_entries` | Code review; no DELETE statements exist |
| **I7** | `bank_account` never influences `debit_paise`, `credit_paise`, or `running_balance_paise` | Scenario F test |
| **I8** | `grand_total_paise` is always a whole number of rupees (a multiple of 100) | `roundToRupee`; assert in tests |
| **I9** | `base_total_paise` = Σ of the transaction's `amount_paise` line values | Posting layer + test |
| **I10** | `payments.amount_paise` > 0 strictly | Zod + test |
| **I11** | `discount_paise` ≤ `base_total_paise` | Zod (§10.9) |
| **I12** | `app_credentials` holds exactly one row | Migration seed + code |
| **I13** | All money columns hold integers; no fractional value is ever written | `money/` module; type-level |

### 5.1 Optional CHECK constraints

SQLite supports these and they cost nothing at write time. Recommended as
defence-in-depth, not as a replacement for I1–I13:

```sql
-- Exactly one side posts (I1)
CHECK ((debit_paise = 0) <> (credit_paise = 0) OR
       (debit_paise = 0 AND credit_paise = 0))

-- Money columns are non-negative where they must be
CHECK (debit_paise  >= 0)
CHECK (credit_paise >= 0)
CHECK (amount_paise >  0)          -- payments (I10)
CHECK (discount_paise >= 0)
CHECK (freight_paise  >= 0)
CHECK (gst_rate >= 0 AND gst_rate <= 100)

-- Grand total is whole rupees (I8)
CHECK (grand_total_paise % 100 = 0)
```

> Note the deliberate absence of a constraint on `round_off_paise` and
> `running_balance_paise` — both are legitimately negative.

## 6. Atomic Write Composition (§15.3)

**D1 has no interactive `BEGIN…COMMIT` over the Workers binding.** Every
multi-row write is one `db.batch([...])`, committing entirely or not at all.

**Creating a transaction:**

```
db.batch([
  1. UPDATE id_sequences  → next human-ID counter        (see §7)
  2. INSERT transactions                                  (header)
  3. INSERT transaction_lines × n
  4. INSERT ledger_entries                                (with running balance)
  5. INSERT audit_log                                     (action='create')
])
```

**Creating a payment:**

```
db.batch([
  1. UPDATE id_sequences
  2. INSERT payments
  3. INSERT ledger_entries
  4. INSERT audit_log
])
```

**Voiding:**

```
db.batch([
  1. UPDATE transactions|payments SET is_voided = 1       (rows retained)
  2. INSERT ledger_entries                                (reversal, equal and opposite)
  3. INSERT audit_log                                     (action='void', before/after JSON)
])
then recomputeLedger(dealerId)
```

**Required test:** a forced mid-batch failure leaves **zero** partial rows. This
is an explicit integration test (§15.3), not an assumption about D1's behaviour.

### 6.1 The ID-ordering problem

Steps 3 and 4 need `transactions.id`, which only exists after step 2. D1's batch
does not let a later statement read an earlier one's generated key.

**[PENDING]** — resolve during Phase 2. Two workable approaches:

- Pre-allocate the primary key (application-generated id rather than
  `AUTOINCREMENT`), so every statement in the batch knows every id up front.
- Use `RETURNING` plus a second batch — but this **breaks atomicity** across the
  two batches and is therefore not acceptable without a compensating design.

The first approach preserves the all-or-nothing guarantee and is the likely
answer. The correctness requirement is fixed regardless of mechanism.

## 7. Proposed: `id_sequences`

> **This table is not in the SRS.** §15.3 requires "the human-ID sequence" to be
> part of the atomic batch, and FR-T9 requires `{MODE}-{YYYY}-{MM}-{NNNN}` with a
> zero-padded sequence scoped to mode and month — but §12 and §13 define no table
> to hold the counter. **This is a genuine specification gap.**

```sql
CREATE TABLE id_sequences (
  scope       TEXT    NOT NULL PRIMARY KEY,  -- e.g. 'SALE-2026-08'
  next_value  INTEGER NOT NULL DEFAULT 1
);
```

Allocation inside the batch, atomic under SQLite's row-level semantics:

```sql
INSERT INTO id_sequences (scope, next_value) VALUES (?1, 2)
  ON CONFLICT(scope) DO UPDATE SET next_value = next_value + 1
  RETURNING next_value;
```

Scopes: `SALE-YYYY-MM`, `PURCHASE-YYYY-MM`, `RCPT-YYYY-MM`, `PAY-YYYY-MM`.

Deriving the counter from `MAX(human_id)` or a row count instead would be wrong:
counting rows breaks after a void (voided rows are retained, so the count no
longer matches), and both approaches race in a way a dedicated counter does not.
A single-user app makes a race unlikely, not impossible — a double-tapped save
button is enough.

**Alternatives if the SRS tail specifies otherwise:** the sequence could live in
the untranscribed sections in another form. Confirm against §15.5+ before
building.

## 8. Query Patterns

### 8.1 Dealer history (the hot path)

```sql
SELECT * FROM ledger_entries
WHERE dealer_id = ?1
ORDER BY entry_date, id;          -- covered by idx_ledger_dealer_date
```

Filters (date range, type, mode, bank account) narrow **which rows are
displayed** — never how `running_balance_paise` was computed. The stored value is
returned as-is. See [UIUX.md §10](UIUX.md) for the mandatory "N of M" notice.

### 8.2 Current balance

```sql
SELECT running_balance_paise FROM ledger_entries
WHERE dealer_id = ?1
ORDER BY entry_date DESC, id DESC
LIMIT 1;
```

Served from the **stored** value, never recomputed on read (FR-L1, §15.2).
A dealer with no entries is `0` — "Settled".

### 8.3 Dealer list with inline balances

A correlated subquery for the latest entry per dealer, or a window function
(`ROW_NUMBER() OVER (PARTITION BY dealer_id ORDER BY entry_date DESC, id DESC)`).
D1's SQLite supports window functions. Prefer the window function — one pass
rather than one subquery per dealer.

### 8.4 Replay

```sql
SELECT * FROM ledger_entries
WHERE dealer_id = ?1
  AND source_type != 'reversal'          -- reversals are re-derived
  AND <source not voided>
ORDER BY entry_date, id;
```

Feed to the pure `replay()` function, then write back the recomputed balances in
one batch.

> **[PENDING §15.5]** — precisely which rows replay excludes (voided sources
> only, or voided sources *and* their reversals) is in the truncated text. The
> two readings give the same final balance but different intermediate rows, so
> this must be confirmed rather than guessed.

### 8.5 Integrity check

```
For each dealer:
  replay all non-voided entries from zero
  assert every recomputed balance == stored running_balance_paise
```

Any divergence is a defect. The arithmetic is integer and exact — there is no
rounding drift to excuse a mismatch.

## 9. Migrations

- `drizzle-kit generate` authors the SQL from `src/db/schema.ts`.
- `wrangler d1 migrations apply` applies it — `--local` in development, remote in
  production.
- **An applied migration is never hand-edited. A new one is added instead** (§13).
- Generated SQL is committed to the repository.

### 9.1 Initial seed

The first migration must seed `app_credentials` with exactly one row (I12). The
initial password hash is supplied out-of-band by the maintainer, never committed.

> **[PENDING §19]** — the provisioning procedure, including how that first
> credential is set and the §19.5 recovery path, is untranscribed.

## 10. Schema Gaps and Open Items

| # | Gap | Impact | Status |
| --- | --- | --- | --- |
| 1 | No table for the human-ID sequence required by §15.3 / FR-T9 | Blocks FR-T9 | `id_sequences` proposed above — **needs confirmation** |
| 2 | `reverses_entry_id` has no declared FK to `ledger_entries.id` | Orphan reversal possible | Add self-referencing FK, or enforce in the posting layer |
| 3 | `source_id` conventions for `opening` and `reversal` unstated | Ambiguous joins | Derived table in §4.5 — confirm |
| 4 | No `sessions` table | Session storage undefined | Likely stateless signed cookie; **[PENDING §16]** |
| 5 | No unique constraint on `transaction_lines (transaction_id, line_no)` | Duplicate line numbers possible | Recommend adding |
| 6 | No backup or retention posture stated | D1 holds the only copy of the ledger | **[PENDING §17]** |
| 7 | Replay's exact row-exclusion rule | Intermediate rows may differ | **[PENDING §15.5]** |
