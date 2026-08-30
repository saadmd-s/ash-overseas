/**
 * The backup restore drill — SRS §17.3, NFR-B3.
 *
 * "A restore procedure is documented AND actually performed and verified into a
 *  scratch database before handover. Verification means: the schema matches,
 *  and a byte-exact paise round-trip of a known dealer's ledger is confirmed."
 *
 * An unverified restore procedure is not a backup — it is a belief about one.
 * This script is the verification, so it can be re-run any time rather than
 * being a thing someone once did.
 *
 * What it does, end to end:
 *   1. fingerprints the SOURCE database (schema + one dealer's whole ledger)
 *   2. exports it with `wrangler d1 export`, exactly as `pnpm db:export` does
 *   3. wipes the SCRATCH database and replays the dump into it
 *   4. fingerprints the scratch database the same way
 *   5. compares the two, byte for byte
 *
 * Usage:
 *   node scripts/verify-restore.ts                    # local drill (ledger-dev)
 *   node scripts/verify-restore.ts --remote \
 *        --source ledger-prod --source-env production --scratch ledger-scratch
 *
 * Requires Node 22.18+ or 24+ (native TypeScript type stripping).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, parseJsonArray, wrangler } from './lib.ts';
import { reorderDump } from './db-export.ts';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const remote = flag('remote');
const source = value('source', 'ledger-dev')!;
const sourceEnv = value('source-env');
const scratch = value('scratch', source)!;
const scratchEnv = value('scratch-env');
const dumpPath = value('output', join('backups', `${source}-restore-drill.sql`))!;

/**
 * The local drill keeps the scratch database in its own persistence directory,
 * so `ledger-dev` can be both source and scratch without one overwriting the
 * other. A remote drill needs a genuinely separate D1 named by --scratch.
 */
const SCRATCH_PERSIST = join('.wrangler', 'restore-drill');

if (remote && scratch === source) {
  fail(
    'A remote drill must restore into a DIFFERENT database.\n' +
      '  Pass --scratch <name>, and never point it at ledger-prod.',
  );
}

// ---------------------------------------------------------------------------
// wrangler
// ---------------------------------------------------------------------------

type Where = 'source' | 'scratch';

function d1Args(where: Where, database: string): string[] {
  const args = [database];
  const env = where === 'source' ? sourceEnv : scratchEnv;
  if (env) args.push('--env', env);
  args.push(remote ? '--remote' : '--local');
  // Only the local scratch is relocated; a remote one is a separate database
  // already, and --persist-to means nothing to it.
  if (!remote && where === 'scratch') args.push('--persist-to', SCRATCH_PERSIST);
  return args;
}

/** Run one query and return its rows. */
function query<T>(where: Where, database: string, sql: string): T[] {
  const { stdout } = wrangler(
    ['d1', 'execute', ...d1Args(where, database), '--yes', '--json', '--command', sql],
    { capture: true },
  );
  return parseJsonArray<{ results?: T[] }>(stdout, 'a query result')[0]?.results ?? [];
}

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

/** Tables this application owns — D1 and SQLite internals are not ours. */
const OURS =
  "name NOT LIKE 'sqlite_%' AND name NOT LIKE '@_cf%' ESCAPE '@' AND name != 'd1_migrations'";

const SCHEMA_SQL = `SELECT type, name, sql FROM sqlite_master WHERE ${OURS} ORDER BY type, name`;

/**
 * One dealer's entire ledger, as stored: raw integer paise, never formatted.
 *
 * Formatting anywhere in here would defeat the point — the thing being proven
 * is that the paise survived the round trip exactly, and a rupee string could
 * hide a rounding difference in its last decimal (§8.5).
 *
 * The dealer with the most entries is chosen so the sample is the largest one
 * available, and by id on a tie so the choice is deterministic across runs.
 */
const LEDGER_SQL = `
  SELECT d.name AS dealer, e.entry_date, e.source_type, e.debit_paise,
         e.credit_paise, e.running_balance_paise
  FROM ledger_entries e
  JOIN dealers d ON d.id = e.dealer_id
  WHERE e.dealer_id = (
    SELECT dealer_id FROM ledger_entries
    GROUP BY dealer_id ORDER BY count(*) DESC, dealer_id LIMIT 1
  )
  ORDER BY e.entry_date, e.id
`;

const COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM dealers)        AS dealers,
    (SELECT count(*) FROM transactions)   AS transactions,
    (SELECT count(*) FROM payments)       AS payments,
    (SELECT count(*) FROM ledger_entries) AS ledger_entries,
    (SELECT count(*) FROM audit_log)      AS audit_log,
    (SELECT coalesce(sum(debit_paise), 0) - coalesce(sum(credit_paise), 0)
       FROM ledger_entries)               AS net_paise
`;

function fingerprint(where: Where, database: string) {
  return {
    schema: query(where, database, SCHEMA_SQL),
    counts: query(where, database, COUNTS_SQL),
    ledger: query(where, database, LEDGER_SQL),
  };
}

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

console.log(`\nRestore drill — ${remote ? 'REMOTE' : 'local'}`);
console.log(`  source : ${source}${sourceEnv ? ` (env ${sourceEnv})` : ''}`);
console.log(`  scratch: ${scratch}${remote ? '' : ` (local, ${SCRATCH_PERSIST})`}`);

console.log('\n[1/5] Fingerprinting the source…');
const before = fingerprint('source', source);
const counts = before.counts[0] as Record<string, number> | undefined;
console.log(`      ${before.schema.length} schema objects, ${before.ledger.length} ledger rows`);
if (counts) console.log(`      ${JSON.stringify(counts)}`);

if (before.ledger.length === 0) {
  fail(
    'The source database has no ledger entries, so nothing would be proven.\n' +
      '  Run the drill against a database with real history in it.',
  );
}

console.log(`\n[2/5] Exporting to ${dumpPath}…`);
mkdirSync(dirname(dumpPath), { recursive: true });
wrangler(['d1', 'export', ...d1Args('source', source), '--output', dumpPath, '-y']);

// The same reordering `pnpm db:export` applies, so what gets restored below is
// exactly the artefact a real backup produces, not a specially prepared one.
// A raw D1 dump of this schema does not replay at all; see scripts/db-export.ts.
writeFileSync(dumpPath, reorderDump(readFileSync(dumpPath, 'utf8')).text);

console.log('\n[3/5] Emptying the scratch database…');
if (remote) {
  // A remote scratch cannot be deleted from disk, so its tables are dropped.
  // The dump's own CREATE TABLE statements would otherwise collide.
  const tables = query<{ name: string }>(
    'scratch',
    scratch,
    `SELECT name FROM sqlite_master WHERE type='table' AND ${OURS} ORDER BY name`,
  );
  if (tables.length) {
    const drops = tables.map((t) => `DROP TABLE IF EXISTS "${t.name}";`).join(' ');
    wrangler(['d1', 'execute', ...d1Args('scratch', scratch), '--yes', '--command', drops], {
      capture: true,
    });
  }
  console.log(`      dropped ${tables.length} tables`);
} else {
  rmSync(SCRATCH_PERSIST, { recursive: true, force: true });
  console.log('      removed the local scratch directory');
}

console.log('\n[4/5] Restoring the dump into the scratch database…');
wrangler(['d1', 'execute', ...d1Args('scratch', scratch), '--yes', '--file', dumpPath]);

console.log('\n[5/5] Fingerprinting the restore and comparing…');
const after = fingerprint('scratch', scratch);

const problems: string[] = [];
for (const part of ['schema', 'counts', 'ledger'] as const) {
  const a = JSON.stringify(before[part]);
  const b = JSON.stringify(after[part]);
  if (a !== b) {
    problems.push(part);
    console.error(`\n  ${part} DIFFERS`);
    console.error(`    source : ${a.slice(0, 400)}`);
    console.error(`    restore: ${b.slice(0, 400)}`);
  }
}

if (problems.length) fail(`Restore verification FAILED: ${problems.join(', ')} did not match.`);

console.log(`
✓ Restore verified.
    schema        ${before.schema.length} objects, identical
    row counts    identical
    ledger        ${before.ledger.length} rows for "${(before.ledger[0] as { dealer: string }).dealer}",
                  byte-exact in integer paise

  Dump: ${dumpPath}
`);
