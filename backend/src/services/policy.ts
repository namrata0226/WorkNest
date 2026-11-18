import { IEmployee } from '../models/Employee';
import { EmployeeLeavePolicy, IEmployeeLeavePolicy, ILeavePolicy, ILeaveType, LeavePolicy, LeaveRule } from '../models/LeaveConfig';

export interface EffectiveRule extends LeaveRule {
  allowed: boolean;
  policyName: string | null;
}

type PolicyEmployee = Pick<IEmployee, '_id' | 'department' | 'location' | 'designation' | 'category'>;

const inEffect = (date: string) => ({
  effectiveFrom: { $lte: date },
  $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }],
});

/** A rule-based policy applies when every dimension it names matches. More named dimensions win. */
export function policyScore(policy: ILeavePolicy, employee: PolicyEmployee): number {
  const dimensions: [unknown[], unknown][] = [
    [policy.departments, employee.department],
    [policy.locations, employee.location],
    [policy.designations, employee.designation],
    [policy.categories, employee.category],
  ];
  let score = 0;
  for (const [scope, value] of dimensions) {
    if (!scope?.length) continue;
    if (value == null || !scope.some((s) => String(s) === String(value))) return -1;
    score++;
  }
  return score;
}

/** An explicit assignment wins; otherwise the most specific matching policy; otherwise none. */
export async function resolvePolicy(employee: PolicyEmployee, date: string): Promise<ILeavePolicy | null> {
  const assignment = await EmployeeLeavePolicy.findOne({ employee: employee._id, ...inEffect(date) })
    .sort({ effectiveFrom: -1 })
    .lean<IEmployeeLeavePolicy>();
  if (assignment) {
    const assigned = await LeavePolicy.findOne({ _id: assignment.policy, isActive: true }).lean<ILeavePolicy>();
    if (assigned) return assigned;
  }
  const candidates = await LeavePolicy.find({ isActive: true, ...inEffect(date) }).lean<ILeavePolicy[]>();
  let best: ILeavePolicy | null = null;
  let bestScore = -1;
  for (const p of candidates) {
    const score = policyScore(p, employee);
    if (score > bestScore || (score === bestScore && best && p.effectiveFrom > best.effectiveFrom)) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

const RULE_FIELDS: (keyof LeaveRule)[] = [
  'isPaid', 'annualEntitlement', 'monthlyAccrual', 'prorateOnJoining', 'carryForward', 'maxCarryForward',
  'carryForwardExpiryDays', 'minDuration', 'maxDuration', 'halfDayAllowed', 'requiresDocument', 'documentRequiredAfterDays',
  'minNoticeDays', 'allowPastDates', 'maxPastDays', 'validateBalance', 'allowNegative', 'maxNegative', 'requiresApproval',
  'applicableCategories',
];

/** An empty list means everyone. Someone with no recorded gender cannot take a restricted type. */
export function genderAllowed(type: Pick<ILeaveType, 'applicableGenders'>, employee: Pick<IEmployee, 'gender'>): boolean {
  if (!type.applicableGenders?.length) return true;
  return employee.gender != null && type.applicableGenders.includes(employee.gender);
}

/** The leave type supplies defaults and any field the policy sets overrides them. */
export function effectiveRule(type: ILeaveType, policy: ILeavePolicy | null, employee: Pick<IEmployee, 'category' | 'gender'>): EffectiveRule {
  const override = policy?.rules?.find((r) => String(r.leaveType) === String(type._id));
  const merged = {} as Record<keyof LeaveRule, unknown>;
  for (const field of RULE_FIELDS) {
    const value = (override as Partial<LeaveRule> | undefined)?.[field];
    merged[field] = value === undefined ? type[field] : value;
  }
  const rule = merged as unknown as LeaveRule;
  const categoryOk = !rule.applicableCategories?.length || rule.applicableCategories.includes(employee.category);
  return {
    ...rule,
    allowed: type.isActive && categoryOk && genderAllowed(type, employee) && override?.isAllowed !== false,
    policyName: policy?.name ?? null,
  };
}

/** Why this person cannot take this type, in words for them; null when they can. */
export function ineligibleReason(type: Pick<ILeaveType, 'name' | 'applicableGenders'>, rule: EffectiveRule, employee: Pick<IEmployee, 'gender'>): string | null {
  if (!genderAllowed(type, employee)) {
    const who = type.applicableGenders.map((g) => g.toLowerCase()).join(' or ');
    return `${type.name} is only available to ${who} employees${employee.gender ? '' : '. Your gender is not on record, so please ask HR to update your profile'}`;
  }
  return rule.allowed ? null : `${type.name} is not available under your leave policy`;
}

/** Lowest balance a debit may leave behind; null means the balance is not enforced. */
export function balanceFloor(rule: LeaveRule): number | null {
  if (!rule.validateBalance) return null;
  if (!rule.allowNegative) return 0;
  return rule.maxNegative == null ? null : -Math.abs(rule.maxNegative);
}
