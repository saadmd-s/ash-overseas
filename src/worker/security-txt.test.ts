/**
 * RFC 9116 security.txt — a public route, so it must also never carry anything
 * but the contact line and its required fields.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/.well-known/security.txt', () => {
  it('names the security contact and an expiry under a year away', async () => {
    const res = await SELF.fetch('https://x/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('Contact: mailto:suhaib.muhammed2002@gmail.com');
    expect(body).toContain('Canonical: https://x/.well-known/security.txt');

    const expires = Date.parse(/^Expires: (.+)$/m.exec(body)![1]);
    const days = (expires - Date.now()) / 86_400_000;
    // RFC 9116: in the future, and recommended less than a year out.
    expect(days).toBeGreaterThan(300);
    expect(days).toBeLessThanOrEqual(366);
  });

  it('is not gated and carries the security headers', async () => {
    const res = await SELF.fetch('https://x/.well-known/security.txt');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
