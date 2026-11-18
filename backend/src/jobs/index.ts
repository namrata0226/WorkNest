import cron from 'node-cron';
import { logger } from '../config/logger';
import { Types } from 'mongoose';
import { PERMISSIONS, ROLES } from '../constants';
import { AttendanceCorrection, IAttendanceCorrection, IWfhRequest, WfhRequest } from '../models/Attendance';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { ExpenseClaim, IExpenseClaim } from '../models/People';
import { Notification } from '../models/System';
import { IUser, User } from '../models/User';
import { dailyAttendance } from '../services/attendance';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { expireCarryForward, runCarryForward, syncEntitlement } from '../services/balance';
import { expireCompOffLots, warnExpiringCompOff } from '../services/compoff';
import { flushEmailOutbox } from '../services/email';
import { holidayAppliesTo, holidayOccurrences } from '../services/holiday';
import { adminsWithPermission, approverUsers, notifyUsers } from '../services/notification';
import { syncOutlookCalendars } from '../services/outlookCalendar';
import { effectiveRule, resolvePolicy } from '../services/policy';
import { companyToday, getSettings } from '../services/settings';
import { addDays, todayIn, yearOf } from '../utils/dates';

/** Grants entitlements and accruals still owed. Ledger idempotency keys make re-runs harmless. */
export async function syncAllEntitlements(today: string): Promise<void> {
  const year = yearOf(today);
  const [employees, types] = await Promise.all([
    Employee.find({ employmentStatus: { $ne: 'INACTIVE' } }).lean<IEmployee[]>(),
    LeaveType.find({ isActive: true, kind: { $ne: 'COMP_OFF' } }).lean<ILeaveType[]>(),
  ]);
  for (const employee of employees) {
    const policy = await resolvePolicy(employee, today);
    for (const type of types) {
      await syncEntitlement(employee, type, effectiveRule(type, policy, employee), year, today);
    }
  }
}

export async function remindUpcomingHolidays(today: string): Promise<number> {
  const settings = await getSettings();
  const horizon = addDays(today, settings.notifications.holidayReminderDays);
  const holidays = (await holidayOccurrences(today, horizon)).filter((h) => h.category !== 'OPTIONAL');
  if (!holidays.length) return 0;
  const employees = await Employee.find({ employmentStatus: { $ne: 'INACTIVE' }, user: { $ne: null } }).select('user location department category').lean<IEmployee[]>();
  let sent = 0;
  for (const h of holidays) {
    for (const e of employees.filter((emp) => holidayAppliesTo(h, emp))) {
      try {
        await notifyUsers([e.user], {
          type: 'HOLIDAY_UPCOMING',
          title: `Upcoming holiday: ${h.name}`,
          message: `${h.name} is on ${h.occurrenceDate}.`,
          link: '/holidays',
          dedupeKey: `holiday:${h._id}:${h.occurrenceDate}`,
        });
        sent++;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
  }
  return sent;
}

/** A reminder once a request has waited long enough, then one escalation to Super Admins. Each is sent only once. */
export async function remindPendingApprovals(now: Date = new Date()): Promise<number> {
  const { notifications } = await getSettings();
  const olderThan = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const reminderCutoff = olderThan(notifications.approvalReminderDays);
  const escalationCutoff = olderThan(notifications.approvalEscalationDays);
  const superAdmins = (await User.find({ role: ROLES.SUPER_ADMIN, isActive: true }).select('_id').lean<IUser[]>()).map((u) => u._id);
  const waiting = [
    ...(await LeaveRequest.find({ status: 'PENDING', createdAt: { $lte: reminderCutoff } }).limit(500).lean<ILeaveRequest[]>()).map((r) => ({ kind: 'LEAVE' as const, label: 'leave request', r, approvers: (e: IEmployee) => approverUsers(r.currentApproverType ?? 'HR_ADMIN', e), link: `/approvals?request=${r._id}` })),
    ...(await WfhRequest.find({ status: 'PENDING', createdAt: { $lte: reminderCutoff } }).limit(500).lean<IWfhRequest[]>()).map((r) => ({ kind: 'WFH' as const, label: 'work from home request', r, approvers: async (e: IEmployee) => [...await approverUsers('REPORTING_MANAGER', e), ...await approverUsers('HR_ADMIN', e)], link: '/approvals' })),
    ...(await AttendanceCorrection.find({ status: 'PENDING', createdAt: { $lte: reminderCutoff } }).limit(500).lean<IAttendanceCorrection[]>()).map((r) => ({ kind: 'CORRECTION' as const, label: 'attendance correction', r, approvers: async (e: IEmployee) => [...await approverUsers('REPORTING_MANAGER', e), ...await adminsWithPermission(PERMISSIONS.ATTENDANCE_MANAGE)], link: '/approvals' })),
    ...(await ExpenseClaim.find({ status: 'PENDING', createdAt: { $lte: reminderCutoff } }).limit(500).lean<IExpenseClaim[]>()).map((r) => ({ kind: 'EXPENSE' as const, label: 'expense claim', r, approvers: async (e: IEmployee) => [...await approverUsers('REPORTING_MANAGER', e), ...await adminsWithPermission(PERMISSIONS.EXPENSES_MANAGE)], link: '/approvals' })),
  ];
  let sent = 0;
  const send = async (recipient: Types.ObjectId, title: string, message: string, item: (typeof waiting)[number], stage: string) => {
    try {
      await notifyUsers([recipient], { type: 'APPROVAL_REMINDER', title, message, link: item.link, dedupeKey: `${stage}:${item.kind}:${item.r._id}`, action: { kind: item.kind, id: item.r._id } });
      sent++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  };
  for (const item of waiting) {
    const employee = await Employee.findById(item.r.employee).lean<IEmployee>();
    if (!employee) continue;
    const others = (ids: Types.ObjectId[]) => [...new Set(ids.map(String))].filter((id) => id !== String(employee.user)).map((id) => new Types.ObjectId(id));
    for (const id of others(await item.approvers(employee))) {
      await send(id, `Reminder: ${item.label} waiting`, `${employee.fullName}'s ${item.label} is still waiting for a decision.`, item, 'reminder');
    }
    if (item.r.createdAt <= escalationCutoff) {
      for (const id of others(superAdmins)) {
        await send(id, `Overdue: ${item.label} from ${employee.fullName}`, `${employee.fullName}'s ${item.label} has waited over ${notifications.approvalEscalationDays} days. You can decide it, or follow up with the approver.`, item, 'escalation');
      }
    }
  }
  return sent;
}

/** One nudge a day, after the set time, to people due in today. Leave, holidays and work from home do not need one. */
export async function remindMissingPunches(now: Date = new Date()): Promise<number> {
  const { notifications, timezone } = await getSettings();
  if (!notifications.punchReminderEnabled) return 0;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  if (time < notifications.punchReminderTime) return 0;
  const today = todayIn(timezone, now);
  if (await Notification.exists({ type: 'PUNCH_REMINDER', dedupeKey: new RegExp(`^punch:${today}:`) })) return 0;
  const { rows } = await dailyAttendance({ date: today });
  const due = rows.filter((r) => r.status === 'UPCOMING');
  const users = await Employee.find({ _id: { $in: due.map((r) => r.employee._id) }, user: { $ne: null } }).select('user').lean<IEmployee[]>();
  let sent = 0;
  for (const e of users) {
    try {
      await notifyUsers([e.user], { type: 'PUNCH_REMINDER', title: 'Forgot to punch in?', message: `You have not punched in today (${today}). If you are working, please punch in.`, link: '/attendance', dedupeKey: `punch:${today}` });
      sent++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return sent;
}

export async function runDailyJobs(today?: string): Promise<void> {
  const date = today ?? (await companyToday());
  await runCarryForward(yearOf(date));
  await syncAllEntitlements(date);
  await expireCarryForward(date);
  await expireCompOffLots(date);
  await warnExpiringCompOff(date);
  await remindUpcomingHolidays(date);
  await remindPendingApprovals();
}

const guarded = (name: string, fn: () => Promise<unknown>) => async () => {
  try {
    await fn();
  } catch (err) {
    logger.error({ err: (err as Error).message, job: name }, 'Scheduled job failed');
  }
};

/** Run one instance with JOBS_ENABLED=true. Duplicates stay harmless because of the idempotency keys. */
export function startJobs(): void {
  cron.schedule('5 0 * * *', guarded('daily', () => runDailyJobs()));
  cron.schedule('* * * * *', guarded('email-outbox', () => flushEmailOutbox()));
  cron.schedule('* * * * *', guarded('outlook-calendar', () => syncOutlookCalendars()));
  cron.schedule('*/5 * * * *', guarded('punch-reminder', () => remindMissingPunches()));
  void guarded('daily-startup', () => runDailyJobs())();
  logger.info('Scheduled jobs started');
}
