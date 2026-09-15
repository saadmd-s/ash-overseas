# Weekly backups ? activation and recovery

The code is implemented locally. **The schedule is not active until these changes reach the private repository's default branch and the account settings below are completed.** No production export, secret upload, or remote restore was performed during implementation.

## What runs automatically

Every **Sunday at 03:47 AM IST** (Saturday 22:17 UTC), `.github/workflows/backup.yml`:

1. Exports all of `ledger-prod` using the existing SQL export wrapper.
2. Restores that exact dump into an isolated, in-memory SQLite database on the GitHub runner.
3. Checks required tables, SQLite integrity, foreign keys, safe integer paise and **every stored running balance**, ordered by dealer/date/id. It accepts an empty ledger but clearly marks that a populated restore drill remains necessary.
4. Packages SQL plus an encrypted manifest containing row counts, checksums, timestamp, Git commit, run ID and encryption-key fingerprint.
5. Compresses and encrypts to your public OpenPGP key. Only the `.gpg` file and its ciphertext checksum are uploaded. Raw SQL, logs and manifest never become artifacts.
6. Retains the private artifact for **90 days** and signals success to Healthchecks. Failures send a failure signal; a missed run is detected by Healthchecks independently of GitHub.

Manual runs use the same process. Runs are restricted to the private repository's default branch, serialized, and limited to 25 minutes. Cloudflare credentials are available only to configuration validation and export, not installation or restore verification. The workflow has read-only repository permissions; action versions are pinned to commits and Dependabot can propose updates.

D1 exports briefly block other database requests, which is why this runs overnight. [Cloudflare export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations).

## 1. Create your recovery key on your computer

Do this yourself so the private recovery key and its password remain under your control.

1. Install **Gpg4win**, including Kleopatra, from [gpg4win.org](https://www.gpg4win.org/). Reopen PowerShell afterward so `gpg` is available.
2. Open **Kleopatra ? File ? New OpenPGP Key Pair** (some versions call this New Certificate).
3. Name it **ASH Overseas Backup**. Create an OpenPGP key with encryption capability and protect it with a strong passphrase. Store the passphrase in your password manager. If the key expires, set a reminder to renew it before that date.
4. Select the new certificate and open its details. Copy the full **fingerprint**, not the short key ID.
5. Choose **Export** / **Export Certificates** to save the **public** key as an armored `.asc` file. Open it in a text editor: it must begin `-----BEGIN PGP PUBLIC KEY BLOCK-----`.
6. Separately choose **Backup Secret Keys** / **Export Secret Keys**. Save that password-protected private backup on an offline USB drive, and keep a second protected copy separately. Never add it to GitHub, the repository, or a chat.

If you prefer commands, `gpg --full-generate-key` starts an interactive wizard. After creation, use `gpg --list-keys --fingerprint` and `gpg --armor --output backup-public.asc --export YOUR_FULL_FINGERPRINT` to export only the public key. Run these outside the repository.

Losing the private key or its passphrase makes the encrypted backups unrecoverable. GitHub cannot decrypt them for you.

## 2. Create a dedicated Cloudflare export token

1. Open [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Choose **Create Token ? Create Custom Token**.
3. Name: **ASH weekly backup**.
4. Start with permission **Account ? D1 ? Read**. Restrict Account Resources to the ASH account, ID `e5567e8cd6174399064ec40c20c71fdc`.
5. Do not add Worker deployment, DNS or unrelated permissions. This workflow performs no production SQL writes. D1 token scope may cover other D1 databases within the selected account; it is not claimed to be isolated to one database.
6. Create the token and copy it directly into the GitHub secret in step 4. Keep any expiry date in your password manager and renew before it expires. Do not use a Global API Key.

The first manual run verifies whether this token can export in your account. If Cloudflare refuses the export with a permissions error, verify the selected account and D1 export permissions before granting additional access; do not replace it with an unrestricted token. The read-only export token has not been tested against your account here.

## 3. Set up missing-backup alerts

1. Open [Healthchecks.io](https://healthchecks.io/) and create/sign in to an account. It offers a card-free tier suitable for this one check.
2. Create a check named **ASH weekly database backup**.
3. Select **Cron** scheduling. Use `17 22 * * 6` with timezone **UTC**, and **Grace Time: 24 hours**. This expects the Sunday IST backup and alerts by Monday morning if no success arrives. Cron mode keeps extra manual runs from postponing the next expected weekly backup.
4. Enable the email integration for your address and send its test notification. Confirm that it arrives.
5. Copy the UUID Ping URL, shaped like `https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, with no trailing slash. Keep it secret. The workflow accepts this host/format and sends only status pings, not ledger contents.
6. After the first manual backup succeeds, confirm the check is **Up**. A new check is not proven active until it receives a signal. Enable repeated down reminders if desired.

This monitor detects missed schedules even if GitHub Actions itself stops running. [Healthchecks setup](https://healthchecks.io/docs/monitoring_cron_jobs/) and [cron settings](https://healthchecks.io/docs/configuring_checks/).

## 4. Add the GitHub settings

Open [saadmd-s/ash-overseas](https://github.com/saadmd-s/ash-overseas).

1. Confirm the repository is **Private** and review who has access.
2. Open **Settings ? Secrets and variables ? Actions ? Secrets ? New repository secret**. Add:

| Secret name               | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| `CLOUDFLARE_BACKUP_TOKEN` | The dedicated Cloudflare token from step 2           |
| `BACKUP_PUBLIC_KEY`       | Entire public `.asc` file, including BEGIN/END lines |
| `BACKUP_HEARTBEAT_URL`    | The Healthchecks UUID Ping URL                       |

3. On the **Variables** tab, add:

| Variable name            | Value                                                               |
| ------------------------ | ------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`  | `e5567e8cd6174399064ec40c20c71fdc`                                  |
| `BACKUP_KEY_FINGERPRINT` | The full public-key fingerprint from Kleopatra; spaces are accepted |

4. Under **Settings ? Actions ? General**, enable GitHub Actions and permit the official `actions/*` and `pnpm/action-setup` actions used here. Set artifact retention to at least **90 days**, subject to your account/organization limit. The workflow requests 90 days explicitly.
5. In your personal **Settings ? Notifications**, enable Actions email notifications, including failures. Healthchecks is the independent alert path; GitHub email alone does not detect a job that never starts.
6. Check your GitHub Actions storage allowance and keep spending disabled if you require a strictly free setup. Compressed encrypted files still count toward artifact storage. Retained size is roughly one dump per week for 13 weeks, plus manual runs and existing CI artifacts.

**Never put the private recovery key, its passphrase, or `AUTH_SECRET` in this workflow.** `AUTH_SECRET` is a Worker secret, not part of the SQL dump; retain a separate recovery record for it or plan to rotate it during a rebuild (existing sessions will end).

## 5. Publish the code and run the first backup

1. In your IDE's Source Control view, review and commit the intended changes, including the new workflow, Python scripts, export fix, tests and documentation. There are also earlier release repairs in this workspace; review those together rather than blindly staging unrelated files.
2. Push the commit/branch and merge it into the repository's default branch (currently expected to be `main`). Wait for CI to pass, including **Backup verification and encryption tests**. No production application deployment is needed just to enable this export workflow.
3. Open **Actions ? Weekly database backup ? Run workflow**. Choose the default branch and click **Run workflow**.
4. Wait for a green run. Check that **Export**, **Restore and verify**, **Encrypt package**, **Store encrypted backup**, and **Report successful backup** all succeeded. A skipped workflow is not a successful backup.
5. On the run's Summary page, download the `ledger-prod-<run-id>-<attempt>` artifact. Unzip it to find a dated `.tar.gz.gpg` and its `.sha256` file.
6. Confirm Healthchecks is **Up**, then perform step 6 below. Only after a real download/decryption check should you consider the setup activated.

Both the older deployed schema and the additive guarded-write migration are supported by the validator. If only one of the two new tables exists, verification fails. The backup does not apply migrations, deploy code, correct balances, or restore production.

## 6. Prove you can recover the downloaded file

1. Put the downloaded files in a private folder outside the repository.
2. In PowerShell, run `Get-FileHash -Algorithm SHA256 .\YOUR-FILE.tar.gz.gpg`. Compare the hash with the accompanying `.sha256` file (case does not matter).
3. In Kleopatra choose **Decrypt/Verify**, select the `.gpg` file, and enter your private-key passphrase. Save the resulting `.tar.gz` locally.
4. Extract the archive. It should contain **ledger-prod.sql** and **manifest.json**. These are sensitive plaintext; keep them in the private folder.
5. Compare `Get-FileHash -Algorithm SHA256 .\ledger-prod.sql` with `sql_sha256` inside `manifest.json`.
6. From the project folder, run `python scripts/verify-backup.py "C:\path\to\ledger-prod.sql" --report "C:\path\to\local-check.json"`. This restores only into memory and checks every balance. It never connects to production.
7. Keep an encrypted copy on independent storage, then remove unneeded plaintext copies using your normal private-data handling process.

The weekly automated check proves that the exported SQL restores into SQLite and that the stored balances reconcile. It cannot prove that the source contains every intended business transaction, or that you still possess a usable private key. Repeat the download/decrypt check **quarterly** and after key changes. Follow the existing [runbook restore drill](RUNBOOK.md#restore) for an isolated D1 restore; a successful SQLite check does not replace that production-platform drill. Never experiment by restoring over `ledger-prod`.

## Ongoing routine

- **Each month:** download one successful encrypted backup and checksum to your computer and a separate drive. Keep 12 monthly copies. GitHub artifacts expire; they are not a permanent archive.
- **Before migrations/releases:** use Run workflow and wait for its artifact before proceeding. During actual restore or maintenance, follow the runbook's quiet-write window.
- **On an alert:** inspect Actions and the age of the last retained artifact immediately. Fix the issue, run a manual backup, and confirm Healthchecks returns to Up. Do not silence an alert by manually pinging success.
- **On verification failure:** preserve the production database and existing backups; investigate the ledger privately. Do not weaken validation or silently recompute production to make the job green. Private export diagnostics are withheld from Actions logs; reproduce locally with authorized access if necessary.
- **On key rotation:** update the public key and fingerprint together, run and decrypt a new backup, and retain old private keys while any old backups remain.
- **On token expiry/quota failure:** renew the scoped token or reclaim expired/unneeded artifacts, then retry. Never delete your only recoverable copy.

Weekly exports can leave up to seven days to re-enter if Cloudflare becomes unavailable. D1 Free Time Travel provides a separate recent-recovery layer but remains in the same provider/account. [Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

## Local verification performed

Eight offline Python tests passed, including current-schema restore, integrity failures, unsafe paise, empty-ledger marking, rejecting private keys, and encrypt/decrypt of a synthetic dump with exact SQL checksum comparison. Nine export-reordering tests passed, including SQL-like multiline notes. TypeScript and ESLint passed. No real backup artifact or GitHub schedule has been exercised from this environment; activation steps above remain required.
