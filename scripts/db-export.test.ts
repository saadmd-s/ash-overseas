/**
 * The dump reordering — SRS §17.3.
 *
 * This exists because a raw `wrangler d1 export` of this schema does NOT
 * replay: the statements come out alphabetically, so
 * `INSERT INTO "transaction_lines"` lands ahead of `CREATE TABLE transactions`
 * and the import dies on "no such table: main.transactions".
 *
 * The restore drill (`pnpm db:verify-restore`) proves the whole path end to
 * end, but it needs a database with history in it. These run anywhere, and they
 * fail loudly if someone ever "simplifies" the reordering away.
 */

import { describe, expect, it } from 'vitest';
import { reorderDump } from './db-export.ts';

/** A miniature of the real dump, with the same fatal ordering. */
const RAW = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE \`dealers\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL
);
INSERT INTO "dealers" ("id","name") VALUES (1,'Kumar Traders');
CREATE TABLE \`transaction_lines\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`transaction_id\` integer NOT NULL,
	FOREIGN KEY (\`transaction_id\`) REFERENCES \`transactions\`(\`id\`)
);
INSERT INTO "transaction_lines" ("id","transaction_id") VALUES (1,1);
CREATE TABLE \`transactions\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`human_id\` text NOT NULL
);
INSERT INTO "transactions" ("id","human_id") VALUES (1,'SALE-2026-08-0001');
CREATE UNIQUE INDEX \`transactions_human_id_unique\` ON \`transactions\` (\`human_id\`);
`;

const positionOf = (text: string, needle: string) => text.indexOf(needle);

describe('reorderDump', () => {
  const { text, counts } = reorderDump(RAW);

  it('puts every CREATE TABLE ahead of every INSERT', () => {
    const lastCreate = text.lastIndexOf('CREATE TABLE');
    const firstInsert = text.indexOf('INSERT INTO');
    expect(lastCreate).toBeLessThan(firstInsert);
  });

  it('fixes the exact failure: transactions exists before its lines are loaded', () => {
    expect(positionOf(text, 'CREATE TABLE `transactions`')).toBeLessThan(
      positionOf(text, 'INSERT INTO "transaction_lines"'),
    );
  });

  it('builds indexes last, after the rows they cover', () => {
    expect(text.lastIndexOf('INSERT INTO')).toBeLessThan(text.indexOf('CREATE UNIQUE INDEX'));
  });

  it('keeps the PRAGMA at the top', () => {
    expect(text.split('\n').find((l) => l.startsWith('PRAGMA'))).toBe(
      'PRAGMA defer_foreign_keys=TRUE;',
    );
  });

  it('keeps multi-line CREATE TABLE bodies intact', () => {
    // A column line does not start a statement, so it must stay attached to
    // the CREATE it belongs to rather than being flung into another group.
    expect(text).toContain('FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`)');
    expect(counts.schema).toBe(4); // the PRAGMA plus three tables
    expect(counts.indexes).toBe(1);
  });

  it('reorders only — it never edits, drops or invents a statement', () => {
    const normalise = (sql: string) =>
      sql
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('--'))
        .sort();

    expect(normalise(text)).toEqual(normalise(RAW));
  });

  it('survives an empty dump without throwing', () => {
    expect(() => reorderDump('')).not.toThrow();
  });
});
