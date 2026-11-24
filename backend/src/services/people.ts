import { Types } from 'mongoose';
import { PERMISSIONS } from '../constants';
import { AuthContext, can } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import {
  Announcement, AnnouncementAck, Checklist, EmployeeDetails, ExpenseClaim, IAnnouncement, IChecklist, IEmployeeDetails, IExpenseClaim,
} from '../models/People';
import { StoredFile } from '../models/System';
import { IUser, User } from '../models/User';
import { decryptField, encryptField } from '../utils/crypto';
import { monthRange } from '../utils/dates';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { ApprovalView, approvalStatusFilter, queueSort } from '../utils/http';
import { isDuplicateKeyError, withTransaction } from '../utils/transaction';
import { monthForEmployees } from './attendance';
import { audit, RequestContext } from './audit';
import { adminsWithPermission, approverUsers, notifyUsers } from './notification';
import { effectiveRule, resolvePolicy } from './policy';
import { companyToday } from './settings';

const nameOf = async (auth: AuthContext) => {
  const me = auth.employeeId ? await Employee.findById(auth.employeeId).select('fullName').lean<IEmployee>() : null;
  return me?.fullName ?? auth.email;
};

/* Self-service details */

export interface DetailsInput {
  bank?: { holderName: string; bankName: string; ifsc: string; accountNumber?: string } | null;
  emergencyContacts?: { name: string; relationship: string; phone: string }[];
  address?: string | null;
}

/** The full account number never leaves this file except through revealBankAccount. */
const present = (doc: IEmployeeDetails | null) => ({
  bank: doc?.bank ? { holderName: doc.bank.holderName, bankName: doc.bank.bankName, ifsc: doc.bank.ifsc, accountLast4: doc.bank.accountLast4 } : null,
  emergencyContacts: doc?.emergencyContacts ?? [],
  address: doc?.address ?? null,
});

export const detailsFor = async (employee: Types.ObjectId | string) => present(await EmployeeDetails.findOne({ employee }).lean<IEmployeeDetails>());

export async function saveOwnDetails(ctx: RequestContext, input: DetailsInput) {
  const employee = ctx.auth!.employeeId!;
  const existing = await EmployeeDetails.findOne({ employee }).lean<IEmployeeDetails>();
  const $set: Record<string, unknown> = {};
  if (input.emergencyContacts !== undefined) $set.emergencyContacts = input.emergencyContacts;
  if (input.address !== undefined) $set.address = input.address;
  if (input.bank === null) $set.bank = null;
  else if (input.bank) {
    const { accountNumber, ...rest } = input.bank;
    if (!accountNumber && !existing?.bank) throw unprocessable('Enter the account number', 'ACCOUNT_REQUIRED');
    $set.bank = {
      ...rest,
      accountEncrypted: accountNumber ? encryptField(accountNumber) : existing!.bank!.accountEncrypted,
      accountLast4: accountNumber ? accountNumber.slice(-4) : existing!.bank!.accountLast4,
    };
  }
  const updated = await EmployeeDetails.findOneAndUpdate({ employee }, { $set }, { upsert: true, returnDocument: 'after' }).lean<IEmployeeDetails>();
  // Which parts changed, and never their values.
  await audit(ctx, { action: 'EMPLOYEE_DETAILS_UPDATED', entityType: 'Employee', entityId: employee, summary: `Updated: ${Object.keys($set).join(', ')}` });
  return present(updated);
}

export async function revealBankAccount(ctx: RequestContext, employeeId: string) {
  const details = await EmployeeDetails.findOne({ employee: employeeId }).lean<IEmployeeDetails>();
  if (!details?.bank) throw notFound('Bank details');
  await audit(ctx, { action: 'BANK_ACCOUNT_VIEWED', category: 'SECURITY', entityType: 'Employee', entityId: employeeId, summary: 'Full bank account number viewed' });
  return { accountNumber: decryptField(details.bank.accountEncrypted) };
}

export const personalDocuments = (employee: Types.ObjectId | string) =>
  StoredFile.find({ ownerEmployee: employee, purpose: 'PERSONAL' }).sort({ createdAt: -1 }).select('originalName mimeType size createdAt').lean();

/* Checklists */

const DEFAULT_ITEMS: Record<IChecklist['kind'], { label: string; owner: 'HR' | 'EMPLOYEE' }[]> = {
  ONBOARDING: [
    { label: 'Submit ID proof', owner: 'EMPLOYEE' },
    { label: 'Add bank details', owner: 'EMPLOYEE' },
    { label: 'Add emergency contact', owner: 'EMPLOYEE' },
    { label: 'Read company policies', owner: 'EMPLOYEE' },
    { label: 'Issue laptop and equipment', owner: 'HR' },
    { label: 'Create email and system accounts', owner: 'HR' },
    { label: 'Sign employment agreement', owner: 'HR' },
  ],
  EXIT: [
    { label: 'Hand over work and documents', owner: 'EMPLOYEE' },
    { label: 'Return laptop and equipment', owner: 'EMPLOYEE' },
    { label: 'Return ID card', owner: 'EMPLOYEE' },
    { label: 'Exit interview', owner: 'HR' },
    { label: 'Remove email and system access', owner: 'HR' },
    { label: 'Final settlement', owner: 'HR' },
    { label: 'Issue relieving letter', owner: 'HR' },
  ],
};

export const checklistsFor = (employee: Types.ObjectId | string) => Checklist.find({ employee }).sort({ createdAt: 1 }).lean();

export async function startChecklist(ctx: RequestContext, employeeId: string, kind: IChecklist['kind']) {
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  try {
    const doc = await Checklist.create({ employee: employee._id, kind, items: DEFAULT_ITEMS[kind] });
    await notifyUsers([employee.user], { type: 'CHECKLIST_UPDATED', title: kind === 'ONBOARDING' ? 'Your onboarding checklist' : 'Your exit checklist', message: 'HR has started a checklist for you. Some items may need you.', link: '/account' });
    await audit(ctx, { action: 'CHECKLIST_STARTED', entityType: 'Employee', entityId: employee._id, summary: `${employee.fullName}: ${kind}` });
    return doc.toObject();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('This checklist has already been started', 'DUPLICATE_CHECKLIST');
    throw err;
  }
}

export async function addChecklistItem(ctx: RequestContext, employeeId: string, id: string, input: { label: string; owner: 'HR' | 'EMPLOYEE' }) {
  const updated = await Checklist.findOneAndUpdate({ _id: id, employee: employeeId }, { $push: { items: input } }, { returnDocument: 'after', runValidators: true }).lean();
  if (!updated) throw notFound('Checklist');
  await audit(ctx, { action: 'CHECKLIST_ITEM_ADDED', entityType: 'Checklist', entityId: id, summary: input.label });
  return updated;
}

/** Employees can tick only their own items, on their own checklist. HR can tick any item. */
export async function setChecklistItem(ctx: RequestContext, scope: { employee: Types.ObjectId | string; asEmployee: boolean }, id: string, itemId: string, done: boolean) {
  const auth = ctx.auth!;
  const doc = await Checklist.findOne({ _id: id, employee: scope.employee }).lean<IChecklist>();
  const item = doc?.items.find((i) => String(i._id) === itemId);
  if (!doc || !item) throw notFound('Checklist item');
  if (scope.asEmployee && item.owner !== 'EMPLOYEE') throw forbidden('HR completes this item', 'HR_ITEM');
  const by = done ? await nameOf(auth) : null;
  const updated = await Checklist.findOneAndUpdate(
    { _id: id, 'items._id': itemId },
    { $set: { 'items.$.done': done, 'items.$.doneByName': by, 'items.$.doneAt': done ? new Date() : null } },
    { returnDocument: 'after' },
  ).lean();
  await audit(ctx, { action: 'CHECKLIST_ITEM_CHANGED', entityType: 'Checklist', entityId: id, summary: `${item.label}: ${done ? 'done' : 'not done'}` });
  return updated;
}

/* Payroll preparation */

const round = (n: number) => Math.round(n * 100) / 100;

export interface PayrollFilters { month: string; department?: string; search?: string }

/**
 * Payable days are the calendar days employed in the month, less absences and unpaid leave.
 * It prepares the figures for payroll and does not calculate pay.
 */
export async function payrollMonth(f: PayrollFilters) {
  const { start, end } = monthRange(f.month);
  const query: Record<string, unknown> = { employmentStatus: { $ne: 'INACTIVE' }, joiningDate: { $lte: end } };
  if (f.department) query.department = f.department;
  const { rows, today } = await monthForEmployees(query, f.month);
  const types = new Map((await LeaveType.find().lean<ILeaveType[]>()).map((t) => [String(t._id), t]));
  const leaves = await LeaveRequest.find({
    employee: { $in: rows.map((r) => r.employee._id) }, status: { $in: ['APPROVED', 'CANCELLATION_REQUESTED'] }, startDate: { $lte: end }, endDate: { $gte: start },
  }).select('employee leaveType startDate dayBreakdown').lean<ILeaveRequest[]>();

  const out = [];
  for (const { employee, days, summary } of rows) {
    let paidLeave = 0;
    let unpaidLeave = 0;
    for (const leave of leaves.filter((l) => String(l.employee) === String(employee._id))) {
      const type = types.get(String(leave.leaveType));
      if (!type) continue;
      const scope = { ...employee, department: employee.department?._id ?? null } as unknown as IEmployee;
      const isPaid = effectiveRule(type, await resolvePolicy(scope, leave.startDate), scope).isPaid;
      const inMonth = leave.dayBreakdown.filter((b) => b.date >= start && b.date <= end).reduce((sum, b) => sum + b.value, 0);
      if (isPaid) paidLeave += inMonth;
      else unpaidLeave += inMonth;
    }
    const employedDays = days.filter((d) => d.status !== 'NOT_EMPLOYED').length;
    out.push({
      employeeId: employee.employeeId,
      employeeName: employee.fullName,
      department: employee.department?.name ?? '',
      employedDays,
      attended: summary.attended,
      present: summary.present,
      workFromHome: summary.workFromHome,
      paidLeave: round(paidLeave),
      unpaidLeave: round(unpaidLeave),
      holidays: days.filter((d) => d.status === 'HOLIDAY').length,
      weekends: days.filter((d) => d.status === 'WEEKEND').length,
      absent: summary.absent,
      lossOfPayDays: round(summary.absent + unpaidLeave),
      payableDays: round(employedDays - summary.absent - unpaidLeave),
    });
  }
  const rx = f.search?.toLowerCase();
  return { month: f.month, complete: end < today, rows: rx ? out.filter((r) => r.employeeName.toLowerCase().includes(rx) || r.employeeId.toLowerCase().includes(rx)) : out };
}

/* Expense claims */

export async function submitExpense(ctx: RequestContext, input: Pick<IExpenseClaim, 'category' | 'expenseDate' | 'amount' | 'description'> & { receipt?: string | null }) {
  const auth = ctx.auth!;
  const employee = await Employee.findById(auth.employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  if (input.expenseDate > await companyToday()) throw unprocessable('The expense date cannot be in the future', 'FUTURE_DATE');
  if (input.receipt && !(await StoredFile.exists({ _id: input.receipt, owner: auth.userId, purpose: { $nin: ['AVATAR', 'PERSONAL'] } }))) throw unprocessable('The receipt was not found', 'RECEIPT_NOT_FOUND');
  const approvers = [...await approverUsers('REPORTING_MANAGER', employee), ...await adminsWithPermission(PERMISSIONS.EXPENSES_MANAGE)].filter((id) => String(id) !== String(employee.user));
  return withTransaction(async (session) => {
    const [created] = await ExpenseClaim.create([{ ...input, receipt: input.receipt ?? null, employee: employee._id }], { session });
    await notifyUsers(approvers, {
      type: 'EXPENSE_SUBMITTED',
      title: 'New expense claim',
      message: `${employee.fullName} claimed ${input.amount.toFixed(2)} for ${input.expenseDate}: ${input.description}`,
      link: '/approvals',
      action: { kind: 'EXPENSE', id: created._id },
    }, session);
    await audit(ctx, { action: 'EXPENSE_SUBMITTED', entityType: 'ExpenseClaim', entityId: created._id, summary: `${employee.fullName}: ${input.amount.toFixed(2)}` }, session);
    return created.toObject() as IExpenseClaim;
  });
}

const populateExpense = { path: 'employee', select: 'fullName employeeId department avatarFile', populate: { path: 'department', select: 'name' } };
const populateReceipt = { path: 'receipt', select: 'originalName' };
const canManageExpenses = (auth: AuthContext) => can(auth, PERMISSIONS.EXPENSES_MANAGE);

export async function pendingExpenses(auth: AuthContext, view?: ApprovalView) {
  const query: Record<string, unknown> = approvalStatusFilter(view, ['APPROVED', 'PAID']);
  if (canManageExpenses(auth)) {
    if (auth.employeeId) query.employee = { $ne: auth.employeeId };
  } else {
    if (!auth.employeeId) return [];
    query.employee = { $in: (await Employee.find({ reportingManager: auth.employeeId }).select('_id').lean<IEmployee[]>()).map((e) => e._id) };
  }
  return ExpenseClaim.find(query).sort(queueSort(view)).limit(200).populate(populateExpense).populate(populateReceipt).lean();
}

export const allExpenses = (status?: string) =>
  ExpenseClaim.find((status ? { status } : {}) as Record<string, unknown>).sort({ createdAt: -1 }).limit(500).populate(populateExpense).populate(populateReceipt).lean();

async function decideExpense(ctx: RequestContext, id: string, approved: boolean, reason: string | null) {
  const auth = ctx.auth!;
  const claim = await ExpenseClaim.findById(id).lean<IExpenseClaim>();
  if (!claim) throw notFound('Claim');
  const employee = await Employee.findById(claim.employee).lean<IEmployee>();
  if (!employee) throw notFound('Claim');
  if (String(employee._id) === String(auth.employeeId)) throw forbidden('You cannot decide your own claim', 'SELF_APPROVAL');
  const manages = auth.employeeId && String(employee.reportingManager) === String(auth.employeeId);
  if (!canManageExpenses(auth) && !manages) throw notFound('Claim');
  const name = await nameOf(auth);
  return withTransaction(async (session) => {
    const updated = await ExpenseClaim.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      { $set: { status: approved ? 'APPROVED' : 'REJECTED', decidedBy: auth.userId, decidedByName: name, decidedAt: new Date(), rejectionReason: reason } },
      { session, returnDocument: 'after' },
    ).lean();
    if (!updated) throw conflict('This claim has already been processed', 'ALREADY_PROCESSED');
    await notifyUsers([employee.user], {
      type: approved ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      title: approved ? 'Expense claim approved' : 'Expense claim rejected',
      message: approved ? `Your claim of ${claim.amount.toFixed(2)} was approved.` : `Your claim of ${claim.amount.toFixed(2)} was rejected. Reason: ${reason}`,
      link: '/expenses',
    }, session);
    await audit(ctx, { action: approved ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED', entityType: 'ExpenseClaim', entityId: id, summary: `${employee.fullName}: ${claim.amount.toFixed(2)}${reason ? ` (${reason})` : ''}` }, session);
    return updated;
  });
}

export const approveExpense = (ctx: RequestContext, id: string) => decideExpense(ctx, id, true, null);
export const rejectExpense = (ctx: RequestContext, id: string, reason: string) => decideExpense(ctx, id, false, reason);

export async function payExpense(ctx: RequestContext, id: string) {
  const claim = await ExpenseClaim.findById(id).lean<IExpenseClaim>();
  if (!claim) throw notFound('Claim');
  if (String(claim.employee) === String(ctx.auth?.employeeId)) throw forbidden('You cannot mark your own claim as paid', 'SELF_APPROVAL');
  return withTransaction(async (session) => {
    const updated = await ExpenseClaim.findOneAndUpdate({ _id: id, status: 'APPROVED' }, { status: 'PAID', paidAt: new Date() }, { session, returnDocument: 'after' }).lean();
    if (!updated) throw conflict('Only an approved claim can be marked as paid', 'NOT_APPROVED');
    const employee = await Employee.findById(claim.employee).select('user').lean<IEmployee>();
    await notifyUsers([employee?.user], { type: 'EXPENSE_PAID', title: 'Expense claim paid', message: `Your claim of ${claim.amount.toFixed(2)} was marked as paid.`, link: '/expenses' }, session);
    await audit(ctx, { action: 'EXPENSE_PAID', entityType: 'ExpenseClaim', entityId: id, summary: claim.amount.toFixed(2) }, session);
    return updated;
  });
}

export async function cancelExpense(ctx: RequestContext, id: string) {
  const updated = await ExpenseClaim.findOneAndUpdate({ _id: id, employee: ctx.auth!.employeeId, status: 'PENDING' }, { status: 'CANCELLED' }, { returnDocument: 'after' }).lean();
  if (!updated) throw notFound('Claim');
  await audit(ctx, { action: 'EXPENSE_CANCELLED', entityType: 'ExpenseClaim', entityId: id });
  return updated;
}

/* Announcements and policies */

export async function publishAnnouncement(ctx: RequestContext, input: Pick<IAnnouncement, 'kind' | 'title' | 'body' | 'requiresAck'> & { document?: string | null }) {
  const auth = ctx.auth!;
  if (input.document && !(await StoredFile.exists({ _id: input.document, owner: auth.userId, purpose: { $nin: ['AVATAR', 'PERSONAL'] } }))) throw unprocessable('The document was not found', 'DOCUMENT_NOT_FOUND');
  const name = await nameOf(auth);
  const doc = await Announcement.create({ ...input, document: input.document ?? null, publishedBy: auth.userId, publishedByName: name });
  const recipients = (await User.find({ isActive: true, _id: { $ne: auth.userId } }).select('_id').lean<IUser[]>()).map((u) => u._id);
  await notifyUsers(recipients, {
    type: 'ANNOUNCEMENT',
    title: input.title,
    message: input.requiresAck ? `${input.body.slice(0, 300)} Please read and confirm this in WorkNest.` : input.body.slice(0, 300),
    link: '/announcements',
  });
  await audit(ctx, { action: 'ANNOUNCEMENT_PUBLISHED', entityType: 'Announcement', entityId: doc._id, summary: input.title });
  return doc.toObject();
}

export async function listAnnouncements(auth: AuthContext) {
  const items = await Announcement.find().sort({ createdAt: -1 }).limit(100).populate('document', 'originalName').lean();
  const acks = await AnnouncementAck.find({ user: auth.userId, announcement: { $in: items.map((a) => a._id) } }).select('announcement').lean();
  const done = new Set(acks.map((a) => String(a.announcement)));
  return items.map((a) => ({ ...a, acknowledged: done.has(String(a._id)) }));
}

export async function acknowledgeAnnouncement(auth: AuthContext, id: string) {
  const announcement = await Announcement.findById(id).lean<IAnnouncement>();
  if (!announcement) throw notFound('Announcement');
  try {
    await AnnouncementAck.create({ announcement: announcement._id, user: auth.userId });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/** Who has confirmed, and who still needs to. People who joined later are included, as the policy applies to them too. */
export async function announcementReaders(id: string) {
  const announcement = await Announcement.findById(id).lean<IAnnouncement>();
  if (!announcement) throw notFound('Announcement');
  const [users, acks] = await Promise.all([
    User.find({ isActive: true }).select('email employee').populate('employee', 'fullName').lean<(Pick<IUser, '_id' | 'email'> & { employee: { fullName: string } | null })[]>(),
    AnnouncementAck.find({ announcement: id }).lean(),
  ]);
  const when = new Map(acks.map((a) => [String(a.user), a.createdAt]));
  const row = (u: (typeof users)[number]) => ({ name: u.employee?.fullName ?? u.email, at: when.get(String(u._id)) ?? null });
  return { confirmed: users.filter((u) => when.has(String(u._id))).map(row), waiting: users.filter((u) => !when.has(String(u._id))).map(row) };
}

export async function deleteAnnouncement(ctx: RequestContext, id: string) {
  const doc = await Announcement.findByIdAndDelete(id).lean<IAnnouncement>();
  if (!doc) throw notFound('Announcement');
  await AnnouncementAck.deleteMany({ announcement: id });
  await audit(ctx, { action: 'ANNOUNCEMENT_DELETED', entityType: 'Announcement', entityId: id, summary: doc.title });
}

