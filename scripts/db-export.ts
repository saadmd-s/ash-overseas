/**
 * Take a backup — SRS §17.3, NFR-B2.
 *
 * Wraps `wrangler d1 export` and then makes the dump actually replayable.
 *
 * ⚠ WHY THE REORDERING EXISTS
 *
 * `wrangler d1 export` writes its statements in alphabetical order by table.
 * That puts `INSERT INTO "transaction_lines"` ahead of `CREATE TABLE
 * transactions`, and because transaction_lines carries a foreign key into
 * transactions, replaying the file fails at that line with:
 *
 *     no such table: main.transactions: SQLITE_ERROR
 *
 * The `PRAGMA defer_foreign_keys=TRUE` the dump opens with cannot help: that
 * defers *enforcement* to commit time, and this is the parent table not
 * existing yet. So a raw D1 dump of this schema is not restorable as written —
 * which is discovered at the exact moment it matters most unless something
 * checks first. `pnpm db:verify-restore` is that something (NFR-B3), and this
 * is the fix it demands.
 *
 * The transform is a reordering only. No statement is edited, dropped or added;
 * the file is regrouped into: schema, then data, then indexes. Indexes last is
 * also how a restore wants them — building them once over the finished table
 * beats maintaining them across every insert.
 *
 * A side benefit worth having: the result replays into plain SQLite too, so the
 * backup can be opened one day without Cloudflare in the picture at all.
 *
 * Usage:
 *   node scripts/db-export.ts --env production --database ledger-prod
 *   node scripts/db-export.ts --local
 *
 * Requires Node 22.18+ or 24+ (native TypeScript type stripping).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, wrangler } from './lib.ts';

// ---------------------------------------------------------------------------
// Statement grouping
// ---------------------------------------------------------------------------

/**
 * A line that begins a new SQL statement.
 *
 * Continuation lines — the column definitions inside a CREATE TABLE — never
 * match, so they stay attached to the statement they belong to.
 */
const STATEMENT_START = /^(PRAGMA|CREATE|INSERT|DELETE|DROP|UPDATE|ALTER|BEGIN|COMMIT|ANALYZE)\b/i;

const isSchema = (s: string) => /^(PRAGMA|CREATE\s+TABLE)\b/i.test(s);
const isIndex = (s: string) => /^CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\b/i.test(s);

export function reorderDump(sql: string): { text: string; counts: Record<string, number> } {
  const statements: string[] = [];

  for (const line of sql.split('\n')) {
    if (STATEMENT_START.test(line) || statements.length === 0) statements.push(line);
    else statements[statements.length - 1] += `\n${line}`;
  }

  const schema: string[] = [];
  const data: string[] = [];
  const indexes: string[] = [];

  for (const statement of statements) {
    if (!statement.trim()) continue;
    if (isSchema(statement)) schema.push(statement);
    else if (isIndex(statement)) indexes.push(statement);
    else data.push(statement);
  }

  const text = [
    '-- Reordered by scripts/db-export.ts so the dump can be replayed as-is.',
    '-- Order: schema, then data, then indexes. See that file for why.',
    '',
    ...schema,
    '',
    ...data,
    '',
    ...indexes,
    '',
  ].join('\n');

  return { text, counts: { schema: schema.length, data: data.length, indexes: indexes.length } };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const local = flag('local');
const env = value('env');
const database = value('database', env === 'production' ? 'ledger-prod' : 'ledger-dev')!;
const output = value('output', join('backups', `${database}.sql`))!;

// Running this file directly is the export; importing it (the unit test) is not.
const invokedDirectly = process.argv[1]?.endsWith('db-export.ts');

if (invokedDirectly) {
  console.log(`\nExporting ${database}${env ? ` (env ${env})` : ''}${local ? ' [local]' : ''}…`);

  mkdirSync(dirname(output), { recursive: true });

  const args = ['d1', 'export', database];
  if (env) args.push('--env', env);
  args.push(local ? '--local' : '--remote', '--output', output, '-y');
  wrangler(args);

  const raw = readFileSync(output, 'utf8');
  if (!raw.trim()) fail('wrangler produced an empty dump. Nothing was kept.');

  const { text, counts } = reorderDump(raw);
  writeFileSync(output, text);

  console.log(
    `\n✓ ${output}` +
      `\n  ${counts.schema} schema statements, ${counts.data} data statements, ` +
      `${counts.indexes} indexes` +
      `\n\n  Keep this OFF the primary store (NFR-B2). It is the complete ledger` +
      `\n  in plain text — it is gitignored, and it must stay that way.\n`,
  );
}
