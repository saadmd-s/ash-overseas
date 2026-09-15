import { describe, expect, it } from 'vitest';
import { toCsv } from '../client/export/csv';
import type { Cell, Sheet } from './build';

function csvRow(cells: Cell[]) {
  const sheet: Sheet = {
    name: 'Test',
    fileName: 'test',
    title: [],
    header: [],
    rows: [cells],
    totals: [],
    widths: [],
    moneyColumns: [],
    dateColumns: [],
    struckRows: [],
  };
  return toCsv(sheet).split('\r\n')[2];
}

describe('CSV text safety', () => {
  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '  =1+1', '\t=1+1'])('keeps %j as text', (value) =>
    expect(csvRow([value])).toBe(`'${value}`),
  );
  it('preserves signed numeric balances', () => {
    expect(csvRow([-319592, 34408, null])).toBe('-319592,34408,');
  });
  it('quotes carriage returns, commas and embedded quotes', () => {
    expect(
      toCsv({
        name: 'Test',
        fileName: 'test',
        title: [],
        header: [],
        rows: [['a\rb', 'a,b', 'a"b']],
        totals: [],
        widths: [],
        moneyColumns: [],
        dateColumns: [],
        struckRows: [],
      }),
    ).toContain('"a\rb","a,b","a""b"');
  });
});
