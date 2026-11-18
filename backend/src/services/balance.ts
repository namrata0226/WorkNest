import { ClientSession, Types } from 'mongoose';
import { LedgerType } from '../constants';
import { Employee, IEmployee } from '../models/Employee';
import { ILeaveType, LeaveType } from '../models/LeaveConfig';
import { ILeaveBalance, ILeaveTransaction, LeaveBalance, LeaveTransaction } from '../models/LeaveLedger';
import { addDays, monthOf, yearOf } from '../utils/dates';
import { notFound, unprocessable } from '../utils/errors';
import { isDuplicateKeyError, withTransaction } from '../utils/transaction';
import { audit, RequestContext } from './audit';
import { getCompOffSummary } from './compoff';
import { notifyUsers } from './notification';
import { balanceFloor, EffectiveRule, effectiveRule, resolvePolicy } from './policy';

/** Which projection field a ledger row moves, and in which direction relative to its signed amount. */
const FIELD_EFFECT: Record<LedgerType, [keyof ILeaveBalance, 1 | -1]> = {
  OPENING: ['openingBalance', 1],
  ENTITLEMENT: ['entitlement', 1],
  ACCRUAL: ['credited', 1],
  CREDIT: ['credited', 1],
  CARRY_FORWARD: ['carryForward', 1],
  ADJUSTMENT: ['adjustments', 1],
  EXPIRY: ['expired', -1],
  RESERVE: ['reserved', -1],
  RELEASE: ['reserved', -1],
  DEBIT: ['used', -1],
  RESTORE: ['used', -1],
};

export interface LedgerEntry {
  employee: Types.ObjectId;
  leaveType: Types.ObjectId;
  year: number;
  type: LedgerType;
  /** Signed effect on the available balance. */
  amount: number;
  reason?: string;
  leaveRequest?: Types.ObjectId;
  performedBy?: Types.ObjectId | null;
  idempotencyKey?: string;
  /** Lowest balance this movement may leave. Null or omitted skips the check. */
  floor?: number | null;
}

/**
 * The only code path that changes a balance. The ledger row and projection update share a
 * transaction, and a replay of the same idempotency key posts nothing.
 */
export async function postLedger(entry: LedgerEntry, session: ClientSession): Promise<ILeaveTransaction | null> {
  if (entry.idempotencyKey) {
    const seen = await LeaveTransaction.exists({ idempotencyKey: entry.idempotencyKey }).session(session);
    if (seen) return null;
  }
  const [field, sign] = FIELD_EFFECT[entry.type];
  const guard: Record<string, unknown> = { employee: entry.employee, leaveType: entry.leaveType, year: entry.year };
  if (entry.floor != null && entry.amount < 0) guard.available = { $gte: entry.floor - entry.amount };

  const balance = await LeaveBalance.findOneAndUpdate(
    guard,
    { $inc: { available: entry.amount, [field]: entry.amount * sign } },
    { session, returnDocument: 'after' },
  ).lean<ILeaveBalance>();
  if (!balance) throw unprocessable('Insufficient leave balance for this request', 'INSUFFICIENT_BALANCE');

  const [tx] = await LeaveTransaction.create(
    [{
      employee: entry.employee,
      leaveType: entry.leaveType,
      year: entry.year,
      type: entry.type,
      amount: entry.amount,
      balanceAfter: balance.available,
      reason: entry.reason ?? null,
      leaveRequest: entry.leaveRequest ?? null,
      performedBy: entry.performedBy ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
    }],
    { session },
  );
  return tx.toObject() as ILeaveTransaction;
}

async function ensureBalanceRow(employee: Types.ObjectId, leaveType: Types.ObjectId, year: number): Promise<void> {
  try {
    await LeaveBalance.updateOne({ employee, leaveType, year }, { $setOnInsert: { employee, leaveType, year } }, { upsert: true });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/** Grants still owed for a year: the annual entitlement, or one accrual per elapsed month. Replays post nothing. */
function dueGrants(employee: IEmployee, type: ILeaveType, rule: EffectiveRule, year: number, today: string) {
  const grants: { type: LedgerType; amount: number; key: string; reason: string }[] = [];
  const joinYear = yearOf(employee.joiningDate);
  if (year < joinYear) return grants;
  const prefix = `${employee._id}:${type._id}`;

  if (rule.monthlyAccrual > 0) {
    const firstMonth = year === joinYear ? monthOf(employee.joiningDate) : 1;
    const thisYear = yearOf(today);
    const lastMonth = year < thisYear ? 12 : year === thisYear ? monthOf(today) : 0;
    for (let m = firstMonth; m <= lastMonth; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`;
      grants.push({ type: 'ACCRUAL', amount: rule.monthlyAccrual, key: `accrual:${prefix}:${ym}`, reason: `Monthly accrual for ${ym}` });
    }
  } else if (rule.annualEntitlement > 0) {
    let amount = rule.annualEntitlement;
    if (rule.prorateOnJoining && year === joinYear) {
      const months = 13 - monthOf(employee.joiningDate);
      amount = Math.round(((rule.annualEntitlement * months) / 12) * 2) / 2;
    }
    if (amount > 0) grants.push({ type: 'ENTITLEMENT', amount, key: `entitlement:${prefix}:${year}`, reason: `Annual entitlement for ${year}` });
  }
  return grants;
}

/** Brings one employee's balance row up to date. Runs outside the caller's transaction. */
export async function syncEntitlement(employee: IEmployee, type: ILeaveType, rule: EffectiveRule, year: number, today: string): Promise<void> {
  if (type.kind === 'COMP_OFF' || !rule.allowed) return;
  await ensureBalanceRow(employee._id, type._id, year);
  const grants = dueGrants(employee, type, rule, year, today);
  if (!grants.length) return;

  const posted = await LeaveTransaction.find({ idempotencyKey: { $in: grants.map((g) => g.key) } }).select('idempotencyKey').lean<ILeaveTransaction[]>();
  const done = new Set(posted.map((p) => p.idempotencyKey));
  const missing = grants.filter((g) => !done.has(g.key));
  if (!missing.length) return;

  try {
    await withTransaction(async (session) => {
      for (const g of missing) {
        await postLedger({ employee: employee._id, leaveType: type._id, year, type: g.type, amount: g.amount, reason: g.reason, idempotencyKey: g.key }, session);
      }
    });
  } catch (err) {
    // Another request posted the same grant first, which is the outcome we wanted.
    if (!isDuplicateKeyError(err)) throw err;
  }
}

export interface BalanceRow extends Partial<ILeaveBalance> {
  leaveType: any;
  isCompOff: boolean;
  compOff?: Awaited<ReturnType<typeof getCompOffSummary>>;
}

/** Every leave type that applies to the employee, with its balance for the year. */
export async function getEmployeeBalances(employee: IEmployee, year: number, today: string): Promise<BalanceRow[]> {
  const asOf = year === yearOf(today) ? today : `${year}-12-31`;
  const [types, policy] = await Promise.all([
    LeaveType.find({ isActive: true }).sort({ name: 1 }).lean<ILeaveType[]>(),
    resolvePolicy(employee, asOf),
  ]);
  const [existing, posted] = await Promise.all([
    LeaveBalance.find({ employee: employee._id, year }).lean<ILeaveBalance[]>(),
    LeaveTransaction.find({ employee: employee._id, year, type: { $in: ['ENTITLEMENT', 'ACCRUAL'] } }).select('idempotencyKey').lean<ILeaveTransaction[]>(),
  ]);
  const balanceByType = new Map(existing.map((b) => [String(b.leaveType), b]));
  const postedKeys = new Set(posted.map((t) => t.idempotencyKey));

  const rows: BalanceRow[] = [];
  for (const type of types) {
    const rule = effectiveRule(type, policy, employee);
    if (!rule.allowed) continue;
    const leaveType = { _id: type._id, name: type.name, code: type.code, color: type.color, kind: type.kind, isPaid: rule.isPaid, validateBalance: rule.validateBalance, eventBased: type.eventBased };
    if (type.kind === 'COMP_OFF') {
      const compOff = await getCompOffSummary(employee._id, today);
      rows.push({
        leaveType,
        isCompOff: true,
        year,
        compOff,
        entitlement: 0,
        credited: compOff.earned,
        used: compOff.used,
        reserved: compOff.reserved,
        expired: compOff.expired,
        adjustments: -compOff.adjustedOut,
        available: compOff.available,
      });
      continue;
    }
    // Reads stay reads unless something is actually owed: a grant is due or the row is missing.
    let balance = balanceByType.get(String(type._id));
    if (!balance || dueGrants(employee, type, rule, year, today).some((g) => !postedKeys.has(g.key))) {
      await syncEntitlement(employee, type, rule, year, today);
      balance = (await LeaveBalance.findOne({ employee: employee._id, leaveType: type._id, year }).lean<ILeaveBalance>())!;
    }
    rows.push({ ...balance, leaveType, isCompOff: false });
  }
  return rows;
}

export interface AdjustmentInput {
  employee: string;
  leaveType: string;
  year: number;
  amount: number;
  kind: 'CREDIT' | 'ADJUSTMENT' | 'OPENING' | 'DEDUCTION';
  reason: string;
  idempotencyKey?: string;
}

/** Credits, deductions and opening balances entered by an admin. Each one needs a reason. */
export async function adjustBalance(ctx: RequestContext, input: AdjustmentInput) {
  const [employee, type] = await Promise.all([
    Employee.findById(input.employee).lean<IEmployee>(),
    LeaveType.findById(input.leaveType).lean<ILeaveType>(),
  ]);
  if (!employee) throw notFound('Employee');
  if (!type) throw notFound('Leave type');
  if (type.kind === 'COMP_OFF') throw unprocessable('Adjust Comp-Off from the Comp-Off module', 'USE_COMPOFF_MODULE');

  const policy = await resolvePolicy(employee, `${input.year}-12-31`);
  await ensureBalanceRow(employee._id, type._id, input.year);

  const amount = input.kind === 'DEDUCTION' ? -Math.abs(input.amount) : input.amount;
  const ledgerType: LedgerType = input.kind === 'DEDUCTION' ? 'ADJUSTMENT' : input.kind;
  const key = input.idempotencyKey ? `manual:${input.idempotencyKey}` : undefined;

  return withTransaction(async (session) => {
    const tx = await postLedger(
      {
        employee: employee._id,
        leaveType: type._id,
        year: input.year,
        type: ledgerType,
        amount,
        reason: input.reason,
        performedBy: ctx.auth?.userId,
        idempotencyKey: key,
        floor: balanceFloor(effectiveRule(type, policy, employee)),
      },
      session,
    );
    if (!tx) return LeaveTransaction.findOne({ idempotencyKey: key }).session(session).lean();

    await audit(ctx, {
      action: 'BALANCE_ADJUSTED',
      entityType: 'LeaveBalance',
      entityId: employee._id,
      summary: `${amount > 0 ? '+' : ''}${amount} ${type.code} for ${employee.fullName} (${input.year}): ${input.reason}`,
      after: { amount, year: input.year, leaveType: type.code, kind: input.kind, balanceAfter: tx.balanceAfter },
    }, session);
    await notifyUsers([employee.user], {
      type: 'BALANCE_ADJUSTED',
      title: 'Leave balance updated',
      message: `Your ${type.name} balance changed by ${amount > 0 ? '+' : ''}${amount} day(s). Reason: ${input.reason}`,
      link: '/balances',
    }, session);
    return tx;
  });
}

/** Proves the projection against the ledger. Used by tests and the balance repair path. */
export async function reconcileBalance(employee: Types.ObjectId, leaveType: Types.ObjectId, year: number) {
  const [sum] = await LeaveTransaction.aggregate<{ total: number }>([
    { $match: { employee, leaveType, year } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const balance = await LeaveBalance.findOne({ employee, leaveType, year }).lean<ILeaveBalance>();
  const ledgerTotal = sum?.total ?? 0;
  const available = balance?.available ?? 0;
  return { ledgerTotal, available, matches: ledgerTotal === available };
}

/** Rolls last year's unused balance into `year` under each type's carry-forward rule. */
export async function runCarryForward(year: number): Promise<number> {
  const prevYear = year - 1;
  const types = await LeaveType.find({ kind: { $ne: 'COMP_OFF' } }).lean<ILeaveType[]>();
  const typeById = new Map(types.map((t) => [String(t._id), t]));
  const rows = await LeaveBalance.find({ year: prevYear, available: { $gt: 0 } }).lean<ILeaveBalance[]>();
  const employees = await Employee.find({ _id: { $in: rows.map((r) => r.employee) }, employmentStatus: { $ne: 'INACTIVE' } }).lean<IEmployee[]>();
  const employeeById = new Map(employees.map((e) => [String(e._id), e]));
  let processed = 0;

  for (const row of rows) {
    const type = typeById.get(String(row.leaveType));
    const employee = employeeById.get(String(row.employee));
    if (!type || !employee) continue;
    const rule = effectiveRule(type, await resolvePolicy(employee, `${year}-01-01`), employee);
    const carried = rule.carryForward ? Math.min(row.available, rule.maxCarryForward) : 0;
    const lapsed = row.available - carried;

    await ensureBalanceRow(employee._id, type._id, year);
    await withTransaction(async (session) => {
      const prefix = `${employee._id}:${type._id}:${year}`;
      if (lapsed > 0) {
        await postLedger({ employee: employee._id, leaveType: type._id, year: prevYear, type: 'EXPIRY', amount: -lapsed, reason: `Unused balance lapsed at end of ${prevYear}`, idempotencyKey: `year-end-lapse:${prefix}` }, session);
      }
      if (carried > 0) {
        await postLedger({ employee: employee._id, leaveType: type._id, year: prevYear, type: 'ADJUSTMENT', amount: -carried, reason: `Moved to ${year} as carry-forward`, idempotencyKey: `year-end-move:${prefix}` }, session);
        await postLedger({ employee: employee._id, leaveType: type._id, year, type: 'CARRY_FORWARD', amount: carried, reason: `Carried forward from ${prevYear}`, idempotencyKey: `carry-forward:${prefix}` }, session);
      }
    });
    processed++;
  }
  return processed;
}

/** Lapses carried-forward days not used within the type's expiry window. Leave taken consumes carry-forward first. */
export async function expireCarryForward(today: string): Promise<number> {
  const year = yearOf(today);
  const types = await LeaveType.find({ carryForward: true, carryForwardExpiryDays: { $ne: null } }).lean<ILeaveType[]>();
  let expired = 0;
  for (const type of types) {
    const lapseDate = addDays(`${year}-01-01`, type.carryForwardExpiryDays!);
    if (today <= lapseDate) continue;
    const rows = await LeaveBalance.find({ year, leaveType: type._id, carryForward: { $gt: 0 } }).lean<ILeaveBalance[]>();
    for (const row of rows) {
      const amount = Math.min(row.available, Math.max(0, row.carryForward - row.used - row.reserved));
      if (amount <= 0) continue;
      const posted = await withTransaction((session) =>
        postLedger({
          employee: row.employee,
          leaveType: type._id,
          year,
          type: 'EXPIRY',
          amount: -amount,
          reason: `Carry-forward lapsed after ${lapseDate}`,
          idempotencyKey: `carry-forward-expiry:${row.employee}:${type._id}:${year}`,
        }, session),
      );
      if (posted) expired++;
    }
  }
  return expired;
}
