// Release regressions. Run with: pnpm exec vitest run --config vitest.audit.config.ts
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { addOpening, createDealer, createPayment, createTransaction, makeDb } from './post';
import { checkLedgerIntegrity, voidPayment } from './recompute';
import * as schema from '../db/schema';

it('concurrent payments return distinct IDs and preserve the complete balance', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Concurrent audit' });
  const input = {
    dealerId: dealer.id,
    entryDate: '2026-08-01',
    direction: 'paid' as const,
    amountPaise: 10000,
  };
  const results = await Promise.all([createPayment(db, input), createPayment(db, input)]);
  expect.soft(new Set(results.map((r) => r.id)).size).toBe(2);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});

it('a failed backdated replay rolls back the new payment', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Replay audit' });
  const input = {
    dealerId: dealer.id,
    entryDate: '2026-08-02',
    direction: 'paid' as const,
    amountPaise: 10000,
  };
  await createPayment(db, input);
  await env.DB.exec(
    "CREATE TRIGGER fail_replay BEFORE UPDATE OF running_balance_paise ON ledger_entries BEGIN SELECT RAISE(ABORT, 'Injected replay failure'); END",
  );
  try {
    await expect(createPayment(db, { ...input, entryDate: '2026-08-01' })).rejects.toThrow(
      'Injected replay failure',
    );
  } finally {
    await env.DB.exec('DROP TRIGGER fail_replay');
  }
  expect.soft(await db.select().from(schema.payments)).toHaveLength(1);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});

it('dealer creation is audited even without an opening balance', async () => {
  const db = makeDb(env.DB);
  await createDealer(db, { name: 'Dealer audit' });
  expect(await db.select().from(schema.auditLog)).toHaveLength(1);
});

it('dealer creation rolls back if its opening write fails', async () => {
  const db = makeDb(env.DB);
  await env.DB.exec(
    "CREATE TRIGGER fail_opening BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT, 'Injected opening failure'); END",
  );
  try {
    await expect(
      createDealer(db, {
        name: 'Opening audit',
        opening: {
          direction: 'owes_us',
          amountPaise: 10000,
          entryDate: '2026-08-01',
        },
      }),
    ).rejects.toThrow();
  } finally {
    await env.DB.exec('DROP TRIGGER fail_opening');
  }
  expect(await db.select().from(schema.dealers)).toHaveLength(0);
});

const paymentDetails = (dealerId: number) => ({
  dealerId,
  entryDate: '2026-08-02',
  direction: 'paid' as const,
  amountPaise: 10000,
});

it('deduplicates simultaneous retries and rejects reuse with changed details', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Retry' });
  const input = paymentDetails(dealer.id);
  const retry = { key: 'payment_retry_key_123', operation: 'POST /api/payments', payload: input };
  const results = await Promise.all([
    createPayment(db, input, retry),
    createPayment(db, input, retry),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await createPayment(db, input, retry)).toEqual(results[0]);
  expect(await db.select().from(schema.payments)).toHaveLength(1);
  expect(await db.select().from(schema.requestReceipts)).toHaveLength(1);
  await expect(
    createPayment(
      db,
      { ...input, amountPaise: 20000 },
      { ...retry, payload: { ...input, amountPaise: 20000 } },
    ),
  ).rejects.toThrow('different details');
});

it('allows only one overlapping reversal and one live opening', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Corrections' });
  const payment = await createPayment(db, paymentDetails(dealer.id));
  const voids = await Promise.allSettled([
    voidPayment(db, payment.id),
    voidPayment(db, payment.id),
  ]);
  expect(voids.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const opening = { direction: 'owes_us' as const, amountPaise: 5000, entryDate: '2026-08-01' };
  const openings = await Promise.allSettled([
    addOpening(db, dealer.id, opening),
    addOpening(db, dealer.id, opening),
  ]);
  expect(openings.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});

it('rejects cumulative overflow without committing the payment', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, {
    name: 'Range',
    opening: {
      direction: 'owes_us',
      amountPaise: Number.MAX_SAFE_INTEGER,
      entryDate: '2026-08-01',
    },
  });
  await expect(createPayment(db, paymentDetails(dealer.id))).rejects.toThrow();
  expect(await db.select().from(schema.payments)).toHaveLength(0);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});

it('replays a ten-thousand-row history in one atomic write', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Long history' });
  await env.DB.prepare(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO ledger_entries (dealer_id, entry_date, source_type, debit_paise, credit_paise, running_balance_paise, label) SELECT ?, '2026-08-03', 'payment', 100, 0, x*100, 'Money paid' FROM n",
  )
    .bind(dealer.id)
    .run();
  const result = await createPayment(db, paymentDetails(dealer.id));
  expect(result.runningBalancePaise).toBe(1010000);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});

it('receipt failure rolls back the financial write, sequence and audit', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Receipt rollback' });
  const input = paymentDetails(dealer.id);
  const retry = { key: 'rollback_receipt_123', operation: 'POST /api/payments', payload: input };
  await env.DB.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON request_receipts BEGIN SELECT RAISE(ABORT, 'Receipt failed'); END",
  );
  try {
    await expect(createPayment(db, input, retry)).rejects.toThrow('Receipt failed');
  } finally {
    await env.DB.exec('DROP TRIGGER fail_receipt');
  }
  expect(await db.select().from(schema.payments)).toHaveLength(0);
  expect(await db.select().from(schema.ledgerEntries)).toHaveLength(0);
  expect(await db.select().from(schema.auditLog)).toHaveLength(1);
  const saved = await createPayment(db, input, retry);
  expect(await createPayment(db, input, retry)).toEqual(saved);
});

it('replay failure during a void rolls back the flag, reversal and audit', async () => {
  const db = makeDb(env.DB);
  const dealer = await createDealer(db, { name: 'Void rollback' });
  const first = await createPayment(db, paymentDetails(dealer.id));
  await createPayment(db, { ...paymentDetails(dealer.id), entryDate: '2026-08-03' });
  await env.DB.exec(
    "CREATE TRIGGER fail_void_replay BEFORE UPDATE OF running_balance_paise ON ledger_entries BEGIN SELECT RAISE(ABORT, 'Void replay failed'); END",
  );
  try {
    await expect(voidPayment(db, first.id)).rejects.toThrow('Void replay failed');
  } finally {
    await env.DB.exec('DROP TRIGGER fail_void_replay');
  }
  expect((await db.select().from(schema.payments)).every((p) => !p.isVoided)).toBe(true);
  expect(await db.select().from(schema.ledgerEntries)).toHaveLength(2);
  expect(await db.select().from(schema.auditLog)).toHaveLength(3);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});

it('retries dealer, opening and goods saves with their original result', async () => {
  const db = makeDb(env.DB);
  const identity = { name: 'All receipts' };
  const dealerKey = {
    key: 'dealer_receipt_123',
    operation: 'POST /api/dealers',
    payload: identity,
  };
  const dealer = await createDealer(db, identity, dealerKey);
  expect(await createDealer(db, identity, dealerKey)).toEqual(dealer);
  const opening = { direction: 'owes_us' as const, amountPaise: 10000, entryDate: '2026-08-01' };
  const openingKey = { key: 'opening_receipt_123', operation: 'opening', payload: opening };
  const opened = await addOpening(db, dealer.id, opening, openingKey);
  expect(await addOpening(db, dealer.id, opening, openingKey)).toEqual(opened);
  const goods = {
    dealerId: dealer.id,
    mode: 'sale' as const,
    entryDate: '2026-08-02',
    bankAccount: 'od' as const,
    gstRate: 18,
    lines: [{ quantity: 1, ratePaise: 10000 }],
  };
  const key = { key: 'goods_receipt_123', operation: 'goods', payload: goods };
  const saved = await createTransaction(db, goods, key);
  expect(await createTransaction(db, goods, key)).toEqual(saved);
  expect(await db.select().from(schema.transactions)).toHaveLength(1);
  expect(await checkLedgerIntegrity(db, dealer.id)).toEqual({ ok: true });
});
