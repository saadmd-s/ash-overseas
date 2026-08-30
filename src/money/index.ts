/**
 * Money math — the sole owner of every arithmetic operation on paise.
 *
 * SRS §8.5, §15.1: no `*`, `/`, or `Math.round` on a monetary value exists
 * anywhere else in the codebase. `parseFloat` and `toFixed` are forbidden for
 * money throughout.
 *
 * Everything down to `balanceHeadline` is SRS Appendix B, implemented verbatim.
 * `parseRupeesToPaise` is required by §20 but absent from Appendix B; it is
 * implemented below to the §10.6 and §10.9 rules and marked as such.
 *
 * All money is an integer number of paise. Integer paise is exact in a JS
 * `number` below 2^53 (≈ ₹90 trillion), so BigInt is unnecessary and must not
 * be introduced. The rule is "never let a fractional money value persist",
 * not "avoid `number`".
 */

/** An integer number of paise. ₹1 = 100 paise. */
export type Paise = number;

// ---------------------------------------------------------------------------
// SRS Appendix B — verbatim
// ---------------------------------------------------------------------------

/** Half-up rounding to the nearest paise. The only rounding primitive. */
export function roundPaise(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Half-up rounding to the nearest whole rupee, returned in paise. */
export function roundToRupee(paise: number): number {
  return roundPaise(paise / 100) * 100;
}

/** A line's amount: quantity may be fractional, rate is integer paise. */
export function lineAmount(quantity: number, ratePaise: number): number {
  return roundPaise(quantity * ratePaise);
}

/** GST on a taxable amount, at a percentage rate. */
export function gstAmount(taxablePaise: number, gstRate: number): number {
  return roundPaise((taxablePaise * gstRate) / 100);
}

/** The full transaction total, exactly as posted to the ledger. */
export function transactionTotals(input: {
  linesPaise: number[];
  discountPaise: number;
  freightPaise: number;
  gstRate: number;
}) {
  const baseTotalPaise = input.linesPaise.reduce((a, b) => a + b, 0);
  const taxablePaise = baseTotalPaise - input.discountPaise + input.freightPaise;
  const gstAmountPaise = gstAmount(taxablePaise, input.gstRate);
  const rawTotalPaise = taxablePaise + gstAmountPaise;
  const grandTotalPaise = roundToRupee(rawTotalPaise);
  const roundOffPaise = grandTotalPaise - rawTotalPaise;
  return { baseTotalPaise, taxablePaise, gstAmountPaise, roundOffPaise, grandTotalPaise };
}

/** Display only. Formats from paise so no float artefact can appear. */
export function formatPaise(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

/** The plain-language balance headline. Never shows a bare sign. */
export function balanceHeadline(paise: number, dealerName: string): string {
  if (paise > 0) return `${dealerName} owes you ${formatPaise(paise)}`;
  if (paise < 0) return `You owe ${dealerName} ${formatPaise(-paise)}`;
  return 'Settled';
}

// ---------------------------------------------------------------------------
// Not in Appendix B — required by SRS §20, specified by §10.6 and §10.9
// ---------------------------------------------------------------------------

/**
 * Rupee text as the owner types it → integer paise.
 *
 * Accepts `313830`, `3,13,830`, `313830.5`, `313830.50`. Indian grouping commas
 * are stripped without validating their placement: the owner types fast, and
 * rejecting `31,3830` would be hostile for no gain.
 *
 * Returns `null` — never `0` — for anything not entered or not parseable, per
 * §10.6: "treats empty as 'not entered', never as zero". An empty discount is
 * absent, not ₹0, and the distinction changes the validation message.
 *
 * Rejects: negatives (§10.9 requires money fields ≥ 0, and a sign is never typed
 * by the owner), more than two decimal places, exponent notation, and anything
 * beyond the safe integer range.
 */
export function parseRupeesToPaise(input: string): Paise | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Digits, grouping commas and at most one decimal point. This is what rejects
  // '-', '+', 'e', '₹' and stray letters — no need to test them separately.
  if (!/^[0-9,]*\.?[0-9]*$/.test(trimmed)) return null;

  const bare = trimmed.replace(/,/g, '');
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(bare);
  if (!match) return null; // more than two decimal places

  const [, rupeeDigits, fractionDigits] = match;
  if (rupeeDigits === '' && (fractionDigits === undefined || fractionDigits === '')) {
    return null; // '.' or ',' alone
  }

  const rupees = rupeeDigits === '' ? 0 : Number(rupeeDigits);
  const paiseFraction = Number((fractionDigits ?? '').padEnd(2, '0'));

  const total = rupees * 100 + paiseFraction;
  if (!Number.isSafeInteger(total)) return null;

  return total;
}

/**
 * Indian digit grouping for the MoneyInput's live echo — `313830` → `3,13,830`.
 *
 * Operates on the digits the owner typed, never on a numeric money value: no
 * arithmetic happens here, and nothing is rounded. `formatPaise` remains the
 * only formatter for a *stored* amount (§10.8).
 *
 * Indian grouping is last-3 then 2s: 1,23,45,678.
 */
export function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}
