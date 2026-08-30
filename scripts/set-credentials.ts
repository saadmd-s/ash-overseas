/**
 * Write the single `app_credentials` row — SRS §19.2 step 7, §19.5.
 *
 * This is the ONLY way credentials get into a fresh deployment, and the only
 * recovery path if the owner forgets the password. There is deliberately no
 * email reset: that would be an unauthenticated write path into the one thing
 * protecting the data (§19.5).
 *
 * It imports `hashPassword` from the same module the Worker uses, on purpose.
 * A script that re-implemented the `pbkdf2$<iters>$<salt>$<hash>` format would
 * drift from the verifier the first time either side changed, and the symptom
 * would be "the password I just set does not work" — with nothing to point at.
 *
 * Usage:
 *   node scripts/set-credentials.ts --local
 *   node scripts/set-credentials.ts --env dev
 *   node scripts/set-credentials.ts --env production
 *
 * Requires Node 22.18+ or 24+ (native TypeScript type stripping).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { hashPassword } from '../src/auth/crypto.ts';
import { fail, wrangler } from './lib.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const local = flag('local');
const target = value('env') ?? (local ? 'dev' : undefined);

if (!target || !['dev', 'production'].includes(target)) {
  fail('Pass --local, --env dev, or --env production.');
}

const database = target === 'production' ? 'ledger-prod' : 'ledger-dev';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * One readline interface for the whole run, created once.
 *
 * Not one per question: a second interface has to re-attach to stdin, and
 * whatever the first one had already buffered is lost with it — which shows up
 * as the second prompt hanging forever on piped input, and as intermittently
 * dropped keystrokes on a real terminal.
 */
const interactive = process.stdin.isTTY === true;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  // `terminal: true` puts readline in raw mode, which needs a real TTY. Forced
  // on for a pipe it swallows everything after the first line and the script
  // hangs on the password prompt.
  terminal: interactive,
});

/**
 * Answers are queued rather than awaited one `rl.question` at a time.
 *
 * On a pipe, readline emits every line the moment the data arrives — before the
 * second question has been asked. `rl.question` only listens for the NEXT line,
 * so those early lines are dropped and the script waits forever for input it
 * has already been given. Buffering them makes the same code work at a
 * keyboard and under `printf ... | node`, which is what lets this script be
 * exercised as part of the release check instead of only by hand.
 */
const answers: string[] = [];
const waiting: ((line: string) => void)[] = [];

rl.on('line', (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else answers.push(line);
});

type Muteable = { _writeToOutput: (s: string) => void };

function ask(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    // Written first, THEN muted: readline echoes the prompt through this same
    // hook, so muting earlier would hide the question along with the answer.
    // Nothing to mute when there is no terminal echoing in the first place.
    const echo = (rl as unknown as Muteable)._writeToOutput;
    if (hidden && interactive) (rl as unknown as Muteable)._writeToOutput = () => {};

    const done = (answer: string) => {
      (rl as unknown as Muteable)._writeToOutput = echo;
      if (hidden && interactive) process.stdout.write('\n');
      resolve(answer);
    };

    const buffered = answers.shift();
    if (buffered !== undefined) done(buffered);
    else waiting.push(done);
  });
}

// ---------------------------------------------------------------------------

console.log(`\nSetting the login for ${database}${local ? ' (local)' : ' (remote)'}.`);
if (target === 'production') {
  console.log('⚠ This overwrites the production login. The old password stops working at once.');
}

const username = (await ask('\nUsername: ')).trim();
if (!USERNAME_PATTERN.test(username)) {
  fail('Username must be 3–32 characters: letters, digits, dot, underscore, hyphen.');
}

const password = await ask('Password (not shown): ', true);
if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
}
if ((await ask('Confirm password: ', true)) !== password) {
  fail('The two passwords do not match. Nothing was written.');
}

// Nothing more is read from stdin; leaving it open would hold the process
// alive after the last message.
rl.close();

console.log('\nHashing (PBKDF2-SHA256, 100,000 iterations)…');
const passwordHash = await hashPassword(password);

// ---------------------------------------------------------------------------
// Write it
// ---------------------------------------------------------------------------

/**
 * The SQL goes through a temp file rather than `--command`, so nothing has to
 * survive shell quoting on the way — and the values are single-quote-escaped on
 * top of that. The username is already restricted to a strict character class
 * above, and a PBKDF2 record is base64 and digits.
 */
const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

// DELETE then INSERT, not UPDATE: a fresh database has no row to update, and
// §19.5 needs re-running this to be the recovery path on an existing one.
const sql = [
  'DELETE FROM app_credentials;',
  `INSERT INTO app_credentials (username, password_hash, updated_at)`,
  `VALUES (${quote(username)}, ${quote(passwordHash)}, unixepoch());`,
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'ash-creds-'));
const file = join(dir, 'set-credentials.sql');

try {
  writeFileSync(file, sql, { mode: 0o600 });

  const args = ['d1', 'execute', database];
  if (target === 'production') args.push('--env', 'production');
  args.push(local ? '--local' : '--remote', '--yes', '--file', file);

  // Through the shared runner, which spawns wrangler without a shell: the temp
  // path here routinely contains a space, and a shell would split it in two.
  const run = wrangler(args, { capture: true, allowFailure: true });
  if (!run.ok) {
    console.error(run.stdout, run.stderr);
    fail('wrangler failed - the credentials were NOT written.');
  }
} finally {
  // The file holds the hash, never the password, but it has no reason to
  // outlive the command either.
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ Login set for ${database}. Sign in as "${username}".`);
if (target === 'production') {
  console.log('  Change the password from inside the application once you are in (Settings).');
}
