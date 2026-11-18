/**
 * Leave dates are calendar dates, not instants, so they are stored and compared as
 * 'YYYY-MM-DD' strings. All arithmetic goes through UTC so the server's timezone and
 * daylight-saving changes can never shift a day.
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUtcMs(date: string): number {
  if (!isDateOnly(date)) throw new Error(`Invalid date-only value: ${String(date)}`);
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const addDays = (date: string, days: number): string => fromUtcMs(toUtcMs(date) + days * DAY_MS);

export const diffDays = (later: string, earlier: string): number => Math.round((toUtcMs(later) - toUtcMs(earlier)) / DAY_MS);

/** 0 = Sunday ... 6 = Saturday */
export const dayOfWeek = (date: string): number => new Date(toUtcMs(date)).getUTCDay();

export const isWeekend = (date: string): boolean => {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
};

export function eachDay(start: string, end: string): string[] {
  const days: string[] = [];
  for (let ms = toUtcMs(start), last = toUtcMs(end); ms <= last; ms += DAY_MS) days.push(fromUtcMs(ms));
  return days;
}

export const yearOf = (date: string): number => Number(date.slice(0, 4));
export const monthOf = (date: string): number => Number(date.slice(5, 7));
export const monthDayOf = (date: string): string => date.slice(5);

export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  return { start: fromUtcMs(Date.UTC(y, m - 1, 1)), end: fromUtcMs(Date.UTC(y, m, 0)) };
}

export function yearRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** Today's calendar date in the given IANA timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Converts a spreadsheet cell or free text to YYYY-MM-DD, or null when it is not a date. */
export function normalizeDateCell(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isDateOnly(text)) return text;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dmy) {
    const candidate = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    return isDateOnly(candidate) ? candidate : null;
  }
  return null;
}
