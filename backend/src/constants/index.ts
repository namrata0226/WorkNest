export const ROLES = { EMPLOYEE: 'EMPLOYEE', HR_ADMIN: 'HR_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' } as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];
export const ROLE_VALUES = Object.values(ROLES);

export const PERMISSIONS = {
  EMPLOYEES_READ: 'employees:read',
  EMPLOYEES_WRITE: 'employees:write',
  ORG_MANAGE: 'org:manage',
  LEAVE_READ_ALL: 'leave:read_all',
  LEAVE_APPROVE: 'leave:approve',
  LEAVE_POLICY_MANAGE: 'leave_policy:manage',
  BALANCES_READ: 'balances:read',
  BALANCES_ADJUST: 'balances:adjust',
  COMPOFF_MANAGE: 'compoff:manage',
  HOLIDAYS_MANAGE: 'holidays:manage',
  CALENDAR_READ: 'calendar:read',
  REPORTS_READ: 'reports:read',
  AUDIT_READ: 'audit:read',
  AUDIT_READ_SYSTEM: 'audit:read_system',
  ADMINS_MANAGE: 'admins:manage',
  SETTINGS_MANAGE: 'settings:manage',
  WORKFLOWS_MANAGE: 'workflows:manage',
  ATTENDANCE_MANAGE: 'attendance:manage',
  PAYROLL_READ: 'payroll:read',
  EMPLOYEE_PRIVATE_READ: 'employee_private:read',
  EXPENSES_MANAGE: 'expenses:manage',
  ANNOUNCEMENTS_MANAGE: 'announcements:manage',
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

const SUPER_ADMIN_ONLY: Permission[] = [
  PERMISSIONS.AUDIT_READ_SYSTEM,
  PERMISSIONS.ADMINS_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.WORKFLOWS_MANAGE,
];

/** Permissions a Super Admin may assign to an HR/Admin account. */
export const HR_ASSIGNABLE_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !SUPER_ADMIN_ONLY.includes(p));

export function permissionsFor(role: Role, custom?: string[] | null): Permission[] {
  if (role === ROLES.SUPER_ADMIN) return ALL_PERMISSIONS;
  if (role === ROLES.EMPLOYEE) return [];
  if (custom) return custom.filter((p): p is Permission => HR_ASSIGNABLE_PERMISSIONS.includes(p as Permission));
  return HR_ASSIGNABLE_PERMISSIONS;
}

export const EMPLOYMENT_STATUS = ['ACTIVE', 'ON_NOTICE', 'INACTIVE'] as const;
export const EMPLOYEE_CATEGORIES = ['PERMANENT', 'CONTRACT', 'INTERN', 'CONSULTANT'] as const;
export const EMPLOYEE_GENDERS = ['FEMALE', 'MALE', 'OTHER'] as const;

export const LEAVE_KINDS = ['STANDARD', 'COMP_OFF', 'OPTIONAL_HOLIDAY'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CANCELLATION_REQUESTED: 'CANCELLATION_REQUESTED',
} as const;
export type LeaveStatus = (typeof LEAVE_STATUS)[keyof typeof LEAVE_STATUS];
export const LEAVE_STATUS_VALUES = Object.values(LEAVE_STATUS);
/** Statuses that occupy the employee's calendar and block overlapping requests. */
export const ACTIVE_LEAVE_STATUSES: LeaveStatus[] = [LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED, LEAVE_STATUS.CANCELLATION_REQUESTED];
/** Statuses whose days have actually been deducted from a balance. */
export const CONFIRMED_LEAVE_STATUSES: LeaveStatus[] = [LEAVE_STATUS.APPROVED, LEAVE_STATUS.CANCELLATION_REQUESTED];

export const DAY_TYPES = ['FULL', 'HALF'] as const;
export const HALF_SESSIONS = ['FIRST', 'SECOND'] as const;
export type HalfSession = (typeof HALF_SESSIONS)[number];

/** Signed amount on a ledger row is its effect on the available balance. */
export const LEDGER_TYPES = ['OPENING', 'ENTITLEMENT', 'ACCRUAL', 'CREDIT', 'CARRY_FORWARD', 'EXPIRY', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'DEBIT', 'RESTORE'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const COMPOFF_REQUEST_STATUS = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const COMPOFF_TX_TYPES = ['CREDIT', 'RESERVE', 'RELEASE', 'DEBIT', 'RESTORE', 'EXPIRE', 'ADJUSTMENT'] as const;
export type CompOffTxType = (typeof COMPOFF_TX_TYPES)[number];

export const HOLIDAY_CATEGORIES = ['NATIONAL', 'PUBLIC', 'FESTIVAL', 'COMPANY', 'OPTIONAL', 'REGIONAL', 'CUSTOM'] as const;
export type HolidayCategory = (typeof HOLIDAY_CATEGORIES)[number];

export const APPROVER_TYPES = ['REPORTING_MANAGER', 'HR_ADMIN', 'SUPER_ADMIN'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

export const NOTIFICATION_TYPES = [
  'LEAVE_SUBMITTED', 'LEAVE_APPROVED', 'LEAVE_REJECTED', 'LEAVE_CANCELLED',
  'CANCELLATION_REQUESTED', 'CANCELLATION_APPROVED', 'CANCELLATION_REJECTED',
  'COMPOFF_SUBMITTED', 'COMPOFF_CREDITED', 'COMPOFF_REJECTED', 'COMPOFF_EXPIRING',
  'HOLIDAY_UPCOMING', 'APPROVAL_REQUIRED', 'BALANCE_ADJUSTED',
  'WFH_REQUESTED', 'WFH_APPROVED', 'WFH_REJECTED', 'WFH_CANCELLED', 'ATTENDANCE_CORRECTED',
  'ATTENDANCE_CORRECTION_REQUESTED', 'APPROVAL_REMINDER', 'PUNCH_REMINDER', 'CHECKLIST_UPDATED',
  'EXPENSE_SUBMITTED', 'EXPENSE_APPROVED', 'EXPENSE_REJECTED', 'EXPENSE_PAID', 'ANNOUNCEMENT',
] as const;
export const EMAIL_ACTION_KINDS = ['LEAVE', 'WFH', 'CORRECTION', 'EXPENSE'] as const;
export type EmailActionKind = (typeof EMAIL_ACTION_KINDS)[number];

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const AUDIT_CATEGORIES = ['HR', 'SECURITY', 'SYSTEM'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
