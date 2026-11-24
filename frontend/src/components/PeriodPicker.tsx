import { addDaysTo, formatMonth, formatRange, todayString } from '../utils/date';
import { Input, Select } from './ui';

/** The server refuses longer periods, so the picker says so before asking. */
export const MAX_PERIOD_DAYS = 366;

export type PeriodKind = 'this-month' | 'last-month' | 'this-week' | 'last-7' | 'last-30' | 'this-year' | 'month' | 'custom';

export interface Period {
  kind: PeriodKind;
  /** Used when kind is 'month'. YYYY-MM. */
  month: string;
  /** Used when kind is 'custom'. YYYY-MM-DD, possibly blank while being typed. */
  from: string;
  to: string;
}

const OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-week', label: 'This week' },
  { value: 'last-7', label: 'Last 7 days' },
  { value: 'last-30', label: 'Last 30 days' },
  { value: 'this-year', label: 'This year so far' },
  { value: 'month', label: 'Choose a month…' },
  { value: 'custom', label: 'Custom dates…' },
];

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

const previousMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** A period for one calendar month, e.g. the month of a date being viewed elsewhere. */
export const monthPeriod = (month: string): Period => ({ kind: 'month', month, from: `${month}-01`, to: monthEnd(month) });

export const defaultPeriod = (today = todayString()): Period => ({ kind: 'this-month', month: today.slice(0, 7), from: `${today.slice(0, 7)}-01`, to: today });

/** The dates a period covers, with weeks starting on Monday. */
export function periodRange(p: Period, today = todayString()): { from: string; to: string } {
  const thisMonth = today.slice(0, 7);
  switch (p.kind) {
    case 'this-month': return { from: `${thisMonth}-01`, to: monthEnd(thisMonth) };
    case 'last-month': {
      const last = previousMonth(thisMonth);
      return { from: `${last}-01`, to: monthEnd(last) };
    }
    case 'this-week': {
      const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      const monday = addDaysTo(today, -weekday);
      return { from: monday, to: addDaysTo(monday, 6) };
    }
    case 'last-7': return { from: addDaysTo(today, -6), to: today };
    case 'last-30': return { from: addDaysTo(today, -29), to: today };
    case 'this-year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'month': return { from: `${p.month}-01`, to: monthEnd(p.month) };
    case 'custom': return { from: p.from, to: p.to };
  }
}

/** Why a custom range cannot be used yet, or null when it is fine. */
export function periodError(p: Period): string | null {
  if (p.kind === 'month') return /^\d{4}-\d{2}$/.test(p.month) ? null : 'Choose a month';
  if (p.kind !== 'custom') return null;
  if (!p.from || !p.to) return 'Choose a start and an end date';
  if (p.to < p.from) return 'The end date cannot be before the start date';
  if (daysBetween(p.from, p.to) > MAX_PERIOD_DAYS) return `Choose a period of at most ${MAX_PERIOD_DAYS} days`;
  return null;
}

/** Query parameters for the attendance API, or null while the period is incomplete. */
export function periodParams(p: Period, today = todayString()): { from: string; to: string } | null {
  return periodError(p) ? null : periodRange(p, today);
}

/** "November 2026" for whole months, otherwise the dates. */
export function periodLabel(p: Period, today = todayString()): string {
  if (periodError(p)) return '';
  const { from, to } = periodRange(p, today);
  if (from.endsWith('-01') && to === monthEnd(from.slice(0, 7))) return formatMonth(from.slice(0, 7));
  return formatRange(from, to);
}

export function PeriodPicker({ value, onChange, today = todayString(), className }: { value: Period; onChange: (next: Period) => void; today?: string; className?: string }) {
  const error = periodError(value);
  const choose = (kind: PeriodKind) => {
    // Opening "custom" starts from whatever was showing, so the person only adjusts it.
    const current = periodError(value) ? periodRange(defaultPeriod(today), today) : periodRange(value, today);
    onChange({ ...value, kind, ...(kind === 'custom' ? current : {}), ...(kind === 'month' ? { month: current.from.slice(0, 7) } : {}) });
  };
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Period" className="w-44" value={value.kind} onChange={(e) => choose(e.target.value as PeriodKind)}>
          {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {value.kind === 'month' && (
          <Input aria-label="Month" type="month" className="w-44" value={value.month} onChange={(e) => onChange({ ...value, month: e.target.value })} />
        )}
        {value.kind === 'custom' && (
          <>
            <Input aria-label="From" type="date" className="w-40" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
            <span className="text-xs text-muted">to</span>
            <Input aria-label="To" type="date" className="w-40" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </>
        )}
      </div>
      {error && value.kind === 'custom' && <p role="alert" className="mt-1 text-xs text-rose">{error}</p>}
    </div>
  );
}
