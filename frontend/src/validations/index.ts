import { z } from 'zod';
import './messages';

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');
const required = (label: string, max = 1000) => z.string().trim().min(1, `${label} is required`).max(max, `${label} must be ${max.toLocaleString('en-IN')} characters or fewer`);
const optionalText = (label: string, max: number) => z.string().max(max, `${label} must be ${max.toLocaleString('en-IN')} characters or fewer`);
const emailField = z.string().trim().min(1, 'Email is required').email('Enter a valid email address');

export const loginSchema = z.object({ email: emailField, password: z.string().min(1, 'Password is required') });
export type LoginForm = z.infer<typeof loginSchema>;

export const forgotSchema = z.object({ email: emailField });

const passwordRule = z.string().min(10, 'Use at least 10 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');

export const resetSchema = z
  .object({ password: passwordRule, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'The passwords do not match', path: ['confirm'] });

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: passwordRule, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { message: 'The passwords do not match', path: ['confirm'] });

export const leaveSchema = z
  .object({
    leaveType: z.string().min(1, 'Choose a leave type'),
    startDate: dateField,
    endDate: dateField,
    dayType: z.enum(['FULL', 'HALF']),
    halfSession: z.enum(['FIRST', 'SECOND']).nullable().optional(),
    reason: optionalText('The reason', 1000).trim().optional(),
    // Set by the form from the leave type. The server applies the same rule for itself.
    reasonOptional: z.boolean().optional(),
    handoverNotes: optionalText('Handover notes', 2000).optional(),
  })
  .refine((v) => v.reasonOptional || Boolean(v.reason), { message: 'A reason is required', path: ['reason'] })
  .refine((v) => v.startDate <= v.endDate, { message: 'The end date cannot be before the start date', path: ['endDate'] })
  .refine((v) => v.dayType !== 'HALF' || v.startDate === v.endDate, { message: 'A half day must start and end on the same date', path: ['endDate'] })
  .refine((v) => v.dayType !== 'HALF' || Boolean(v.halfSession), { message: 'Choose the first or second half', path: ['halfSession'] });
export type LeaveForm = z.infer<typeof leaveSchema>;

export const compOffSchema = z.object({
  workedDate: dateField,
  dayType: z.enum(['FULL', 'HALF']),
  reason: required('A reason'),
});
export type CompOffForm = z.infer<typeof compOffSchema>;

export const employeeSchema = z.object({
  employeeId: z.string().trim().min(1, 'Employee ID is required').regex(/^[A-Za-z0-9-]{2,20}$/, 'Use 2 to 20 letters, digits or hyphens'),
  fullName: required('Full name', 120),
  email: emailField,
  phone: z.union([z.literal(''), z.string().regex(/^[+\d][\d\s()-]{5,20}$/, 'Enter a valid phone number')]).optional(),
  gender: z.enum(['', 'FEMALE', 'MALE', 'OTHER']).optional(),
  department: z.string().optional(),
  designation: optionalText('Designation', 100).optional(),
  reportingManager: z.string().optional(),
  joiningDate: dateField,
  location: z.string().optional(),
  category: z.enum(['PERMANENT', 'CONTRACT', 'INTERN', 'CONSULTANT']),
  leavePolicy: z.string().optional(),
});
export type EmployeeForm = z.infer<typeof employeeSchema>;

export const profileSchema = employeeSchema.pick({ fullName: true, phone: true });
export type ProfileForm = z.infer<typeof profileSchema>;

export const wfhSchema = z
  .object({ startDate: dateField, endDate: dateField, reason: required('A reason') })
  .refine((v) => v.startDate <= v.endDate, { message: 'The end date cannot be before the start date', path: ['endDate'] });
export type WfhForm = z.infer<typeof wfhSchema>;

export const attendanceCorrectionSchema = z
  .object({
    punchIn: z.string().regex(/^\d{2}:\d{2}$/, 'Enter a time'),
    punchOut: z.union([z.literal(''), z.string().regex(/^\d{2}:\d{2}$/)]).optional(),
    note: required('A reason', 500),
  })
  .refine((v) => !v.punchOut || v.punchOut > v.punchIn, { message: 'Punch out must be after punch in', path: ['punchOut'] });
export type AttendanceCorrectionForm = z.infer<typeof attendanceCorrectionSchema>;

export const correctionRequestSchema = z
  .object({
    date: dateField,
    punchIn: z.string().regex(/^\d{2}:\d{2}$/, 'Enter a time'),
    punchOut: z.union([z.literal(''), z.string().regex(/^\d{2}:\d{2}$/)]).optional(),
    reason: required('A reason', 500),
  })
  .refine((v) => !v.punchOut || v.punchOut > v.punchIn, { message: 'Punch out must be after punch in', path: ['punchOut'] });
export type CorrectionRequestForm = z.infer<typeof correctionRequestSchema>;

export const EXPENSE_MAX_AMOUNT = 10_000_000;
export const EXPENSE_DESCRIPTION_MAX = 1000;

export const expenseSchema = z.object({
  category: z.enum(['TRAVEL', 'FOOD', 'ACCOMMODATION', 'SUPPLIES', 'INTERNET_PHONE', 'OTHER']),
  expenseDate: dateField,
  amount: z
    .number({ message: 'Enter an amount' })
    .positive('Enter an amount above zero')
    .max(EXPENSE_MAX_AMOUNT, `The amount cannot be more than ₹${EXPENSE_MAX_AMOUNT.toLocaleString('en-IN')}`)
    .refine((n) => Math.round(n * 100) / 100 === n, 'Use at most two decimal places'),
  description: required('The description', EXPENSE_DESCRIPTION_MAX),
});
export type ExpenseForm = z.infer<typeof expenseSchema>;

export const announcementSchema = z.object({
  kind: z.enum(['ANNOUNCEMENT', 'POLICY']),
  title: required('A title', 200),
  body: required('A message', 10_000),
  requiresAck: z.boolean(),
});
export type AnnouncementForm = z.infer<typeof announcementSchema>;

export const holidaySchema = z.object({
  name: required('Holiday name', 120),
  date: dateField,
  category: z.enum(['NATIONAL', 'PUBLIC', 'FESTIVAL', 'COMPANY', 'OPTIONAL', 'REGIONAL', 'CUSTOM']),
  description: optionalText('The description', 500).optional(),
  isHalfDay: z.boolean(),
  halfDaySession: z.enum(['FIRST', 'SECOND']),
  recurring: z.boolean(),
  locations: z.array(z.string()),
  departments: z.array(z.string()),
  employeeCategories: z.array(z.enum(['PERMANENT', 'CONTRACT', 'INTERN', 'CONSULTANT'])),
});
export type HolidayForm = z.infer<typeof holidaySchema>;

const quarterNumber = z.number({ error: 'Enter a number' }).refine((n) => Number.isInteger(n * 4), 'Use steps of 0.25');

export const adjustmentSchema = z.object({
  leaveType: z.string().min(1, 'Choose a leave type'),
  year: z.number({ error: 'Enter a year' }).int('Enter a whole year').min(2000, 'Enter a year from 2000 to 2100').max(2100, 'Enter a year from 2000 to 2100'),
  kind: z.enum(['CREDIT', 'DEDUCTION', 'ADJUSTMENT', 'OPENING']),
  amount: quarterNumber.refine((n) => n !== 0, 'Cannot be zero'),
  reason: required('A reason', 500),
});
export type AdjustmentForm = z.infer<typeof adjustmentSchema>;

export const compOffManualSchema = z.object({
  employee: z.string().min(1, 'Choose an employee'),
  amount: quarterNumber.refine((n) => n !== 0, 'Cannot be zero'),
  reason: required('A reason', 500),
  earnedDate: z.string().optional(),
  expiresOn: z.string().optional(),
});
export type CompOffManualForm = z.infer<typeof compOffManualSchema>;

export const reasonSchema = z.object({ reason: required('A reason') });

const timeField = z.string().regex(/^\d{2}:\d{2}$/, 'Enter a time');
export const calendarItemSchema = z
  .object({
    kind: z.enum(['EVENT', 'TASK']),
    title: required('A title', 200),
    date: dateField,
    endDate: z.string().optional(),
    allDay: z.boolean(),
    startTime: z.union([z.literal(''), timeField]).optional(),
    endTime: z.union([z.literal(''), timeField]).optional(),
    location: optionalText('The location', 200).optional(),
    description: optionalText('The description', 2000).optional(),
    color: z.enum(['brand', 'sky', 'violet', 'amber', 'rose', 'slate']),
    visibility: z.enum(['PRIVATE', 'COMPANY']),
    /** A select's value: '' for none, otherwise minutes. */
    reminder: z.string(),
  })
  .superRefine((v, ctx) => {
    const timed = !v.allDay;
    if (timed && !v.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: v.kind === 'TASK' ? 'Choose a due time, or tick "No due time"' : 'Choose a start time' });
    if (timed && v.kind === 'EVENT') {
      if (!v.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Choose an end time' });
      else if (v.startTime && v.endTime <= v.startTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'The end time must be after the start time' });
    }
    if (!timed && v.kind === 'EVENT' && v.endDate && v.endDate < v.date) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date cannot be before the start date' });
  });
export type CalendarItemForm = z.infer<typeof calendarItemSchema>;
