import { randomUUID } from 'crypto';
import { RequestHandler } from 'express';
import { ACTIVE_LEAVE_STATUSES, CONFIRMED_LEAVE_STATUSES, LEAVE_STATUS } from '../constants';
import { CompOffRequest, CompOffTransaction } from '../models/CompOff';
import { Employee, IEmployee } from '../models/Employee';
import { LeaveTransaction } from '../models/LeaveLedger';
import { LeaveRequest } from '../models/LeaveRequest';
import { ctxOf } from '../services/audit';
import { adjustBalance, BalanceRow, getEmployeeBalances } from '../services/balance';
import { employeeHolidays } from '../services/holiday';
import { companyToday } from '../services/settings';
import { addDays, yearOf } from '../utils/dates';
import { notFound } from '../utils/errors';
import { created, escapeRegex, ok, pageMeta, pageOptions } from '../utils/http';

async function balancesFor(employeeId: unknown, year?: number) {
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  const today = await companyToday();
  return { employee, balances: await getEmployeeBalances(employee, year ?? yearOf(today), today), today };
}

export const myBalances: RequestHandler = async (req, res) => {
  const { balances } = await balancesFor(req.auth!.employeeId, req.valid.query.year);
  ok(res, balances);
};

export const employeeBalances: RequestHandler = async (req, res) => {
  const { employee, balances } = await balancesFor(req.valid.params.employeeId, req.valid.query.year);
  ok(res, { employee: { _id: employee._id, employeeId: employee.employeeId, fullName: employee.fullName }, balances });
};

async function transactions(employee: unknown, q: any) {
  const filter: Record<string, unknown> = { employee };
  if (q.year) filter.year = q.year;
  if (q.leaveType) filter.leaveType = q.leaveType;
  const { skip, limit, sort } = pageOptions(q, ['createdAt', 'amount', 'year'], 'createdAt');
  const [items, total] = await Promise.all([
    LeaveTransaction.find(filter).sort(sort).skip(skip).limit(limit)
      .populate('leaveType', 'name code color')
      .populate('performedBy', 'email')
      .lean(),
    LeaveTransaction.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q, total) };
}

export const myTransactions: RequestHandler = async (req, res) => {
  const { items, meta } = await transactions(req.auth!.employeeId, req.valid.query);
  ok(res, items, meta);
};

export const employeeTransactions: RequestHandler = async (req, res) => {
  const { items, meta } = await transactions(req.valid.params.employeeId, req.valid.query);
  ok(res, items, meta);
};

export const adjustment: RequestHandler = async (req, res) => {
  // Without a client key each call is its own adjustment. With one, retries post once.
  const idempotencyKey = req.get('Idempotency-Key') ?? randomUUID();
  created(res, await adjustBalance(ctxOf(req), { ...req.valid.body, idempotencyKey }));
};

/** The admin overview: employees with their balances for the year. */
export const overview: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const today = await companyToday();
  const year = q.year ?? yearOf(today);
  const filter: Record<string, unknown> = { employmentStatus: { $ne: 'INACTIVE' } };
  if (q.department) filter.department = q.department;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ fullName: rx }, { employeeId: rx }];
  }
  const { skip, limit, sort } = pageOptions(q, ['fullName', 'employeeId'], 'fullName');
  const [employees, total] = await Promise.all([
    Employee.find(filter).sort(sort).skip(skip).limit(limit).populate('department', 'name').lean<any[]>(),
    Employee.countDocuments(filter),
  ]);
  const items = [];
  for (const e of employees) {
    const balances = await getEmployeeBalances(e, year, today);
    items.push({
      _id: e._id,
      employeeId: e.employeeId,
      fullName: e.fullName,
      department: e.department?.name ?? null,
      balances: balances.map((b) => ({ leaveType: b.leaveType, available: b.available, used: b.used, reserved: b.reserved })),
    });
  }
  ok(res, items, pageMeta(q, total));
};

const sumRows = (rows: BalanceRow[], field: 'entitlement' | 'credited' | 'carryForward' | 'openingBalance' | 'adjustments') =>
  rows.reduce((sum, r) => sum + (r[field] ?? 0), 0);

/** Everything the employee dashboard renders, computed from MongoDB in one request. */
export const dashboard: RequestHandler = async (req, res) => {
  const employeeId = req.auth!.employeeId!;
  const { employee, balances, today } = await balancesFor(employeeId);
  const year = yearOf(today);

  const [recent, upcoming, pendingCount, usage, transactions, compOffHistory, compOffRequests, holidays] = await Promise.all([
    LeaveRequest.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(6).populate('leaveType', 'name code color').lean(),
    LeaveRequest.find({ employee: employeeId, status: { $in: CONFIRMED_LEAVE_STATUSES }, endDate: { $gte: today } }).sort({ startDate: 1 }).limit(5).populate('leaveType', 'name code color').lean(),
    LeaveRequest.countDocuments({ employee: employeeId, status: LEAVE_STATUS.PENDING }),
    LeaveRequest.find({ employee: employeeId, status: { $in: CONFIRMED_LEAVE_STATUSES }, 'dayBreakdown.date': { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).select('dayBreakdown').lean(),
    LeaveTransaction.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(10).populate('leaveType', 'name code color').lean(),
    CompOffTransaction.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(10).lean(),
    CompOffRequest.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(5).lean(),
    employeeHolidays(employee, today, addDays(today, 180)),
  ]);

  const totalUsed = usage.reduce(
    (sum, r) => sum + r.dayBreakdown.filter((d) => yearOf(d.date) === year).reduce((s, d) => s + d.value, 0),
    0,
  );
  const paid = balances.filter((b) => !b.isCompOff && b.leaveType.isPaid && !b.leaveType.eventBased);
  const byCode = (code: string) => balances.find((b) => b.leaveType.code === code)?.available ?? null;

  ok(res, {
    year,
    today,
    cards: {
      totalAnnualEntitlement: sumRows(paid, 'entitlement') + sumRows(paid, 'credited') + sumRows(paid, 'carryForward') + sumRows(paid, 'openingBalance'),
      casualBalance: byCode('CL'),
      sickBalance: byCode('SL'),
      earnedBalance: byCode('EL'),
      compOffBalance: balances.find((b) => b.isCompOff)?.available ?? 0,
      totalUsed,
      upcomingApproved: upcoming.length,
      pendingRequests: pendingCount,
    },
    balances,
    recent,
    upcoming,
    holidays: holidays.slice(0, 6).map((h) => ({ id: h._id, name: h.name, date: h.occurrenceDate, category: h.category, isHalfDay: h.isHalfDay })),
    transactions,
    compOffHistory,
    compOffRequests,
    activeStatuses: ACTIVE_LEAVE_STATUSES,
  });
};
