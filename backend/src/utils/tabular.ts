import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { badRequest } from './errors';

export interface Column {
  key: string;
  header: string;
}

export interface Table {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reads the first worksheet of an .xlsx or a .csv into rows keyed by lower-case alphanumeric header. */
export async function parseTabular(buffer: Buffer, originalName: string): Promise<Record<string, unknown>[]> {
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.csv')) {
    try {
      return parse(buffer, {
        columns: (headers: string[]) => headers.map(normalizeHeader),
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, unknown>[];
    } catch {
      throw badRequest('The CSV file could not be parsed');
    }
  }
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw badRequest('The Excel file could not be parsed');
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw badRequest('The Excel file has no worksheets');
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      headers[col] = normalizeHeader(String(cell.text ?? ''));
    });
    const rows: Record<string, unknown>[] = [];
    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      const out: Record<string, unknown> = {};
      row.eachCell((cell, col) => {
        const key = headers[col];
        if (key) out[key] = cell.value instanceof Date ? cell.value : cell.text.trim();
      });
      if (Object.keys(out).length) rows.push(out);
    });
    return rows;
  }
  throw badRequest('Upload a .csv or .xlsx file');
}

/** Stops spreadsheet apps from executing cell text as a formula (CSV injection). */
function safeCell(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function toCsv(table: Table): Buffer {
  const out = stringify(
    table.rows.map((r) => table.columns.map((c) => safeCell(r[c.key]))),
    { header: true, columns: table.columns.map((c) => c.header), bom: true },
  );
  return Buffer.from(out, 'utf8');
}

export async function toXlsx(table: Table): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(table.title.slice(0, 31).replace(/[*?:/\\[\]]/g, ' '));
  sheet.columns = table.columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(12, c.header.length + 4) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of table.rows) {
    sheet.addRow(table.columns.map((c) => safeCell(row[c.key])));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
