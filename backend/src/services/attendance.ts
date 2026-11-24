import { ClientSession, Types } from 'mongoose';
import { CONFIRMED_LEAVE_STATUSES, ACTIVE_LEAVE_STATUSES, PERMISSIONS } from '../constants';
import { AuthContext, can } from '../middleware/auth';
import { AttendanceCorrection, AttendanceRecord, IAttendanceCorrection, IAttendanceRecord, IWfhRequest, WfhRequest } from '../models/Attendance';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { addDays, diffDays, eachDay, isWeekend, monthRange, todayIn } from '../utils/dates';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { ApprovalView, approvalStatusFilter, escapeRegex, queueSort } from '../utils/http';
import { isDuplicateKeyError, withTransaction } from '../utils/transaction';
import { audit, RequestContext } from './audit';
import { employeeHolidays, holidayAppliesTo, holidayOccurrences, nonOptional } from './holiday';
import { calculateLeaveDays } from './leaveCalculation';
import { adminsWithPermission, approverUsers, notifyUsers } from './notification';
import { getSettings } from './settings';

export type AttendanceStatus = 'PRESENT' | 'WFH' | 'ON_LEAVE' | 'HALF_LEAVE' | 'HOLIDAY' | 'WEEKEND' | 'ABSENT' | 'UPCOMING' | 'NOT_EMPLOYED' | 'NOT_TRACKED';

const MAX_WFH_SPAN_DAYS = 31;
const MAX_WFH_PAST_DAYS = 30;

const timeIn = (timeZone: string, now: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);

const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export const workedMinutes = (record: Pick<IAttendanceRecord, 'punchIn' | 'punchOut'> | null | undefined) =>
  (record?.punchOut ? toMinutes(record.punchOut) - toMinutes(record.punchIn) : null);

/**
 * Attendance is worked out from punches, approved leave, approved work from home and holidays rather than stored,
 * so cancelling any of them corrects the affected days by itself.
 */
export function dayStatus(d: { date: string; today: string; joiningDate: string; trackingFrom?: string | null; hasPunch: boolean; leaveValue: number; wfh: boolean; fullHoliday: boolean }): AttendanceStatus {
  if (d.hasPunch) {
    if (d.leaveValue > 0 && d.leaveValue < 1) return 'HALF_LEAVE';
    return d.wfh ? 'WFH' : 'PRESENT';
  }
  if (d.date < d.joiningDate) return 'NOT_EMPLOYED';
  if (d.leaveValue >= 1) return 'ON_LEAVE';
  if (d.leaveValue > 0) return 'HALF_LEAVE';
  if (d.fullHoliday) return 'HOLIDAY';
  if (isWeekend(d.date)) return 'WEEKEND';
  if (d.wfh) return 'WFH';
  if (d.date >= d.today) return 'UPCOMING';
  return d.trackingFrom && d.date < d.trackingFrom ? 'NOT_TRACKED' : 'ABSENT';
}

const overlapping = (start: string, end: string) => ({ startDate: { $lte: end }, endDate: { $gte: start } });

interface Sources {
  records: Map<string, IAttendanceRecord>;
  leaveValue: Map<string, number>;
  wfh: Pick<IWfhRequest, 'startDate' | 'endDate'>[];
}

const emptySources = (): Sources => ({ records: new Map(), leaveValue: new Map(), wfh: [] });

/** Everything for a date range, grouped by employee so that large months stay quick. */
async function loadSources(employees: Types.ObjectId[], start: string, end: string): Promise<Map<string, Sources>> {
  const employee = { $in: employees };
  const [records, leaves, wfh] = await Promise.all([
    AttendanceRecord.find({ employee, date: { $gte: start, $lte: end } }).lean<IAttendanceRecord[]>(),
    LeaveRequest.find({ employee, status: { $in: CONFIRMED_LEAVE_STATUSES }, ...overlapping(start, end) }).select('employee dayBreakdown').lean<ILeaveRequest[]>(),
    WfhRequest.find({ employee, status: 'APPROVED', ...overlapping(start, end) }).select('employee startDate endDate').lean<IWfhRequest[]>(),
  ]);
  const grouped = new Map<string, Sources>(employees.map((id) => [String(id), emptySources()]));
  for (const r of records) grouped.get(String(r.employee))!.records.set(r.date, r);
  for (const l of leaves) {
    const mine = grouped.get(String(l.employee))!;
    for (const b of l.dayBreakdown) mine.leaveValue.set(b.date, (mine.leaveValue.get(b.date) ?? 0) + b.value);
  }
  for (const w of wfh) grouped.get(String(w.employee))!.wfh.push(w);
  return grouped;
}

function buildDay(employee: Pick<IEmployee, 'joiningDate'>, date: string, today: string, trackingFrom: string | null, sources: Sources, holiday: { name: string; isHalfDay: boolean } | undefined) {
  const record = sources.records.get(date) ?? null;
  const wfh = sources.wfh.some((w) => w.startDate <= date && w.endDate >= date);
  const status = dayStatus({ date, today, joiningDate: employee.joiningDate, trackingFrom, hasPunch: Boolean(record), leaveValue: sources.leaveValue.get(date) ?? 0, wfh, fullHoliday: Boolean(holiday && !holiday.isHalfDay) });
  return {
    date,
    status,
    holiday: holiday?.name ?? null,
    punchIn: record?.punchIn ?? null,
    punchOut: record?.punchOut ?? null,
    workedMinutes: workedMinutes(record),
    corrected: record?.source === 'HR_CORRECTION',
    correctionNote: record?.correctionNote ?? null,
  };
}

export type Day = ReturnType<typeof buildDay>;

/**
 * Totals for a run of days. Work from home counts as attendance: `attended` is days worked in the office plus
 * days worked from home, out of `workingDays` (the days someone was expected to work and the day has passed).
 */
function summarize(days: Day[], today: string) {
  const count = (...statuses: AttendanceStatus[]) => days.filter((d) => statuses.includes(d.status)).length;
  const present = count('PRESENT');
  // Approved work from home shows on future days too, but only counts once the day has come.
  const workFromHome = days.filter((d) => d.status === 'WFH' && d.date <= today).length;
  const onLeave = count('ON_LEAVE') + count('HALF_LEAVE');
  const absent = count('ABSENT');
  return { present, workFromHome, attended: present + workFromHome, onLeave, absent, workingDays: present + workFromHome + onLeave + absent };
}

type DepartmentNamed = Omit<IEmployee, 'department'> & { department: { _id: Types.ObjectId; name: string } | null };

/** One month for many people. Holidays are worked out per person, as they can depend on location and department. */
export async function monthForEmployees(query: Record<string, unknown>, month: string) {
  const { start, end } = monthRange(month);
  return rangeForEmployees(query, start, end);
}

export async function rangeForEmployees(query: Record<string, unknown>, start: string, end: string) {
  const employees = await Employee.find(query).sort({ fullName: 1 }).populate('department', 'name').lean<DepartmentNamed[]>();
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const [sources, occurrences] = await Promise.all([loadSources(employees.map((e) => e._id), start, end), holidayOccurrences(start, end)]);
  const dates = eachDay(start, end);
  return {
    today,
    rows: employees.map((e) => {
      const scope = { ...e, department: e.department?._id ?? null };
      const holidays = nonOptional(occurrences.filter((h) => holidayAppliesTo(h, scope)));
      const days = dates.map((date) => buildDay(e, date, today, settings.attendanceStartDate, sources.get(String(e._id))!, holidays.find((h) => h.date === date)));
      return { employee: e, days, summary: summarize(days, today) };
    }),
  };
}

export interface Period { start: string; end: string }

/** A from/to range when given, otherwise the month, otherwise the current month in the company's timezone. */
export async function resolvePeriod(q: { month?: string; from?: string; to?: string }): Promise<Period> {
  if (q.from && q.to) return { start: q.from, end: q.to };
  return monthRange(q.month ?? todayIn((await getSettings()).timezone).slice(0, 7));
}

export const employeeMonth = (employeeId: Types.ObjectId | string, month: string) => employeeRange(employeeId, monthRange(month));

/** One person's days over any period, with totals. `month` is the period's first month, kept for older clients. */
export async function employeeRange(employeeId: Types.ObjectId | string, { start, end }: Period) {
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const [sources, holidays] = await Promise.all([loadSources([employee._id], start, end), employeeHolidays(employee, start, end)]);
  const applicable = nonOptional(holidays);
  const days = eachDay(start, end).map((date) => buildDay(employee, date, today, settings.attendanceStartDate, sources.get(String(employee._id))!, applicable.find((h) => h.date === date)));
  return { today, month: start.slice(0, 7), from: start, to: end, employee: { _id: employee._id, fullName: employee.fullName, employeeId: employee.employeeId }, days, summary: summarize(days, today) };
}

/** Today's state for the punch button, whatever month is being viewed. */
export async function todayAttendance(employeeId: Types.ObjectId) {
  const settings = await getSettings();
  const now = new Date();
  const today = todayIn(settings.timezone, now);
  const record = await AttendanceRecord.findOne({ employee: employeeId, date: today }).lean<IAttendanceRecord>();
  return { date: today, punchIn: record?.punchIn ?? null, punchOut: record?.punchOut ?? null, workedMinutes: workedMinutes(record) };
}

/** The time always comes from the server, so nobody can record a punch for a time of their choosing. */
export async function punchIn(ctx: RequestContext) {
  const employeeId = ctx.auth!.employeeId!;
  const settings = await getSettings();
  const now = new Date();
  try {
    await AttendanceRecord.create({ employee: employeeId, date: todayIn(settings.timezone, now), punchIn: timeIn(settings.timezone, now), source: 'WEB', ip: ctx.ip ?? null });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('You have already punched in today', 'ALREADY_PUNCHED_IN');
    throw err;
  }
  return todayAttendance(employeeId);
}

export async function punchOut(ctx: RequestContext) {
  const employeeId = ctx.auth!.employeeId!;
  const settings = await getSettings();
  const now = new Date();
  const date = todayIn(settings.timezone, now);
  const updated = await AttendanceRecord.findOneAndUpdate({ employee: employeeId, date, punchOut: null }, { punchOut: timeIn(settings.timezone, now) });
  if (!updated) {
    if (await AttendanceRecord.exists({ employee: employeeId, date })) throw conflict('You have already punched out today', 'ALREADY_PUNCHED_OUT');
    throw unprocessable('Punch in before punching out', 'NOT_PUNCHED_IN');
  }
  return todayAttendance(employeeId);
}

export interface DailyFilters { date: string; department?: string; search?: string; manager?: Types.ObjectId }

export async function dailyAttendance(f: DailyFilters) {
  const query: Record<string, unknown> = { employmentStatus: { $ne: 'INACTIVE' }, joiningDate: { $lte: f.date } };
  if (f.department) query.department = f.department;
  if (f.manager) query.reportingManager = f.manager;
  if (f.search) {
    const rx = new RegExp(escapeRegex(f.search), 'i');
    query.$or = [{ fullName: rx }, { employeeId: rx }];
  }
  const employees = await Employee.find(query).sort({ fullName: 1 }).populate('department', 'name').lean<DepartmentNamed[]>();
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const [sources, occurrences] = await Promise.all([loadSources(employees.map((e) => e._id), f.date, f.date), holidayOccurrences(f.date, f.date)]);
  const rows = employees.map((e) => {
    const scope = { ...e, department: e.department?._id ?? null };
    const holiday = nonOptional(occurrences.filter((h) => holidayAppliesTo(h, scope)))[0];
    return {
      employee: { _id: e._id, fullName: e.fullName, employeeId: e.employeeId, department: e.department?.name ?? null, avatarFile: e.avatarFile ?? null },
      ...buildDay(e, f.date, today, settings.attendanceStartDate, sources.get(String(e._id))!, holiday),
    };
  });
  return { date: f.date, today, summary: { ...summarize(rows, today), notPunched: rows.filter((r) => r.status === 'UPCOMING').length }, rows };
}

/** The checks shared by HR's corrections and employees' requests, so both follow the same rules. */
async function assertCorrectable(employee: IEmployee, date: string, punchIn: string, punchOut?: string | null) {
  const settings = await getSettings();
  if (date > todayIn(settings.timezone)) throw unprocessable('Attendance cannot be recorded for a future date', 'FUTURE_DATE');
  if (date < employee.joiningDate) throw unprocessable('This date is before the employee joined', 'BEFORE_JOINING');
  if (punchOut && punchOut <= punchIn) throw unprocessable('Punch out must be after punch in', 'INVALID_TIMES');
}

async function writeCorrection(ctx: RequestContext, employee: IEmployee, date: string, input: { punchIn: string; punchOut?: string | null; note: string }, session: ClientSession) {
  const before = await AttendanceRecord.findOne({ employee: employee._id, date }).session(session).lean<IAttendanceRecord>();
  const updated = await AttendanceRecord.findOneAndUpdate(
    { employee: employee._id, date },
    { $set: { punchIn: input.punchIn, punchOut: input.punchOut ?? null, source: 'HR_CORRECTION', correctedBy: ctx.auth?.userId, correctionNote: input.note } },
    { upsert: true, returnDocument: 'after', session },
  ).lean<IAttendanceRecord>();
  await audit(ctx, {
    action: 'ATTENDANCE_CORRECTED',
    entityType: 'AttendanceRecord',
    entityId: updated!._id,
    summary: `${employee.fullName} on ${date}: ${input.note}`,
    before: before ? { punchIn: before.punchIn, punchOut: before.punchOut } : null,
    after: { punchIn: input.punchIn, punchOut: input.punchOut ?? null },
  }, session);
  return updated;
}

export async function correctAttendance(ctx: RequestContext, employeeId: string, date: string, input: { punchIn: string; punchOut?: string | null; note: string }) {
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  if (String(employee._id) === String(ctx.auth?.employeeId)) throw forbidden('Ask another administrator to correct your own attendance', 'SELF_CORRECTION');
  await assertCorrectable(employee, date, input.punchIn, input.punchOut);

  return withTransaction(async (session) => {
    const updated = await writeCorrection(ctx, employee, date, input, session);
    await notifyUsers([employee.user], {
      type: 'ATTENDANCE_CORRECTED',
      title: 'Attendance corrected',
      message: `HR updated your attendance for ${date}. Reason: ${input.note}`,
      link: '/attendance',
    }, session);
    return updated;
  });
}

/* Correction requests from employees */

async function correctionApprovers(employee: IEmployee): Promise<Types.ObjectId[]> {
  const [manager, hr] = await Promise.all([approverUsers('REPORTING_MANAGER', employee), adminsWithPermission(PERMISSIONS.ATTENDANCE_MANAGE)]);
  return [...manager, ...hr].filter((id) => String(id) !== String(employee.user));
}

export async function requestCorrection(ctx: RequestContext, input: { date: string; punchIn: string; punchOut?: string | null; reason: string }) {
  const employee = await Employee.findById(ctx.auth!.employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  await assertCorrectable(employee, input.date, input.punchIn, input.punchOut);
  const approvers = await correctionApprovers(employee);
  try {
    return await withTransaction(async (session) => {
      const [created] = await AttendanceCorrection.create([{ employee: employee._id, date: input.date, punchIn: input.punchIn, punchOut: input.punchOut ?? null, reason: input.reason }], { session });
      await notifyUsers(approvers, {
        type: 'ATTENDANCE_CORRECTION_REQUESTED',
        title: 'Attendance correction requested',
        message: `${employee.fullName} asked to correct ${input.date}: ${input.punchIn} to ${input.punchOut ?? 'not recorded'}. Reason: ${input.reason}`,
        link: '/approvals',
        action: { kind: 'CORRECTION', id: created._id },
      }, session);
      await audit(ctx, { action: 'ATTENDANCE_CORRECTION_REQUESTED', entityType: 'AttendanceCorrection', entityId: created._id, summary: `${employee.fullName}: ${input.date}` }, session);
      return created.toObject() as IAttendanceCorrection;
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('You already have a request waiting for this date', 'DUPLICATE_CORRECTION');
    throw err;
  }
}

const canManageAttendance = (auth: AuthContext) => can(auth, PERMISSIONS.ATTENDANCE_MANAGE);

export async function pendingCorrections(auth: AuthContext, view?: ApprovalView) {
  const query: Record<string, unknown> = approvalStatusFilter(view);
  if (canManageAttendance(auth)) {
    if (auth.employeeId) query.employee = { $ne: auth.employeeId };
  } else {
    if (!auth.employeeId) return [];
    query.employee = { $in: (await Employee.find({ reportingManager: auth.employeeId }).select('_id').lean<IEmployee[]>()).map((e) => e._id) };
  }
  return AttendanceCorrection.find(query).sort(queueSort(view)).limit(200)
    .populate({ path: 'employee', select: 'fullName employeeId department avatarFile', populate: { path: 'department', select: 'name' } })
    .lean();
}

async function decideCorrection(ctx: RequestContext, id: string, approved: boolean, reason: string | null) {
  const auth = ctx.auth!;
  const request = await AttendanceCorrection.findById(id).lean<IAttendanceCorrection>();
  if (!request) throw notFound('Request');
  const employee = await Employee.findById(request.employee).lean<IEmployee>();
  if (!employee) throw notFound('Request');
  if (String(employee._id) === String(auth.employeeId)) throw forbidden('You cannot decide your own request', 'SELF_APPROVAL');
  const manages = auth.employeeId && String(employee.reportingManager) === String(auth.employeeId);
  if (!canManageAttendance(auth) && !manages) throw notFound('Request');
  const actor = auth.employeeId ? await Employee.findById(auth.employeeId).select('fullName').lean<IEmployee>() : null;

  return withTransaction(async (session) => {
    const updated = await AttendanceCorrection.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      { $set: { status: approved ? 'APPROVED' : 'REJECTED', decidedBy: auth.userId, decidedByName: actor?.fullName ?? 'Administrator', decidedAt: new Date(), rejectionReason: reason } },
      { session, returnDocument: 'after' },
    ).lean<IAttendanceCorrection>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
    if (approved) await writeCorrection(ctx, employee, request.date, { punchIn: request.punchIn, punchOut: request.punchOut, note: request.reason }, session);
    else await audit(ctx, { action: 'ATTENDANCE_CORRECTION_REJECTED', entityType: 'AttendanceCorrection', entityId: id, summary: `${employee.fullName} on ${request.date}: ${reason}` }, session);
    await notifyUsers([employee.user], {
      type: 'ATTENDANCE_CORRECTED',
      title: approved ? 'Attendance correction approved' : 'Attendance correction rejected',
      message: approved ? `Your attendance for ${request.date} was updated.` : `Your correction for ${request.date} was rejected. Reason: ${reason}`,
      link: '/attendance',
    }, session);
    return updated;
  });
}

export const approveCorrection = (ctx: RequestContext, id: string) => decideCorrection(ctx, id, true, null);
export const rejectCorrection = (ctx: RequestContext, id: string, reason: string) => decideCorrection(ctx, id, false, reason);

export const myCorrections = (employee: Types.ObjectId) => AttendanceCorrection.find({ employee }).sort({ createdAt: -1 }).limit(50).lean();

export async function cancelCorrection(ctx: RequestContext, id: string) {
  const updated = await AttendanceCorrection.findOneAndUpdate({ _id: id, employee: ctx.auth!.employeeId, status: 'PENDING' }, { status: 'CANCELLED' }, { returnDocument: 'after' }).lean();
  if (!updated) throw notFound('Request');
  return updated;
}

/* Managers. Only direct reports, and only to read. */

export async function teamMonth(auth: AuthContext, employeeId: string, period: Period) {
  if (!auth.employeeId || !(await Employee.exists({ _id: employeeId, reportingManager: auth.employeeId }))) throw notFound('Employee');
  return employeeRange(employeeId, period);
}

/* Work from home */

async function wfhApprovers(employee: IEmployee): Promise<Types.ObjectId[]> {
  const [manager, hr] = await Promise.all([approverUsers('REPORTING_MANAGER', employee), approverUsers('HR_ADMIN', employee)]);
  return [...manager, ...hr];
}

export async function applyWfh(ctx: RequestContext, input: { startDate: string; endDate: string; reason: string }) {
  const employeeId = ctx.auth!.employeeId!;
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  const { startDate, endDate } = input;
  if (startDate > endDate) throw unprocessable('The end date cannot be before the start date', 'INVALID_DATES');
  if (diffDays(endDate, startDate) >= MAX_WFH_SPAN_DAYS) throw unprocessable(`A request can cover at most ${MAX_WFH_SPAN_DAYS} days`, 'WFH_TOO_LONG');
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  if (startDate < addDays(today, -MAX_WFH_PAST_DAYS)) throw unprocessable(`You can only apply up to ${MAX_WFH_PAST_DAYS} days back`, 'WFH_TOO_OLD');
  if (startDate < employee.joiningDate) throw unprocessable('These dates are before your joining date', 'BEFORE_JOINING');

  // The server counts the days, using the same weekend and holiday rules as leave.
  const holidays = nonOptional(await employeeHolidays(employee, startDate, endDate));
  const { totalDays } = calculateLeaveDays({ startDate, endDate, dayType: 'FULL', holidays });
  if (totalDays <= 0) throw unprocessable('The selected dates contain no working days', 'NO_WORKING_DAYS');
  const approvers = await wfhApprovers(employee);

  return withTransaction(async (session) => {
    // Writing to the employee makes concurrent submissions conflict and retry, as leave applications do.
    await Employee.updateOne({ _id: employeeId }, { $inc: { leaveLock: 1 } }, { session });
    const clash = await WfhRequest.findOne({ employee: employeeId, status: { $in: ['PENDING', 'APPROVED'] }, ...overlapping(startDate, endDate) }).session(session).lean<IWfhRequest>();
    if (clash) throw conflict(`These dates overlap your work from home request for ${clash.startDate} to ${clash.endDate}`, 'OVERLAPPING_REQUEST');
    // A half-day leave can sit alongside work from home on the rest of that day.
    const leave = await LeaveRequest.findOne({ employee: employeeId, status: { $in: ACTIVE_LEAVE_STATUSES }, dayType: 'FULL', ...overlapping(startDate, endDate) }).session(session).lean<ILeaveRequest>();
    if (leave) throw conflict(`These dates overlap your leave for ${leave.startDate} to ${leave.endDate}`, 'OVERLAPPING_LEAVE');

    const [created] = await WfhRequest.create([{ employee: employeeId, startDate, endDate, totalDays, reason: input.reason }], { session });
    const when = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    await notifyUsers(approvers, {
      type: 'WFH_REQUESTED',
      title: 'New work from home request',
      message: `${employee.fullName} asked to work from home: ${when} (${totalDays} day(s)).`,
      link: '/approvals',
      action: { kind: 'WFH', id: created._id },
    }, session);
    await audit(ctx, { action: 'WFH_APPLIED', entityType: 'WfhRequest', entityId: created._id, summary: `${employee.fullName}: ${when} (${totalDays}d)` }, session);
    return created.toObject() as IWfhRequest;
  });
}

const canDecideAny = (auth: AuthContext) => can(auth, PERMISSIONS.LEAVE_APPROVE);

/** Managers see their own reports and leave approvers see everyone. Nobody sees their own request here. */
export async function pendingWfh(auth: AuthContext, view?: ApprovalView) {
  const query: Record<string, unknown> = approvalStatusFilter(view);
  const reports = canDecideAny(auth) || !auth.employeeId ? null : await Employee.find({ reportingManager: auth.employeeId }).select('_id').lean<IEmployee[]>();
  if (reports) query.employee = { $in: reports.map((e) => e._id) };
  else if (auth.employeeId) query.employee = { $ne: auth.employeeId };
  return WfhRequest.find(query).sort(queueSort(view)).limit(200)
    .populate({ path: 'employee', select: 'fullName employeeId department avatarFile', populate: { path: 'department', select: 'name' } })
    .lean();
}

async function decidable(auth: AuthContext, id: string): Promise<{ request: IWfhRequest; employee: IEmployee }> {
  const request = await WfhRequest.findById(id).lean<IWfhRequest>();
  if (!request) throw notFound('Request');
  const employee = await Employee.findById(request.employee).lean<IEmployee>();
  if (!employee) throw notFound('Request');
  if (String(employee._id) === String(auth.employeeId)) throw forbidden('You cannot decide your own request', 'SELF_APPROVAL');
  const manages = auth.employeeId && String(employee.reportingManager) === String(auth.employeeId);
  if (!canDecideAny(auth) && !manages) throw notFound('Request');
  return { request, employee };
}

async function decide(ctx: RequestContext, id: string, approved: boolean, reason: string | null) {
  const auth = ctx.auth!;
  const { request, employee } = await decidable(auth, id);
  const actor = auth.employeeId ? await Employee.findById(auth.employeeId).select('fullName').lean<IEmployee>() : null;
  return withTransaction(async (session) => {
    const updated = await WfhRequest.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      { $set: { status: approved ? 'APPROVED' : 'REJECTED', decidedBy: auth.userId, decidedByName: actor?.fullName ?? 'Administrator', decidedAt: new Date(), rejectionReason: reason } },
      { session, returnDocument: 'after' },
    ).lean<IWfhRequest>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
    const when = `${request.startDate} to ${request.endDate}`;
    await notifyUsers([employee.user], {
      type: approved ? 'WFH_APPROVED' : 'WFH_REJECTED',
      title: approved ? 'Work from home approved' : 'Work from home rejected',
      message: approved ? `Your work from home for ${when} was approved. Your attendance will show these days as work from home.` : `Your work from home for ${when} was rejected. Reason: ${reason}`,
      link: '/attendance',
    }, session);
    await audit(ctx, { action: approved ? 'WFH_APPROVED' : 'WFH_REJECTED', entityType: 'WfhRequest', entityId: id, summary: `${employee.fullName}: ${when}${reason ? ` (${reason})` : ''}` }, session);
    return updated;
  });
}

export const approveWfh = (ctx: RequestContext, id: string) => decide(ctx, id, true, null);
export const rejectWfh = (ctx: RequestContext, id: string, reason: string) => decide(ctx, id, false, reason);

/** Owners can withdraw until the dates have passed, and approvers can cancel on their behalf. Past days stay on record. */
export async function cancelWfh(ctx: RequestContext, id: string) {
  const auth = ctx.auth!;
  const request = await WfhRequest.findById(id).lean<IWfhRequest>();
  if (!request) throw notFound('Request');
  const isOwner = String(request.employee) === String(auth.employeeId);
  if (!isOwner && !canDecideAny(auth)) throw notFound('Request');
  const settings = await getSettings();
  if (request.status === 'APPROVED' && request.endDate < todayIn(settings.timezone)) throw conflict('These dates have already passed', 'WFH_IN_PAST');
  const employee = await Employee.findById(request.employee).lean<IEmployee>();
  return withTransaction(async (session) => {
    const updated = await WfhRequest.findOneAndUpdate({ _id: id, status: { $in: ['PENDING', 'APPROVED'] } }, { status: 'CANCELLED' }, { session, returnDocument: 'after' }).lean<IWfhRequest>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
    if (!isOwner) {
      await notifyUsers([employee?.user], {
        type: 'WFH_CANCELLED',
        title: 'Work from home cancelled',
        message: `Your work from home for ${request.startDate} to ${request.endDate} was cancelled by an administrator.`,
        link: '/attendance',
      }, session);
    }
    await audit(ctx, { action: 'WFH_CANCELLED', entityType: 'WfhRequest', entityId: id, summary: `${employee?.fullName}: ${request.startDate} to ${request.endDate}` }, session);
    return updated;
  });
}

