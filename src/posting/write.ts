import { eq, sql } from 'drizzle-orm';
import { dealers, ledgerWriteRevision, requestReceipts } from '../db/schema';
import type { BatchItem, Db } from './db';

export class WriteConflict extends Error {}

export interface RetryIdentity {
  key: string;
  operation: string;
  payload: unknown;
}

export interface PreparedWrite<T> {
  statements: BatchItem[];
  result: (results: unknown[]) => T;
  // Receipt JSON can refer to IDs allocated earlier in the same batch.
  receipt?: ReturnType<typeof sql>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(payload: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function staleWrite(error: unknown): boolean {
  // Drizzle wraps the D1 error in `cause`. Only this specific guard failure
  // is retryable; arbitrary failures may have an uncertain commit outcome.
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (error.message.includes('NOT NULL constraint failed: ledger_write_revision.version'))
      return true;
  }
  return false;
}

/**
 * Read a revision BEFORE preparing a write. The first statements in the ONE
 * committing batch verify it and advance it, or fail a NOT NULL constraint.
 * D1 rolls the entire batch back on that failure. All reads/decisions are then
 * repeated. This works across Worker instances without an in-memory mutex.
 * Every application write to dealers, sources or ledger rows uses this helper.
 */
export async function withLedgerWrite<T>(
  db: Db,
  prepare: () => Promise<PreparedWrite<T>>,
  retry?: RetryIdentity,
): Promise<T> {
  const digest = retry ? await fingerprint(retry.payload) : undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const [revision] = await db
      .select()
      .from(ledgerWriteRevision)
      .where(eq(ledgerWriteRevision.id, 1));
    const expected = revision?.version ?? 0;
    if (retry) {
      const [receipt] = await db
        .select()
        .from(requestReceipts)
        .where(eq(requestReceipts.key, retry.key));
      if (receipt) {
        if (receipt.operation !== retry.operation || receipt.fingerprint !== digest) {
          throw new WriteConflict(
            'This save key was already used for different details. Start a new entry.',
          );
        }
        return JSON.parse(receipt.resultJson) as T;
      }
    }
    const prepared = await prepare();
    if (!prepared.statements.length) return prepared.result([]);
    const statements: BatchItem[] = [
      db.insert(ledgerWriteRevision).values({ id: 1, version: 0 }).onConflictDoNothing(),
      db
        .update(ledgerWriteRevision)
        .set({
          version: sql`CASE WHEN version = ${expected} THEN version + 1 ELSE NULL END`,
        })
        .where(eq(ledgerWriteRevision.id, 1)),
      ...prepared.statements,
    ];
    if (retry) {
      if (!prepared.receipt) throw new Error('Missing atomic save receipt.');
      statements.push(
        db.insert(requestReceipts).values({
          key: retry.key,
          operation: retry.operation,
          fingerprint: digest!,
          resultJson: prepared.receipt,
        }),
      );
    }
    try {
      const results = await db.batch(statements as [BatchItem, ...BatchItem[]]);
      return prepared.result(results.slice(2));
    } catch (error) {
      if (!staleWrite(error)) throw error;
    }
  }
  throw new WriteConflict('Another save is in progress. Please retry in a moment.');
}

export async function assertWritableDealer(db: Db, dealerId: number) {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer || dealer.isArchived)
    throw new WriteConflict('Restore or select an active dealer before adding entries.');
}
