import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { Employee, IEmployee } from '../models/Employee';
import { Department, Location } from '../models/Org';
import { EmployeeLeavePolicy, LeavePolicy } from '../models/LeaveConfig';
import { User } from '../models/User';
import { EMPLOYEE_GENDERS, ROLES } from '../constants';
import { normalizeDateCell } from '../utils/dates';
import { badRequest, conflict, ErrorDetail, forbidden, notFound } from '../utils/errors';
import { isDuplicateKeyError, withTransaction } from '../utils/transaction';
import { audit, RequestContext } from './audit';
import { createPasswordLink, hashPassword, revokeAllSessions } from './auth';
import { emailConfigured, sendEmail } from './email';
import { cancelOpenRequestsFor } from './leave';
import { companyToday } from './settings';

export interface EmployeeInput {
  employeeId: string;
  fullName: string;
  email: string;
  phone?: string | null;
  gender?: IEmployee['gender'];
  department?: string | null;
  designation?: string | null;
  reportingManager?: string | null;
  joiningDate: string;
  location?: string | null;
  category?: IEmployee['category'];
  leavePolicy?: string | null;
}

const DUPLICATE_MESSAGE = 'An employee with this ID or email already exists';

async function assertManagerValid(managerId: string | null | undefined, selfId?: Types.ObjectId) {
  if (!managerId) return;
  if (selfId && String(selfId) === managerId) throw badRequest('An employee cannot report to themselves', 'INVALID_MANAGER');
  // Walking up the chain keeps approval routing from ever looping.
  let cursor: Types.ObjectId | null = new Types.ObjectId(managerId);
  const seen = new Set<string>();
  while (cursor) {
    if (selfId && String(cursor) === String(selfId)) throw badRequest('This reporting line would create a cycle', 'INVALID_MANAGER');
    if (seen.has(String(cursor))) break;
    seen.add(String(cursor));
    const doc: IEmployee | null = await Employee.findById(cursor).select('reportingManager').lean<IEmployee>();
    if (!doc) throw badRequest('The reporting manager was not found', 'INVALID_MANAGER');
    cursor = doc.reportingManager;
  }
}

export async function createEmployee(ctx: RequestContext, input: EmployeeInput) {
  await assertManagerValid(input.reportingManager);
  // The account starts with an unknown random password; the person sets their own through the link.
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  const today = await companyToday();

  let userId!: Types.ObjectId;
  let employee!: IEmployee;
  try {
    await withTransaction(async (session) => {
      const employeeRef = new Types.ObjectId();
      userId = new Types.ObjectId();
      await User.create([{ _id: userId, email: input.email, passwordHash, role: ROLES.EMPLOYEE, employee: employeeRef, mustChangePassword: false }], { session });
      const [doc] = await Employee.create([{ ...input, _id: employeeRef, user: userId, employmentStatus: 'ACTIVE' }], { session });
      if (input.leavePolicy) {
        await EmployeeLeavePolicy.create([{ employee: employeeRef, policy: input.leavePolicy, effectiveFrom: input.joiningDate < today ? input.joiningDate : today, assignedBy: ctx.auth?.userId }], { session });
      }
      await audit(ctx, { action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: employeeRef, summary: `${doc.employeeId} ${doc.fullName}` }, session);
      employee = doc.toObject() as IEmployee;
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict(DUPLICATE_MESSAGE, 'DUPLICATE_EMPLOYEE');
    throw err;
  }

  const link = await createPasswordLink(userId, 'ACTIVATION');
  const sent = await sendEmail({
    to: employee.email,
    subject: 'Your WorkNest account',
    text: `Welcome. Set your password with this link, which works once and expires in 72 hours:\n\n${link}`,
    devLink: link,
  });
  // Without SMTP the admin is the only way this link can reach the new employee.
  return { employee, activationLink: sent || emailConfigured() ? null : link };
}

export type EmployeeUpdate = Partial<Omit<EmployeeInput, 'employeeId'>>;

export async function updateEmployee(ctx: RequestContext, id: string, input: EmployeeUpdate) {
  const existing = await Employee.findById(id).lean<IEmployee>();
  if (!existing) throw notFound('Employee');
  await assertManagerValid(input.reportingManager, existing._id);
  const today = await companyToday();

  try {
    return await withTransaction(async (session) => {
      const updated = await Employee.findByIdAndUpdate(id, { $set: input }, { session, returnDocument: 'after', runValidators: true }).lean<IEmployee>();
      if (input.email && input.email.toLowerCase() !== existing.email && existing.user) {
        await User.updateOne({ _id: existing.user }, { email: input.email.toLowerCase() }, { session });
      }
      if (input.leavePolicy !== undefined && String(input.leavePolicy) !== String(existing.leavePolicy)) {
        await EmployeeLeavePolicy.updateMany({ employee: existing._id, effectiveTo: null }, { effectiveTo: today }, { session });
        if (input.leavePolicy) {
          await EmployeeLeavePolicy.create([{ employee: existing._id, policy: input.leavePolicy, effectiveFrom: today, assignedBy: ctx.auth?.userId }], { session });
        }
      }
      await audit(ctx, {
        action: 'EMPLOYEE_UPDATED',
        entityType: 'Employee',
        entityId: id,
        summary: `${existing.employeeId} ${existing.fullName}`,
        before: Object.fromEntries(Object.keys(input).map((k) => [k, (existing as unknown as Record<string, unknown>)[k]])),
        after: input,
      }, session);
      return updated;
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict(DUPLICATE_MESSAGE, 'DUPLICATE_EMPLOYEE');
    throw err;
  }
}

/** Deactivation keeps all history. It ends the login and withdraws requests still waiting for a decision. */
export async function setEmployeeStatus(ctx: RequestContext, id: string, status: IEmployee['employmentStatus']) {
  const employee = await Employee.findById(id).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  if (String(employee._id) === String(ctx.auth?.employeeId)) throw forbidden('You cannot change your own employment status', 'SELF_STATUS_CHANGE');

  const active = status !== 'INACTIVE';
  await withTransaction(async (session) => {
    await Employee.updateOne({ _id: id }, { employmentStatus: status }, { session });
    if (employee.user) await User.updateOne({ _id: employee.user }, { isActive: active }, { session });
    await audit(ctx, { action: 'EMPLOYEE_STATUS_CHANGED', entityType: 'Employee', entityId: id, summary: `${employee.employeeId}: ${employee.employmentStatus} to ${status}`, before: { status: employee.employmentStatus }, after: { status } }, session);
  });
  if (!active) {
    if (employee.user) await revokeAllSessions(employee.user, 'DEACTIVATED');
    await cancelOpenRequestsFor(ctx, employee._id);
  }
  return Employee.findById(id).lean();
}

export interface ImportResult {
  total: number;
  created: number;
  errors: ErrorDetail[];
  activationLinks: { email: string; link: string }[];
}

const MAX_IMPORT_ROWS = 2000;

/** Each row stands alone: a bad row is reported and the rest still import. */
export async function importEmployees(ctx: RequestContext, rows: Record<string, unknown>[]): Promise<ImportResult> {
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`An import can hold at most ${MAX_IMPORT_ROWS} rows`);
  const [departments, locations, policies] = await Promise.all([
    Department.find().lean(), Location.find().lean(), LeavePolicy.find().select('name').lean(),
  ]);
  const byName = <T extends { name: string; _id: Types.ObjectId }>(docs: T[]) => new Map(docs.map((d) => [d.name.toLowerCase(), String(d._id)]));
  const deptIds = byName(departments);
  const locIds = byName(locations);
  const policyIds = byName(policies);

  const result: ImportResult = { total: rows.length, created: 0, errors: [], activationLinks: [] };
  const managerLinks: { employeeId: string; managerCode: string; rowNo: number }[] = [];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const text = (k: string) => String(row[k] ?? '').trim();
    const fail = (message: string) => result.errors.push({ path: `row ${rowNo}`, message });

    const employeeId = text('employeeid').toUpperCase();
    const fullName = text('fullname') || text('name');
    const email = text('email').toLowerCase();
    const joiningDate = normalizeDateCell(row.joiningdate);
    const category = (text('category').toUpperCase() || 'PERMANENT') as IEmployee['category'];

    if (!/^[A-Z0-9-]{2,20}$/.test(employeeId)) { fail('Employee ID is missing or invalid'); continue; }
    if (!fullName) { fail('Full name is required'); continue; }
    if (!emailRe.test(email)) { fail('Email is missing or invalid'); continue; }
    if (!joiningDate) { fail('Joining date must be a date such as 2024-03-15'); continue; }
    if (!['PERMANENT', 'CONTRACT', 'INTERN', 'CONSULTANT'].includes(category)) { fail(`Unknown category "${text('category')}"`); continue; }
    const gender = (text('gender').toUpperCase() || null) as IEmployee['gender'];
    if (gender && !EMPLOYEE_GENDERS.includes(gender)) { fail(`Unknown gender "${text('gender')}"`); continue; }

    // "Team" is the name people see; a "Department" column from an older file still works.
    const teamName = text('team') || text('department');
    const department = teamName ? deptIds.get(teamName.toLowerCase()) : null;
    if (teamName && !department) { fail(`Unknown team "${teamName}"`); continue; }
    const location = text('location') ? locIds.get(text('location').toLowerCase()) : null;
    if (text('location') && !location) { fail(`Unknown location "${text('location')}"`); continue; }
    const leavePolicy = text('leavepolicy') ? policyIds.get(text('leavepolicy').toLowerCase()) : null;
    if (text('leavepolicy') && !leavePolicy) { fail(`Unknown leave policy "${text('leavepolicy')}"`); continue; }

    try {
      const { activationLink } = await createEmployee(ctx, {
        employeeId, fullName, email, joiningDate, category, gender,
        phone: text('phone') || null,
        designation: text('designation') || null,
        department: department ?? null,
        location: location ?? null,
        leavePolicy: leavePolicy ?? null,
      });
      result.created++;
      if (activationLink) result.activationLinks.push({ email, link: activationLink });
      if (text('reportingmanager')) managerLinks.push({ employeeId, managerCode: text('reportingmanager').toUpperCase(), rowNo });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  // Second pass, since a manager may appear later in the file than their reports.
  for (const link of managerLinks) {
    const manager = await Employee.findOne({ employeeId: link.managerCode }).select('_id').lean<IEmployee>();
    if (!manager) {
      result.errors.push({ path: `row ${link.rowNo}`, message: `Reporting manager "${link.managerCode}" was not found; the employee was created without one` });
      continue;
    }
    await Employee.updateOne({ employeeId: link.employeeId }, { reportingManager: manager._id });
  }

  await audit(ctx, { action: 'EMPLOYEES_IMPORTED', entityType: 'Employee', summary: `${result.created} of ${result.total} rows imported` });
  return result;
}
