/**
 * Refuse to deploy to production without AUTH_SECRET — SRS §16.1.
 *
 * "The build must refuse to start in production mode without it."
 *
 * The Worker enforces this at runtime as well (src/worker/index.ts serves
 * nothing at all in production while the secret is missing), and that runtime
 * check is the one that actually protects the data — a secret can be deleted
 * long after a successful deploy.
 *
 * This one exists so the failure surfaces at `pnpm deploy:prod`, rather than
 * being discovered by whoever opens the URL afterwards.
 *
 * Requires Node 22.18+ or 24+ (native TypeScript type stripping).
 */

import { parseJsonArray, wrangler } from './lib.ts';

const { ok, stdout, stderr } = wrangler(['secret', 'list', '--env', 'production'], {
  capture: true,
  allowFailure: true,
});

/**
 * THE FIRST DEPLOY IS A SPECIAL CASE, and getting it wrong makes this script
 * impassable.
 *
 * `wrangler secret list` needs the Worker to exist. Before the very first
 * deploy it does not, so the call fails with "Worker ... not found" — which is
 * not a missing secret and not a login problem. Treated as a generic failure it
 * blocks the only deploy that could ever create the Worker, and blames the
 * login while doing it. (Observed on the real first deploy; the message sent
 * you looking at wrangler auth, which was fine.)
 *
 * Allowing it through is safe, and that is the point: `src/worker/index.ts`
 * refuses to serve ANYTHING in production while AUTH_SECRET is unset. A first
 * deploy without the secret produces a Worker that answers every request with
 * a refusal — never the ledger. The runtime check is the one protecting the
 * data; this script only exists to surface the problem at deploy time instead
 * of leaving it for whoever opens the URL.
 */
const workerMissing = /not found|does not exist/i.test(`${stderr}${stdout}`);

if (!ok && workerMissing) {
  console.warn(
    [
      '',
      '! No Worker exists yet, so its secrets cannot be listed. Treating this',
      '  as the first deploy and continuing.',
      '',
      '  The deployed Worker will REFUSE TO SERVE until you run:',
      '    pnpm exec wrangler secret put AUTH_SECRET --env production',
      '',
    ].join('\n'),
  );
} else if (!ok) {
  console.error('\nX Could not list production secrets. Is wrangler logged in?\n');
  console.error(stderr || stdout);
  process.exit(1);
}

/**
 * Parsed properly when the output looks like JSON, with a substring fallback:
 * a wrangler version that changes its output shape must not be able to turn
 * this check into a silent pass.
 *
 * The bracket test is doing real work. `parseJsonArray` reports a malformed
 * list by calling `fail()`, which exits the process — it does not throw — so
 * wrapping it in try/catch achieves nothing, and on the first deploy (no
 * Worker, no JSON in stdout) it would kill the deploy with a message about
 * parsing rather than the warning above.
 */
const looksLikeJson = stdout.includes('[') && stdout.lastIndexOf(']') > stdout.indexOf('[');
const names = looksLikeJson
  ? parseJsonArray<{ name: string }>(stdout, 'the secret list').map((s) => s.name)
  : [];

// On a first deploy there is no Worker and therefore no secret list to read.
// The warning above has already said so, and said what to run next.
if (!workerMissing && !names.includes('AUTH_SECRET') && !stdout.includes('AUTH_SECRET')) {
  console.error(
    [
      '',
      'X AUTH_SECRET is not set for the production environment.',
      '',
      '  Without it the auth gate is DISABLED. The Worker will refuse to serve',
      '  at all rather than serve the ledger unprotected, so this deploy would',
      '  produce a dead site. Refusing to deploy.',
      '',
      '  Set it to a 32-byte random value:',
      '    pnpm exec wrangler secret put AUTH_SECRET --env production',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

if (!workerMissing) console.log('- AUTH_SECRET is set for production.');
