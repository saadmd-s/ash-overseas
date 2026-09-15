# Release repair report ? 15 September 2026

**The reproduced code blockers are repaired locally. Production release verification is still pending.** No deployment, remote migration or production financial write was performed. The earlier audit is superseded by this report; the original historical launch report remains in `docs/LAUNCH_REPORT_2026-09-13.md`.

## Repairs

- **Concurrent writes:** a database revision guard protects read/prepare/commit across Worker instances. A stale preparation rolls back and retries. IDs come from the inserting batch, so overlapping saves cannot return another request's ID.
- **Atomic replay and correction:** source rows, sequence, ledger posting, backdated balance updates and audit now commit in one D1 batch. Dealer creation, its optional opening and audit are atomic too. Concurrent openings and double deletions are checked within the guarded operation.
- **Retry safety:** creation APIs accept `Idempotency-Key`. The payload fingerprint and original result commit with the financial write. Same-key retries return the saved result; reuse for different details is rejected. Entry drafts retain a seed so retrying a lost response uses the same key. Dealer/opening dialog seeds last for the current mounted form; closing and recreating those forms starts a new operation. Requests without a key remain supported and are not deduplicated.
- **Money safety:** writes and replay reject unsafe cumulative balances. Export totals sum integer paise before converting to rupees and reject aggregate overflow. Appendix B formulas remain unchanged.
- **Input and resource limits:** real calendar-date validation, calculated-total checks, 256 KiB API body limit, 25 goods lines, 200-character names, 500-character general text and 4,000-character notes. Cross-dealer filters reject invalid values.
- **Export security:** CSV formula-like text is escaped as text; numeric balances stay numeric. Large ID selections use one JSON parameter instead of exceeding D1's bind-parameter limit. Dealer balance reads no longer issue a query per dealer.
- **History navigation:** transaction cursors follow `(entry_date, id)`, including backdated rows. Transactions and activity screens expose older pages. Dealer search ignores stale responses. Unknown client routes show a missing-page message.
- **Client reliability:** guarded preference storage, dealer/mode-specific form mounting, keyboard focus containment/restoration in dialogs, and service-worker cache writes tied to event lifetime. Cache-first requests are restricted to shell assets; API data remains network-only.
- **Security handling:** API responses explicitly use `no-store`; unexpected database failures return generic errors without SQL parameters in logs. Cash payments normalize their bank tag consistently.
- **Dependencies:** scoped patches for transitive sharp and esbuild; `pnpm audit` reports no known vulnerabilities. This is an advisory check, not proof of absence of vulnerabilities.

## Verification

- Final full regression suite passed: **268 tests across 17 files**, including retry results for every creation type, client retry behavior/storage failure, and exact fractional-rupee export totals.
- Actual D1 failure injection proves rollback during backdated replay, opening insertion, void replay and retry-receipt insertion. The former mocked opening failure now exercises a real database trigger.
- Concurrent payments return distinct IDs and preserve balances. Concurrent same-key retries produce one payment. Overlapping voids/openings preserve their invariants.
- A backdated insert successfully replayed **10,000 ledger rows** in local D1 with exact integrity verification. This is a synthetic correctness/capacity check, not a production latency benchmark or an unlimited-history guarantee.
- TypeScript and ESLint passed. Default and production-selected builds passed. Generated production config was checked: Worker `ash`, `APP_ENV=production`, database `ledger-prod`.
- `pnpm db:generate` reported no schema drift after generation. Integration tests apply the committed migrations to isolated local databases.
- No connected browser was available on 15 September. Prior live HTTP/security evidence from 14 September remains in ignored `.prelaunch/live-2026-09-14.json`; it describes the previous deployed version, not these local repairs.

## Deployment and remaining gates

1. Review and apply the new additive migration `0001_silly_impossible_man.sql` before deploying this code. It creates `ledger_write_revision` and `request_receipts`; there are no destructive schema changes. Follow the release section in `docs/RUNBOOK.md`, including a backup first. Keep all financial writes on the guarded code path. Direct SQL writes bypass this protection.
2. Deploy only through `pnpm deploy:prod`. Recheck authentication, strict CSP, security headers and no-store responses against the deployed build.
3. Use disposable staging data to verify owner workflows, all exports in both formats under production CSP, pagination, keyboard dialogs, mobile layout and PWA install/update/offline behavior. A real phone check is still required.
4. Complete the isolated production backup/restore drill with meaningful data and verify recurring backups. The existing remote-development drill is historical evidence, not a completed production drill.

Existing data is not automatically repaired by this migration. If an earlier overlapping save affected stored balances, inspect ledger integrity and reconcile source entries before using the existing recompute maintenance helper; never invent or discard financial records to make totals match. Retain retry receipts in backups: deleting them removes deduplication for older retry keys. A response replay returns the original save result, not a freshly queried current balance.

Owner choices in SRS ?22 remain unchanged (cash bank tag, default history order, payments in the all-transactions export, and branding).
