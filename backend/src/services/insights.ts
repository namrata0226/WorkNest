import { CONFIRMED_LEAVE_STATUSES } from '../constants';
import { AuthContext } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { addDays } from '../utils/dates';
import { dailyAttendance, rangeForEmployees } from './attendance';
import { employeeHolidays, nonOptional } from './holiday';
import { companyToday } from './settings';

const ABSENCE_WINDOW_DAYS = 30;

export async function hrInsights() {
  const today = await companyToday();
  const daily = await dailyAttendance({ date: today });
  const away = daily.rows.filter((r) => r.status === 'ON_LEAVE' || r.status === 'HALF_LEAVE' || r.status === 'ABSENT').map((r) => ({ name: r.employee.fullName, status: r.status }));

  const thisMonth = today.slice(0, 7);
  const months: string[] = [];
  const [y, m] = thisMonth.split('-').map(Number);
  for (let back = 11; back >= 0; back--) {
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const leaves = await LeaveRequest.find({ status: { $in: CONFIRMED_LEAVE_STATUSES }, endDate: { $gte: `${months[0]}-01` } }).select('leaveType dayBreakdown').lean<ILeaveRequest[]>();
  const names = new Map((await LeaveType.find().select('name').lean<ILeaveType[]>()).map((t) => [String(t._id), t.name]));
  const byMonth = new Map(months.map((k) => [k, 0]));
  const byType = new Map<string, number>();
  for (const l of leaves) {
    for (const b of l.dayBreakdown) {
      const key = b.date.slice(0, 7);
      if (!byMonth.has(key)) continue;
      byMonth.set(key, byMonth.get(key)! + b.value);
      const name = names.get(String(l.leaveType)) ?? 'Other';
      byType.set(name, (byType.get(name) ?? 0) + b.value);
    }
  }

  const windowStart = addDays(today, -ABSENCE_WINDOW_DAYS);
  const { rows } = await rangeForEmployees({ employmentStatus: { $ne: 'INACTIVE' }, joiningDate: { $lte: today } }, windowStart, addDays(today, -1));
  const frequentAbsent = rows
    .map((r) => ({ _id: r.employee._id, name: r.employee.fullName, employeeId: r.employee.employeeId, department: r.employee.department?.name ?? null, days: r.summary.absent }))
    .filter((r) => r.days > 0)
    .sort((a, b) => b.days - a.days)
    .slice(0, 10);

  return {
    today,
    summary: daily.summary,
    headcount: daily.rows.length,
    away,
    leaveTrend: [...byMonth].map(([month, days]) => ({ month, days })),
    leaveByType: [...byType].map(([name, days]) => ({ name, days })).sort((a, b) => b.days - a.days),
    absenceWindowDays: ABSENCE_WINDOW_DAYS,
    frequentAbsent,
  };
}

/** Colleagues who are away. Never says what kind of leave it is, as that can be private. */
export interface TeamCalendarOptions { scope?: 'team' | 'company'; department?: string }

/**
 * Who is away, for everyone: by default the caller's team, or the whole company (optionally one team).
 * Only dates and names are shared. Leave types and reasons stay private.
 */
export async function teamCalendar(auth: AuthContext, start: string, end: string, opts: TeamCalendarOptions = {}) {
  const me = await Employee.findById(auth.employeeId).lean<IEmployee>();
  if (!me) return { events: [], holidays: [] };
  const query: Record<string, unknown> = { _id: { $ne: me._id }, employmentStatus: { $ne: 'INACTIVE' } };
  if (opts.scope === 'company') {
    if (opts.department) query.department = opts.department;
  } else {
    const or: Record<string, unknown>[] = [{ reportingManager: me._id }];
    if (me.department) or.push({ department: me.department });
    if (me.reportingManager) or.push({ reportingManager: me.reportingManager }, { _id: me.reportingManager });
    query.$or = or;
  }
  const colleagues = await Employee.find(query).select('fullName avatarFile department').populate('department', 'name').lean<(Omit<IEmployee, 'department'> & { department: { name: string } | null })[]>();
  const leaves = await LeaveRequest.find({ employee: { $in: colleagues.map((c) => c._id) }, status: { $in: CONFIRMED_LEAVE_STATUSES }, startDate: { $lte: end }, endDate: { $gte: start } })
    .select('employee startDate endDate dayType').lean<ILeaveRequest[]>();
  const byId = new Map(colleagues.map((c) => [String(c._id), c]));
  const holidays = nonOptional(await employeeHolidays(me, start, end));
  return {
    events: leaves.map((l) => ({ id: String(l._id), employeeId: String(l.employee), employeeName: byId.get(String(l.employee))?.fullName ?? '', avatarFile: byId.get(String(l.employee))?.avatarFile ?? null, team: byId.get(String(l.employee))?.department?.name ?? null, startDate: l.startDate, endDate: l.endDate, halfDay: l.dayType === 'HALF' })),
    holidays: holidays.map((h) => ({ id: `${h._id}-${h.date}`, name: h.name, date: h.date, category: h.category, isHalfDay: h.isHalfDay })),
  };
}
