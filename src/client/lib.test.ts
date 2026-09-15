import { afterEach, expect, it, vi } from 'vitest';
import { api, bankPreference } from './lib';
afterEach(() => vi.unstubAllGlobals());
it('reuses the save key after a lost response and distinguishes a new entry', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockImplementation(async () => Response.json({ id: 1 }));
  vi.stubGlobal('fetch', fetcher);
  const body = { amountPaise: 10000 };
  await expect(api.create('/api/payments', body, 'draft-a')).rejects.toThrow();
  await api.create('/api/payments', body, 'draft-a');
  await api.create('/api/payments', body, 'draft-b');
  await api.create('/api/payments', { amountPaise: 20000 }, 'draft-a');
  const keys = fetcher.mock.calls.map((call) => call[1].headers['Idempotency-Key']);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).not.toBe(keys[2]);
  expect(keys[0]).not.toBe(keys[3]);
});
it('keeps saves usable when preference storage is blocked', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  });
  expect(bankPreference.load()).toBe('od');
  expect(() => bankPreference.save('current')).not.toThrow();
});
