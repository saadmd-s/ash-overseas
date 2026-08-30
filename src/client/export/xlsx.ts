/**
 * Excel writer — SheetJS, client-side (SRS §11.2).
 *
 * Generated in the browser from JSON the API returns, which keeps a heavy
 * dependency out of the Worker and well inside its CPU limit, and keeps the
 * export logic beside the formatting logic it must match.
 *
 * Consumes the same `Sheet` as the CSV writer, so the two cannot drift.
 */

import * as XLSX from 'xlsx';
import type { Cell, Sheet } from '../../export/build';

/** Excel's day-serial epoch: 1899-12-30 (the 1900 leap-year bug included). */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DD` → an Excel day serial.
 *
 * Built from UTC parts so no local timezone can shift the day. `entry_date` is
 * an IST calendar date (§12.4); an off-by-one here would silently move every
 * entry in the sheet.
 */
function excelSerial(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - EXCEL_EPOCH_UTC) / MS_PER_DAY;
}

function toCellObject(value: Cell, isMoney: boolean): XLSX.CellObject | undefined {
  // undefined leaves the cell genuinely empty — not 0, not "".
  if (value === null) return undefined;

  if (typeof value === 'object') {
    return { t: 'n', v: excelSerial(value.date), z: 'dd-mmm-yyyy' };
  }
  if (typeof value === 'number') {
    // §11.4 — a NUMERIC cell with `#,##0.00`, so the accountant can sort,
    // filter and SUM without cleaning the file. No currency symbol in the value.
    return isMoney ? { t: 'n', v: value, z: '#,##0.00' } : { t: 'n', v: value };
  }
  return { t: 's', v: value };
}

const STRIKE = { font: { strike: true } };

export function toWorkbook(sheet: Sheet): XLSX.WorkBook {
  const ws: XLSX.WorkSheet = {};
  const money = new Set(sheet.moneyColumns);

  let r = 0;
  const write = (row: Cell[], opts: { bold?: boolean; strike?: boolean } = {}) => {
    row.forEach((value, c) => {
      const cell = toCellObject(value, money.has(c));
      if (!cell) return;
      if (opts.bold) cell.s = { font: { bold: true } };
      if (opts.strike) cell.s = STRIKE;
      ws[XLSX.utils.encode_cell({ r, c })] = cell;
    });
    r += 1;
  };

  // Title block: business name, what this is, the filters applied, the closing
  // balance in plain language, and when it was generated (§11.3). A file can
  // then never be misread out of context.
  for (const line of sheet.title) write([line], { bold: true });
  write([]); // spacer

  const headerRow = r;
  write(sheet.header, { bold: true });

  const firstDataRow = r;
  sheet.rows.forEach((row, i) => write(row, { strike: sheet.struckRows.includes(i) }));
  write(sheet.totals, { bold: true });

  const lastRow = r - 1;
  const lastCol = Math.max(sheet.header.length, sheet.totals.length) - 1;
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });
  ws['!cols'] = sheet.widths.map((wch) => ({ wch }));
  // Freeze everything above the first data row, so the header stays put (§11.4).
  ws['!freeze'] = XLSX.utils.encode_cell({ r: firstDataRow, c: 0 });
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: headerRow, c: 0 },
      e: { r: lastRow - 1, c: lastCol },
    }),
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  return wb;
}

export function toXlsxBlob(sheet: Sheet): Blob {
  const data = XLSX.write(toWorkbook(sheet), { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
