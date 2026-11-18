/**
 * Development: resets nothing, then adds a demo company by driving the same services the
 * API uses, so all demo balances come from real ledger movements.
 * Production: creates only baseline configuration and the first Super Admin.
 */
import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import { env } from '../src/config/env';
import { HolidayCategory, HR_ASSIGNABLE_PERMISSIONS, Permission, ROLES } from '../src/constants';
import { AuthContext } from '../src/middleware/auth';
import { CompanySettings, CompOffRequest, Department, Employee, Holiday, IEmployee, LeaveRequest, Location, User } from '../src/models';
import { RequestContext } from '../src/services/audit';
import { hashPassword } from '../src/services/auth';
import { adjustBalance } from '../src/services/balance';
import { ensureBaseline } from '../src/services/baseline';
import { adjustCompOff, applyCompOff, approveCompOff } from '../src/services/compoff';
import { applyLeave, approveLeave, rejectLeave } from '../src/services/leave';
import { companyToday, getSettings } from '../src/services/settings';
import { addDays, isWeekend, yearOf } from '../src/utils/dates';

const ctxFor = (userId: Types.ObjectId, email: string, role: AuthContext['role'], permissions: readonly Permission[], employeeId: Types.ObjectId | null): RequestContext => ({
  auth: { userId, email, role, permissions: [...permissions], employeeId, sessionId: new Types.ObjectId() },
});

function nextWorkingDay(from: string, offset: number): string {
  let d = from;
  let n = offset;
  while (n > 0 || isWeekend(d)) {
    d = addDays(d, 1);
    if (!isWeekend(d)) n--;
  }
  return d;
}

async function main() {
  await connectDb();
  const today = await companyToday();
  const types = await ensureBaseline(today);
  // Attendance begins now, so earlier days are not reported as absences.
  await getSettings();
  await CompanySettings.updateOne({ key: 'global', attendanceStartDate: null }, { $set: { attendanceStartDate: today } });

  if (env.isProd) {
    const email = process.env.SEED_SUPERADMIN_EMAIL;
    const password = process.env.SEED_SUPERADMIN_PASSWORD;
    if (!email || !password) throw new Error('Set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD');
    if (!(await User.exists({ role: ROLES.SUPER_ADMIN }))) {
      await User.create({ email, passwordHash: await hashPassword(password), role: ROLES.SUPER_ADMIN, mustChangePassword: true });
      console.log(`Super Admin created: ${email}`);
    }
    console.log('Baseline configuration ready.');
    return;
  }

  if (await Employee.exists({ employeeId: 'EMP001' })) {
    console.log('Demo data already exists. Nothing to do.');
    return;
  }

  const password = process.env.SEED_PASSWORD || `Demo-${randomBytes(6).toString('hex')}1`;
  const passwordHash = await hashPassword(password);

  const [eng, hr, sales, finance] = await Department.create([
    { name: 'Engineering', code: 'ENG' }, { name: 'People Operations', code: 'HR' }, { name: 'Sales', code: 'SAL' }, { name: 'Finance', code: 'FIN' },
  ]);
  const [mumbai, bengaluru] = await Location.create([{ name: 'Mumbai', city: 'Mumbai' }, { name: 'Bengaluru', city: 'Bengaluru' }]);

  const people: [string, string, string, typeof eng, typeof mumbai, string, string | null, 'EMPLOYEE' | 'HR_ADMIN' | 'SUPER_ADMIN', 'FEMALE' | 'MALE'][] = [
    ['EMP001', 'Amudha Kaliamoorthi', 'amudha.kaliamoorthi@leavehub.test', hr, mumbai, 'HR Manager', null, 'SUPER_ADMIN', 'FEMALE'],
    ['EMP002', 'Dinjit Dinesh', 'dinjit.dinesh@leavehub.test', eng, bengaluru, 'Engineering Manager', null, 'HR_ADMIN', 'MALE'],
    ['EMP003', 'Namrata Kurariya', 'namrata.kurariya@leavehub.test', eng, bengaluru, 'Senior Engineer', 'EMP002', 'EMPLOYEE', 'FEMALE'],
    ['EMP004', 'Rohan Das', 'rohan.das@leavehub.test', eng, bengaluru, 'Engineer', 'EMP002', 'EMPLOYEE', 'MALE'],
    ['EMP005', 'Meera Iyer', 'meera.iyer@leavehub.test', sales, mumbai, 'Account Executive', null, 'EMPLOYEE', 'FEMALE'],
    ['EMP006', 'Kabir Singh', 'kabir.singh@leavehub.test', sales, mumbai, 'Sales Lead', null, 'EMPLOYEE', 'MALE'],
    ['EMP007', 'Anita Rao', 'anita.rao@leavehub.test', finance, mumbai, 'Accountant', null, 'EMPLOYEE', 'FEMALE'],
    ['EMP008', 'Vikram Joshi', 'vikram.joshi@leavehub.test', finance, bengaluru, 'Financial Analyst', 'EMP007', 'EMPLOYEE', 'MALE'],
  ];

  const staff = new Map<string, IEmployee>();
  const joinYear = yearOf(today) - 2;
  for (const [employeeId, fullName, email, department, location, designation, , role, gender] of people) {
    const userId = new Types.ObjectId();
    const employeeRef = new Types.ObjectId();
    await User.create({ _id: userId, email, passwordHash, role, employee: employeeRef });
    const doc = await Employee.create({ _id: employeeRef, employeeId, fullName, email, gender, department: department._id, location: location._id, designation, joiningDate: `${joinYear}-04-01`, user: userId, phone: '+91 98200 00000' });
    staff.set(employeeId, doc.toObject() as IEmployee);
  }
  for (const [employeeId, , , , , , managerCode] of people) {
    if (managerCode) await Employee.updateOne({ employeeId }, { reportingManager: staff.get(managerCode)!._id });
  }

  const year = yearOf(today);
  const holidays: [string, string, HolidayCategory, Record<string, unknown>?][] = [
    ["New Year's Day", '01-01', 'COMPANY'],
    ['Republic Day', '01-26', 'NATIONAL', { recurring: true }],
    ['Holi', '03-04', 'FESTIVAL'],
    ['Good Friday', '04-03', 'OPTIONAL'],
    ['Maharashtra Day', '05-01', 'REGIONAL', { locations: [mumbai._id] }],
    ['Independence Day', '08-15', 'NATIONAL', { recurring: true }],
    ['Ganesh Chaturthi', '09-14', 'REGIONAL', { locations: [mumbai._id] }],
    ['Gandhi Jayanti', '10-02', 'NATIONAL', { recurring: true }],
    ['Dussehra', '10-20', 'FESTIVAL'],
    ['Karnataka Rajyotsava', '11-01', 'REGIONAL', { locations: [bengaluru._id] }],
    ['Diwali', '11-09', 'FESTIVAL'],
    ['Diwali Eve', '11-06', 'COMPANY', { isHalfDay: true, halfDaySession: 'SECOND' }],
    ['Christmas Day', '12-25', 'PUBLIC', { recurring: true }],
    ['Company Foundation Day', '12-18', 'COMPANY'],
    ['Christmas Eve', '12-24', 'OPTIONAL'],
  ];
  for (const [name, md, category, extra] of holidays) {
    await Holiday.create({ name, date: `${year}-${md}`, year, category, description: `${name} ${year}`, ...extra });
  }

  const dinjit = staff.get('EMP002')!;
  const hrCtx = ctxFor(dinjit.user!, dinjit.email, 'HR_ADMIN', HR_ASSIGNABLE_PERMISSIONS, dinjit._id);
  const employeeCtx = (code: string) => {
    const e = staff.get(code)!;
    return ctxFor(e.user!, e.email, 'EMPLOYEE', [], e._id);
  };
  const leave = async (code: string, typeCode: string, startOffset: number, endOffset: number, reason: string, then?: 'approve' | 'reject', half?: 'FIRST' | 'SECOND') => {
    const start = nextWorkingDay(today, startOffset);
    const end = half ? start : nextWorkingDay(today, endOffset);
    const { request } = await applyLeave(employeeCtx(code), staff.get(code)!._id, {
      leaveType: String(types.get(typeCode)), startDate: start, endDate: end, dayType: half ? 'HALF' : 'FULL', halfSession: half ?? null, reason,
    });
    if (then === 'approve') await approveLeave(hrCtx, String(request._id), 'Enjoy your time off');
    if (then === 'reject') await rejectLeave(hrCtx, String(request._id), 'Critical release that week');
    return request;
  };

  await leave('EMP003', 'CL', 1, 2, 'Family function', 'approve');
  await leave('EMP004', 'EL', 3, 7, 'Trip home', 'approve');
  await leave('EMP005', 'CL', 2, 3, 'Personal work');
  await leave('EMP006', 'EL', 5, 9, 'Vacation', 'approve');
  await leave('EMP007', 'SL', 1, 1, 'Medical appointment', 'approve', 'FIRST');
  await leave('EMP008', 'CL', 4, 4, 'Bank visit', 'reject');
  await leave('EMP002', 'CL', 6, 7, 'School admission');
  await leave('EMP003', 'SL', 12, 12, 'Dental procedure');

  // Comp-Off: a real claim for last weekend, plus a manual credit.
  let lastSaturday = addDays(today, -1);
  while (new Date(`${lastSaturday}T00:00:00Z`).getUTCDay() !== 6) lastSaturday = addDays(lastSaturday, -1);
  const rohan = staff.get('EMP004')!;
  const claim = await applyCompOff(employeeCtx('EMP004'), rohan._id, { workedDate: lastSaturday, dayType: 'FULL', reason: 'Weekend production release' });
  await approveCompOff(hrCtx, String(claim._id), { comment: 'Thanks for covering the release' });
  await applyCompOff(employeeCtx('EMP003'), staff.get('EMP003')!._id, { workedDate: lastSaturday, dayType: 'HALF', reason: 'Incident support' });
  await adjustCompOff(hrCtx, { employee: String(staff.get('EMP005')!._id), amount: 2, reason: 'Worked two client event weekends', earnedDate: addDays(today, -20), expiresOn: addDays(today, 10), idempotencyKey: 'seed-meera' });
  await adjustBalance(hrCtx, { employee: String(staff.get('EMP006')!._id), leaveType: String(types.get('EL')), year, amount: 3, kind: 'CREDIT', reason: 'Referral bonus days', idempotencyKey: 'seed-kabir' });

  const counts = { leaves: await LeaveRequest.countDocuments(), compOff: await CompOffRequest.countDocuments() };
  console.log(`\nDemo company ready (${counts.leaves} leave requests, ${counts.compOff} Comp-Off claims).`);
  console.log(`Password for every demo account: ${password}\n`);
  console.log('  Super Admin       amudha.kaliamoorthi@leavehub.test');
  console.log('  HR Admin, manager dinjit.dinesh@leavehub.test');
  console.log('  Employee          namrata.kurariya@leavehub.test');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
