import { Types } from 'mongoose';
import { LeaveKind } from '../constants';
import { ApprovalWorkflow, LeaveType } from '../models/LeaveConfig';
import { getSettings } from './settings';

type TypeSeed = { name: string; code: string; color: string; kind?: LeaveKind } & Record<string, unknown>;

export const DEFAULT_LEAVE_TYPES: TypeSeed[] = [
  { name: 'Casual Leave', code: 'CL', color: '#0f766e', annualEntitlement: 12, maxDuration: 5 },
  { name: 'Sick Leave', code: 'SL', color: '#be123c', annualEntitlement: 10, allowPastDates: true, maxPastDays: 7, documentRequiredAfterDays: 2 },
  { name: 'Earned Leave', code: 'EL', color: '#4338ca', annualEntitlement: 15, carryForward: true, maxCarryForward: 15, minNoticeDays: 3 },
  { name: 'Privilege Leave', code: 'PL', color: '#7c3aed', isActive: false },
  { name: 'Annual Leave', code: 'AL', color: '#0369a1', isActive: false },
  { name: 'Comp-Off', code: 'CO', color: '#b45309', kind: 'COMP_OFF' },
  { name: 'Maternity Leave', code: 'ML', color: '#c026d3', eventBased: true, applicableGenders: ['FEMALE'], annualEntitlement: 130, halfDayAllowed: false, requiresDocument: true, prorateOnJoining: false, minNoticeDays: 14 },
  { name: 'Paternity Leave', code: 'PAT', color: '#2563eb', eventBased: true, applicableGenders: ['MALE'], annualEntitlement: 5, halfDayAllowed: false, prorateOnJoining: false },
  { name: 'Menstrual Leave', code: 'MNL', color: '#db2777', description: 'One day a month, approved automatically.', eventBased: true, applicableGenders: ['FEMALE'], maxRequestsPerMonth: 1, annualEntitlement: 12, maxDuration: 1, halfDayAllowed: false, allowPastDates: true, maxPastDays: 3, requiresApproval: false, prorateOnJoining: false },
  { name: 'Bereavement Leave', code: 'BL', color: '#475569', eventBased: true, annualEntitlement: 5, halfDayAllowed: false, allowPastDates: true, maxPastDays: 7, prorateOnJoining: false },
  { name: 'Unpaid Leave', code: 'LWP', color: '#71717a', isPaid: false, validateBalance: false },
  { name: 'Optional Holiday', code: 'OH', color: '#65a30d', kind: 'OPTIONAL_HOLIDAY', annualEntitlement: 2, halfDayAllowed: false, prorateOnJoining: false },
];

/** Configuration every installation needs. Existing records are left as they are. */
export async function ensureBaseline(today: string): Promise<Map<string, Types.ObjectId>> {
  await getSettings();
  for (const t of DEFAULT_LEAVE_TYPES) {
    await LeaveType.updateOne({ code: t.code }, { $setOnInsert: { effectiveFrom: today, ...t } }, { upsert: true, setDefaultsOnInsert: true });
    // Types created before gender rules existed never had the field. A value an admin has saved is kept.
    if (t.applicableGenders) await LeaveType.updateOne({ code: t.code, applicableGenders: { $exists: false } }, { $set: { applicableGenders: t.applicableGenders } });
  }
  await ApprovalWorkflow.updateOne(
    { isDefault: true },
    { $setOnInsert: { name: 'HR approval', isDefault: true, isActive: true, steps: [{ order: 1, approverType: 'HR_ADMIN', label: 'HR approval' }] } },
    { upsert: true },
  );
  const types = await LeaveType.find().select('code').lean();
  return new Map(types.map((t) => [t.code, t._id]));
}
