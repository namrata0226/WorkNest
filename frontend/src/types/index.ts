export type Role = 'EMPLOYEE' | 'HR_ADMIN' | 'SUPER_ADMIN';

export type Permission =
  | 'employees:read' | 'employees:write' | 'org:manage' | 'leave:read_all' | 'leave:approve' | 'leave_policy:manage'
  | 'balances:read' | 'balances:adjust' | 'compoff:manage' | 'holidays:manage' | 'calendar:read' | 'reports:read'
  | 'audit:read' | 'audit:read_system' | 'admins:manage' | 'settings:manage' | 'workflows:manage' | 'attendance:manage'
  | 'payroll:read' | 'employee_private:read' | 'expenses:manage' | 'announcements:manage';

export interface Named { _id: string; name: string }

export type AttendanceStatus = 'PRESENT' | 'WFH' | 'ON_LEAVE' | 'HALF_LEAVE' | 'HOLIDAY' | 'WEEKEND' | 'ABSENT' | 'UPCOMING' | 'NOT_EMPLOYED' | 'NOT_TRACKED';

export interface AttendanceDay {
  date: string;
  status: AttendanceStatus;
  holiday: string | null;
  punchIn: string | null;
  punchOut: string | null;
  workedMinutes: number | null;
  corrected: boolean;
  correctionNote: string | null;
}

/** `attended` = present + work from home, out of `workingDays` (present + WFH + leave + absent). */
export interface AttendanceSummary { present: number; workFromHome: number; attended: number; onLeave: number; absent: number; workingDays: number }

export interface AttendanceMonth {
  today: string;
  month: string;
  /** The period the days cover. */
  from?: string;
  to?: string;
  employee: { _id: string; fullName: string; employeeId: string };
  days: AttendanceDay[];
  summary: AttendanceSummary;
}

export interface AttendanceToday { date: string; punchIn: string | null; punchOut: string | null; workedMinutes: number | null }

export interface WfhRequest {
  _id: string;
  employee: PersonRef;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  decidedByName: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface Employee {
  _id: string;
  employeeId: string;
  fullName: string;
  email: string;
  phone?: string | null;
  gender?: 'FEMALE' | 'MALE' | 'OTHER' | null;
  department?: Named | null;
  designation?: string | null;
  reportingManager?: { _id: string; fullName: string; employeeId: string } | null;
  joiningDate: string;
  location?: Named | null;
  employmentStatus: 'ACTIVE' | 'ON_NOTICE' | 'INACTIVE';
  category: 'PERMANENT' | 'CONTRACT' | 'INTERN' | 'CONSULTANT';
  leavePolicy?: Named | null;
  avatarFile?: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  role: Role;
  permissions: Permission[];
  mustChangePassword: boolean;
  avatarUrl?: string | null;
  isManager?: boolean;
  employee: Employee | null;
}

export type PersonRef = string | { _id: string; fullName: string; employeeId: string; department?: Named | null; avatarFile?: string | null };

export interface AttendanceCorrection {
  _id: string;
  employee: PersonRef;
  date: string;
  punchIn: string;
  punchOut: string | null;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  decidedByName?: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface ExpenseClaim {
  _id: string;
  employee: PersonRef;
  category: string;
  expenseDate: string;
  amount: number;
  description: string;
  receipt: { _id: string; originalName: string } | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'CANCELLED';
  decidedByName?: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface Announcement {
  _id: string;
  kind: 'ANNOUNCEMENT' | 'POLICY';
  title: string;
  body: string;
  document: { _id: string; originalName: string } | null;
  requiresAck: boolean;
  publishedByName: string;
  acknowledged: boolean;
  createdAt: string;
}

export interface EmployeeDetails {
  bank: { holderName: string; bankName: string; ifsc: string; accountLast4: string } | null;
  emergencyContacts: { name: string; relationship: string; phone: string }[];
  address: string | null;
}

export interface PersonalDocument { _id: string; originalName: string; mimeType: string; size: number; createdAt: string }

export interface Checklist {
  _id: string;
  kind: 'ONBOARDING' | 'EXIT';
  items: { _id: string; label: string; owner: 'HR' | 'EMPLOYEE'; done: boolean; doneByName: string | null }[];
}

export interface LeaveTypeRef { _id: string; name: string; code: string; color: string; kind?: string; isPaid?: boolean; validateBalance?: boolean; eventBased?: boolean }

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'CANCELLATION_REQUESTED';

export interface ApprovalStep { order: number; approverType: string; label: string; status: string; actedByName: string | null; comment: string | null; actedAt: string | null }

export interface LeaveRequest {
  _id: string;
  employee: { _id: string; employeeId: string; fullName: string; designation?: string; department?: Named | null; avatarFile?: string | null };
  leaveType: LeaveTypeRef;
  startDate: string;
  endDate: string;
  dayType: 'FULL' | 'HALF';
  halfSession: 'FIRST' | 'SECOND' | null;
  reason: string | null;
  handoverNotes: string | null;
  outlookEventId?: string | null;
  outlookSyncError?: 'MAILBOX_NOT_FOUND' | 'REQUEST_REJECTED' | null;
  document: { _id: string; originalName: string } | null;
  totalDays: number;
  dayBreakdown: { date: string; value: number }[];
  status: LeaveStatus;
  approvalSteps: ApprovalStep[];
  currentApproverType: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  createdAt: string;
  balance?: BalanceRow | null;
}

export interface BalanceRow {
  leaveType: LeaveTypeRef;
  isCompOff: boolean;
  year: number;
  openingBalance?: number;
  entitlement?: number;
  credited?: number;
  used?: number;
  reserved?: number;
  carryForward?: number;
  expired?: number;
  adjustments?: number;
  available?: number;
}

export interface LedgerRow {
  _id: string;
  leaveType?: LeaveTypeRef;
  year: number;
  type: string;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  createdAt: string;
  performedBy?: { email: string } | null;
}

export interface CompOffSummary {
  earned: number;
  used: number;
  reserved: number;
  expired: number;
  adjustedOut: number;
  available: number;
  pendingCredit: number;
  nextExpiry: string | null;
  lots: { id: string; earnedDate: string | null; expiresOn: string | null; remaining: number }[];
}

export interface CompOffRequest {
  _id: string;
  employee: { _id: string; employeeId: string; fullName: string; department?: Named | null };
  workedDate: string;
  dayType: 'FULL' | 'HALF';
  amount: number;
  reason: string;
  occasion: string;
  document: { _id: string; originalName: string } | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  expiresOn: string | null;
  decisionComment: string | null;
  createdAt: string;
}

export interface CompOffTx {
  _id: string;
  employee?: { employeeId: string; fullName: string };
  type: string;
  amount: number;
  reason: string | null;
  earnedDate: string | null;
  expiresOn: string | null;
  remaining: number;
  createdAt: string;
}

export interface Holiday {
  _id: string;
  name: string;
  date: string;
  occurrenceDate: string;
  category: string;
  description: string | null;
  locations: string[];
  departments: string[];
  employeeCategories: string[];
  isHalfDay: boolean;
  halfDaySession: 'FIRST' | 'SECOND';
  recurring: boolean;
}

export interface LeaveType extends LeaveTypeRef {
  kind: string;
  eventBased: boolean;
  description: string | null;
  isPaid: boolean;
  annualEntitlement: number;
  monthlyAccrual: number;
  prorateOnJoining: boolean;
  carryForward: boolean;
  maxCarryForward: number;
  carryForwardExpiryDays: number | null;
  minDuration: number;
  maxDuration: number | null;
  halfDayAllowed: boolean;
  requiresDocument: boolean;
  documentRequiredAfterDays: number | null;
  minNoticeDays: number;
  allowPastDates: boolean;
  maxPastDays: number;
  validateBalance: boolean;
  allowNegative: boolean;
  maxNegative: number | null;
  requiresApproval: boolean;
  applicableCategories: string[];
  applicableGenders: string[];
  maxRequestsPerMonth: number | null;
  isActive: boolean;
  effectiveFrom: string;
}

export interface PageMeta { page: number; limit: number; total: number; totalPages: number; unread?: number }

export interface ApiFieldError { path: string; message: string }

export interface NotificationItem { _id: string; type: string; title: string; message: string; link: string | null; readAt: string | null; createdAt: string }

export type CalendarItemKind = 'EVENT' | 'TASK';
export type CalendarItemColor = 'brand' | 'sky' | 'violet' | 'amber' | 'rose' | 'slate';
export interface CalendarItem {
  _id: string;
  owner: string;
  ownerName: string;
  kind: CalendarItemKind;
  title: string;
  description: string | null;
  location: string | null;
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  color: CalendarItemColor;
  visibility: 'PRIVATE' | 'COMPANY';
  reminderMinutes: number | null;
  done: boolean;
  doneAt: string | null;
}
