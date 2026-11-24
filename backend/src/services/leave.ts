import { ClientSession, Types } from 'mongoose';
import { ACTIVE_LEAVE_STATUSES, ApproverType, LEAVE_STATUS, PERMISSIONS, ROLES } from '../constants';
import { AuthContext, can } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { ApprovalWorkflow, IApprovalWorkflow, ILeaveType, LeaveType } from '../models/LeaveConfig';
import { LeaveBalance } from '../models/LeaveLedger';
import { ApprovalStep, ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { StoredFile } from '../models/System';
import { IUser, User } from '../models/User';
import { diffDays } from '../utils/dates';
import { AppError, conflict, ErrorDetail, forbidden, notFound, unprocessable } from '../utils/errors';
import { isDuplicateKeyError, withTransaction } from '../utils/transaction';
import { audit, RequestContext } from './audit';
import { postLedger, syncEntitlement } from './balance';
import {
  Allocation, confirmReservedCompOff, consumeCompOff, getCompOffSummary, planCompOffAllocation, releaseCompOff, reserveCompOff, restoreCompOff,
} from './compoff';
import { employeeHolidays, HolidayInstance, nonOptional } from './holiday';
import { calculateLeaveDays, CalculationResult } from './leaveCalculation';
import { approverUsers, notifyUsers } from './notification';
import { balanceFloor, EffectiveRule, effectiveRule, ineligibleReason, resolvePolicy } from './policy';
import { companyToday, getSettings } from './settings';

export interface LeaveInput {
  leaveType: string;
  startDate: string;
  endDate: string;
  dayType: 'FULL' | 'HALF';
  halfSession?: 'FIRST' | 'SECOND' | null;
  reason?: string | null;
  handoverNotes?: string | null;
  document?: string | null;
}

interface Evaluation {
  employee: IEmployee;
  type: ILeaveType;
  rule: EffectiveRule;
  calc: CalculationResult;
  today: string;
  issues: ErrorDetail[];
  documentRequired: boolean;
  holidays: HolidayInstance[];
}

const MAX_SPAN_DAYS = 366;

async function recalculate(employee: IEmployee, input: Pick<LeaveInput, 'startDate' | 'endDate' | 'dayType' | 'halfSession'>) {
  const holidays = await employeeHolidays(employee, input.startDate, input.endDate);
  const calc = calculateLeaveDays({ ...input, holidays: nonOptional(holidays) });
  return { holidays, calc };
}

/** Every business rule that decides whether an application can go ahead. Preview and submit share it. */
export async function evaluateLeave(employeeId: Types.ObjectId, input: LeaveInput): Promise<Evaluation> {
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  const type = await LeaveType.findById(input.leaveType).lean<ILeaveType>();
  if (!type) throw notFound('Leave type');

  const issues: ErrorDetail[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (employee.employmentStatus === 'INACTIVE') add('employee', 'Your employee record is inactive');

  const today = await companyToday();
  const policy = await resolvePolicy(employee, input.startDate);
  const rule = effectiveRule(type, policy, employee);

  const ineligible = ineligibleReason(type, rule, employee);
  if (ineligible) add('leaveType', ineligible);
  if (input.startDate > input.endDate) add('endDate', 'The end date cannot be before the start date');
  if (diffDays(input.endDate, input.startDate) > MAX_SPAN_DAYS) add('endDate', 'A single application cannot span more than a year');

  const invalidRange = input.startDate > input.endDate || diffDays(input.endDate, input.startDate) > MAX_SPAN_DAYS;
  if (invalidRange) {
    return { employee, type, rule, calc: { totalDays: 0, dayBreakdown: [], excluded: [], byYear: [] }, today, issues, documentRequired: rule.requiresDocument, holidays: [] };
  }

  if (input.dayType === 'HALF') {
    if (!rule.halfDayAllowed) add('dayType', `${type.name} cannot be taken as a half day`);
    if (input.startDate !== input.endDate) add('endDate', 'A half-day leave must start and end on the same date');
    if (!input.halfSession) add('halfSession', 'Choose the first or second half');
  } else if (input.halfSession) {
    add('halfSession', 'A session only applies to half-day leave');
  }

  if (input.startDate < employee.joiningDate) add('startDate', 'Leave cannot start before your joining date');

  if (input.startDate < today) {
    if (!rule.allowPastDates) add('startDate', `${type.name} cannot be applied for past dates`);
    else if (diffDays(today, input.startDate) > rule.maxPastDays) add('startDate', `${type.name} can be back-dated by at most ${rule.maxPastDays} day(s)`);
  } else if (diffDays(input.startDate, today) < rule.minNoticeDays) {
    add('startDate', `${type.name} needs at least ${rule.minNoticeDays} day(s) of advance notice`);
  }

  const { holidays, calc } = await recalculate(employee, input);

  if (calc.totalDays <= 0) add('startDate', 'The selected dates contain no working days');
  else {
    if (calc.totalDays < rule.minDuration) add('endDate', `${type.name} needs a minimum of ${rule.minDuration} day(s)`);
    if (rule.maxDuration != null && calc.totalDays > rule.maxDuration) add('endDate', `${type.name} allows a maximum of ${rule.maxDuration} day(s)`);
  }

  if (type.kind === 'OPTIONAL_HOLIDAY') {
    const optional = new Set(holidays.filter((h) => h.category === 'OPTIONAL').map((h) => h.occurrenceDate));
    if (calc.dayBreakdown.some((d) => !optional.has(d.date))) add('startDate', 'This leave can only be taken on an optional holiday that applies to you');
  }

  const documentRequired = rule.requiresDocument || (rule.documentRequiredAfterDays != null && calc.totalDays > rule.documentRequiredAfterDays);
  return { employee, type, rule, calc, today, issues, documentRequired, holidays };
}

function buildSteps(workflow: IApprovalWorkflow | null, employee: IEmployee): ApprovalStep[] {
  const defined = [...(workflow?.steps ?? [])].sort((a, b) => a.order - b.order);
  // A reporting-manager step falls away when the employee has no manager.
  const usable = defined.filter((s) => s.approverType !== 'REPORTING_MANAGER' || employee.reportingManager);
  const steps = usable.length ? usable : [{ order: 1, approverType: 'HR_ADMIN' as ApproverType, label: 'HR approval' }];
  return steps.map((s, i) => ({
    order: i,
    approverType: s.approverType,
    label: s.label || s.approverType,
    status: 'WAITING',
    actedBy: null,
    actedByName: null,
    comment: null,
    actedAt: null,
  }));
}

async function resolveWorkflow(leaveType: Types.ObjectId): Promise<IApprovalWorkflow | null> {
  const specific = await ApprovalWorkflow.findOne({ isActive: true, leaveTypes: leaveType }).lean<IApprovalWorkflow>();
  return specific ?? ApprovalWorkflow.findOne({ isActive: true, isDefault: true }).lean<IApprovalWorkflow>();
}

function overlaps(existing: Pick<ILeaveRequest, 'dayType' | 'halfSession' | 'startDate'>, input: LeaveInput): boolean {
  // Two half days on one date only collide if they claim the same half.
  if (existing.dayType === 'HALF' && input.dayType === 'HALF' && existing.startDate === input.startDate) {
    return existing.halfSession === input.halfSession;
  }
  return true;
}

export async function findOverlap(employee: Types.ObjectId, input: LeaveInput, session?: ClientSession) {
  const candidates = await LeaveRequest.find({
    employee,
    status: { $in: ACTIVE_LEAVE_STATUSES },
    startDate: { $lte: input.endDate },
    endDate: { $gte: input.startDate },
  })
    .session(session ?? null)
    .lean<ILeaveRequest[]>();
  return candidates.find((c) => overlaps(c, input)) ?? null;
}

/** Counted by the month a request starts in. Rejected and cancelled requests free the slot again. */
async function monthlyLimitMessage(employee: Types.ObjectId, type: ILeaveType, startDate: string, session?: ClientSession): Promise<string | null> {
  const limit = type.maxRequestsPerMonth;
  if (!limit) return null;
  const month = startDate.slice(0, 7);
  const used = await LeaveRequest.countDocuments({
    employee,
    leaveType: type._id,
    status: { $in: ACTIVE_LEAVE_STATUSES },
    startDate: { $gte: `${month}-01`, $lte: `${month}-31` },
  }).session(session ?? null);
  if (used < limit) return null;
  return `${type.name} can be applied for ${limit === 1 ? 'once' : `${limit} times`} a month, and you have already used this for ${month}`;
}

async function checkAvailability(e: Evaluation): Promise<ErrorDetail | null> {
  if (e.type.kind === 'COMP_OFF') {
    const summary = await getCompOffSummary(e.employee._id, e.today);
    if (summary.available < e.calc.totalDays) return { path: 'leaveType', message: `Only ${summary.available} day(s) of Comp-Off are available` };
    try {
      await planCompOffAllocation(e.employee._id, e.calc.dayBreakdown, e.today);
    } catch (err) {
      if (err instanceof AppError) return { path: 'leaveType', message: err.message };
      throw err;
    }
    return null;
  }
  const floor = balanceFloor(e.rule);
  if (floor === null) return null;
  for (const { year, amount } of e.calc.byYear) {
    const row = await LeaveBalance.findOne({ employee: e.employee._id, leaveType: e.type._id, year }).select('available').lean();
    const available = row?.available ?? 0;
    if (available - amount < floor) return { path: 'leaveType', message: `Only ${available} day(s) of ${e.type.name} are available for ${year}` };
  }
  return null;
}

/** What the application form shows before submission, computed by the same code that enforces it. */
export async function previewLeave(employeeId: Types.ObjectId, input: LeaveInput) {
  const e = await evaluateLeave(employeeId, input);
  const issues = [...e.issues];
  if (e.rule.allowed && e.calc.totalDays > 0) {
    for (const { year } of e.calc.byYear) await syncEntitlement(e.employee, e.type, e.rule, year, e.today);
    const shortfall = await checkAvailability(e);
    if (shortfall) issues.push(shortfall);
    const overlap = await findOverlap(employeeId, input);
    if (overlap) issues.push({ path: 'startDate', message: `These dates overlap your request for ${overlap.startDate} to ${overlap.endDate}` });
    const monthly = await monthlyLimitMessage(employeeId, e.type, input.startDate);
    if (monthly) issues.push({ path: 'startDate', message: monthly });
  }
  return {
    totalDays: e.calc.totalDays,
    dayBreakdown: e.calc.dayBreakdown,
    excluded: e.calc.excluded,
    documentRequired: e.documentRequired,
    halfDayAllowed: e.rule.halfDayAllowed,
    issues,
  };
}

async function settleApproval(request: ILeaveRequest, e: { type: ILeaveType; rule: EffectiveRule; employee: IEmployee }, actorId: Types.ObjectId | null | undefined, today: string, session: ClientSession) {
  // Holidays may have changed while this was pending, so the cost is re-derived at decision time.
  const { calc } = await recalculate(e.employee, request);
  if (calc.totalDays <= 0) throw unprocessable('These dates no longer contain working days. Reject the request instead.', 'NO_ELIGIBLE_DAYS');

  const update: Partial<ILeaveRequest> = { totalDays: calc.totalDays, dayBreakdown: calc.dayBreakdown };
  const ref = { employee: request.employee, leaveRequest: request._id, performedBy: actorId };

  if (e.type.kind === 'COMP_OFF') {
    const unchanged = calc.totalDays === request.totalDays;
    if (request.compOffAllocationState === 'RESERVED' && unchanged) {
      await confirmReservedCompOff(request.compOffAllocations, ref, session);
      update.compOffAllocations = request.compOffAllocations;
    } else {
      if (request.compOffAllocationState === 'RESERVED') await releaseCompOff(request.compOffAllocations, ref, session);
      const plan = await planCompOffAllocation(request.employee, calc.dayBreakdown, today, session);
      await consumeCompOff(plan, ref, session);
      update.compOffAllocations = plan;
    }
    update.compOffAllocationState = 'CONSUMED';
  } else {
    for (const r of request.reservations) {
      await postLedger({
        employee: request.employee, leaveType: request.leaveType, year: r.year, type: 'RELEASE', amount: r.amount,
        reason: 'Reservation released on approval', leaveRequest: request._id, performedBy: actorId,
        idempotencyKey: `leave:${request._id}:release:${r.year}`,
      }, session);
    }
    const floor = balanceFloor(e.rule);
    for (const d of calc.byYear) {
      await postLedger({
        employee: request.employee, leaveType: request.leaveType, year: d.year, type: 'DEBIT', amount: -d.amount,
        reason: `Approved leave ${request.startDate} to ${request.endDate}`, leaveRequest: request._id, performedBy: actorId,
        idempotencyKey: `leave:${request._id}:debit:${d.year}`, floor,
      }, session);
    }
    update.reservations = [];
    update.deductions = calc.byYear;
  }
  return update;
}

/**
 * A Super Admin with nobody above them has no one to approve their leave, so it is approved automatically.
 * Giving them a reporting manager puts their leave back through approval.
 */
async function isTopOfHierarchy(employee: IEmployee): Promise<boolean> {
  if (employee.reportingManager || !employee.user) return false;
  const user = await User.findById(employee.user).select('role').lean<IUser>();
  return user?.role === ROLES.SUPER_ADMIN;
}

export async function applyLeave(ctx: RequestContext, employeeId: Types.ObjectId, input: LeaveInput, idempotencyKey?: string) {
  if (idempotencyKey) {
    const replay = await LeaveRequest.findOne({ employee: employeeId, idempotencyKey }).lean<ILeaveRequest>();
    if (replay) return { request: replay, replayed: true };
  }

  const e = await evaluateLeave(employeeId, input);
  const topOfHierarchy = await isTopOfHierarchy(e.employee);
  const issues = [...e.issues];
  // An approver needs a reason to decide on. Leave approved automatically has no approver.
  if (e.rule.requiresApproval && !topOfHierarchy && !input.reason) issues.push({ path: 'reason', message: 'A reason is required' });
  if (e.documentRequired && !input.document) issues.push({ path: 'document', message: `A supporting document is required for this ${e.type.name} request` });
  if (input.document) {
    const file = await StoredFile.exists({ _id: input.document, owner: ctx.auth?.userId, purpose: { $nin: ['AVATAR', 'PERSONAL'] } });
    if (!file) issues.push({ path: 'document', message: 'The supporting document was not found' });
  }
  if (issues.length) throw new AppError(422, 'LEAVE_RULE_VIOLATION', issues[0].message, issues);

  for (const { year } of e.calc.byYear) await syncEntitlement(e.employee, e.type, e.rule, year, e.today);

  const shortfall = await checkAvailability(e);
  if (shortfall) throw new AppError(422, 'INSUFFICIENT_BALANCE', shortfall.message, [shortfall]);

  const settings = await getSettings();
  const steps = buildSteps(await resolveWorkflow(e.type._id), e.employee);
  const autoApprove = !e.rule.requiresApproval || topOfHierarchy;

  try {
    const request = await withTransaction(async (session) => {
      // Writing to the employee makes concurrent submissions conflict and retry one at a time,
      // so the overlap check below is always made against committed requests.
      await Employee.updateOne({ _id: employeeId }, { $inc: { leaveLock: 1 } }, { session });

      const overlap = await findOverlap(employeeId, input, session);
      if (overlap) throw conflict(`These dates overlap your request for ${overlap.startDate} to ${overlap.endDate}`, 'OVERLAPPING_REQUEST');

      const monthly = await monthlyLimitMessage(employeeId, e.type, input.startDate, session);
      if (monthly) throw unprocessable(monthly, 'MONTHLY_LIMIT_REACHED');

      const requestId = new Types.ObjectId();
      const reserve = settings.reserveBalanceOnPending && !autoApprove;
      const doc: Partial<ILeaveRequest> = {
        _id: requestId,
        employee: employeeId,
        leaveType: e.type._id,
        startDate: input.startDate,
        endDate: input.endDate,
        dayType: input.dayType,
        halfSession: input.dayType === 'HALF' ? input.halfSession ?? null : null,
        reason: input.reason || null,
        handoverNotes: input.handoverNotes ?? null,
        document: input.document ? new Types.ObjectId(input.document) : null,
        totalDays: e.calc.totalDays,
        dayBreakdown: e.calc.dayBreakdown,
        status: LEAVE_STATUS.PENDING,
        approvalSteps: steps,
        currentStep: 0,
        currentApproverType: steps[0].approverType,
        reservations: [],
        deductions: [],
        compOffAllocations: [],
        compOffAllocationState: 'NONE',
        idempotencyKey: idempotencyKey ?? null,
      };

      if (reserve && e.type.kind === 'COMP_OFF') {
        const plan = await planCompOffAllocation(employeeId, e.calc.dayBreakdown, e.today, session);
        await reserveCompOff(plan, { employee: employeeId, leaveRequest: requestId, performedBy: ctx.auth?.userId }, session);
        doc.compOffAllocations = plan;
        doc.compOffAllocationState = 'RESERVED';
      } else if (reserve && balanceFloor(e.rule) !== null) {
        const floor = balanceFloor(e.rule);
        for (const d of e.calc.byYear) {
          await postLedger({
            employee: employeeId, leaveType: e.type._id, year: d.year, type: 'RESERVE', amount: -d.amount,
            reason: `Held for pending leave ${input.startDate} to ${input.endDate}`, leaveRequest: requestId, performedBy: ctx.auth?.userId,
            idempotencyKey: `leave:${requestId}:reserve:${d.year}`, floor,
          }, session);
        }
        doc.reservations = e.calc.byYear;
      }

      if (autoApprove) {
        const settled = await settleApproval(doc as ILeaveRequest, e, null, e.today, session);
        Object.assign(doc, settled, { status: LEAVE_STATUS.APPROVED, currentApproverType: null, decidedAt: new Date(), approvalSteps: [] });
      }

      const [created] = await LeaveRequest.create([doc], { session });

      const when = input.startDate === input.endDate ? input.startDate : `${input.startDate} to ${input.endDate}`;
      await notifyUsers([e.employee.user], {
        type: autoApprove ? 'LEAVE_APPROVED' : 'LEAVE_SUBMITTED',
        title: autoApprove ? 'Leave approved' : 'Leave request submitted',
        message: `${e.type.name} for ${when} (${e.calc.totalDays} day(s)) ${autoApprove ? 'was approved automatically' : 'is awaiting approval'}.`,
        link: `/leaves/${requestId}`,
      }, session);
      if (!autoApprove) {
        await notifyUsers(await approverUsers(steps[0].approverType, e.employee), {
          type: 'APPROVAL_REQUIRED',
          title: 'New leave request',
          message: `${e.employee.fullName} applied for ${e.type.name}: ${when} (${e.calc.totalDays} day(s)).`,
          link: `/approvals?request=${requestId}`,
          action: { kind: 'LEAVE', id: requestId },
        }, session);
      }
      await audit(ctx, {
        action: autoApprove ? 'LEAVE_AUTO_APPROVED' : 'LEAVE_APPLIED',
        entityType: 'LeaveRequest',
        entityId: requestId,
        summary: `${e.employee.fullName}: ${e.type.code} ${when} (${e.calc.totalDays}d)`,
      }, session);
      return created.toObject() as ILeaveRequest;
    });
    return { request, replayed: false };
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const replay = await LeaveRequest.findOne({ employee: employeeId, idempotencyKey }).lean<ILeaveRequest>();
      if (replay) return { request: replay, replayed: true };
    }
    throw err;
  }
}

/** Whether this person may act on the request's current step. Nobody may decide their own leave. */
export async function assertCanDecide(auth: AuthContext, request: Pick<ILeaveRequest, 'employee' | 'currentApproverType' | 'status'>) {
  if (auth.employeeId && String(request.employee) === String(auth.employeeId)) {
    throw forbidden('You cannot decide your own leave request', 'SELF_APPROVAL');
  }
  if (can(auth, PERMISSIONS.LEAVE_APPROVE)) {
    if (request.currentApproverType === 'SUPER_ADMIN' && auth.role !== 'SUPER_ADMIN') throw forbidden('This step needs a Super Admin');
    return;
  }
  if (request.currentApproverType === 'REPORTING_MANAGER' && auth.employeeId) {
    const reports = await Employee.exists({ _id: request.employee, reportingManager: auth.employeeId });
    if (reports) return;
  }
  throw forbidden();
}

async function actorName(auth?: AuthContext): Promise<string> {
  if (!auth?.employeeId) return auth?.email ?? 'System';
  const me = await Employee.findById(auth.employeeId).select('fullName').lean<IEmployee>();
  return me?.fullName ?? auth.email;
}

async function loadRuleContext(request: Pick<ILeaveRequest, 'employee' | 'leaveType' | 'startDate'>) {
  const [employee, type] = await Promise.all([
    Employee.findById(request.employee).lean<IEmployee>(),
    LeaveType.findById(request.leaveType).lean<ILeaveType>(),
  ]);
  if (!employee || !type) throw notFound('Leave request data');
  const rule = effectiveRule(type, await resolvePolicy(employee, request.startDate), employee);
  return { employee, type, rule };
}

export async function approveLeave(ctx: RequestContext, id: string, comment?: string) {
  const auth = ctx.auth!;
  const name = await actorName(auth);
  const today = await companyToday();

  return withTransaction(async (session) => {
    const request = await LeaveRequest.findById(id).session(session).lean<ILeaveRequest>();
    if (!request) throw notFound('Leave request');
    if (request.status !== LEAVE_STATUS.PENDING) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
    await assertCanDecide(auth, request);

    const stepIndex = request.currentStep;
    const stepPath = `approvalSteps.${stepIndex}`;
    const stepUpdate = {
      [`${stepPath}.status`]: 'APPROVED',
      [`${stepPath}.actedBy`]: auth.userId,
      [`${stepPath}.actedByName`]: name,
      [`${stepPath}.comment`]: comment ?? null,
      [`${stepPath}.actedAt`]: new Date(),
    };
    // The status and step guard, plus a write conflict on this document, is what makes the
    // second of two simultaneous approvals fail rather than deduct twice.
    const guard = { _id: id, status: LEAVE_STATUS.PENDING, currentStep: stepIndex };
    const ctxData = await loadRuleContext(request);
    const nextStep = request.approvalSteps[stepIndex + 1];

    if (nextStep) {
      const updated = await LeaveRequest.findOneAndUpdate(
        guard,
        { $set: { ...stepUpdate, currentStep: stepIndex + 1, currentApproverType: nextStep.approverType } },
        { session, returnDocument: 'after' },
      ).lean<ILeaveRequest>();
      if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
      await notifyUsers(await approverUsers(nextStep.approverType, ctxData.employee), {
        type: 'APPROVAL_REQUIRED',
        title: 'Leave request needs your approval',
        message: `${ctxData.employee.fullName}'s ${ctxData.type.name} request passed ${request.approvalSteps[stepIndex].label}.`,
        link: `/approvals?request=${id}`,
        action: { kind: 'LEAVE', id: new Types.ObjectId(id) },
      }, session);
      await audit(ctx, { action: 'LEAVE_STEP_APPROVED', entityType: 'LeaveRequest', entityId: id, summary: `Step ${stepIndex + 1} approved by ${name}` }, session);
      return updated;
    }

    const settled = await settleApproval(request, ctxData, auth.userId, today, session);
    const updated = await LeaveRequest.findOneAndUpdate(
      guard,
      { $set: { ...stepUpdate, ...settled, status: LEAVE_STATUS.APPROVED, currentApproverType: null, decidedBy: auth.userId, decidedAt: new Date() } },
      { session, returnDocument: 'after' },
    ).lean<ILeaveRequest>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');

    await notifyUsers([ctxData.employee.user], {
      type: 'LEAVE_APPROVED',
      title: 'Leave approved',
      message: `Your ${ctxData.type.name} from ${updated.startDate} to ${updated.endDate} (${updated.totalDays} day(s)) was approved.${comment ? ` Comment: ${comment}` : ''}`,
      link: `/leaves/${id}`,
    }, session);
    await audit(ctx, {
      action: 'LEAVE_APPROVED',
      entityType: 'LeaveRequest',
      entityId: id,
      summary: `Approved ${ctxData.type.code} for ${ctxData.employee.fullName}: ${updated.startDate} to ${updated.endDate} (${updated.totalDays}d)`,
      before: { status: LEAVE_STATUS.PENDING },
      after: { status: LEAVE_STATUS.APPROVED, totalDays: updated.totalDays },
    }, session);
    return updated;
  });
}

/** Gives back whatever the request holds, whether reserved while pending or deducted after approval. */
async function returnHeldBalance(request: ILeaveRequest, reason: string, actorId: Types.ObjectId | null | undefined, session: ClientSession) {
  const ref = { employee: request.employee, leaveRequest: request._id, performedBy: actorId };
  if (request.compOffAllocationState === 'RESERVED') {
    await releaseCompOff(request.compOffAllocations as Allocation[], ref, session);
  } else if (request.compOffAllocationState === 'CONSUMED') {
    await restoreCompOff(request.compOffAllocations as Allocation[], ref, session);
  }
  for (const r of request.reservations) {
    await postLedger({
      employee: request.employee, leaveType: request.leaveType, year: r.year, type: 'RELEASE', amount: r.amount,
      reason, leaveRequest: request._id, performedBy: actorId, idempotencyKey: `leave:${request._id}:release:${r.year}`,
    }, session);
  }
  for (const d of request.deductions) {
    await postLedger({
      employee: request.employee, leaveType: request.leaveType, year: d.year, type: 'RESTORE', amount: d.amount,
      reason, leaveRequest: request._id, performedBy: actorId, idempotencyKey: `leave:${request._id}:restore:${d.year}`,
    }, session);
  }
}

const clearedHolds = { reservations: [], deductions: [], compOffAllocationState: 'NONE' as const };

export async function rejectLeave(ctx: RequestContext, id: string, reason: string) {
  const auth = ctx.auth!;
  const name = await actorName(auth);
  return withTransaction(async (session) => {
    const request = await LeaveRequest.findById(id).session(session).lean<ILeaveRequest>();
    if (!request) throw notFound('Leave request');
    if (request.status !== LEAVE_STATUS.PENDING) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
    await assertCanDecide(auth, request);

    const stepPath = `approvalSteps.${request.currentStep}`;
    const updated = await LeaveRequest.findOneAndUpdate(
      { _id: id, status: LEAVE_STATUS.PENDING, currentStep: request.currentStep },
      {
        $set: {
          ...clearedHolds,
          status: LEAVE_STATUS.REJECTED,
          rejectionReason: reason,
          currentApproverType: null,
          decidedBy: auth.userId,
          decidedAt: new Date(),
          [`${stepPath}.status`]: 'REJECTED',
          [`${stepPath}.actedBy`]: auth.userId,
          [`${stepPath}.actedByName`]: name,
          [`${stepPath}.comment`]: reason,
          [`${stepPath}.actedAt`]: new Date(),
        },
      },
      { session, returnDocument: 'after' },
    ).lean<ILeaveRequest>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');

    await returnHeldBalance(request, 'Leave rejected', auth.userId, session);
    const { employee, type } = await loadRuleContext(request);
    await notifyUsers([employee.user], {
      type: 'LEAVE_REJECTED',
      title: 'Leave rejected',
      message: `Your ${type.name} from ${request.startDate} to ${request.endDate} was rejected. Reason: ${reason}`,
      link: `/leaves/${id}`,
    }, session);
    await audit(ctx, { action: 'LEAVE_REJECTED', entityType: 'LeaveRequest', entityId: id, summary: `Rejected ${type.code} for ${employee.fullName}: ${reason}`, before: { status: LEAVE_STATUS.PENDING }, after: { status: LEAVE_STATUS.REJECTED } }, session);
    return updated;
  });
}

/** Employees may withdraw their own pending request. Admins may cancel any live request except their own approved one. */
export async function cancelLeave(ctx: RequestContext, id: string, reason?: string) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const request = await LeaveRequest.findById(id).session(session).lean<ILeaveRequest>();
    if (!request) throw notFound('Leave request');
    const isOwner = auth.employeeId && String(request.employee) === String(auth.employeeId);
    const isAdmin = can(auth, PERMISSIONS.LEAVE_APPROVE);
    if (!isOwner && !isAdmin) throw notFound('Leave request');
    if (!ACTIVE_LEAVE_STATUSES.includes(request.status)) throw conflict('This request can no longer be cancelled', 'NOT_CANCELLABLE');
    if (isOwner && request.status !== LEAVE_STATUS.PENDING) {
      throw forbidden('Approved leave must go through a cancellation request', 'CANCELLATION_REQUEST_REQUIRED');
    }
    return finishCancellation(ctx, request, reason ?? (isOwner ? 'Withdrawn by employee' : 'Cancelled by admin'), 'LEAVE_CANCELLED', session);
  });
}

async function finishCancellation(ctx: RequestContext, request: ILeaveRequest, reason: string, type: 'LEAVE_CANCELLED' | 'CANCELLATION_APPROVED', session: ClientSession) {
  const updated = await LeaveRequest.findOneAndUpdate(
    { _id: request._id, status: request.status },
    {
      $set: {
        ...clearedHolds,
        status: LEAVE_STATUS.CANCELLED,
        cancelledAt: new Date(),
        currentApproverType: null,
        cancellationReason: request.cancellationReason ?? reason,
        cancellationDecidedBy: ctx.auth?.userId ?? null,
      },
    },
    { session, returnDocument: 'after' },
  ).lean<ILeaveRequest>();
  if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');

  await returnHeldBalance(request, reason, ctx.auth?.userId, session);
  const { employee, type: leaveType } = await loadRuleContext(request);
  await notifyUsers([employee.user], {
    type,
    title: type === 'CANCELLATION_APPROVED' ? 'Cancellation approved' : 'Leave cancelled',
    message: `Your ${leaveType.name} from ${request.startDate} to ${request.endDate} was cancelled and the balance restored.`,
    link: `/leaves/${request._id}`,
  }, session);
  await audit(ctx, {
    action: type,
    entityType: 'LeaveRequest',
    entityId: request._id,
    summary: `Cancelled ${leaveType.code} for ${employee.fullName}: ${reason}`,
    before: { status: request.status },
    after: { status: LEAVE_STATUS.CANCELLED },
  }, session);
  return updated;
}

export async function requestCancellation(ctx: RequestContext, id: string, reason: string) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const request = await LeaveRequest.findById(id).session(session).lean<ILeaveRequest>();
    if (!request || String(request.employee) !== String(auth.employeeId)) throw notFound('Leave request');
    const updated = await LeaveRequest.findOneAndUpdate(
      { _id: id, status: LEAVE_STATUS.APPROVED },
      { $set: { status: LEAVE_STATUS.CANCELLATION_REQUESTED, cancellationReason: reason, cancellationRequestedAt: new Date() } },
      { session, returnDocument: 'after' },
    ).lean<ILeaveRequest>();
    if (!updated) throw conflict('Only approved leave can have a cancellation request', 'NOT_APPROVED');

    const { employee, type } = await loadRuleContext(request);
    await notifyUsers(await approverUsers('HR_ADMIN', employee), {
      type: 'CANCELLATION_REQUESTED',
      title: 'Cancellation requested',
      message: `${employee.fullName} asked to cancel ${type.name} from ${request.startDate} to ${request.endDate}. Reason: ${reason}`,
      link: `/approvals?request=${id}`,
    }, session);
    await audit(ctx, { action: 'CANCELLATION_REQUESTED', entityType: 'LeaveRequest', entityId: id, summary: `${employee.fullName}: ${reason}` }, session);
    return updated;
  });
}

export async function decideCancellation(ctx: RequestContext, id: string, approve: boolean, comment?: string) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const request = await LeaveRequest.findById(id).session(session).lean<ILeaveRequest>();
    if (!request) throw notFound('Leave request');
    if (String(request.employee) === String(auth.employeeId)) throw forbidden('You cannot decide your own cancellation', 'SELF_APPROVAL');
    if (request.status !== LEAVE_STATUS.CANCELLATION_REQUESTED) throw conflict('There is no open cancellation request', 'ALREADY_PROCESSED');

    if (approve) {
      const done = await finishCancellation(ctx, request, comment ?? 'Cancellation approved', 'CANCELLATION_APPROVED', session);
      await LeaveRequest.updateOne({ _id: id }, { $set: { cancellationDecisionComment: comment ?? null } }, { session });
      return done;
    }

    const updated = await LeaveRequest.findOneAndUpdate(
      { _id: id, status: LEAVE_STATUS.CANCELLATION_REQUESTED },
      { $set: { status: LEAVE_STATUS.APPROVED, cancellationDecisionComment: comment ?? null, cancellationDecidedBy: auth.userId } },
      { session, returnDocument: 'after' },
    ).lean<ILeaveRequest>();
    if (!updated) throw conflict('There is no open cancellation request', 'ALREADY_PROCESSED');
    const { employee, type } = await loadRuleContext(request);
    await notifyUsers([employee.user], {
      type: 'CANCELLATION_REJECTED',
      title: 'Cancellation declined',
      message: `Your request to cancel ${type.name} from ${request.startDate} to ${request.endDate} was declined.${comment ? ` Reason: ${comment}` : ''}`,
      link: `/leaves/${id}`,
    }, session);
    await audit(ctx, { action: 'CANCELLATION_REJECTED', entityType: 'LeaveRequest', entityId: id, summary: `Declined for ${employee.fullName}${comment ? `: ${comment}` : ''}` }, session);
    return updated;
  });
}

/** Withdraws open requests when someone leaves, so their reservations do not linger. */
export async function cancelOpenRequestsFor(ctx: RequestContext, employeeId: Types.ObjectId) {
  const open = await LeaveRequest.find({ employee: employeeId, status: LEAVE_STATUS.PENDING }).select('_id').lean<ILeaveRequest[]>();
  for (const { _id } of open) {
    await withTransaction(async (session) => {
      const request = await LeaveRequest.findById(_id).session(session).lean<ILeaveRequest>();
      if (request?.status === LEAVE_STATUS.PENDING) await finishCancellation(ctx, request, 'Employee deactivated', 'LEAVE_CANCELLED', session);
    });
  }
  return open.length;
}
