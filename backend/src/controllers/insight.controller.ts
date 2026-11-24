import { RequestHandler } from 'express';
import { PERMISSIONS } from '../constants';
import { can } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { AuditLog } from '../models/System';
import { companyCalendar, employeeCalendar, monthlySummary, summaryDetails } from '../services/calendar';
import { buildReport } from '../services/report';
import { diffDays } from '../utils/dates';
import { badRequest, notFound } from '../utils/errors';
import { escapeRegex, ok, pageMeta, pageOptions } from '../utils/http';
import { sendTable } from './holiday.controller';

const MAX_CALENDAR_SPAN = 400;

function assertSpan(start: string, end: string) {
  if (diffDays(end, start) > MAX_CALENDAR_SPAN) throw badRequest('The calendar range is too large');
}

export const company: RequestHandler = async (req, res) => {
  const { employeeId: _ignored, ...filters } = req.valid.query;
  assertSpan(filters.start, filters.end);
  ok(res, await companyCalendar(filters));
};

export const employee: RequestHandler = async (req, res) => {
  const auth = req.auth!;
  const { start, end, employeeId } = req.valid.query;
  assertSpan(start, end);
  const target = employeeId ?? auth.employeeId;
  if (!target) throw notFound('Employee');
  if (String(target) !== String(auth.employeeId) && !can(auth, PERMISSIONS.CALENDAR_READ)) throw notFound('Employee');
  const doc = await Employee.findById(target).lean<IEmployee>();
  if (!doc) throw notFound('Employee');
  ok(res, await employeeCalendar(doc, start, end));
};

export const summaryDetail: RequestHandler = async (req, res) => {
  const { month, kind, department, leaveType, search } = req.valid.query;
  ok(res, await summaryDetails(month, kind, { department, leaveType, search }));
};

export const summary: RequestHandler = async (req, res) => {
  const { month, department, leaveType, search, page, limit } = req.valid.query;
  const data = await monthlySummary(month, { department, leaveType, search });
  const start = (page - 1) * limit;
  ok(res, { ...data, rows: data.rows.slice(start, start + limit) }, pageMeta(req.valid.query, data.rows.length));
};

export const exportCalendar: RequestHandler = async (req, res) => {
  const { month, format, department, leaveType, search } = req.valid.query;
  const data = await monthlySummary(month, { department, leaveType, search });
  await sendTable(res, {
    title: `Leave summary ${month}`,
    columns: [
      { key: 'employeeName', header: 'Employee Name' },
      { key: 'employeeId', header: 'Employee ID' },
      { key: 'department', header: 'Team' },
      { key: 'casual', header: 'Casual Leave' },
      { key: 'sick', header: 'Sick Leave' },
      { key: 'earned', header: 'Earned Leave' },
      { key: 'compOff', header: 'Comp-Off' },
      { key: 'other', header: 'Other Leave' },
      { key: 'total', header: 'Total Leave Days' },
    ],
    rows: data.rows as unknown as Record<string, unknown>[],
  }, format);
};

export const report: RequestHandler = async (req, res) => {
  const { page, limit, sort: _s, order: _o, ...filters } = req.valid.query;
  const table = await buildReport(req.valid.params.report, filters);
  const start = (page - 1) * limit;
  ok(res, { title: table.title, columns: table.columns, rows: table.rows.slice(start, start + limit) }, pageMeta(req.valid.query, table.rows.length));
};

export const exportReport: RequestHandler = async (req, res) => {
  const { report: name, format, ...filters } = req.valid.query;
  await sendTable(res, await buildReport(name, filters), format);
};

/** HR sees HR activity. Security and system events need the system-wide permission. */
export const auditLogs: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = {};
  if (!can(req.auth!, PERMISSIONS.AUDIT_READ_SYSTEM)) filter.category = 'HR';
  else if (q.category) filter.category = q.category;
  if (q.action) filter.action = q.action;
  if (q.entityType) filter.entityType = q.entityType;
  if (q.from || q.to) {
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = new Date(`${q.from}T00:00:00.000Z`);
    if (q.to) range.$lte = new Date(`${q.to}T23:59:59.999Z`);
    filter.createdAt = range;
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ summary: rx }, { actorEmail: rx }, { action: rx }];
  }
  const { skip, limit, sort } = pageOptions(q, ['createdAt', 'action'], 'createdAt');
  const [items, total] = await Promise.all([AuditLog.find(filter).sort(sort).skip(skip).limit(limit).lean(), AuditLog.countDocuments(filter)]);
  ok(res, items, pageMeta(q, total));
};
