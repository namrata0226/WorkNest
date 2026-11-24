import { Types } from 'mongoose';
import { ACTIVE_LEAVE_STATUSES, CONFIRMED_LEAVE_STATUSES, LEAVE_STATUS } from '../constants';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { addDays, diffDays, monthRange } from '../utils/dates';
import { escapeRegex } from '../utils/http';
import { employeeHolidays, holidayOccurrences } from './holiday';
import { companyToday } from './settings';

export interface CalendarFilters {
  start: string;
  end: string;
  department?: string;
  leaveType?: string;
  status?: string;
  search?: string;
}

/** Null means no restriction; otherwise the employee ids that pass the filters. */
export async function matchingEmployeeIds(f: Pick<CalendarFilters, 'department' | 'search'>): Promise<Types.ObjectId[] | null> {
  if (!f.department && !f.search) return null;
  const query: Record<string, unknown> = {};
  if (f.department) query.department = f.department;
  if (f.search) {
    const rx = new RegExp(escapeRegex(f.search), 'i');
    query.$or = [{ fullName: rx }, { employeeId: rx }];
  }
  return (await Employee.find(query).select('_id').lean<IEmployee[]>()).map((e) => e._id);
}

/** A leave is drawn as runs of its charged days, so it never paints over weekends or holidays. */
export function toSegments(days: { date: string; value: number }[]): { start: string; end: string; days: number }[] {
  const segments: { start: string; end: string; days: number }[] = [];
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const last = segments[segments.length - 1];
    if (last && diffDays(d.date, last.end) === 1) {
      last.end = d.date;
      last.days += d.value;
    } else {
      segments.push({ start: d.date, end: d.date, days: d.value });
    }
  }
  return segments;
}

type PopulatedRequest = Omit<ILeaveRequest, 'employee' | 'leaveType'> & {
  employee: Pick<IEmployee, '_id' | 'employeeId' | 'fullName'> & { department?: { _id: Types.ObjectId; name: string } | null };
  leaveType: Pick<ILeaveType, '_id' | 'name' | 'code' | 'color' | 'kind'>;
};

function toEvents(requests: PopulatedRequest[], f: Pick<CalendarFilters, 'start' | 'end'>) {
  return requests.flatMap((r) =>
    toSegments(r.dayBreakdown)
      .filter((s) => s.start <= f.end && s.end >= f.start)
      .map((s, i) => ({
        id: `${r._id}:${i}`,
        requestId: r._id,
        start: s.start,
        end: s.end,
        endExclusive: addDays(s.end, 1),
        days: s.days,
        totalDays: r.totalDays,
        requestStart: r.startDate,
        requestEnd: r.endDate,
        status: r.status,
        dayType: r.dayType,
        halfSession: r.halfSession,
        reason: r.reason,
        employee: { id: r.employee._id, employeeId: r.employee.employeeId, fullName: r.employee.fullName, department: r.employee.department?.name ?? null },
        leaveType: { id: r.leaveType._id, name: r.leaveType.name, code: r.leaveType.code, color: r.leaveType.color },
      })),
  );
}

const STATUSES_FOR = (status?: string) => {
  if (status === 'APPROVED') return CONFIRMED_LEAVE_STATUSES;
  if (status === 'PENDING') return [LEAVE_STATUS.PENDING];
  return ACTIVE_LEAVE_STATUSES;
};

export async function companyCalendar(f: CalendarFilters) {
  const query: Record<string, unknown> = {
    status: { $in: STATUSES_FOR(f.status) },
    startDate: { $lte: f.end },
    endDate: { $gte: f.start },
  };
  if (f.leaveType) query.leaveType = f.leaveType;
  const ids = await matchingEmployeeIds(f);
  if (ids) query.employee = { $in: ids };

  const [requests, holidays] = await Promise.all([
    LeaveRequest.find(query)
      .select('employee leaveType startDate endDate status dayType halfSession dayBreakdown totalDays reason')
      .populate({ path: 'employee', select: 'employeeId fullName department', populate: { path: 'department', select: 'name' } })
      .populate('leaveType', 'name code color kind')
      .sort({ startDate: 1 })
      .lean<PopulatedRequest[]>(),
    holidayOccurrences(f.start, f.end),
  ]);
  return {
    events: toEvents(requests.filter((r) => r.employee && r.leaveType), f),
    holidays: holidays
      .filter((h) => !f.department || !h.departments?.length || h.departments.some((d) => String(d) === f.department))
      .map((h) => ({ id: h._id, name: h.name, date: h.occurrenceDate, category: h.category, isHalfDay: h.isHalfDay })),
  };
}

export async function employeeCalendar(employee: IEmployee, start: string, end: string) {
  const [requests, holidays] = await Promise.all([
    LeaveRequest.find({ employee: employee._id, status: { $in: ACTIVE_LEAVE_STATUSES }, startDate: { $lte: end }, endDate: { $gte: start } })
      .populate({ path: 'employee', select: 'employeeId fullName department', populate: { path: 'department', select: 'name' } })
      .populate('leaveType', 'name code color kind')
      .lean<PopulatedRequest[]>(),
    employeeHolidays(employee, start, end),
  ]);
  return {
    events: toEvents(requests, { start, end }),
    holidays: holidays.map((h) => ({ id: h._id, name: h.name, date: h.occurrenceDate, category: h.category, isHalfDay: h.isHalfDay })),
  };
}

export interface SummaryRow {
  employeeRef: Types.ObjectId;
  employeeName: string;
  employeeId: string;
  department: string;
  byType: Record<string, number>;
  casual: number;
  sick: number;
  earned: number;
  compOff: number;
  other: number;
  total: number;
}

const BUCKET: Record<string, 'casual' | 'sick' | 'earned' | 'compOff'> = { CL: 'casual', SL: 'sick', EL: 'earned', CO: 'compOff' };

/** Cards and the employee table for one month. Only confirmed days are counted as leave taken. */
export async function monthlySummary(month: string, f: Pick<CalendarFilters, 'department' | 'leaveType' | 'search'> = {}) {
  const { start, end } = monthRange(month);
  const today = await companyToday();
  const ids = await matchingEmployeeIds(f);
  const restrict = ids ? { employee: { $in: ids } } : {};
  const typeFilter = f.leaveType ? { leaveType: f.leaveType } : {};
  const overlap = { startDate: { $lte: end }, endDate: { $gte: start } };

  const employeeQuery: Record<string, unknown> = { employmentStatus: { $ne: 'INACTIVE' } };
  if (f.department) employeeQuery.department = f.department;
  if (ids) employeeQuery._id = { $in: ids };

  const [activeEmployees, confirmed, pending, onLeaveNow, types] = await Promise.all([
    Employee.find(employeeQuery).select('employeeId fullName department').populate('department', 'name').lean<any[]>(),
    LeaveRequest.find({ status: { $in: CONFIRMED_LEAVE_STATUSES }, ...overlap, ...restrict, ...typeFilter }).select('employee leaveType dayBreakdown').lean<ILeaveRequest[]>(),
    LeaveRequest.countDocuments({ status: LEAVE_STATUS.PENDING, ...overlap, ...restrict, ...typeFilter }),
    LeaveRequest.distinct('employee', { status: { $in: CONFIRMED_LEAVE_STATUSES }, 'dayBreakdown.date': today, ...restrict, ...typeFilter }),
    LeaveType.find().select('code').lean<ILeaveType[]>(),
  ]);
  const codeById = new Map(types.map((t) => [String(t._id), t.code]));

  // Former employees with leave in this month still belong on its report.
  const knownIds = new Set(activeEmployees.map((e) => String(e._id)));
  const missing = [...new Set(confirmed.map((r) => String(r.employee)))].filter((id) => !knownIds.has(id));
  const former = missing.length
    ? await Employee.find({ _id: { $in: missing } }).select('employeeId fullName department').populate('department', 'name').lean<any[]>()
    : [];

  const rows = new Map<string, SummaryRow>();
  for (const e of [...activeEmployees, ...former]) {
    rows.set(String(e._id), {
      employeeRef: e._id,
      employeeName: e.fullName,
      employeeId: e.employeeId,
      department: e.department?.name ?? '',
      byType: {},
      casual: 0, sick: 0, earned: 0, compOff: 0, other: 0, total: 0,
    });
  }

  const absencesByDate = new Map<string, Set<string>>();
  const employeesOnLeave = new Set<string>();
  let approvedDays = 0;
  for (const r of confirmed) {
    const code = codeById.get(String(r.leaveType)) ?? '';
    const row = rows.get(String(r.employee));
    for (const d of r.dayBreakdown) {
      if (d.date < start || d.date > end) continue;
      approvedDays += d.value;
      employeesOnLeave.add(String(r.employee));
      if (!absencesByDate.has(d.date)) absencesByDate.set(d.date, new Set());
      absencesByDate.get(d.date)!.add(String(r.employee));
      if (row) {
        row.byType[code] = (row.byType[code] ?? 0) + d.value;
        row[BUCKET[code] ?? 'other'] += d.value;
        row.total += d.value;
      }
    }
  }

  let peak = 0;
  for (const set of absencesByDate.values()) peak = Math.max(peak, set.size);
  const peakDates = peak ? [...absencesByDate.entries()].filter(([, s]) => s.size === peak).map(([date]) => date).sort() : [];

  return {
    month,
    cards: {
      totalActiveEmployees: activeEmployees.length,
      employeesOnLeaveThisMonth: employeesOnLeave.size,
      employeesCurrentlyOnLeave: onLeaveNow.length,
      totalApprovedLeaveDays: approvedDays,
      pendingLeaveRequests: pending,
      maxAbsence: { count: peak, dates: peakDates },
    },
    rows: [...rows.values()].sort((a, b) => b.total - a.total || a.employeeName.localeCompare(b.employeeName)),
  };
}

export const SUMMARY_DETAIL_KINDS = ['active', 'onLeaveMonth', 'onLeaveToday', 'approvedDays', 'pending', 'peak'] as const;
export type SummaryDetailKind = (typeof SUMMARY_DETAIL_KINDS)[number];

type PersonOut = { _id: Types.ObjectId; fullName: string; employeeId: string; department: string | null; designation: string | null; avatarFile: Types.ObjectId | null };
type LeaveOut = { requestId: Types.ObjectId; status: string; leaveType: { name: string; code: string; color: string } | null; startDate: string; endDate: string; days: number; halfDay: boolean; appliedAt: Date };

/**
 * The people or requests behind one summary card, with the same filters and the same rules as the counts,
 * so a list always adds up to the number on the card it was opened from.
 */
export async function summaryDetails(month: string, kind: SummaryDetailKind, f: Pick<CalendarFilters, 'department' | 'leaveType' | 'search'> = {}) {
  const { start, end } = monthRange(month);
  const today = await companyToday();
  const ids = await matchingEmployeeIds(f);
  const restrict = ids ? { employee: { $in: ids } } : {};
  const typeFilter = f.leaveType ? { leaveType: f.leaveType } : {};
  const overlap = { startDate: { $lte: end }, endDate: { $gte: start } };

  const person = (e: any): PersonOut => ({ _id: e._id, fullName: e.fullName, employeeId: e.employeeId, department: e.department?.name ?? null, designation: e.designation ?? null, avatarFile: e.avatarFile ?? null });
  const populateEmployee = { path: 'employee', select: 'fullName employeeId designation avatarFile department', populate: { path: 'department', select: 'name' } };
  const leaveOut = (r: any, inMonth = false): LeaveOut => ({
    requestId: r._id,
    status: r.status,
    leaveType: r.leaveType ? { name: r.leaveType.name, code: r.leaveType.code, color: r.leaveType.color } : null,
    startDate: r.startDate,
    endDate: r.endDate,
    days: inMonth ? r.dayBreakdown.filter((d: { date: string }) => d.date >= start && d.date <= end).reduce((s: number, d: { value: number }) => s + d.value, 0) : r.totalDays,
    halfDay: r.dayType === 'HALF',
    appliedAt: r.createdAt,
  });

  if (kind === 'active') {
    const query: Record<string, unknown> = { employmentStatus: { $ne: 'INACTIVE' } };
    if (f.department) query.department = f.department;
    if (ids) query._id = { $in: ids };
    const people = await Employee.find(query).sort({ fullName: 1 }).select('fullName employeeId designation avatarFile department').populate('department', 'name').lean<any[]>();
    return { kind, month, people: people.map(person) };
  }

  if (kind === 'pending' || kind === 'onLeaveToday' || kind === 'approvedDays' || kind === 'onLeaveMonth') {
    const query =
      kind === 'pending' ? { status: LEAVE_STATUS.PENDING, ...overlap }
        : kind === 'onLeaveToday' ? { status: { $in: CONFIRMED_LEAVE_STATUSES }, 'dayBreakdown.date': today }
          : { status: { $in: CONFIRMED_LEAVE_STATUSES }, ...overlap };
    const requests = await LeaveRequest.find({ ...query, ...restrict, ...typeFilter })
      .sort({ startDate: 1, createdAt: 1 })
      .populate(populateEmployee)
      .populate('leaveType', 'name code color')
      .lean<any[]>();
    const rows = requests
      .filter((r) => r.employee)
      .map((r) => ({ employee: person(r.employee), leave: leaveOut(r, kind === 'approvedDays' || kind === 'onLeaveMonth') }))
      // Leave whose charged days all fall outside the month (e.g. only a weekend overlaps) does not count.
      .filter((r) => kind === 'pending' || kind === 'onLeaveToday' || r.leave.days > 0);

    if (kind !== 'onLeaveMonth') return { kind, month, today, requests: rows };

    // One row per person, with every leave they take in the month.
    const byPerson = new Map<string, { employee: PersonOut; days: number; leaves: LeaveOut[] }>();
    for (const r of rows) {
      const key = String(r.employee._id);
      const entry = byPerson.get(key) ?? { employee: r.employee, days: 0, leaves: [] };
      entry.days += r.leave.days;
      entry.leaves.push(r.leave);
      byPerson.set(key, entry);
    }
    return { kind, month, people: [...byPerson.values()].sort((a, b) => b.days - a.days || a.employee.fullName.localeCompare(b.employee.fullName)) };
  }

  // peak: the busiest date(s), with who is away on each.
  const confirmed = await LeaveRequest.find({ status: { $in: CONFIRMED_LEAVE_STATUSES }, ...overlap, ...restrict, ...typeFilter })
    .populate(populateEmployee)
    .populate('leaveType', 'name code color')
    .lean<any[]>();
  const byDate = new Map<string, Map<string, { employee: PersonOut; leaveType: LeaveOut['leaveType']; value: number }>>();
  for (const r of confirmed) {
    if (!r.employee) continue;
    for (const d of r.dayBreakdown as { date: string; value: number }[]) {
      if (d.date < start || d.date > end) continue;
      const day = byDate.get(d.date) ?? new Map();
      day.set(String(r.employee._id), { employee: person(r.employee), leaveType: r.leaveType ? { name: r.leaveType.name, code: r.leaveType.code, color: r.leaveType.color } : null, value: d.value });
      byDate.set(d.date, day);
    }
  }
  const peak = Math.max(0, ...[...byDate.values()].map((m) => m.size));
  const dates = peak
    ? [...byDate.entries()].filter(([, m]) => m.size === peak).sort(([a], [b]) => a.localeCompare(b)).map(([date, m]) => ({ date, people: [...m.values()].sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName)) }))
    : [];
  return { kind, month, peak, dates };
}
