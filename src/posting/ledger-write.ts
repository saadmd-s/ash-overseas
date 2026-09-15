import { asc, desc, eq, sql } from 'drizzle-orm';
import { ledgerEntries } from '../db/schema';
import {
  compareEntryOrder,
  post,
  replay,
  type LedgerEvent,
  type ReplayableEntry,
} from '../ledger/engine';
import type { BatchItem, Db } from './db';

export async function ledgerRows(db: Db, dealerId: number) {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.dealerId, dealerId))
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.id));
}

function balanceUpdates(db: Db, changes: { id: number; balance: number }[]): BatchItem[] {
  if (!changes.length) return [];
  // One parameter and one statement regardless of history length. Joining on
  // primary keys avoids one D1 statement/subrequest per replayed row.
  return [
    db
      .update(ledgerEntries)
      .set({ runningBalancePaise: sql`json_extract(replayed.value, '$.balance')` })
      .from(sql`json_each(${JSON.stringify(changes)}) AS replayed`)
      .where(sql`${ledgerEntries.id} = json_extract(replayed.value, '$.id')`),
  ];
}

export function replayUpdates(db: Db, rows: Awaited<ReturnType<typeof ledgerRows>>) {
  const ordered = [...rows].sort(compareEntryOrder);
  const balances = replay(
    ordered.map((r) => ({ ...r, label: (r.label ?? 'Sale') as ReplayableEntry['label'] })),
  );
  const changes = ordered.flatMap((row, i) =>
    row.runningBalancePaise === balances[i].runningBalancePaise
      ? []
      : [{ id: row.id, balance: balances[i].runningBalancePaise }],
  );
  return { updates: balanceUpdates(db, changes), changed: changes.length };
}

/** Plan the new row AND all replay writes before committing any of them. */
export async function planAppend(db: Db, dealerId: number, event: LedgerEvent) {
  const [last] = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.dealerId, dealerId))
    .orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.id))
    .limit(1);
  if (!last || event.entryDate >= last.entryDate) {
    const priorBalance = last?.runningBalancePaise ?? 0;
    const entry = post(priorBalance, event);
    return {
      entry,
      priorBalance,
      updates: [] as BatchItem[],
      closingBalance: entry.runningBalancePaise,
    };
  }
  const rows = await ledgerRows(db, dealerId);
  // The actual AUTOINCREMENT ID will follow every existing ID on the same
  // date. A sort-only sentinel represents it without allocating outside batch.
  const pending = { ...post(0, event), id: Number.MAX_SAFE_INTEGER };
  const ordered = [
    ...rows.map((r) => ({ ...r, label: (r.label ?? 'Sale') as ReplayableEntry['label'] })),
    pending,
  ].sort(compareEntryOrder);
  const balances = replay(ordered);
  const index = ordered.findIndex((r) => r === pending);
  const changes: { id: number; balance: number }[] = [];
  ordered.forEach((row, i) => {
    if (row !== pending && row.runningBalancePaise !== balances[i].runningBalancePaise) {
      changes.push({ id: row.id, balance: balances[i].runningBalancePaise });
    }
  });
  return {
    entry: balances[index],
    priorBalance: index ? balances[index - 1].runningBalancePaise : 0,
    updates: balanceUpdates(db, changes),
    closingBalance: balances[balances.length - 1].runningBalancePaise,
  };
}
