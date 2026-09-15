# Maintainer Runbook

For whoever looks after this application. SRS §19.4 sets the bar: from this
document alone, without the original developer, you can **deploy, run the tests,
take a backup, and restore it.**

Everything below has been run. Where something has _not_ been run in this
account, it says so.

- [Before you start](#before-you-start)
- [Everyday commands](#everyday-commands)
- [First-time provisioning](#first-time-provisioning)
- [Deploying](#deploying)
- [Backup](#backup)
- [Restore](#restore)
- [Logins and passwords](#logins-and-passwords)
- [Fixing a wrong entry](#fixing-a-wrong-entry)
- [Incidents](#incidents)
- [Checks that still need a real browser](#checks-that-still-need-a-real-browser)
- [Things that will bite you](#things-that-will-bite-you)

---

## Before you start

| You need             | Notes                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Node 22.18+          | 24 recommended. The `scripts/` files are TypeScript run directly by Node's native type stripping, which needs 22.18 or newer. |
| pnpm 10              | `corepack enable` is enough.                                                                                                  |
| A Cloudflare account | Free plan. **No payment card** — that is why R2 is not used (§17.3).                                                          |
| `wrangler login`     | Or `CLOUDFLARE_API_TOKEN` in the environment for CI.                                                                          |

Clone, then:

```bash
pnpm install
cp .dev.vars.example .dev.vars     # then fill in AUTH_SECRET, see below
pnpm db:migrate:local
pnpm dev                           # http://localhost:5173
```

Generate a value for `AUTH_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Leaving `AUTH_SECRET` empty locally disables the login gate. That is deliberate
and local-only — see [Things that will bite you](#things-that-will-bite-you).

---

## Everyday commands

| Command                  | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `pnpm dev`               | Vite + the Worker + local D1                            |
| `pnpm check`             | typecheck, lint, tests, build — run this before pushing |
| `pnpm test`              | The full suite (pure + D1 integration in workerd)       |
| `pnpm test:watch`        | The same, watching                                      |
| `pnpm db:generate`       | Author a migration from `src/db/schema.ts`              |
| `pnpm db:migrate:local`  | Apply migrations to the local database                  |
| `pnpm db:migrate:dev`    | …to remote `ledger-dev`                                 |
| `pnpm db:migrate:prod`   | …to `ledger-prod`                                       |
| `pnpm db:export`         | Back up production ([Backup](#backup))                  |
| `pnpm db:verify-restore` | The restore drill ([Restore](#restore))                 |
| `pnpm auth:setup`        | Write the login ([Logins](#logins-and-passwords))       |
| `pnpm deploy:prod`       | Deploy to production                                    |

The suite should read **221 passing**. If a number here has drifted, the count
in [README](../README.md) and [CLAUDE.md](../CLAUDE.md) is stale, not wrong —
check what changed.

---

## First-time provisioning

**Already done for this deployment.** Kept as the procedure for a rebuild or a
move to another account.

|                    |                                                                          |
| ------------------ | ------------------------------------------------------------------------ |
| URL                | **https://ash.ashoverseas.workers.dev**                                  |
| Cloudflare account | `e5567e8cd6174399064ec40c20c71fdc`                                       |
| Worker             | `ash` (from `env.production`; the top-level `ash-dev` is never deployed) |
| Databases          | `ledger-prod`, `ledger-dev` — both region APAC                           |

⚠ **Step 5 must be `pnpm deploy:prod` and nothing else.** Not `wrangler deploy`,
and not `vite build && wrangler deploy --env production`. See "The
`CLOUDFLARE_ENV` trap" under [Things that will bite you](#things-that-will-bite-you) —
that shortcut deploys the development configuration with the auth gate disabled,
and reports success while doing it.

Once per account, following SRS §19.2.

```bash
# 1. Two databases. Separate dev and prod is mandatory (§16.4).
pnpm exec wrangler d1 create ledger-dev
pnpm exec wrangler d1 create ledger-prod
```

2. Paste both returned IDs into `wrangler.jsonc` — dev under the top-level
   `d1_databases`, prod under `env.production.d1_databases`. They ship as
   `REPLACE_WITH_LEDGER_DEV_ID` / `REPLACE_WITH_LEDGER_PROD_ID`, and local
   development works without them.

```bash
# 3. Schema.
pnpm db:migrate:dev
pnpm db:migrate:prod

# 4. The one secret. 32 random bytes.
pnpm exec wrangler secret put AUTH_SECRET --env production

# 5. Ship it.
pnpm deploy:prod

# 6. The login. Interactive; the password is not echoed.
pnpm auth:setup --env production
```

7. Sign in at the `*.workers.dev` URL and change the password from **Settings**,
   so the password you typed at a terminal is not the one that stays in use.

No custom domain and no DNS are needed — authentication is enforced inside the
Worker, not by anything in front of it.

On GitHub: private repository, branch protection on `main` requiring CI, and
Dependabot (already configured in `.github/dependabot.yml`).

---

## Deploying

```bash
pnpm check          # never deploy red
pnpm deploy:prod
```

`deploy:prod` is [`scripts/deploy-prod.ts`](../scripts/deploy-prod.ts), and it
does three things in order:

1. **Refuses to deploy without `AUTH_SECRET`.** Not belt-and-braces: without it
   the login gate disables, and the Worker's own runtime check then serves
   nothing at all — a dead site rather than an exposed one, but still a bad
   afternoon. The one exception is a first deploy, when no Worker exists to hold
   a secret yet.
2. **Builds with `CLOUDFLARE_ENV=production`**, which is the only thing that
   actually selects the environment.
3. **Reads the generated config back and refuses to upload** unless it resolved
   to `APP_ENV=production` and `ledger-prod`.

Step 3 exists because the failure it catches is otherwise completely silent — a
green build, a successful deploy, and the wrong database with the gate off. See
"The `CLOUDFLARE_ENV` trap" in
[Things that will bite you](#things-that-will-bite-you).

**Never deploy with bare `wrangler deploy`.** There is deliberately no plain
`pnpm deploy` script.

After deploying, confirm the environment from the outside rather than trusting
the output:

```bash
curl -sI https://ash.ashoverseas.workers.dev/ | grep -i content-security-policy
# must be the strict one: default-src 'self'; ... and NO 'unsafe-inline'
```

`vite dev` serves a deliberately looser CSP (`unsafe-inline`, for React Fast
Refresh — see the comment in `vite.config.ts`). Seeing that policy in production
means a development build reached the deploy.

If a migration is part of the release, apply it **before** deploying the code
that needs it:

```bash
pnpm db:migrate:prod
pnpm deploy:prod
```

Never hand-edit a migration that has been applied. Add a new one.

---

## Backup

Two independent layers (SRS §17.3):

**1. D1 Time Travel** — 30-day point-in-time recovery, on by default, free, no
configuration. Covers "someone broke it this week".

```bash
# Where can I go back to?
pnpm exec wrangler d1 time-travel info ledger-prod --env production

# Restore the whole database to a moment. DESTRUCTIVE - take a dump first.
pnpm exec wrangler d1 time-travel restore ledger-prod --env production \
  --timestamp 2026-08-30T00:00:00Z
```

**2. SQL dumps** — the long-horizon copy, because Time Travel stops at 30 days.

```bash
pnpm db:export        # writes backups/ledger-prod.sql
```

Take one **monthly and before every migration**, and keep it somewhere that is
not Cloudflare. `backups/` is gitignored and must stay that way — the file is
the complete ledger in plain text.

> `pnpm db:export` is `wrangler d1 export` plus a reordering pass. A raw D1 dump
> of this schema **cannot be replayed** — see
> [Things that will bite you](#things-that-will-bite-you). Always back up with
> this command, never with `wrangler d1 export` directly.

---

## Restore

### The drill

NFR-B3 is explicit that a restore must be _performed and verified_, not merely
documented. `pnpm db:verify-restore` is that verification, and it is re-runnable:

```bash
pnpm db:verify-restore
```

It fingerprints the source, exports it, wipes a scratch database, replays the
dump, fingerprints the result, and compares — schema, row counts, and one
dealer's entire ledger in raw integer paise, byte for byte. It fails loudly on
any difference.

Against production, restoring into a scratch database (never into `ledger-prod`):

```bash
pnpm exec wrangler d1 create ledger-scratch
node scripts/verify-restore.ts --remote \
  --source ledger-prod --source-env production --scratch ledger-scratch
pnpm exec wrangler d1 delete ledger-scratch --skip-confirmation
```

**Delete the scratch database when the drill is done.** After a successful run
it holds a complete restored copy of the ledger — every dealer, every balance —
in a database nobody is thinking about. It is a second copy of the data at rest,
so it should exist only for the length of the drill. No binding in
`wrangler.jsonc` is needed; the script addresses it by name.

**Status:** the drill is verified against **remote D1**, which is what the
production form exercises — 17 schema objects identical, row counts identical,
and a dealer's ledger byte-exact in integer paise across export → wipe → replay,
including a 1-paise entry and a ₹99,99,999.99 one. That run used seeded data in
`ledger-dev`; the data was removed afterwards and `ledger-dev` is empty again.

The drill against **`ledger-prod` itself has not passed**, and cannot yet: the
script refuses a source with no ledger entries —

```
✗ The source database has no ledger entries, so nothing would be proven.
```

which is correct behaviour, not a failure. **Re-run it against `ledger-prod`
once the owner has entered their first real transactions.** That is the last
NFR-B3 tick, and it is now the only one outstanding.

### An actual restore

```bash
pnpm db:export                                  # 1. keep the current state first
pnpm exec wrangler d1 execute ledger-prod --env production --remote \
  --yes --file backups/ledger-prod-2026-08-01.sql
```

If the target already has tables, drop them first — the dump's `CREATE TABLE`
statements will not run over existing ones.

Prefer Time Travel when the damage is inside 30 days: it is exact to the second
and needs no file.

---

## Logins and passwords

One user. Credentials live in the D1 `app_credentials` table, **not** in
environment secrets — which is what makes the in-application password change
possible: a Worker cannot rewrite its own secrets, but it can write to its
database.

**Normal change:** Settings, inside the application. Re-requires the current
password.

**Forgotten password** — a maintainer operation (§19.5):

```bash
pnpm auth:setup --env production
```

This overwrites the single credentials row. There is deliberately **no email
reset**: it would be an unauthenticated write path into the only thing
protecting the data.

Changing the password or username signs out every other session immediately —
the session cookie is bound to the credentials' `updated_at`. The device you
change it on stays signed in. That is the tool to reach for if a phone is lost.

---

## Fixing a wrong entry

**Nothing is ever deleted**, even though the owner's button says **Delete**.
Underneath, a delete is a **void**: the source is flagged, an equal and opposite
reversing entry is posted against it, the dealer's ledger is replayed, and an
audit row is written. The screen hides the pair by default ("Show deleted
entries" reveals it); exports always include both, marked "Deleted" and "Cancels
a deleted entry". Deleting a **dealer** archives them; "Show deleted dealers" on
the Dealers screen finds them again, and their page has Restore.

A wrong **balance from the old book** is corrected the same way: Delete it on the
dealer page, then "Add balance from old book" appears again. Only one can be live
per dealer; a second is refused with `OPENING_EXISTS`.

- Wrong **amount, date, quantity, rate, GST rate, discount, freight, dealer or
  mode** → delete it and re-enter. There is no edit path for these, on purpose.
- Wrong **note, reference tag, or item-name spelling** → these are non-financial
  and may be edited in place; the edit is audited. Open the entry from the dealer
  screen or the all-transactions list — **View or edit** — and change the wording
  there. The figures on that sheet are text, not fields: there is deliberately
  nothing to type an amount into.

  Behind it is `PATCH /api/transactions/:id`, whose request schema is `.strict()`.
  Sending it a financial field is a `400`, never a quietly ignored key — being
  told an amount changed when it did not is worse than being refused.

`recomputeLedger(dealerId)` replays every non-voided entry from zero (or from the
opening entry) and rewrites the running balances. It runs automatically after
every void and after any back-dated insert. `checkLedgerIntegrity()` verifies the
stored running balances against a fresh replay without changing anything — that
is the one to reach for if a balance ever looks wrong.

The **Activity log** (Account → Activity log) shows every create, delete, edit and sign-in, newest
first. It is read-only: no route anywhere updates or deletes an audit row.

---

## Incidents

**"The site returns 503 and says AUTH_SECRET."** Working as designed. Production
refuses to serve rather than serve the ledger with the gate open. Set the secret
and redeploy:

```bash
pnpm exec wrangler secret put AUTH_SECRET --env production
pnpm deploy:prod
```

**"Nobody can log in."** Check `pnpm exec wrangler d1 execute ledger-prod --env production --remote --command "SELECT username, updated_at FROM app_credentials"`.
No row means the setup script was never run against this database. Run
`pnpm auth:setup --env production`.

**"A balance looks wrong."** Do not edit the database. Run the integrity check,
read the dealer's history, and find the entry — then delete it. If the stored
balance disagrees with a replay, that is a bug worth reporting with the dealer id.

**"I need to see what happened."** The Activity log (on the Account page), then Cloudflare's Workers
logs (`observability` is enabled). Note that **no money or dealer detail is ever
logged** (§16.3), by design — the audit table is the record, not the logs.

**Rolling back a deploy.** Cloudflare keeps previous Worker versions; roll back
in the dashboard, or redeploy the previous commit. A rollback does **not** undo a
migration — if the release included one, restore the data separately.

---

## Checks that still need a real browser

Everything above has been verified by running it. These four cannot be, from a
terminal, and should be walked through once before the owner starts entering real
data:

1. **The interface on a real phone.** Every screen has been checked at 360, 375,
   768 and 1280 px in headless Chrome (no horizontal overflow, 44 px touch
   targets, visible keyboard focus, no console errors — see LAUNCH_REPORT.md).
   What an emulator cannot judge is one-handed use, touch feel and the iOS
   keyboard; NFR-U2 needs an eye on a real device.
2. **An Excel and a CSV download actually save.** The workbook is built in the
   browser and handed over as a `blob:` object URL. Downloads started by
   `<a download>` are not governed by CSP fetch directives, so
   `default-src 'self'` should not interfere — but the export is the single most
   important output of this application, and "should" is not "did".
3. **The PWA installs and the shell loads offline**, while `/api` still refuses
   to serve anything from cache. A stale balance is a dangerous balance, which is
   why `public/sw.js` returns early for every `/api` path.
4. **The entry detail sheet on a real phone.** Checked at 360 px in headless
   Chrome; its scrolling inside the bottom sheet has not been felt by a thumb.

---

## Things that will bite you

1. **PBKDF2 iterations are capped at 100,000.** Above that the Workers runtime
   throws `NotSupportedError` — but the Node test runner does not, so a higher
   value passes the entire suite and then fails on the first real login.
   `PBKDF2_ITERATIONS` in `src/auth/crypto.ts` is asserted by a test for exactly
   this reason. Do not raise it.

2. **`AUTH_SECRET` unset disables the gate.** Locally that is a convenience. In
   production the Worker refuses to serve at all, and `deploy:prod` refuses to
   ship. Do not "fix" either check. The one exception, deliberate: on a FIRST
   deploy there is no Worker yet, so its secrets cannot be listed —
   `require-auth-secret.ts` recognises that, warns, and continues, because the
   Worker it creates will refuse to serve until the secret is set.

3. **The `CLOUDFLARE_ENV` trap — this one already caused a bad deploy.** With
   `@cloudflare/vite-plugin`, `vite build` resolves the Worker configuration at
   **build** time and writes it to `dist/<top-level name>/wrangler.json`, then
   points `.wrangler/deploy/config.json` at it. `wrangler deploy` reads that
   artefact. So `wrangler deploy --env production` is **silently ignored** — the
   environment was decided during the build.

   The first deploy of this project went out that way and reported success,
   with:

   ```
   env.DB (ledger-dev)            D1 Database
   env.APP_ENV ("development")    Environment Variable
   ```

   `APP_ENV=development` is the value that switches OFF the fail-closed check.
   That Worker would not have refused to serve without `AUTH_SECRET`; it would
   have served the ledger with the sign-in gate disabled, against the dev
   database.

   The environment is chosen by `CLOUDFLARE_ENV` in the build's environment, and
   `scripts/deploy-prod.ts` does that, then reads the generated config back and
   refuses to upload unless it says `APP_ENV=production` and `ledger-prod`.
   **Always deploy with `pnpm deploy:prod`.** There is deliberately no plain
   `pnpm deploy` script any more — it was the same trap without the guard.

4. **A raw `wrangler d1 export` dump cannot be replayed.** Its statements come
   out alphabetically, so `INSERT INTO "transaction_lines"` lands before
   `CREATE TABLE transactions`, and the import dies on
   `no such table: main.transactions`. The `PRAGMA defer_foreign_keys=TRUE` in
   the dump does not help — that defers enforcement, and this is the parent table
   not existing yet. `pnpm db:export` reorders the statements to fix it. Use it.

5. **`run_worker_first: true` in `wrangler.jsonc` must stay.** Without it the
   assets service answers before the Worker runs, and the HTML document ships
   with none of the §16.2 security headers — and the production fail-closed check
   is skipped for the app shell.

6. **The session cookie is `SameSite=Strict`**, not `Lax`.

7. **Never point the restore drill at `ledger-prod` as its scratch database.**
   The script refuses, but the refusal is the second line of defence.

8. **`.dev.vars` is loaded by the test runner.** The suite resets `AUTH_SECRET`
   before every test so results do not depend on whether your machine has that
   file. If you add a test that cares about the gate, arm it explicitly.

9. **The service worker must never serve the HTML page from cache while
   online.** It once did — `/` cache-first under a cache name that never
   changed — and after a redeploy the owner's phone kept loading old HTML that
   asked for bundles which no longer existed. The server answered those with
   `index.html` and a 200, the browser refused to run HTML as a script, and the
   site was a blank page for the one person who had visited before, while
   working for everyone else. `public/sw.js` is now network-first for
   navigations, and missing `/assets/*` are a real 404. **If you change the
   caching rules in `sw.js`, bump `SHELL`** — that is what clears old caches.
   If a phone is ever stuck on a blank page, reloading twice lets the new worker
   take over; clearing site data for the URL fixes it immediately.

10. **The login rate limit fails open without its binding.** `LOGIN_LIMITER` is
    a Cloudflare rate-limit binding (10 sign-in attempts a minute per IP), and
    bindings do not inherit into `env.production` — it is declared twice in
    `wrangler.jsonc`. Without it the login route skips the check rather than
    breaking local development and tests, so `scripts/deploy-prod.ts` refuses a
    production build that lacks it. The limit is approximate and counted per
    Cloudflare location by design: it slows a guessing run, it does not count
    exactly.
11. **`wrangler types` reads `.dev.vars`.** Regenerating the binding types adds
    `AUTH_SECRET: string` to `worker-configuration.d.ts`, which breaks the
    typecheck — the Worker declares it optional, because unset is a real state.
    Delete those generated lines after running it.

## September 2026 ledger repair release

This release adds `0001_silly_impossible_man.sql`. It has been applied by the isolated integration suite, **not to the remote databases** during the repair pass.

1. Arrange a quiet write window and take a production backup with `pnpm db:export` using the backup procedure above.
2. Apply and verify the migration in development/staging first. It adds `ledger_write_revision` and `request_receipts` without altering existing ledger rows.
3. For the production release, run `pnpm db:migrate:prod` before `pnpm deploy:prod`. Do not deploy the new code against a database missing these tables.
4. Check the deployment protections and complete the browser/export/PWA checks listed in `LAUNCH_REPORT.md` before calling the release verified.

All writes that change dealers, transaction details or ledger balances must use `withLedgerWrite`. Its revision check, writes, replay and retry receipt form one atomic D1 batch. A direct SQL maintenance write or an older Worker version bypasses this guard, so do not mix those writers with the new version during the transition.

The migration does not repair historical incorrect balances. Reconcile source records and inspect `checkLedgerIntegrity` before any targeted maintenance replay. `recomputeLedger` now performs its updates and audit atomically. Back up before maintenance and verify exact paise afterward.

Keep both new tables in full backups. Retry receipts deliberately have no automatic expiry: purging them permits old keys to create another entry. If rollback of application code becomes necessary, leave the additive tables in place; the old version still has the concurrency defects and should not resume normal financial entry until repaired. This release has not had a production rollback drill.
