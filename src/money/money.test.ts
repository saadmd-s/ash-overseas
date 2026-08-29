import { describe, expect, it } from 'vitest';
import {
  balanceHeadline,
  formatPaise,
  gstAmount,
  lineAmount,
  parseRupeesToPaise,
  roundPaise,
  roundToRupee,
  transactionTotals,
} from './index';

describe('roundPaise', () => {
  it('rounds half away from zero, symmetrically', () => {
    // SRS §8.1 calls this "half-up"; Appendix B implements half-away-from-zero.
    // The symmetry is what matters for money: a credit and its reversal must
    // round identically, or a void would not restore the prior balance exactly.
    expect(roundPaise(0.5)).toBe(1);
    expect(roundPaise(-0.5)).toBe(-1);
    expect(roundPaise(1.5)).toBe(2);
    expect(roundPaise(-1.5)).toBe(-2);
  });

  it('leaves integers untouched', () => {
    expect(roundPaise(0)).toBe(0);
    expect(roundPaise(22_824_000)).toBe(22_824_000);
    expect(roundPaise(-20)).toBe(-20);
  });

  it('rounds toward zero below the halfway point', () => {
    expect(roundPaise(0.4)).toBe(0);
    expect(roundPaise(1.49)).toBe(1);
    expect(roundPaise(-1.49)).toBe(-1);
  });
});

describe('roundToRupee', () => {
  it('rounds to a whole rupee and returns paise', () => {
    expect(roundToRupee(26_932_320)).toBe(26_932_300);
    expect(roundToRupee(150)).toBe(200);
    expect(roundToRupee(149)).toBe(100);
    expect(roundToRupee(100)).toBe(100);
  });

  it('always returns a multiple of 100', () => {
    for (const value of [1, 49, 50, 51, 99, 26_932_320, 21_995_200]) {
      expect(roundToRupee(value) % 100).toBe(0);
    }
  });
});

describe('lineAmount', () => {
  it('multiplies a fractional quantity by an integer rate', () => {
    expect(lineAmount(9510, 2400)).toBe(22_824_000);
    expect(lineAmount(11_650, 1600)).toBe(18_640_000);
    expect(lineAmount(1000, 20_000)).toBe(20_000_000);
    expect(lineAmount(500, 10_000)).toBe(5_000_000);
  });

  it('handles a fractional quantity exactly', () => {
    // A shipment may be 9,510.5 kg — §8.1.
    expect(lineAmount(9510.5, 2400)).toBe(22_825_200);
  });

  it('always returns an integer', () => {
    expect(Number.isInteger(lineAmount(0.333, 100))).toBe(true);
    expect(lineAmount(0.333, 100)).toBe(33);
  });
});

describe('gstAmount', () => {
  it('computes GST at the given rate', () => {
    expect(gstAmount(22_824_000, 18)).toBe(4_108_320);
    expect(gstAmount(18_640_000, 18)).toBe(3_355_200);
    expect(gstAmount(5_000_000, 18)).toBe(900_000);
  });

  it('returns zero at a zero rate', () => {
    expect(gstAmount(22_824_000, 0)).toBe(0);
  });

  it('handles the other common rates', () => {
    expect(gstAmount(10_000_000, 5)).toBe(500_000);
    expect(gstAmount(10_000_000, 12)).toBe(1_200_000);
    expect(gstAmount(10_000_000, 28)).toBe(2_800_000);
  });
});

describe('transactionTotals — SRS §8.4 worked example', () => {
  // 9,510 kg × ₹24.00, GST 18%, no discount, no freight.
  const totals = transactionTotals({
    linesPaise: [lineAmount(9510, 2400)],
    discountPaise: 0,
    freightPaise: 0,
    gstRate: 18,
  });

  it('base total is ₹2,28,240.00', () => {
    expect(totals.baseTotalPaise).toBe(22_824_000);
  });

  it('taxable equals base when discount and freight are zero', () => {
    expect(totals.taxablePaise).toBe(22_824_000);
  });

  it('GST is ₹41,083.20', () => {
    expect(totals.gstAmountPaise).toBe(4_108_320);
  });

  it('posts ₹2,69,323.00 — the rounded figure', () => {
    expect(totals.grandTotalPaise).toBe(26_932_300);
  });

  it('records a round-off of −₹0.20', () => {
    expect(totals.roundOffPaise).toBe(-20);
  });

  it('posts a whole number of rupees', () => {
    expect(totals.grandTotalPaise % 100).toBe(0);
  });
});

describe('transactionTotals — discount and freight', () => {
  it('subtracts discount and adds freight before GST', () => {
    // §8.2: taxable = base − discount + freight, GST computed on taxable.
    const totals = transactionTotals({
      linesPaise: [10_000_000],
      discountPaise: 500_000,
      freightPaise: 200_000,
      gstRate: 18,
    });
    expect(totals.baseTotalPaise).toBe(10_000_000);
    expect(totals.taxablePaise).toBe(9_700_000);
    expect(totals.gstAmountPaise).toBe(1_746_000);
    expect(totals.grandTotalPaise).toBe(11_446_000);
    expect(totals.roundOffPaise).toBe(0);
  });

  it('sums multiple lines into the base total', () => {
    const totals = transactionTotals({
      linesPaise: [22_824_000, 18_640_000],
      discountPaise: 0,
      freightPaise: 0,
      gstRate: 18,
    });
    expect(totals.baseTotalPaise).toBe(41_464_000);
  });

  it('handles a zero GST rate', () => {
    const totals = transactionTotals({
      linesPaise: [5_000_000],
      discountPaise: 0,
      freightPaise: 0,
      gstRate: 0,
    });
    expect(totals.gstAmountPaise).toBe(0);
    expect(totals.grandTotalPaise).toBe(5_000_000);
    expect(totals.roundOffPaise).toBe(0);
  });
});

describe('transactionTotals — Scenario C figures', () => {
  it('ASH 39: 9,510 × ₹24 posts 2,69,323 with round-off −20', () => {
    const t = transactionTotals({
      linesPaise: [lineAmount(9510, 2400)],
      discountPaise: 0,
      freightPaise: 0,
      gstRate: 18,
    });
    expect(t.grandTotalPaise).toBe(26_932_300);
    expect(t.roundOffPaise).toBe(-20);
  });

  it('ASH 42: 11,650 × ₹16 posts 2,19,952 with round-off 0', () => {
    const t = transactionTotals({
      linesPaise: [lineAmount(11_650, 1600)],
      discountPaise: 0,
      freightPaise: 0,
      gstRate: 18,
    });
    expect(t.gstAmountPaise).toBe(3_355_200);
    expect(t.grandTotalPaise).toBe(21_995_200);
    expect(t.roundOffPaise).toBe(0);
  });
});

/**
 * Intl.NumberFormat puts a non-breaking space (U+00A0) between the currency
 * symbol and the digits. Normalise it so the expected strings below read the
 * way a person would actually write them.
 */
const sp = (text: string) => text.replace(/\u00a0/g, ' ');

describe('formatPaise', () => {
  it('formats with Indian grouping and two decimals', () => {
    expect(sp(formatPaise(12_345_678))).toBe('₹1,23,456.78');
    expect(sp(formatPaise(26_932_300))).toBe('₹2,69,323.00');
  });

  it('formats zero and negatives', () => {
    expect(sp(formatPaise(0))).toBe('₹0.00');
    expect(sp(formatPaise(-32_300_000))).toBe('-₹3,23,000.00');
  });
});

describe('balanceHeadline', () => {
  it('says the dealer owes when positive', () => {
    expect(sp(balanceHeadline(3_440_800, 'Kumar Traders'))).toBe(
      'Kumar Traders owes you ₹34,408.00',
    );
  });

  it('says you owe when negative, without a sign', () => {
    const headline = sp(balanceHeadline(-32_300_000, 'Kumar Traders'));
    expect(headline).toBe('You owe Kumar Traders ₹3,23,000.00');
    expect(headline).not.toContain('-');
  });

  it('says Settled at zero', () => {
    expect(balanceHeadline(0, 'Kumar Traders')).toBe('Settled');
  });

  it('never emits the words debit or credit', () => {
    for (const paise of [5_900_000, -5_900_000, 0]) {
      const headline = balanceHeadline(paise, 'Kumar Traders').toLowerCase();
      expect(headline).not.toContain('debit');
      expect(headline).not.toContain('credit');
    }
  });
});

describe('parseRupeesToPaise', () => {
  it('parses plain rupees', () => {
    expect(parseRupeesToPaise('313830')).toBe(31_383_000);
  });

  it('parses Indian grouping', () => {
    expect(parseRupeesToPaise('3,13,830')).toBe(31_383_000);
  });

  it('parses two decimal places', () => {
    expect(parseRupeesToPaise('313830.50')).toBe(31_383_050);
    expect(parseRupeesToPaise('0.01')).toBe(1);
    expect(parseRupeesToPaise('0.1')).toBe(10);
  });

  it('treats empty as not entered, never as zero', () => {
    // §10.6 — an empty discount is absent, not ₹0.
    expect(parseRupeesToPaise('')).toBeNull();
    expect(parseRupeesToPaise('   ')).toBeNull();
  });

  it('parses an explicit zero as zero', () => {
    expect(parseRupeesToPaise('0')).toBe(0);
  });

  it('rejects more than two decimal places', () => {
    expect(parseRupeesToPaise('100.123')).toBeNull();
  });

  it('rejects negatives', () => {
    expect(parseRupeesToPaise('-100')).toBeNull();
  });

  it('rejects exponent notation and stray characters', () => {
    expect(parseRupeesToPaise('1e5')).toBeNull();
    expect(parseRupeesToPaise('₹100')).toBeNull();
    expect(parseRupeesToPaise('abc')).toBeNull();
    expect(parseRupeesToPaise('100 rupees')).toBeNull();
    expect(parseRupeesToPaise('.')).toBeNull();
  });

  it('always returns an integer', () => {
    for (const input of ['1', '1.5', '1.55', '3,13,830.99']) {
      const result = parseRupeesToPaise(input);
      expect(result).not.toBeNull();
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it('round-trips through formatPaise', () => {
    const paise = parseRupeesToPaise('3,13,830.50');
    expect(paise).toBe(31_383_050);
    expect(sp(formatPaise(paise!))).toBe('₹3,13,830.50');
  });
});
