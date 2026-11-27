import { RequestHandler } from 'express';
import { ExpenseClaim } from '../models/People';
import { IStoredFile, StoredFile } from '../models/System';
import { Employee, IEmployee } from '../models/Employee';
import * as attendance from '../services/attendance';
import { ctxOf, audit } from '../services/audit';
import * as emailAction from '../services/emailAction';
import { readBytes, removeStoredFile, storeUpload } from '../services/file';
import { hrInsights, teamCalendar } from '../services/insights';
import * as people from '../services/people';
import { getSettings } from '../services/settings';
import { todayIn } from '../utils/dates';
import { badRequest, notFound } from '../utils/errors';
import { created, ok, pageMeta, pageOptions } from '../utils/http';
import { sendTable } from './holiday.controller';

const currentMonth = async () => todayIn((await getSettings()).timezone).slice(0, 7);

/* Attendance corrections, export, team */
export const requestCorrection: RequestHandler = async (req, res) => created(res, await attendance.requestCorrection(ctxOf(req), req.valid.body));
export const myCorrections: RequestHandler = async (req, res) => ok(res, await attendance.myCorrections(req.auth!.employeeId!));
export const pendingCorrections: RequestHandler = async (req, res) => ok(res, await attendance.pendingCorrections(req.auth!, req.valid.query.view));
export const approveCorrection: RequestHandler = async (req, res) => ok(res, await attendance.approveCorrection(ctxOf(req), req.valid.params.id));
export const rejectCorrection: RequestHandler = async (req, res) => ok(res, await attendance.rejectCorrection(ctxOf(req), req.valid.params.id, req.valid.body.reason));
export const cancelCorrection: RequestHandler = async (req, res) => ok(res, await attendance.cancelCorrection(ctxOf(req), req.valid.params.id));

const DAY_CODE: Record<attendance.AttendanceStatus, string> = { PRESENT: 'P', WFH: 'WFH', ON_LEAVE: 'L', HALF_LEAVE: 'HL', HOLIDAY: 'H', WEEKEND: 'W', ABSENT: 'A', UPCOMING: '', NOT_EMPLOYED: '', NOT_TRACKED: '' };

export const exportAttendance: RequestHandler = async (req, res) => {
  const { department, format } = req.valid.query;
  const { start, end } = await attendance.resolvePeriod(req.valid.query);
  const query: Record<string, unknown> = { employmentStatus: { $ne: 'INACTIVE' } };
  if (department) query.department = department;
  const { rows } = await attendance.rangeForEmployees(query, start, end);
  const dates = rows[0]?.days.map((d) => d.date) ?? [];
  // A single month keeps its short "2026-11" label; any other period is named by its dates.
  const label = req.valid.query.month ?? `${start} to ${end}`;
  // Day columns show the day of the month, plus the month when the period crosses one.
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  await audit(ctxOf(req), { action: 'ATTENDANCE_EXPORTED', entityType: 'Attendance', summary: label });
  await sendTable(res, {
    title: `Attendance ${label}`,
    columns: [
      { key: 'employeeId', header: 'Employee ID' },
      { key: 'employeeName', header: 'Employee Name' },
      { key: 'department', header: 'Team' },
      { key: 'attended', header: 'Total Attendance' },
      { key: 'present', header: 'Present' },
      { key: 'wfh', header: 'Work From Home' },
      { key: 'leave', header: 'On Leave' },
      { key: 'absent', header: 'Absent' },
      ...dates.map((d) => ({ key: d, header: sameMonth ? d.slice(8) : `${d.slice(8)}/${d.slice(5, 7)}` })),
    ],
    rows: rows.map((r) => ({
      employeeId: r.employee.employeeId,
      employeeName: r.employee.fullName,
      department: r.employee.department?.name ?? '',
      attended: r.summary.attended,
      present: r.summary.present,
      wfh: r.summary.workFromHome,
      leave: r.summary.onLeave,
      absent: r.summary.absent,
      ...Object.fromEntries(r.days.map((d) => [d.date, DAY_CODE[d.status]])),
    })),
  }, format);
};

export const teamDaily: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const date = q.date ?? todayIn((await getSettings()).timezone);
  const result = await attendance.dailyAttendance({ date, search: q.search, status: q.status, manager: req.auth!.employeeId! });
  const { skip, limit } = pageOptions(q, [], 'date');
  ok(res, { ...result, rows: result.rows.slice(skip, skip + limit) }, pageMeta(q, result.rows.length));
};
export const teamMonth: RequestHandler = async (req, res) => {
  ok(res, await attendance.teamMonth(req.auth!, req.valid.params.employeeId, await attendance.resolvePeriod(req.valid.query)));
};

/* Insights and team calendar */
export const insights: RequestHandler = async (_req, res) => ok(res, await hrInsights());
export const calendar: RequestHandler = async (req, res) => {
  const { start, end, scope, department } = req.valid.query;
  ok(res, await teamCalendar(req.auth!, start, end, { scope, department }));
};

/* Decisions from email. Public, because the token is the proof, and rate limited. */
export const emailPreview: RequestHandler = async (req, res) => ok(res, await emailAction.previewEmailAction(req.valid.body.token));
export const emailDecide: RequestHandler = async (req, res) => ok(res, await emailAction.decideEmailAction(ctxOf(req), req.valid.body.token, req.valid.body.decision, req.valid.body.reason));

/* Colleagues' profile photos */
export const employeeAvatar: RequestHandler = async (req, res) => {
  const employee = await Employee.findById(req.valid.params.id).select('avatarFile').lean<IEmployee>();
  const file = employee?.avatarFile ? await StoredFile.findById(employee.avatarFile).lean<IStoredFile>() : null;
  if (!file) throw notFound('Profile photo');
  const bytes = await readBytes(file);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(bytes);
};

/* Self-service */
export const myDetails: RequestHandler = async (req, res) => ok(res, await people.detailsFor(req.auth!.employeeId!));
export const saveMyDetails: RequestHandler = async (req, res) => ok(res, await people.saveOwnDetails(ctxOf(req), req.valid.body));
export const employeeDetails: RequestHandler = async (req, res) => {
  await audit(ctxOf(req), { action: 'EMPLOYEE_DETAILS_VIEWED', category: 'SECURITY', entityType: 'Employee', entityId: req.valid.params.id });
  ok(res, { ...(await people.detailsFor(req.valid.params.id)), documents: await people.personalDocuments(req.valid.params.id) });
};
export const revealBank: RequestHandler = async (req, res) => ok(res, await people.revealBankAccount(ctxOf(req), req.valid.params.id));

export const myDocuments: RequestHandler = async (req, res) => ok(res, await people.personalDocuments(req.auth!.employeeId!));
export const uploadMyDocument: RequestHandler = async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  created(res, await storeUpload(req.auth!, req.file, 'PERSONAL'));
};
export const deleteMyDocument: RequestHandler = async (req, res) => {
  const file = await StoredFile.findOne({ _id: req.valid.params.id, ownerEmployee: req.auth!.employeeId, purpose: 'PERSONAL' }).lean<IStoredFile>();
  if (!file) throw notFound('File');
  await removeStoredFile(file);
  ok(res, { deleted: true });
};

/* Checklists */
export const myChecklists: RequestHandler = async (req, res) => ok(res, await people.checklistsFor(req.auth!.employeeId!));
export const setMyItem: RequestHandler = async (req, res) => {
  ok(res, await people.setChecklistItem(ctxOf(req), { employee: req.auth!.employeeId!, asEmployee: true }, req.valid.params.id, req.valid.params.itemId, req.valid.body.done));
};
export const employeeChecklists: RequestHandler = async (req, res) => ok(res, await people.checklistsFor(req.valid.params.id));
export const startChecklist: RequestHandler = async (req, res) => created(res, await people.startChecklist(ctxOf(req), req.valid.params.id, req.valid.body.kind));
export const addItem: RequestHandler = async (req, res) => ok(res, await people.addChecklistItem(ctxOf(req), req.valid.params.id, req.valid.params.checklistId, req.valid.body));
export const setItem: RequestHandler = async (req, res) => {
  ok(res, await people.setChecklistItem(ctxOf(req), { employee: req.valid.params.id, asEmployee: false }, req.valid.params.checklistId, req.valid.params.itemId, req.valid.body.done));
};

/* Payroll */
const payrollColumns = [
  { key: 'employeeId', header: 'Employee ID' }, { key: 'employeeName', header: 'Employee Name' }, { key: 'department', header: 'Team' },
  { key: 'employedDays', header: 'Days Employed' }, { key: 'attended', header: 'Total Attendance' }, { key: 'present', header: 'Present' }, { key: 'workFromHome', header: 'Work From Home' },
  { key: 'paidLeave', header: 'Paid Leave' }, { key: 'unpaidLeave', header: 'Unpaid Leave' }, { key: 'holidays', header: 'Holidays' }, { key: 'weekends', header: 'Weekends' },
  { key: 'absent', header: 'Absent' }, { key: 'lossOfPayDays', header: 'Loss Of Pay Days' }, { key: 'payableDays', header: 'Payable Days' },
];
export const payroll: RequestHandler = async (req, res) => {
  const { month, department, search } = req.valid.query;
  ok(res, await people.payrollMonth({ month: month ?? await currentMonth(), department, search }));
};
export const exportPayroll: RequestHandler = async (req, res) => {
  const { month, department, format } = req.valid.query;
  const data = await people.payrollMonth({ month, department });
  await audit(ctxOf(req), { action: 'PAYROLL_EXPORTED', category: 'SECURITY', entityType: 'Payroll', summary: month });
  await sendTable(res, { title: `Payroll ${month}`, columns: payrollColumns, rows: data.rows as unknown as Record<string, unknown>[] }, format);
};

/* Expenses */
export const submitExpense: RequestHandler = async (req, res) => created(res, await people.submitExpense(ctxOf(req), req.valid.body));
export const myExpenses: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter = { employee: req.auth!.employeeId };
  const { skip, limit } = pageOptions(q, [], 'createdAt');
  const [items, total] = await Promise.all([ExpenseClaim.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('receipt', 'originalName').lean(), ExpenseClaim.countDocuments(filter)]);
  ok(res, items, pageMeta(q, total));
};
export const pendingExpenses: RequestHandler = async (req, res) => ok(res, await people.pendingExpenses(req.auth!, req.valid.query.view));
export const allExpenses: RequestHandler = async (req, res) => ok(res, await people.allExpenses(req.valid.query.status));
export const approveExpense: RequestHandler = async (req, res) => ok(res, await people.approveExpense(ctxOf(req), req.valid.params.id));
export const rejectExpense: RequestHandler = async (req, res) => ok(res, await people.rejectExpense(ctxOf(req), req.valid.params.id, req.valid.body.reason));
export const payExpense: RequestHandler = async (req, res) => ok(res, await people.payExpense(ctxOf(req), req.valid.params.id));
export const cancelExpense: RequestHandler = async (req, res) => ok(res, await people.cancelExpense(ctxOf(req), req.valid.params.id));

/* Announcements */
export const listAnnouncements: RequestHandler = async (req, res) => ok(res, await people.listAnnouncements(req.auth!));
export const publishAnnouncement: RequestHandler = async (req, res) => created(res, await people.publishAnnouncement(ctxOf(req), req.valid.body));
export const acknowledge: RequestHandler = async (req, res) => {
  await people.acknowledgeAnnouncement(req.auth!, req.valid.params.id);
  ok(res, { acknowledged: true });
};
export const readers: RequestHandler = async (req, res) => ok(res, await people.announcementReaders(req.valid.params.id));
export const deleteAnnouncement: RequestHandler = async (req, res) => {
  await people.deleteAnnouncement(ctxOf(req), req.valid.params.id);
  ok(res, { deleted: true });
};

