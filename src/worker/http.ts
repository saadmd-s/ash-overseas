/**
 * Shared route helpers.
 *
 * SRS §14: error responses carry a stable machine-readable `code` and a human
 * message, so the client can branch without string-matching prose — and they
 * never echo money or dealer details (§16.3).
 */

import { z } from 'zod';

export function fail(code: string, message: string, fields?: Record<string, string>) {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}

export function flatten(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

export const idParam = z.coerce.number().int().positive();
