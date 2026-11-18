import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { permissionsFor } from '../constants';
import { AuthContext } from '../middleware/auth';
import { AttendanceCorrection, IAttendanceCorrection, IWfhRequest, WfhRequest } from '../models/Attendance';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { EmailActionToken, ExpenseClaim, IEmailActionToken, IExpenseClaim } from '../models/People';
import { IUser, User } from '../models/User';
import { AppError } from '../utils/errors';
import { approveCorrection, approveWfh, rejectCorrection, rejectWfh } from './attendance';
import { audit, RequestContext } from './audit';
import { approveLeave, rejectLeave } from './leave';
import { approveExpense, rejectExpense } from './people';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
// The same answer for every failure, so a guessed token learns nothing.
const invalid = () => new AppError(410, 'LINK_INVALID', 'This link has expired or has already been used. Open WorkNest to review the request.');

async function usable(token: string): Promise<{ doc: IEmailActionToken; user: IUser }> {
  const doc = await EmailActionToken.findOne({ tokenHash: hash(token), usedAt: null, expiresAt: { $gt: new Date() } }).lean<IEmailActionToken>();
  if (!doc) throw invalid();
  const user = await User.findById(doc.user).lean<IUser>();
  if (!user?.isActive || user.mustChangePassword) throw invalid();
  return { doc, user };
}

/** What the person is deciding. Only requested by the page after it opens, so opening or scanning a link changes nothing. */
export async function previewEmailAction(token: string) {
  const { doc } = await usable(token);
  const describe = async (employeeId: Types.ObjectId, lines: { label: string; value: string }[], title: string, status: string, decidable: string[]) => {
    const employee = await Employee.findById(employeeId).select('fullName').lean<IEmployee>();
    return { title, employee: employee?.fullName ?? 'Employee', lines, decidable: decidable.includes(status) };
  };
  if (doc.kind === 'LEAVE') {
    const r = await LeaveRequest.findById(doc.target).lean<ILeaveRequest>();
    if (!r) throw invalid();
    const type = await LeaveType.findById(r.leaveType).select('name').lean<ILeaveType>();
    return describe(r.employee, [{ label: 'Leave type', value: type?.name ?? '' }, { label: 'Dates', value: `${r.startDate} to ${r.endDate}` }, { label: 'Days', value: String(r.totalDays) }, { label: 'Reason', value: r.reason ?? '—' }], 'Leave request', r.status, ['PENDING']);
  }
  if (doc.kind === 'WFH') {
    const r = await WfhRequest.findById(doc.target).lean<IWfhRequest>();
    if (!r) throw invalid();
    return describe(r.employee, [{ label: 'Dates', value: `${r.startDate} to ${r.endDate}` }, { label: 'Days', value: String(r.totalDays) }, { label: 'Reason', value: r.reason }], 'Work from home request', r.status, ['PENDING']);
  }
  if (doc.kind === 'CORRECTION') {
    const r = await AttendanceCorrection.findById(doc.target).lean<IAttendanceCorrection>();
    if (!r) throw invalid();
    return describe(r.employee, [{ label: 'Date', value: r.date }, { label: 'Punch in', value: r.punchIn }, { label: 'Punch out', value: r.punchOut ?? 'Not recorded' }, { label: 'Reason', value: r.reason }], 'Attendance correction', r.status, ['PENDING']);
  }
  const r = await ExpenseClaim.findById(doc.target).lean<IExpenseClaim>();
  if (!r) throw invalid();
  return describe(r.employee, [{ label: 'Date', value: r.expenseDate }, { label: 'Amount', value: r.amount.toFixed(2) }, { label: 'Description', value: r.description }], 'Expense claim', r.status, ['PENDING']);
}

/**
 * Runs the same code as the app, as the person the link was sent to and with their current permissions,
 * so losing approval rights or being the applicant blocks the decision here too.
 */
export async function decideEmailAction(base: RequestContext, token: string, decision: 'approve' | 'reject', reason?: string) {
  const { doc, user } = await usable(token);
  const auth: AuthContext = { userId: user._id, sessionId: new Types.ObjectId(), email: user.email, role: user.role, permissions: permissionsFor(user.role, user.permissions), employeeId: user.employee };
  const ctx: RequestContext = { ...base, auth };
  const id = String(doc.target);
  if (decision === 'reject' && !reason) throw new AppError(422, 'REASON_REQUIRED', 'Enter a reason for rejecting this request');
  const approve = { LEAVE: () => approveLeave(ctx, id), WFH: () => approveWfh(ctx, id), CORRECTION: () => approveCorrection(ctx, id), EXPENSE: () => approveExpense(ctx, id) };
  const reject = { LEAVE: () => rejectLeave(ctx, id, reason!), WFH: () => rejectWfh(ctx, id, reason!), CORRECTION: () => rejectCorrection(ctx, id, reason!), EXPENSE: () => rejectExpense(ctx, id, reason!) };
  await (decision === 'approve' ? approve : reject)[doc.kind]();
  await EmailActionToken.updateOne({ _id: doc._id }, { usedAt: new Date() });
  await audit(ctx, { action: 'DECIDED_FROM_EMAIL', category: 'SECURITY', entityType: doc.kind, entityId: id, summary: decision });
  return { decision };
}
