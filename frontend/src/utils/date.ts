/** Leave dates are date-only strings. They are parsed as UTC so the browser's timezone cannot shift them. */
const asUtc = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options });
const LONG = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const SHORT = fmt({ day: 'numeric', month: 'short' });
const WEEKDAY = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const MONTH = fmt({ month: 'long', year: 'numeric' });

export const formatDate = (date?: string | null) => (date ? LONG.format(asUtc(date)) : '—');
export const formatDay = (date: string) => WEEKDAY.format(asUtc(date));
export const formatMonth = (month: string) => MONTH.format(asUtc(`${month}-01`));

export function formatRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  return start.slice(0, 4) === end.slice(0, 4) ? `${SHORT.format(asUtc(start))} – ${LONG.format(asUtc(end))}` : `${LONG.format(asUtc(start))} – ${LONG.format(asUtc(end))}`;
}

export const formatDateTime = (iso?: string | null) =>
  iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

/** A browser Date as a local calendar date. FullCalendar hands back local midnights. */
export function toDateOnly(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysTo(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const todayString = () => toDateOnly(new Date());
export const currentYear = () => new Date().getFullYear();

export const days = (n?: number | null) => {
  const value = n ?? 0;
  return `${value} ${value === 1 ? 'day' : 'days'}`;
};
