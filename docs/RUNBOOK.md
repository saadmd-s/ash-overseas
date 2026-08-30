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

The suite should read **196 passing**. If a number here has drifted, the count
in [README](../README.md) and [CLAUDE.md](../CLAUDE.md) is stale, not wrong —
check what changed.

---

## First-time provisioning

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

`deploy:prod` runs `scripts/require-auth-secret.ts` first and **refuses to
deploy** if `AUTH_SECRET` is missing from the production environment. That is
not belt-and-braces: without it the login gate silently disables, and the
Worker's own runtime check would then serve nothing at all — a dead site rather
than an exposed one, but still a bad afternoon.

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
# add ledger-scratch to wrangler.jsonc temporarily, then:
node scripts/verify-restore.ts --remote \
  --source ledger-prod --source-env production --scratch ledger-scratch
```

**Status:** verified against a local database with real history. The production
form of the drill has not been run in this account, because the account does not
exist yet — it is step 8 of first-time provisioning, and it is the last thing
that should be ticked before the owner enters real data.

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

**Nothing is ever deleted.** A correction is a **void**: the source is flagged,
an equal and opposite reversing entry is posted against it, the dealer's ledger
is replayed, and an audit row is written. Both the original and the reversal stay
visible, and both appear in exports, flagged.

- Wrong **amount, date, quantity, rate, GST rate, discount, freight, dealer or
  mode** → void it and re-enter. There is no edit path for these, on purpose.
- Wrong **note, reference tag, or item-name spelling** → these are non-financial
  and may be edited in place; the edit is audited.

`recomputeLedger(dealerId)` replays every non-voided entry from zero (or from the
opening entry) and rewrites the running balances. It runs automatically after
every void and after any back-dated insert. `checkLedgerIntegrity()` verifies the
stored running balances against a fresh replay without changing anything — that
is the one to reach for if a balance ever looks wrong.

The **Audit log** screen shows every create, void, edit and sign-in, newest
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
read the dealer's history, and find the entry — then void it. If the stored
balance disagrees with a replay, that is a bug worth reporting with the dealer id.

**"I need to see what happened."** The Audit log screen, then Cloudflare's Workers
logs (`observability` is enabled). Note that **no money or dealer detail is ever
logged** (§16.3), by design — the audit table is the record, not the logs.

**Rolling back a deploy.** Cloudflare keeps previous Worker versions; roll back
in the dashboard, or redeploy the previous commit. A rollback does **not** undo a
migration — if the release included one, restore the data separately.

---

## Checks that still need a real browser

Everything above has been verified by running it. These three cannot be, from a
terminal, and should be walked through once before the owner starts entering real
data:

1. **The interface at 360 px.** It is built mobile-first with 44 px tap targets
   and it has never been looked at on a phone. NFR-U2 asks for one-handed use at
   360 px; that is a judgement only an eye can make.
2. **An Excel and a CSV download actually save.** The workbook is built in the
   browser and handed over as a `blob:` object URL. Downloads started by
   `<a download>` are not governed by CSP fetch directives, so
   `default-src 'self'` should not interfere — but the export is the single most
   important output of this application, and "should" is not "did".
3. **The PWA installs and the shell loads offline**, while `/api` still refuses
   to serve anything from cache. A stale balance is a dangerous balance, which is
   why `public/sw.js` returns early for every `/api` path.

---

## Things that will bite you

1. **PBKDF2 iterations are capped at 100,000.** Above that the Workers runtime
   throws `NotSupportedError` — but the Node test runner does not, so a higher
   value passes the entire suite and then fails on the first real login.
   `PBKDF2_ITERATIONS` in `src/auth/crypto.ts` is asserted by a test for exactly
   this reason. Do not raise it.

2. **`AUTH_SECRET` unset disables the gate.** Locally that is a convenience. In
   production the Worker refuses to serve at all, and `deploy:prod` refuses to
   ship. Do not "fix" either check.

3. **A raw `wrangler d1 export` dump cannot be replayed.** Its statements come
   out alphabetically, so `INSERT INTO "transaction_lines"` lands before
   `CREATE TABLE transactions`, and the import dies on
   `no such table: main.transactions`. The `PRAGMA defer_foreign_keys=TRUE` in
   the dump does not help — that defers enforcement, and this is the parent table
   not existing yet. `pnpm db:export` reorders the statements to fix it. Use it.

4. **`run_worker_first: true` in `wrangler.jsonc` must stay.** Without it the
   assets service answers before the Worker runs, and the HTML document ships
   with none of the §16.2 security headers — and the production fail-closed check
   is skipped for the app shell.

5. **The session cookie is `SameSite=Strict`**, not `Lax`.

6. **Never point the restore drill at `ledger-prod` as its scratch database.**
   The script refuses, but the refusal is the second line of defence.

7. **`.dev.vars` is loaded by the test runner.** The suite resets `AUTH_SECRET`
   before every test so results do not depend on whether your machine has that
   file. If you add a test that cares about the gate, arm it explicitly.
