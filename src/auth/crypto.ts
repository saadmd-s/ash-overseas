/**
 * Authentication cryptography — SRS §16.1.
 *
 * Web Crypto **only**. Identical code has to run in workerd and in the Node
 * test runner, so there is no `node:crypto` import anywhere in this file; a
 * Node-only primitive would pass every test and then fail to resolve on deploy.
 *
 * Nothing here touches the database. Storage lives in src/worker/auth.ts, which
 * makes this module directly unit-testable at the pure level.
 */

/**
 * ⚠ HARD CEILING — do not raise this.
 *
 * The Workers runtime throws `NotSupportedError` for PBKDF2 above 100,000
 * iterations. The Node test runner does not, so a higher value passes the entire
 * suite and then fails in production on the first login — after the owner has
 * already been handed the URL. `crypto.test.ts` asserts this constant, so
 * raising it is a test failure rather than a deploy failure.
 */
export const PBKDF2_ITERATIONS = 100_000;

/** Session lifetime — 30 days (§16.1). */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const KEY_BITS = 256;
const SALT_BYTES = 16;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe base64 without padding — a cookie value may not contain `=` or `/`. */
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/**
 * Constant-time byte comparison.
 *
 * A `===` on the encoded hash leaks, through response timing, how many leading
 * bytes a guess got right. That is a practical attack against an endpoint an
 * attacker can call repeatedly, and the length check leaking is harmless
 * because both lengths are fixed by the algorithm.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Passwords — PBKDF2-SHA256
// ---------------------------------------------------------------------------

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Encode as `pbkdf2$<iters>$<salt>$<hash>` — the §16.1 storage format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Verify against a stored hash, re-deriving with the iteration count recorded
 * in the record itself.
 *
 * Reading iterations from the record rather than from the constant means an
 * older row keeps verifying if the constant ever moves — the usual reason to
 * store the parameter alongside the hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  // A malformed or absurd stored value must fail closed, never throw its way
  // into a 500 that reveals the record is corrupt.
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }

  try {
    const derived = await deriveBits(password, fromBase64(parts[2]), iterations);
    return timingSafeEqual(derived, fromBase64(parts[3]));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sessions — HMAC-SHA256 signed token
// ---------------------------------------------------------------------------

export interface SessionPayload {
  /** Username at the time the session was minted. */
  u: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
  /**
   * Credential version — the `updated_at` of the app_credentials row.
   *
   * This is what makes a password change revoke existing sessions. §16.5 puts a
   * stolen unlocked phone out of the threat model, mitigated "only by the
   * 30-day session expiry and the sign-out action" — but sign-out only clears
   * the cookie in the browser doing the signing out, so it does nothing about a
   * cookie already copied elsewhere. Binding the token to the credential
   * version turns a password change into real revocation, which is the response
   * an owner would actually reach for.
   */
  v: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    utf8.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** `<base64url(payload)>.<base64url(signature)>` */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = toBase64Url(utf8.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verify a token and return its payload, or `null` for anything at all wrong:
 * bad shape, bad signature, expired, unparseable.
 *
 * `crypto.subtle.verify` does the comparison, so the signature check is not
 * hand-rolled.
 */
export async function verifySession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(signature) as BufferSource,
      utf8.encode(body),
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as SessionPayload;
    if (typeof payload?.u !== 'string' || typeof payload?.exp !== 'number') return null;
    if (typeof payload?.v !== 'number') return null;
    if (payload.exp <= nowSeconds) return null;

    return payload;
  } catch {
    return null;
  }
}
