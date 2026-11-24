import { z } from 'zod';
import './messages';
import { APPROVER_TYPES, EMPLOYEE_CATEGORIES, EMPLOYEE_GENDERS, EMPLOYMENT_STATUS, HALF_SESSIONS, HOLIDAY_CATEGORIES, HR_ASSIGNABLE_PERMISSIONS, LEAVE_KINDS, LEAVE_STATUS_VALUES } from '../constants';
import { dateOnly, objectId, quarterStep } from '../middleware/validate';
import { diffDays } from '../utils/dates';
import { CALENDAR_ITEM_COLORS, CALENDAR_ITEM_KINDS, CALENDAR_ITEM_VISIBILITY } from '../models/CalendarItem';
import { SUMMARY_DETAIL_KINDS } from '../services/calendar';
import { REPORT_NAMES } from '../services/report';
import { APPROVAL_VIEWS, paginationQuery } from '../utils/http';

const email = z.string().trim().toLowerCase().email('Must be a valid email address').max(200);
const text = (max: number) => z.string().trim().min(1, 'This field is required').max(max, `Use ${max.toLocaleString('en-IN')} characters or fewer`);
const nullableId = objectId.nullable().optional();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be in YYYY-MM format');
const year = z.coerce.number().int().min(2000).max(2100);

/* Authentication */
export const loginBody = z.strictObject({ email, password: z.string().min(1).max(200) });
export const forgotBody = z.strictObject({ email });
export const resetBody = z.strictObject({ token: z.string().min(20).max(200), password: z.string().min(8).max(200) });
export const changePasswordBody = z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) });

/* Employees. employeeId is deliberately absent from the update schema and role from both. */
const employeeFields = {
  fullName: text(120),
  email,
  phone: z.string().trim().regex(/^[+\d][\d\s()-]{5,20}$/, 'Must be a valid phone number').nullable().optional(),
  gender: z.enum(EMPLOYEE_GENDERS).nullable().optional(),
  department: nullableId,
  designation: z.string().trim().max(100).nullable().optional(),
  reportingManager: nullableId,
  joiningDate: dateOnly,
  location: nullableId,
  category: z.enum(EMPLOYEE_CATEGORIES).optional(),
  leavePolicy: nullableId,
};
export const employeeCreateBody = z.strictObject({
  employeeId: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, 'Use 2 to 20 letters, digits or hyphens'),
  ...employeeFields,
});
export const employeeUpdateBody = z.strictObject(employeeFields).partial();
/* What people may change about themselves. Gender decides leave entitlement and email is the login, so both stay with HR. */
/** What any employee may change about themselves. Everything else (gender, email, team, manager…) goes through HR. */
export const employeeProfileBody = z.strictObject({ fullName: employeeFields.fullName, phone: employeeFields.phone });
export const employeeStatusBody = z.strictObject({ status: z.enum(EMPLOYMENT_STATUS) });
export const employeeListQuery = z.object({
  ...paginationQuery,
  search: z.string().trim().max(100).optional(),
  department: objectId.optional(),
  location: objectId.optional(),
  status: z.enum(EMPLOYMENT_STATUS).optional(),
});

/* Attendance and work from home. Punches take no body: the server records the time. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a time such as 09:30');
/** Longest attendance period one request may cover: a year, so a report never builds an unbounded table. */
export const MAX_ATTENDANCE_DAYS = 366;
const periodFields = { month: month.optional(), from: dateOnly.optional(), to: dateOnly.optional() };
type PeriodFields = { month?: string; from?: string; to?: string };
const checkPeriod = <T extends PeriodFields>(schema: z.ZodType<T>) => schema
  .refine((q) => Boolean(q.from) === Boolean(q.to), { message: 'Choose both a start and an end date', path: ['to'] })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The end date cannot be before the start date', path: ['to'] })
  .refine((q) => !q.from || !q.to || diffDays(q.to, q.from) < MAX_ATTENDANCE_DAYS, { message: `Choose a period of at most ${MAX_ATTENDANCE_DAYS} days`, path: ['to'] });
/** A month (YYYY-MM) or a from/to date range. With neither, the current month. */
export const attendanceMonthQuery = checkPeriod(z.object(periodFields));
export const attendanceDailyQuery = z.object({ ...paginationQuery, date: dateOnly.optional(), department: objectId.optional(), search: z.string().trim().max(100).optional() });
export const attendanceCorrectionBody = z.strictObject({ punchIn: clockTime, punchOut: clockTime.nullable().optional(), note: text(500) });
export const emptyBody = z.strictObject({});
export const wfhApplyBody = z.strictObject({ startDate: dateOnly, endDate: dateOnly, reason: text(1000) });
export const wfhListQuery = z.object(paginationQuery);

const moneyAmount = z.number().positive('Enter an amount above zero').max(10_000_000, 'The amount cannot be more than ₹1,00,00,000').refine((n) => Math.round(n * 100) / 100 === n, 'Use at most two decimal places');
export const correctionRequestBody = z.strictObject({ date: dateOnly, punchIn: clockTime, punchOut: clockTime.nullable().optional(), reason: text(500) });
export const attendanceExportQuery = checkPeriod(z.object({ ...periodFields, department: objectId.optional(), format: z.enum(['csv', 'xlsx']).default('xlsx') }))
  .refine((q) => Boolean(q.month || q.from), { message: 'Choose a month or a date range', path: ['month'] });
export const teamDailyQuery = z.object({ ...paginationQuery, date: dateOnly.optional(), search: z.string().trim().max(100).optional() });
export const dateRangeQuery = z.object({ start: dateOnly, end: dateOnly });
export const emailPreviewBody = z.strictObject({ token: z.string().min(20).max(200) });
export const emailDecideBody = z.strictObject({ token: z.string().min(20).max(200), decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).optional() });
const emergencyContact = z.strictObject({ name: text(120), relationship: text(60), phone: z.string().trim().regex(/^[+\d][\d\s()-]{5,20}$/, 'Must be a valid phone number') });
export const employeeDetailsBody = z.strictObject({
  bank: z.strictObject({
    holderName: text(120),
    bankName: text(120),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Must be a valid IFSC code'),
    accountNumber: z.string().trim().regex(/^\d{6,20}$/, 'Must be 6 to 20 digits').optional(),
  }).nullable().optional(),
  emergencyContacts: z.array(emergencyContact).max(5).optional(),
  address: z.string().trim().max(500).nullable().optional(),
});
export const checklistStartBody = z.strictObject({ kind: z.enum(['ONBOARDING', 'EXIT']) });
export const checklistItemBody = z.strictObject({ label: text(200), owner: z.enum(['HR', 'EMPLOYEE']) });
export const checklistDoneBody = z.strictObject({ done: z.boolean() });
export const payrollQuery = z.object({ month: month.optional(), department: objectId.optional(), search: z.string().trim().max(100).optional() });
export const payrollExportQuery = z.object({ month, department: objectId.optional(), format: z.enum(['csv', 'xlsx']).default('xlsx') });
export const expenseBody = z.strictObject({
  category: z.enum(['TRAVEL', 'FOOD', 'ACCOMMODATION', 'SUPPLIES', 'INTERNET_PHONE', 'OTHER']),
  expenseDate: dateOnly,
  amount: moneyAmount,
  description: text(1000),
  receipt: objectId.nullable().optional(),
});
export const expenseListQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED']).optional() });
export const announcementBody = z.strictObject({
  kind: z.enum(['ANNOUNCEMENT', 'POLICY']),
  title: text(200),
  body: text(10_000),
  document: objectId.nullable().optional(),
  requiresAck: z.boolean(),
});

/* Departments and locations */
export const departmentBody = z.strictObject({ name: text(100), code: z.string().trim().max(20).nullable().optional(), isActive: z.boolean().optional() });
export const locationBody = z.strictObject({ name: text(100), city: z.string().trim().max(100).nullable().optional(), isActive: z.boolean().optional() });

/* Leave */
export const leaveFieldsBody = z.strictObject({
  leaveType: objectId,
  startDate: dateOnly,
  endDate: dateOnly,
  dayType: z.enum(['FULL', 'HALF']).default('FULL'),
  halfSession: z.enum(HALF_SESSIONS).nullable().optional(),
});
export const leaveApplyBody = z.strictObject({
  ...leaveFieldsBody.shape,
  // Required or not depends on the employee's leave rule, so applyLeave decides.
  reason: z.string().trim().max(1000).nullable().optional(),
  handoverNotes: z.string().trim().max(2000).nullable().optional(),
  document: objectId.nullable().optional(),
});
const leaveFilter = {
  status: z.enum(LEAVE_STATUS_VALUES).optional(),
  leaveType: objectId.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
};
export const approvalViewQuery = z.object({ view: z.enum(APPROVAL_VIEWS).optional() });
export const approvalsQuery = z.object({ ...paginationQuery, ...leaveFilter, view: z.enum(APPROVAL_VIEWS).optional() });
export const myLeavesQuery = z.object({ ...paginationQuery, ...leaveFilter });
export const allLeavesQuery = z.object({ ...paginationQuery, ...leaveFilter, employee: objectId.optional(), department: objectId.optional(), search: z.string().trim().max(100).optional() });
export const reasonBody = z.strictObject({ reason: text(1000) });
export const optionalReasonBody = z.strictObject({ reason: z.string().trim().max(1000).optional() });
export const commentBody = z.strictObject({ comment: z.string().trim().max(1000).optional() });

/* Balances */
export const yearQuery = z.object({ year: year.optional() });
export const transactionsQuery = z.object({ ...paginationQuery, year: year.optional(), leaveType: objectId.optional() });
export const adjustmentBody = z.strictObject({
  employee: objectId,
  leaveType: objectId,
  year,
  amount: quarterStep(z.number().min(-365).max(365)).refine((n) => n !== 0, 'Amount cannot be zero'),
  kind: z.enum(['CREDIT', 'ADJUSTMENT', 'OPENING', 'DEDUCTION']),
  reason: text(500),
});
export const balanceListQuery = z.object({ ...paginationQuery, year: year.optional(), department: objectId.optional(), search: z.string().trim().max(100).optional() });

/* Comp-Off */
export const compOffApplyBody = z.strictObject({
  workedDate: dateOnly,
  dayType: z.enum(['FULL', 'HALF']).default('FULL'),
  reason: text(1000),
  document: objectId.nullable().optional(),
});
export const compOffApproveBody = z.strictObject({ expiresOn: dateOnly.optional(), comment: z.string().trim().max(1000).optional() });
export const compOffAdjustBody = z.strictObject({
  employee: objectId,
  amount: quarterStep(z.number().min(-365).max(365)).refine((n) => n !== 0, 'Amount cannot be zero'),
  reason: text(500),
  earnedDate: dateOnly.optional(),
  expiresOn: dateOnly.optional(),
});
export const compOffExpiryBody = z.strictObject({ expiresOn: dateOnly });
export const compOffListQuery = z.object({ ...paginationQuery, status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), employee: objectId.optional(), search: z.string().trim().max(100).optional() });
export const compOffTxQuery = z.object({ ...paginationQuery, employee: objectId.optional() });

/* Holidays */
const holidayFields = {
  name: text(120),
  date: dateOnly,
  category: z.enum(HOLIDAY_CATEGORIES),
  description: z.string().trim().max(500).nullable().optional(),
  locations: z.array(objectId).max(100).optional(),
  departments: z.array(objectId).max(100).optional(),
  employeeCategories: z.array(z.enum(EMPLOYEE_CATEGORIES)).optional(),
  isHalfDay: z.boolean().optional(),
  halfDaySession: z.enum(HALF_SESSIONS).optional(),
  recurring: z.boolean().optional(),
};
export const holidayBody = z.strictObject(holidayFields);
export const holidayUpdateBody = z.strictObject(holidayFields).partial();
export const holidayListQuery = z.object({ year: year.optional(), category: z.enum(HOLIDAY_CATEGORIES).optional(), scope: z.enum(['mine', 'all']).default('mine') });
export const holidayCopyBody = z.strictObject({ fromYear: year, toYear: year }).refine((b) => b.fromYear !== b.toYear, 'Choose two different years');
export const exportFormat = z.enum(['csv', 'xlsx']).default('xlsx');
export const holidayExportQuery = z.object({ year: year.optional(), format: exportFormat });

/* Leave types and policies */
const ruleFields = {
  isPaid: z.boolean(),
  annualEntitlement: quarterStep(z.number().min(0).max(366)),
  monthlyAccrual: quarterStep(z.number().min(0).max(31)),
  prorateOnJoining: z.boolean(),
  carryForward: z.boolean(),
  maxCarryForward: quarterStep(z.number().min(0).max(366)),
  carryForwardExpiryDays: z.number().int().min(0).max(366).nullable(),
  minDuration: quarterStep(z.number().min(0).max(366)),
  maxDuration: quarterStep(z.number().min(0.5).max(366)).nullable(),
  halfDayAllowed: z.boolean(),
  requiresDocument: z.boolean(),
  documentRequiredAfterDays: z.number().min(0).max(366).nullable(),
  minNoticeDays: z.number().int().min(0).max(365),
  allowPastDates: z.boolean(),
  maxPastDays: z.number().int().min(0).max(365),
  validateBalance: z.boolean(),
  allowNegative: z.boolean(),
  maxNegative: quarterStep(z.number().min(0).max(366)).nullable(),
  requiresApproval: z.boolean(),
  applicableCategories: z.array(z.enum(EMPLOYEE_CATEGORIES)),
};
const typeFields = {
  name: text(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,10}$/, 'Use 1 to 10 letters, digits or hyphens'),
  kind: z.enum(LEAVE_KINDS),
  eventBased: z.boolean(),
  applicableGenders: z.array(z.enum(EMPLOYEE_GENDERS)),
  maxRequestsPerMonth: z.number().int().min(1).max(31).nullable(),
  description: z.string().trim().max(500).nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour'),
  isActive: z.boolean(),
  effectiveFrom: dateOnly,
  ...ruleFields,
};
export const leaveTypeCreateBody = z.strictObject(typeFields).partial().required({ name: true, code: true });
export const leaveTypeUpdateBody = z.strictObject(typeFields).partial();

const policyRule = z.strictObject({ leaveType: objectId, isAllowed: z.boolean(), ...ruleFields }).partial().required({ leaveType: true });
const policyFields = {
  name: text(100),
  description: z.string().trim().max(500).nullable(),
  departments: z.array(objectId),
  locations: z.array(objectId),
  designations: z.array(z.string().trim().min(1).max(100)),
  categories: z.array(z.enum(EMPLOYEE_CATEGORIES)),
  rules: z.array(policyRule).max(100),
  effectiveFrom: dateOnly,
  effectiveTo: dateOnly.nullable(),
  isActive: z.boolean(),
};
export const policyCreateBody = z.strictObject(policyFields).partial().required({ name: true, effectiveFrom: true });
export const policyUpdateBody = z.strictObject(policyFields).partial();

/* Calendar */
/* Personal events and tasks */
export const calendarItemBody = z.strictObject({
  kind: z.enum(CALENDAR_ITEM_KINDS),
  title: text(200),
  description: z.string().trim().max(2000).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  date: dateOnly,
  endDate: dateOnly.nullable().optional(),
  allDay: z.boolean().default(false),
  startTime: clockTime.nullable().optional(),
  endTime: clockTime.nullable().optional(),
  color: z.enum(CALENDAR_ITEM_COLORS).default('brand'),
  visibility: z.enum(CALENDAR_ITEM_VISIBILITY).default('PRIVATE'),
  reminderMinutes: z.number().int().min(0).max(10_080).nullable().optional(),
});
export const calendarItemDoneBody = z.strictObject({ done: z.boolean() });

export const calendarQuery = z
  .object({
    start: dateOnly,
    end: dateOnly,
    department: objectId.optional(),
    leaveType: objectId.optional(),
    status: z.enum(['PENDING', 'APPROVED', 'ALL']).optional(),
    search: z.string().trim().max(100).optional(),
    employeeId: objectId.optional(),
  })
  .refine((q) => q.start <= q.end, { message: 'start must not be after end', path: ['end'] });
export const summaryQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  month,
  department: objectId.optional(),
  leaveType: objectId.optional(),
  search: z.string().trim().max(100).optional(),
});
export const summaryDetailsQuery = z.object({ month, kind: z.enum(SUMMARY_DETAIL_KINDS), department: objectId.optional(), leaveType: objectId.optional(), search: z.string().trim().max(100).optional() });
export const calendarExportQuery = z.object({
  month,
  format: exportFormat,
  department: objectId.optional(),
  leaveType: objectId.optional(),
  search: z.string().trim().max(100).optional(),
});

/* Reports */
const reportFilters = {
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  month: month.optional(),
  year: year.optional(),
  employee: objectId.optional(),
  department: objectId.optional(),
  leaveType: objectId.optional(),
};
export const reportParams = z.object({ report: z.enum(REPORT_NAMES) });
export const reportQuery = z.object({ ...paginationQuery, limit: z.coerce.number().int().min(1).max(500).default(100), ...reportFilters });
export const reportExportQuery = z.object({ report: z.enum(REPORT_NAMES), format: exportFormat, ...reportFilters });

/* Audit and notifications */
export const auditQuery = z.object({
  ...paginationQuery,
  action: z.string().trim().max(60).optional(),
  category: z.enum(['HR', 'SECURITY', 'SYSTEM']).optional(),
  entityType: z.string().trim().max(60).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  search: z.string().trim().max(100).optional(),
});
export const notificationQuery = z.object({ ...paginationQuery, unread: z.enum(['true', 'false']).optional() });

/* Super Admin */
const permissionList = z.array(z.enum(HR_ASSIGNABLE_PERMISSIONS as [string, ...string[]]));
export const adminCreateBody = z
  .strictObject({
    email: email.optional(),
    employee: objectId.optional(),
    role: z.enum(['HR_ADMIN', 'SUPER_ADMIN']),
    permissions: permissionList.nullable().optional(),
  })
  .refine((b) => Boolean(b.email) !== Boolean(b.employee), 'Provide either an email for a new account or an existing employee');
export const adminUpdateBody = z.strictObject({
  role: z.enum(['EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN']).optional(),
  permissions: permissionList.nullable().optional(),
  isActive: z.boolean().optional(),
});
export const adminListQuery = z.object({ ...paginationQuery, search: z.string().trim().max(100).optional() });

const compOffSettings = z.strictObject({
  validityDays: z.number().int().min(1).max(3650),
  allowOnWeeklyOff: z.boolean(),
  allowOnHoliday: z.boolean(),
  allowHalfDay: z.boolean(),
  maxClaimAgeDays: z.number().int().min(0).max(3650),
  requireDocument: z.boolean(),
  expiryWarningDays: z.number().int().min(0).max(365),
}).partial();

const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const settingsBody = z.strictObject({
  companyName: text(120),
  timezone: z.string().refine(validTimezone, 'Must be a valid IANA timezone'),
  reserveBalanceOnPending: z.boolean(),
  compOff: compOffSettings,
  security: z.strictObject({
    maxFailedLogins: z.number().int().min(1).max(50),
    lockoutMinutes: z.number().int().min(1).max(1440),
    minPasswordLength: z.number().int().min(8).max(128),
  }).partial(),
  attendanceStartDate: dateOnly.nullable(),
  notifications: z.strictObject({
    emailEnabled: z.boolean(),
    holidayReminderDays: z.number().int().min(0).max(60),
    approvalReminderDays: z.number().int().min(1).max(60),
    approvalEscalationDays: z.number().int().min(1).max(60),
    punchReminderEnabled: z.boolean(),
    punchReminderTime: clockTime,
  }).partial(),
}).partial();
export const compOffSettingsBody = compOffSettings;

const workflowFields = {
  name: text(100),
  steps: z.array(z.strictObject({ order: z.number().int().min(1), approverType: z.enum(APPROVER_TYPES), label: z.string().trim().max(80).default('') })).min(1).max(5),
  leaveTypes: z.array(objectId),
  isDefault: z.boolean(),
  isActive: z.boolean(),
};
export const workflowCreateBody = z.strictObject(workflowFields).partial().required({ name: true, steps: true });
export const workflowUpdateBody = z.strictObject(workflowFields).partial();
