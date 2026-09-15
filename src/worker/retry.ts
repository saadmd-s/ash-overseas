import type { Context } from 'hono';
import type { RetryIdentity } from '../posting/write';

/** Header syntax is validated centrally before any API handler runs. */
export function retryIdentity(c: Context, payload: unknown): RetryIdentity | undefined {
  const key = c.req.header('Idempotency-Key');
  return key
    ? { key, operation: `${c.req.method} ${new URL(c.req.url).pathname}`, payload }
    : undefined;
}
