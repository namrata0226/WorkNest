import { Request, RequestHandler } from 'express';
import { Types } from 'mongoose';
import { PERMISSIONS, LEAVE_STATUS } from '../constants';
import { can } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { ctxOf } from '../services/audit';
import { getEmployeeBalances } from '../services/balance';
import * as leave from '../services/leave';
import { effectiveRule, ineligibleReason, resolvePolicy } from '../services/policy';
import { companyToday } from '../services/settings';
import { yearOf } from '../utils/dates';
import { badRequest, notFound } from '../utils/errors';
import { created, escapeRegex, ok, pageMeta, pageOptions } from '../utils/http';

const SORTABLE = ['startDate', 'endDate', 'createdAt', 'status', 'totalDays'];

function idempotencyKeyOf(req: Request): string | undefined {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return undefined;
  if (!/^[\w-]{8,100}$/.test(key)) throw badRequest('Idempotency-Key must be 8 to 100 letters, digits, hyphens or underscores');
  return key;
}

function dateFilter(q: { from?: string; to?: string }) {
  const filter: Record<string, unknown> = {};
  if (q.from) filter.endDate = { $gte: q.from };
  if (q.to) filter.startDate = { $lte: q.to };
  return filter;
}

const withRefs = <T>(query: T): T =>
  (query as any)
    .populate('leaveType', 'name code color kind')
    .populate({ path: 'employee', select: 'employeeId fullName department designation avatarFile', populate: { path: 'department', select: 'name' } })
    .populate('document', 'originalName mimeType size');

export const preview: RequestHandler = async (req, res) => {
  ok(res, await leave.previewLeave(req.auth!.employeeId!, req.valid.body));
};

export const apply: RequestHandler = async (req, res) => {
  const result = await leave.applyLeave(ctxOf(req), req.auth!.employeeId!, req.valid.body, idempotencyKeyOf(req));
  if (result.replayed) return ok(res, result.request, { replayed: true });
  created(res, result.request);
};

export const listMine: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = { employee: req.auth!.employeeId, ...dateFilter(q) };
  if (q.status) filter.status = q.status;
  if (q.leaveType) filter.leaveType = q.leaveType;
  const { skip, limit, sort } = pageOptions(q, SORTABLE, 'createdAt');
  const [items, total] = await Promise.all([
    withRefs(LeaveRequest.find(filter).sort(sort).skip(skip).limit(limit)).lean(),
    LeaveRequest.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q, total));
};

export const listAll: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = { ...dateFilter(q) };
  if (q.status) filter.status = q.status;
  if (q.leaveType) filter.leaveType = q.leaveType;
  if (q.employee) filter.employee = q.employee;
  if (q.department || q.search) {
    const empQuery: Record<string, unknown> = {};
    if (q.department) empQuery.department = q.department;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      empQuery.$or = [{ fullName: rx }, { employeeId: rx }];
    }
    const ids = (await Employee.find(empQuery).select('_id').lean<IEmployee[]>()).map((e) => e._id);
    filter.employee = q.employee ? { $in: ids.filter((id) => String(id) === q.employee) } : { $in: ids };
  }
  const { skip, limit, sort } = pageOptions(q, SORTABLE, 'createdAt');
  const [items, total] = await Promise.all([
    withRefs(LeaveRequest.find(filter).sort(sort).skip(skip).limit(limit)).lean(),
    LeaveRequest.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q, total));
};

/** Readable by its owner, leave admins and the employee's manager. Anyone else gets a 404. */
export const getOne: RequestHandler = async (req, res) => {
  const auth = req.auth!;
  const raw = await LeaveRequest.findById(req.valid.params.id).lean<ILeaveRequest>();
  if (!raw) throw notFound('Leave request');
  const isOwner = String(raw.employee) === String(auth.employeeId);
  const isAdmin = can(auth, PERMISSIONS.LEAVE_READ_ALL);
  const isManager = !isOwner && !isAdmin && auth.employeeId
    ? Boolean(await Employee.exists({ _id: raw.employee, reportingManager: auth.employeeId }))
    : false;
  if (!isOwner && !isAdmin && !isManager) throw notFound('Leave request');

  const request = await withRefs(LeaveRequest.findById(raw._id)).lean();
  const employee = await Employee.findById(raw.employee).lean<IEmployee>();
  const today = await companyToday();
  const balances = employee ? await getEmployeeBalances(employee, yearOf(raw.startDate), today) : [];
  const balance = balances.find((b) => String(b.leaveType._id) === String(raw.leaveType)) ?? null;
  ok(res, { ...request, balance });
};

export const cancel: RequestHandler = async (req, res) => {
  ok(res, await leave.cancelLeave(ctxOf(req), req.valid.params.id, req.valid.body.reason));
};

export const requestCancellation: RequestHandler = async (req, res) => {
  ok(res, await leave.requestCancellation(ctxOf(req), req.valid.params.id, req.valid.body.reason));
};

/** Admins see everything awaiting a decision; managers see their reports' current manager steps. */
export const pendingApprovals: RequestHandler = async (req, res) => {
  const auth = req.auth!;
  const q = req.valid.query;
  const filter: Record<string, unknown> = {};

  if (can(auth, PERMISSIONS.LEAVE_APPROVE)) {
    filter.status = { $in: [LEAVE_STATUS.PENDING, LEAVE_STATUS.CANCELLATION_REQUESTED] };
    if (auth.role !== 'SUPER_ADMIN') {
      filter.$or = [{ status: LEAVE_STATUS.CANCELLATION_REQUESTED }, { currentApproverType: { $ne: 'SUPER_ADMIN' } }];
    }
    if (auth.employeeId) filter.employee = { $ne: auth.employeeId };
  } else {
    if (!auth.employeeId) return ok(res, [], pageMeta(q, 0));
    const reports = await Employee.find({ reportingManager: auth.employeeId }).select('_id').lean<IEmployee[]>();
    filter.status = LEAVE_STATUS.PENDING;
    filter.currentApproverType = 'REPORTING_MANAGER';
    filter.employee = { $in: reports.map((r) => r._id) };
  }

  const { skip, limit, sort } = pageOptions({ ...q, order: q.sort ? q.order : 'asc' }, SORTABLE, 'createdAt');
  const [items, total] = await Promise.all([
    withRefs(LeaveRequest.find(filter).sort(sort).skip(skip).limit(limit)).lean(),
    LeaveRequest.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q, total));
};

export const approve: RequestHandler = async (req, res) => {
  ok(res, await leave.approveLeave(ctxOf(req), req.valid.params.id, req.valid.body.comment));
};

export const reject: RequestHandler = async (req, res) => {
  ok(res, await leave.rejectLeave(ctxOf(req), req.valid.params.id, req.valid.body.reason));
};

export const approveCancellation: RequestHandler = async (req, res) => {
  ok(res, await leave.decideCancellation(ctxOf(req), req.valid.params.id, true, req.valid.body.comment));
};

export const rejectCancellation: RequestHandler = async (req, res) => {
  ok(res, await leave.decideCancellation(ctxOf(req), req.valid.params.id, false, req.valid.body.reason));
};

/** Every active leave type with the rules the form needs. Types this employee cannot take carry the reason, and applying is still refused. */
export const availableTypes: RequestHandler = async (req, res) => {
  const employee = await Employee.findById(req.auth!.employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  const today = await companyToday();
  const [types, policy] = await Promise.all([LeaveType.find({ isActive: true }).sort({ name: 1 }).lean<ILeaveType[]>(), resolvePolicy(employee, today)]);
  const out = types
    .map((t) => ({ type: t, rule: effectiveRule(t, policy, employee) }))
    .map(({ type, rule }) => ({
      _id: type._id as Types.ObjectId,
      name: type.name,
      code: type.code,
      kind: type.kind,
      color: type.color,
      description: type.description,
      isPaid: rule.isPaid,
      halfDayAllowed: rule.halfDayAllowed,
      requiresDocument: rule.requiresDocument,
      documentRequiredAfterDays: rule.documentRequiredAfterDays,
      minNoticeDays: rule.minNoticeDays,
      allowPastDates: rule.allowPastDates,
      maxDuration: rule.maxDuration,
      requiresApproval: rule.requiresApproval,
      maxRequestsPerMonth: type.maxRequestsPerMonth,
      ineligibleReason: ineligibleReason(type, rule, employee),
    }));
  ok(res, out);
};
