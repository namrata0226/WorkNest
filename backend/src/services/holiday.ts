import { IEmployee } from '../models/Employee';
import { Holiday, IHoliday } from '../models/Holiday';
import { isDateOnly, monthDayOf, yearOf } from '../utils/dates';

export interface HolidayInstance extends IHoliday {
  /** The date this occurrence falls on. Differs from `date` for later years of a recurring holiday. */
  occurrenceDate: string;
}

/** Holidays falling in a range, expanding recurring ones. An explicit entry beats a recurring copy of itself. */
export async function holidayOccurrences(start: string, end: string): Promise<HolidayInstance[]> {
  const docs = await Holiday.find({
    $or: [{ date: { $gte: start, $lte: end } }, { recurring: true, date: { $lte: end } }],
  }).lean<IHoliday[]>();

  const found = new Map<string, HolidayInstance>();
  for (const h of docs.filter((d) => d.date >= start && d.date <= end)) {
    found.set(`${h.date}|${h.name}`, { ...h, occurrenceDate: h.date });
  }
  for (const h of docs.filter((d) => d.recurring)) {
    for (let y = Math.max(yearOf(start), yearOf(h.date)); y <= yearOf(end); y++) {
      const date = `${y}-${monthDayOf(h.date)}`;
      if (!isDateOnly(date) || date < start || date > end) continue;
      const key = `${date}|${h.name}`;
      if (!found.has(key)) found.set(key, { ...h, occurrenceDate: date });
    }
  }
  return [...found.values()].sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
}

type HolidayScope = Pick<IHoliday, 'locations' | 'departments' | 'employeeCategories'>;
type EmployeeScope = Pick<IEmployee, 'location' | 'department' | 'category'>;

export function holidayAppliesTo(h: HolidayScope, e: EmployeeScope): boolean {
  const matches = (scope: unknown[] | undefined, value: unknown) =>
    !scope?.length || (value != null && scope.some((s) => String(s) === String(value)));
  return matches(h.locations, e.location) && matches(h.departments, e.department) && matches(h.employeeCategories, e.category);
}

export async function employeeHolidays(employee: EmployeeScope, start: string, end: string): Promise<HolidayInstance[]> {
  return (await holidayOccurrences(start, end)).filter((h) => holidayAppliesTo(h, employee));
}

/** Holidays that reduce a leave's cost. Optional ones stay working days unless claimed as leave. */
export const nonOptional = (holidays: HolidayInstance[]) =>
  holidays.filter((h) => h.category !== 'OPTIONAL').map((h) => ({ ...h, date: h.occurrenceDate }));
