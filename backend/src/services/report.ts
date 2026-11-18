import { Types } from 'mongoose';
import { CONFIRMED_LEAVE_STATUSES, LEAVE_STATUS } from '../constants';
import { CompOffRequest, CompOffTransaction, ICompOffTransaction } from '../models/CompOff';
import { Employee } from '../models/Employee';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { ILeaveBalance, LeaveBalance } from '../models/LeaveLedger';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { monthOf, monthRange, yearRange } from '../utils/dates';
import { badRequest } from '../utils/errors';
import { Table } from '../utils/tabular';
import { holidayOccurrences } from './holiday';
import { companyToday } from './settings';

export interface ReportFilters {
  from?: string;
  to?: string;
  month?: string;
  year?: number;
  employee?: string;
  department?: string;
  leaveType?: string;
}

export const REPORT_NAMES = ['monthly', 'annual', 'employee', 'department', 'balances', 'compoff', 'compoff-expiry', 'pending', 'holidays', 'cancellations'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

interface EmployeeInfo {
  _id: Types.ObjectId;
  employeeId: string;
  fullName: string;
  department: string;
}

async function employeeDirectory(f: ReportFilters): Promise<Map<string, EmployeeInfo>> {
  const query: Record<string, unknown> = {};
  if (f.employee) query._id = f.employee;
  if (f.department) query.department = f.department;
  const docs = await Employee.find(query).select('employeeId fullName department').populate('department', 'name').sort({ fullName: 1 }).lean<any[]>();
  return new Map(docs.map((e) => [String(e._id), { _id: e._id, employeeId: e.employeeId, fullName: e.fullName, department: e.department?.name ?? '' }]));
}

async function typeDirectory(): Promise<Map<string, ILeaveType>> {
  const types = await LeaveType.find().sort({ code: 1 }).lean<ILeaveType[]>();
  return new Map(types.map((t) => [String(t._id), t]));
}

async function requestsInRange(start: string, end: string, f: ReportFilters, statuses: string[], ids: string[]) {
  const query: Record<string, unknown> = { status: { $in: statuses }, startDate: { $lte: end }, endDate: { $gte: start }, employee: { $in: ids } };
  if (f.leaveType) query.leaveType = f.leaveType;
  return LeaveRequest.find(query).sort({ startDate: 1 }).lean<ILeaveRequest[]>();
}

/** The days of a request that fall inside the range. A leave across a boundary counts in each side's report. */
const daysWithin = (r: ILeaveRequest, start: string, end: string) => r.dayBreakdown.filter((d) => d.date >= start && d.date <= end);

const baseColumns = [
  { key: 'employeeName', header: 'Employee Name' },
  { key: 'employeeId', header: 'Employee ID' },
  { key: 'department', header: 'Department' },
];

function resolveRange(f: ReportFilters, today: string) {
  if (f.month) return monthRange(f.month);
  if (f.from || f.to) return { start: f.from ?? `${(f.to ?? today).slice(0, 4)}-01-01`, end: f.to ?? `${(f.from ?? today).slice(0, 4)}-12-31` };
  if (f.year) return yearRange(f.year);
  return null;
}

async function byEmployeeAndType(title: string, start: string, end: string, f: ReportFilters): Promise<Table> {
  const [employees, types] = await Promise.all([employeeDirectory(f), typeDirectory()]);
  const requests = await requestsInRange(start, end, f, CONFIRMED_LEAVE_STATUSES, [...employees.keys()]);
  const rows = new Map<string, Record<string, unknown>>();
  const codes = new Set<string>();
  for (const r of requests) {
    const e = employees.get(String(r.employee));
    const code = types.get(String(r.leaveType))?.code ?? 'UNKNOWN';
    const days = daysWithin(r, start, end).reduce((s, d) => s + d.value, 0);
    if (!e || !days) continue;
    codes.add(code);
    const row = rows.get(e.employeeId) ?? { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, total: 0 };
    row[code] = ((row[code] as number) ?? 0) + days;
    row.total = (row.total as number) + days;
    rows.set(e.employeeId, row);
  }
  return {
    title,
    columns: [...baseColumns, ...[...codes].sort().map((c) => ({ key: c, header: c })), { key: 'total', header: 'Total Days' }],
    rows: [...rows.values()].sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName))),
  };
}

export async function buildReport(name: ReportName, f: ReportFilters): Promise<Table> {
  const today = await companyToday();
  const range = resolveRange(f, today);
  const yearDefault = Number(today.slice(0, 4));

  switch (name) {
    case 'monthly': {
      const month = f.month ?? today.slice(0, 7);
      const { start, end } = monthRange(month);
      return byEmployeeAndType(`Monthly leave ${month}`, start, end, f);
    }
    case 'annual': {
      const year = f.year ?? yearDefault;
      const { start, end } = yearRange(year);
      const employees = await employeeDirectory(f);
      const requests = await requestsInRange(start, end, f, CONFIRMED_LEAVE_STATUSES, [...employees.keys()]);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const rows = new Map<string, Record<string, unknown>>();
      for (const r of requests) {
        const e = employees.get(String(r.employee));
        if (!e) continue;
        const row = rows.get(e.employeeId) ?? { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, total: 0 };
        for (const d of daysWithin(r, start, end)) {
          const key = months[monthOf(d.date) - 1];
          row[key] = ((row[key] as number) ?? 0) + d.value;
          row.total = (row.total as number) + d.value;
        }
        rows.set(e.employeeId, row);
      }
      return {
        title: `Annual leave ${year}`,
        columns: [...baseColumns, ...months.map((m) => ({ key: m, header: m })), { key: 'total', header: 'Total Days' }],
        rows: [...rows.values()].sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName))),
      };
    }
    case 'employee': {
      const { start, end } = range ?? yearRange(yearDefault);
      const [employees, types] = await Promise.all([employeeDirectory(f), typeDirectory()]);
      const requests = await requestsInRange(start, end, f, Object.values(LEAVE_STATUS), [...employees.keys()]);
      return {
        title: `Employee leave ${start} to ${end}`,
        columns: [...baseColumns,
          { key: 'leaveType', header: 'Leave Type' }, { key: 'startDate', header: 'Start' }, { key: 'endDate', header: 'End' },
          { key: 'days', header: 'Days' }, { key: 'status', header: 'Status' }, { key: 'reason', header: 'Reason' }],
        rows: requests.map((r) => {
          const e = employees.get(String(r.employee))!;
          return { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, leaveType: types.get(String(r.leaveType))?.code, startDate: r.startDate, endDate: r.endDate, days: r.totalDays, status: r.status, reason: r.reason };
        }),
      };
    }
    case 'department': {
      const { start, end } = range ?? yearRange(yearDefault);
      const [employees, types] = await Promise.all([employeeDirectory(f), typeDirectory()]);
      const requests = await requestsInRange(start, end, f, CONFIRMED_LEAVE_STATUSES, [...employees.keys()]);
      const groups = new Map<string, { department: string; leaveType: string; days: number; staff: Set<string> }>();
      for (const r of requests) {
        const e = employees.get(String(r.employee))!;
        const code = types.get(String(r.leaveType))?.code ?? 'UNKNOWN';
        const days = daysWithin(r, start, end).reduce((s, d) => s + d.value, 0);
        if (!days) continue;
        const key = `${e.department}|${code}`;
        const g = groups.get(key) ?? { department: e.department || 'Unassigned', leaveType: code, days: 0, staff: new Set<string>() };
        g.days += days;
        g.staff.add(e.employeeId);
        groups.set(key, g);
      }
      return {
        title: `Department leave ${start} to ${end}`,
        columns: [{ key: 'department', header: 'Department' }, { key: 'leaveType', header: 'Leave Type' }, { key: 'days', header: 'Days' }, { key: 'employees', header: 'Employees' }],
        rows: [...groups.values()].sort((a, b) => a.department.localeCompare(b.department) || a.leaveType.localeCompare(b.leaveType)).map((g) => ({ department: g.department, leaveType: g.leaveType, days: g.days, employees: g.staff.size })),
      };
    }
    case 'balances': {
      const year = f.year ?? yearDefault;
      const [employees, types] = await Promise.all([employeeDirectory(f), typeDirectory()]);
      const query: Record<string, unknown> = { year, employee: { $in: [...employees.keys()] } };
      if (f.leaveType) query.leaveType = f.leaveType;
      const rows = await LeaveBalance.find(query).lean<ILeaveBalance[]>();
      return {
        title: `Leave balances ${year}`,
        columns: [...baseColumns, { key: 'leaveType', header: 'Leave Type' }, { key: 'openingBalance', header: 'Opening' }, { key: 'entitlement', header: 'Entitlement' }, { key: 'credited', header: 'Credited' }, { key: 'carryForward', header: 'Carry Forward' }, { key: 'adjustments', header: 'Adjustments' }, { key: 'used', header: 'Used' }, { key: 'reserved', header: 'Pending' }, { key: 'expired', header: 'Expired' }, { key: 'available', header: 'Available' }],
        rows: rows
          .map((b) => {
            const e = employees.get(String(b.employee))!;
            return { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, leaveType: types.get(String(b.leaveType))?.code, openingBalance: b.openingBalance, entitlement: b.entitlement, credited: b.credited, carryForward: b.carryForward, adjustments: b.adjustments, used: b.used, reserved: b.reserved, expired: b.expired, available: b.available };
          })
          .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || String(a.leaveType).localeCompare(String(b.leaveType))),
      };
    }
    case 'compoff': {
      const employees = await employeeDirectory(f);
      const lots = await CompOffTransaction.find({ type: 'CREDIT', employee: { $in: [...employees.keys()] } }).lean<ICompOffTransaction[]>();
      const rows = new Map<string, Record<string, number | string>>();
      for (const lot of lots) {
        if (range && lot.earnedDate && (lot.earnedDate < range.start || lot.earnedDate > range.end)) continue;
        const e = employees.get(String(lot.employee))!;
        const row = rows.get(e.employeeId) ?? { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, earned: 0, used: 0, reserved: 0, expired: 0, available: 0 };
        row.earned = (row.earned as number) + lot.amount;
        row.used = (row.used as number) + lot.used;
        row.reserved = (row.reserved as number) + lot.reserved;
        const lapsed = lot.expiresOn && lot.expiresOn < today;
        row.expired = (row.expired as number) + lot.expired + (lapsed ? lot.remaining : 0);
        row.available = (row.available as number) + (lapsed ? 0 : lot.remaining);
        rows.set(e.employeeId, row);
      }
      return {
        title: 'Comp-Off earned and used',
        columns: [...baseColumns, { key: 'earned', header: 'Earned' }, { key: 'used', header: 'Used' }, { key: 'reserved', header: 'Pending Use' }, { key: 'expired', header: 'Expired' }, { key: 'available', header: 'Available' }],
        rows: [...rows.values()],
      };
    }
    case 'compoff-expiry': {
      const employees = await employeeDirectory(f);
      const start = range?.start ?? today;
      const end = range?.end ?? `${yearDefault + 1}-12-31`;
      const lots = await CompOffTransaction.find({
        type: 'CREDIT', remaining: { $gt: 0 }, expiresOn: { $gte: start, $lte: end }, employee: { $in: [...employees.keys()] },
      }).sort({ expiresOn: 1 }).lean<ICompOffTransaction[]>();
      return {
        title: `Comp-Off expiry ${start} to ${end}`,
        columns: [...baseColumns, { key: 'earnedDate', header: 'Earned On' }, { key: 'expiresOn', header: 'Expires On' }, { key: 'remaining', header: 'Days Remaining' }],
        rows: lots.map((l) => {
          const e = employees.get(String(l.employee))!;
          return { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, earnedDate: l.earnedDate, expiresOn: l.expiresOn, remaining: l.remaining };
        }),
      };
    }
    case 'pending': {
      const [employees, types] = await Promise.all([employeeDirectory(f), typeDirectory()]);
      const ids = [...employees.keys()];
      const typeQuery = f.leaveType ? { leaveType: f.leaveType } : {};
      const [leaves, compOffs] = await Promise.all([
        LeaveRequest.find({ status: { $in: [LEAVE_STATUS.PENDING, LEAVE_STATUS.CANCELLATION_REQUESTED] }, employee: { $in: ids }, ...typeQuery }).sort({ createdAt: 1 }).lean<ILeaveRequest[]>(),
        CompOffRequest.find({ status: 'PENDING', employee: { $in: ids } }).sort({ createdAt: 1 }).lean(),
      ]);
      return {
        title: 'Pending approvals',
        columns: [...baseColumns, { key: 'kind', header: 'Request' }, { key: 'detail', header: 'Detail' }, { key: 'days', header: 'Days' }, { key: 'status', header: 'Status' }, { key: 'submitted', header: 'Submitted' }],
        rows: [
          ...leaves.map((r) => {
            const e = employees.get(String(r.employee))!;
            return { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, kind: types.get(String(r.leaveType))?.code, detail: `${r.startDate} to ${r.endDate}`, days: r.totalDays, status: r.status, submitted: r.createdAt.toISOString().slice(0, 10) };
          }),
          ...compOffs.map((r) => {
            const e = employees.get(String(r.employee))!;
            return { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, kind: 'Comp-Off credit', detail: `Worked ${r.workedDate}`, days: r.amount, status: r.status, submitted: r.createdAt.toISOString().slice(0, 10) };
          }),
        ],
      };
    }
    case 'holidays': {
      const { start, end } = range ?? yearRange(f.year ?? yearDefault);
      const holidays = await holidayOccurrences(start, end);
      return {
        title: `Holiday calendar ${start} to ${end}`,
        columns: [{ key: 'date', header: 'Date' }, { key: 'name', header: 'Holiday' }, { key: 'category', header: 'Category' }, { key: 'dayType', header: 'Day' }, { key: 'recurring', header: 'Recurring' }, { key: 'description', header: 'Description' }],
        rows: holidays.map((h) => ({ date: h.occurrenceDate, name: h.name, category: h.category, dayType: h.isHalfDay ? 'Half' : 'Full', recurring: h.recurring ? 'Yes' : 'No', description: h.description ?? '' })),
      };
    }
    case 'cancellations': {
      const { start, end } = range ?? yearRange(yearDefault);
      const [employees, types] = await Promise.all([employeeDirectory(f), typeDirectory()]);
      const requests = await requestsInRange(start, end, f, [LEAVE_STATUS.CANCELLED, LEAVE_STATUS.CANCELLATION_REQUESTED], [...employees.keys()]);
      return {
        title: `Leave cancellations ${start} to ${end}`,
        columns: [...baseColumns, { key: 'leaveType', header: 'Leave Type' }, { key: 'startDate', header: 'Start' }, { key: 'endDate', header: 'End' }, { key: 'days', header: 'Days' }, { key: 'status', header: 'Status' }, { key: 'reason', header: 'Cancellation Reason' }],
        rows: requests.map((r) => {
          const e = employees.get(String(r.employee))!;
          return { employeeName: e.fullName, employeeId: e.employeeId, department: e.department, leaveType: types.get(String(r.leaveType))?.code, startDate: r.startDate, endDate: r.endDate, days: r.totalDays, status: r.status, reason: r.cancellationReason ?? '' };
        }),
      };
    }
    default:
      throw badRequest('Unknown report');
  }
}
