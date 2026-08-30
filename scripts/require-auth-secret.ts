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

if (!ok) {
  console.error('\nX Could not list production secrets. Is wrangler logged in?\n');
  console.error(stderr || stdout);
  process.exit(1);
}

// Parsed properly when possible, with a substring fallback: a wrangler version
// that changes its output shape must not be able to turn this check into a
// silent pass.
let names: string[] = [];
try {
  names = parseJsonArray<{ name: string }>(stdout, 'the secret list').map((s) => s.name);
} catch {
  names = [];
}

if (!names.includes('AUTH_SECRET') && !stdout.includes('AUTH_SECRET')) {
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

console.log('- AUTH_SECRET is set for production.');
