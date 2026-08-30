/**
 * Auth cryptography — the pure level (SRS §20).
 *
 * These run in plain Node, which is exactly why the first test exists: the Node
 * runner will happily do a million PBKDF2 iterations, and the Workers runtime
 * will not. Nothing here can catch that at runtime, so the constant is asserted
 * instead.
 */

import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  PBKDF2_ITERATIONS,
  SESSION_TTL_SECONDS,
  signSession,
  verifyPassword,
  verifySession,
} from './crypto';

describe('PBKDF2 parameters — SRS §16.1', () => {
  it('never exceeds the 100,000-iteration ceiling the Workers runtime enforces', () => {
    // ⚠ Raising this constant makes every login throw NotSupportedError in
    // production while this entire suite stays green. That is the trap; this
    // assertion is the only thing standing in front of it.
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
    expect(PBKDF2_ITERATIONS).toBe(100_000);
  });

  it('records the iteration count in the stored hash, in the §16.1 format', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const [scheme, iterations, salt, hash] = stored.split('$');

    expect(scheme).toBe('pbkdf2');
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
    expect(salt.length).toBeGreaterThan(0);
    expect(hash.length).toBeGreaterThan(0);
  });

  it('salts, so the same password never produces the same stored value', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('expires a 30-day session, per §16.1', () => {
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword('s3cret-passphrase', stored)).toBe(true);
    expect(await verifyPassword('s3cret-passphras', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('fails closed on a malformed record rather than throwing', async () => {
    for (const bad of [
      '',
      'nonsense',
      'pbkdf2$100000$only-three',
      'bcrypt$1$a$b',
      'pbkdf2$x$a$b',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('refuses a record claiming more iterations than the runtime allows', async () => {
    // A row like this could only arrive from a tampered database or a script
    // built against a different constant. Deriving it would throw inside
    // workerd; rejecting it turns that into a failed login instead of a 500.
    const stored = await hashPassword('pw');
    const inflated = stored.replace(`$${PBKDF2_ITERATIONS}$`, '$1000000$');
    expect(await verifyPassword('pw', inflated)).toBe(false);
  });
});

describe('Session tokens', () => {
  const secret = 'a-32-byte-secret-for-testing-only';
  const payload = { u: 'owner', exp: Math.floor(Date.now() / 1000) + 60, v: 1_700_000_000 };

  it('round-trips a signed payload', async () => {
    const token = await signSession(payload, secret);
    expect(await verifySession(token, secret)).toEqual(payload);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(payload, secret);
    expect(await verifySession(token, 'some-other-secret')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    // The whole point: edit the claims and the signature no longer matches.
    const token = await signSession(payload, secret);
    const [body, signature] = token.split('.');
    const forged = btoa(JSON.stringify({ ...payload, u: 'attacker' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(forged).not.toBe(body);
    expect(await verifySession(`${forged}.${signature}`, secret)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signSession({ ...payload, exp: 1_000 }, secret);
    expect(await verifySession(token, secret)).toBeNull();
  });

  it('rejects structural nonsense without throwing', async () => {
    for (const bad of ['', '.', 'abc', 'abc.', '.abc', 'a.b.c', 'not-base64!.also-not']) {
      expect(await verifySession(bad, secret)).toBeNull();
    }
  });

  it('carries the credential version, so a password change can revoke it', async () => {
    const token = await signSession(payload, secret);
    const verified = await verifySession(token, secret);
    expect(verified?.v).toBe(payload.v);
  });
});
