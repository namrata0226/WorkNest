export const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  PAID: 'Paid',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  CANCELLATION_REQUESTED: 'Cancellation requested',
  ACTIVE: 'Active',
  ON_NOTICE: 'On notice',
  INACTIVE: 'Inactive',
  WAITING: 'Waiting',
};

export const STATUS_TONE: Record<string, 'green' | 'amber' | 'rose' | 'gray' | 'sky'> = {
  PENDING: 'amber',
  APPROVED: 'green',
  PAID: 'green',
  REJECTED: 'rose',
  CANCELLED: 'gray',
  CANCELLATION_REQUESTED: 'sky',
  ACTIVE: 'green',
  ON_NOTICE: 'amber',
  INACTIVE: 'gray',
  WAITING: 'gray',
};

export const LEDGER_LABEL: Record<string, string> = {
  OPENING: 'Opening balance',
  ENTITLEMENT: 'Annual entitlement',
  ACCRUAL: 'Monthly accrual',
  CREDIT: 'Credit',
  CARRY_FORWARD: 'Carry-forward',
  EXPIRY: 'Expired',
  ADJUSTMENT: 'Adjustment',
  RESERVE: 'Held for pending leave',
  RELEASE: 'Hold released',
  DEBIT: 'Leave taken',
  RESTORE: 'Leave restored',
  EXPIRE: 'Expired',
};

export const HOLIDAY_CATEGORIES = ['NATIONAL', 'PUBLIC', 'FESTIVAL', 'COMPANY', 'OPTIONAL', 'REGIONAL', 'CUSTOM'] as const;
export const EXPENSE_CATEGORIES = ['TRAVEL', 'FOOD', 'ACCOMMODATION', 'SUPPLIES', 'INTERNET_PHONE', 'OTHER'] as const;
export const EMPLOYEE_CATEGORIES = ['PERMANENT', 'CONTRACT', 'INTERN', 'CONSULTANT'] as const;
export const EMPLOYEE_GENDERS = ['FEMALE', 'MALE', 'OTHER'] as const;

export const ROLE_LABEL: Record<string, string> = { EMPLOYEE: 'Employee', HR_ADMIN: 'HR/Admin', SUPER_ADMIN: 'Super Admin' };

export const titleCase = (text: string) => text.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const PERMISSION_LABEL: Record<string, string> = {
  'employees:read': 'View employees',
  'employees:write': 'Manage employees',
  'org:manage': 'Manage teams and locations',
  'leave:read_all': 'View all leave',
  'leave:approve': 'Approve leave',
  'leave_policy:manage': 'Manage leave types and policies',
  'balances:read': 'View balances',
  'balances:adjust': 'Adjust balances',
  'compoff:manage': 'Manage Comp-Off',
  'holidays:manage': 'Manage holidays',
  'calendar:read': 'View company calendar',
  'reports:read': 'View reports and exports',
  'audit:read': 'View HR audit log',
  'attendance:manage': 'View and correct attendance',
  'payroll:read': 'View and export payroll figures',
  'employee_private:read': 'View bank details and personal documents',
  'expenses:manage': 'Manage expense claims',
  'announcements:manage': 'Publish announcements and policies',
};
