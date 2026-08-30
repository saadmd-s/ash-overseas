/**
 * Zod schemas — the server boundary.
 *
 * SRS §10.9: server-side validation is authoritative and is re-run in full even
 * when the client has already checked. §16.3: never trust the client; money
 * fields accept integer paise only, and floats, NaN, disallowed negatives and
 * out-of-range values are rejected here.
 */

import { z } from 'zod';
import { lineAmount } from '../money';

/**
 * Money. Integer paise, never a float, never NaN.
 *
 * `z.number().int()` rejects both a fractional value and NaN, and `finite()`
 * rejects Infinity. `safe()` keeps it inside 2^53, where integer arithmetic is
 * exact — the bound the money rule relies on (§8.5).
 */
export const paise = z.number().int().finite().safe().nonnegative();

/** A payment amount is strictly positive (FR-P1, §10.9). */
export const positivePaise = paise.refine((n) => n > 0, {
  message: 'Amount must be greater than zero.',
});

/**
 * Today's date in IST.
 *
 * `entry_date` is an IST calendar date, not an instant (§12.4), and the Worker's
 * clock is UTC. At 23:00 UTC it is already tomorrow in IST, so validating
 * against the UTC date would reject a legitimate entry — or accept one dated in
 * the future. IST is UTC+5:30 with no DST, so a fixed offset is exact.
 */
export function todayIST(now: Date = new Date()): string {
  const IST_OFFSET_MS = 19_800_000; // +05:30
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A calendar date, `YYYY-MM-DD`, not later than today in IST (§10.9). */
export const entryDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a real date.')
  .refine((d) => d <= todayIST(), 'Date cannot be in the future.');

/** An invoice date may differ from the entry date but still cannot be future. */
export const optionalPastDate = entryDate.nullish();

export const bankAccount = z.enum(['od', 'current']);

/** §8.3 — a number from 0 to 100 inclusive. Not restricted to a fixed set. */
export const gstRate = z.number().finite().min(0).max(100);

export const createDealerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  contact: z.string().trim().nullish(),
  address: z.string().trim().nullish(),
  gstin: z.string().trim().nullish(),
  stateCode: z.string().trim().nullish(),
  type: z.enum(['supplier', 'buyer', 'both']).default('both'),
  opening: z
    .object({
      direction: z.enum(['owes_us', 'we_owe']),
      amountPaise: positivePaise,
      entryDate,
    })
    .optional(),
});

const transactionLine = z.object({
  itemName: z.string().trim().nullish(),
  // Quantity is NOT money — it may legitimately be fractional (9,510.5 kg).
  quantity: z.number().finite().nonnegative(),
  unit: z.string().trim().nullish(),
  ratePaise: paise,
});

export const createTransactionSchema = z
  .object({
    dealerId: z.number().int().positive(),
    mode: z.enum(['purchase', 'sale']),
    entryDate,
    invoiceNo: z.string().trim().nullish(),
    invoiceDate: optionalPastDate,
    referenceTag: z.string().trim().nullish(),
    bankAccount,
    gstRate: gstRate.default(18),
    discountPaise: paise.default(0),
    freightPaise: paise.default(0),
    isReturnNote: z.boolean().default(false),
    notes: z.string().trim().nullish(),
    lines: z.array(transactionLine).min(1, 'At least one line item is required.'),
  })
  .refine(
    (t) => {
      // §10.9 — discount may not exceed the base total. Checked here rather
      // than in the posting layer so the client gets a field-level error.
      // Through the money module — quantity x rate is money arithmetic, and it
      // belongs in exactly one place (§15.1).
      const base = t.lines.reduce((sum, l) => sum + lineAmount(l.quantity, l.ratePaise), 0);
      return t.discountPaise <= base;
    },
    { message: 'Discount cannot exceed the base total.', path: ['discountPaise'] },
  );

export const createPaymentSchema = z.object({
  dealerId: z.number().int().positive(),
  entryDate,
  direction: z.enum(['received', 'paid']),
  amountPaise: positivePaise,
  method: z.enum(['cash', 'bank', 'cheque', 'upi']).nullish(),
  bankAccount: bankAccount.nullish(),
  reference: z.string().trim().nullish(),
  notes: z.string().trim().nullish(),
});

export const ledgerQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  type: z.enum(['transaction', 'payment']).optional(),
  mode: z.enum(['purchase', 'sale']).optional(),
  bankAccount: bankAccount.optional(),
});

/**
 * Dealer edit — identity fields and the archive flag only.
 *
 * FR-D3: editing identity fields never alters any posted figure, which is why
 * nothing monetary appears here. FR-A6 requires a void and re-entry for any
 * change to a date, amount, quantity, rate, GST rate, discount, freight, dealer
 * or mode — so those are absent by design, not by omission.
 */
export const patchDealerSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    contact: z.string().trim().nullish(),
    address: z.string().trim().nullish(),
    gstin: z.string().trim().nullish(),
    stateCode: z.string().trim().nullish(),
    type: z.enum(['supplier', 'buyer', 'both']).optional(),
    isArchived: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to change.' });
