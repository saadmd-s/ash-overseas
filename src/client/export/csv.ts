/**
 * CSV writer — FR-X5.
 *
 * Consumes the SAME `Sheet` the xlsx writer consumes, so the two formats cannot
 * drift (SRS §11.2). All conversion already happened in the row-builder.
 */

import type { Cell, Sheet } from '../../export/build';

function escape(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = typeof value === 'object' ? value.date : value;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(sheet: Sheet): string {
  const lines: string[] = [];
  for (const line of sheet.title) lines.push(escape(line));
  lines.push('');
  lines.push(sheet.header.map(escape).join(','));
  for (const row of sheet.rows) lines.push(row.map(escape).join(','));
  lines.push(sheet.totals.map(escape).join(','));
  return lines.join('\r\n');
}
