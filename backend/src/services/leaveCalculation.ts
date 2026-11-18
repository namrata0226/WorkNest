import { HalfSession } from '../constants';
import { dayOfWeek, eachDay, yearOf } from '../utils/dates';

export interface HolidayOccurrence {
  date: string;
  name: string;
  category: string;
  isHalfDay: boolean;
  halfDaySession: HalfSession;
}

export interface CalculationInput {
  startDate: string;
  endDate: string;
  dayType: 'FULL' | 'HALF';
  halfSession?: HalfSession | null;
  /** Only the holidays that apply to this employee, already excluding optional ones. */
  holidays: HolidayOccurrence[];
}

export interface CalculationResult {
  totalDays: number;
  dayBreakdown: { date: string; value: number }[];
  excluded: { date: string; reason: 'WEEKLY_OFF' | 'HOLIDAY' | 'HALF_DAY_HOLIDAY'; label: string }[];
  byYear: { year: number; amount: number }[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The single source of truth for how many leave days a date range costs. */
export function calculateLeaveDays(input: CalculationInput): CalculationResult {
  const { startDate, endDate, dayType, halfSession, holidays } = input;
  const holidayByDate = new Map<string, HolidayOccurrence>();
  for (const h of holidays) {
    const known = holidayByDate.get(h.date);
    // When a full-day and a half-day holiday share a date, the full day wins.
    if (!known || (known.isHalfDay && !h.isHalfDay)) holidayByDate.set(h.date, h);
  }

  const dayBreakdown: CalculationResult['dayBreakdown'] = [];
  const excluded: CalculationResult['excluded'] = [];

  for (const date of eachDay(startDate, endDate)) {
    const dow = dayOfWeek(date);
    if (dow === 0 || dow === 6) {
      excluded.push({ date, reason: 'WEEKLY_OFF', label: DAY_NAMES[dow] });
      continue;
    }
    const holiday = holidayByDate.get(date);
    if (holiday && !holiday.isHalfDay) {
      excluded.push({ date, reason: 'HOLIDAY', label: holiday.name });
      continue;
    }

    let value = dayType === 'HALF' ? 0.5 : 1;
    if (holiday?.isHalfDay) {
      if (dayType === 'HALF') {
        // Taking off the half of the day that is already a holiday costs nothing.
        if (halfSession === holiday.halfDaySession) {
          excluded.push({ date, reason: 'HOLIDAY', label: holiday.name });
          continue;
        }
      } else {
        value = 0.5;
        excluded.push({ date, reason: 'HALF_DAY_HOLIDAY', label: holiday.name });
      }
    }
    dayBreakdown.push({ date, value });
  }

  const years = new Map<number, number>();
  for (const d of dayBreakdown) years.set(yearOf(d.date), (years.get(yearOf(d.date)) ?? 0) + d.value);

  return {
    totalDays: dayBreakdown.reduce((sum, d) => sum + d.value, 0),
    dayBreakdown,
    excluded,
    byYear: [...years.entries()].map(([year, amount]) => ({ year, amount })),
  };
}
