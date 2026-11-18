import { ClientSession, Types } from 'mongoose';
import { ApproverType, EmailActionKind, NotificationType, PERMISSIONS, permissionsFor, ROLES } from '../constants';
import { Employee, IEmployee } from '../models/Employee';
import { Notification } from '../models/System';
import { IUser, User } from '../models/User';
import { getSettings } from './settings';

interface Message {
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  dedupeKey?: string;
  /** Adds Approve and Reject buttons to the email, for the people able to decide. */
  action?: { kind: EmailActionKind; id: Types.ObjectId };
}

export async function notifyUsers(recipients: (Types.ObjectId | null | undefined)[], msg: Message, session?: ClientSession): Promise<void> {
  const unique = [...new Set(recipients.filter(Boolean).map(String))];
  if (!unique.length) return;
  const settings = await getSettings();
  await Notification.insertMany(
    unique.map((recipient) => ({
      recipient,
      type: msg.type,
      title: msg.title,
      message: msg.message,
      link: msg.link ?? null,
      dedupeKey: msg.dedupeKey ? `${msg.dedupeKey}:${recipient}` : null,
      action: msg.action ?? null,
      emailStatus: settings.notifications.emailEnabled ? 'PENDING' : 'NONE',
    })),
    { session, ordered: true },
  );
}

export async function adminsWithPermission(permission: string): Promise<Types.ObjectId[]> {
  const users = await User.find({ role: { $in: [ROLES.HR_ADMIN, ROLES.SUPER_ADMIN] }, isActive: true })
    .select('role permissions')
    .lean<IUser[]>();
  const holders = users.filter((u) => (permissionsFor(u.role, u.permissions) as string[]).includes(permission));
  const hr = holders.filter((u) => u.role === ROLES.HR_ADMIN);
  // Super Admins are the fallback so that a request is never left with nobody to act on it.
  return (hr.length ? hr : holders).map((u) => u._id);
}

export async function approverUsers(type: ApproverType, employee: Pick<IEmployee, '_id' | 'reportingManager' | 'user'>): Promise<Types.ObjectId[]> {
  let recipients: Types.ObjectId[] = [];
  if (type === 'REPORTING_MANAGER' && employee.reportingManager) {
    const manager = await Employee.findById(employee.reportingManager).select('user').lean<IEmployee>();
    if (manager?.user) recipients = [manager.user];
  } else if (type === 'SUPER_ADMIN') {
    recipients = (await User.find({ role: ROLES.SUPER_ADMIN, isActive: true }).select('_id').lean<IUser[]>()).map((u) => u._id);
  }
  if (!recipients.length) recipients = await adminsWithPermission(PERMISSIONS.LEAVE_APPROVE);
  const others = recipients.filter((id) => String(id) !== String(employee.user));
  if (others.length) return others;
  // The only HR person applied and cannot decide their own request, so it goes up rather than to nobody.
  const superAdmins = await User.find({ role: ROLES.SUPER_ADMIN, isActive: true }).select('_id').lean<IUser[]>();
  return superAdmins.map((u) => u._id).filter((id) => String(id) !== String(employee.user));
}
