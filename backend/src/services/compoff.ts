import { ClientSession, Types } from 'mongoose';
import { PERMISSIONS } from '../constants';
import { CompOffRequest, CompOffTransaction, ICompOffRequest, ICompOffTransaction } from '../models/CompOff';
import { Employee, IEmployee } from '../models/Employee';
import { StoredFile } from '../models/System';
import { addDays, diffDays, isWeekend, todayIn } from '../utils/dates';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { withTransaction } from '../utils/transaction';
import { audit, RequestContext } from './audit';
import { employeeHolidays } from './holiday';
import { adminsWithPermission, notifyUsers } from './notification';
import { getSettings } from './settings';

export interface Allocation {
  lot: Types.ObjectId;
  amount: number;
}

export async function getCompOffSummary(employee: Types.ObjectId, today: string) {
  const lots = await CompOffTransaction.find({ employee, type: 'CREDIT' }).sort({ expiresOn: 1 }).lean<ICompOffTransaction[]>();
  const pendingCredit = await CompOffRequest.find({ employee, status: 'PENDING' }).select('amount').lean<ICompOffRequest[]>();
  const summary = { earned: 0, used: 0, reserved: 0, expired: 0, adjustedOut: 0, available: 0, pendingCredit: 0, nextExpiry: null as string | null };
  const active: { id: Types.ObjectId; earnedDate: string | null; expiresOn: string | null; remaining: number }[] = [];
  for (const lot of lots) {
    summary.earned += lot.amount;
    summary.used += lot.used;
    summary.reserved += lot.reserved;
    summary.expired += lot.expired;
    summary.adjustedOut += lot.adjustedOut;
    if (lot.remaining <= 0) continue;
    // A lot past its date is expired even if the nightly job has not swept it yet.
    if (lot.expiresOn && lot.expiresOn < today) {
      summary.expired += lot.remaining;
      continue;
    }
    summary.available += lot.remaining;
    active.push({ id: lot._id, earnedDate: lot.earnedDate, expiresOn: lot.expiresOn, remaining: lot.remaining });
    if (lot.expiresOn && (!summary.nextExpiry || lot.expiresOn < summary.nextExpiry)) summary.nextExpiry = lot.expiresOn;
  }
  summary.pendingCredit = pendingCredit.reduce((s, r) => s + r.amount, 0);
  return { ...summary, lots: active };
}

/**
 * Picks lots for each leave day, earliest expiry first. A lot only covers a day it is
 * still valid on, and only if it has not already expired today.
 */
export async function planCompOffAllocation(
  employee: Types.ObjectId,
  days: { date: string; value: number }[],
  today: string,
  session?: ClientSession,
): Promise<Allocation[]> {
  const lots = await CompOffTransaction.find({ employee, type: 'CREDIT', remaining: { $gt: 0 }, expiresOn: { $gte: today } })
    .sort({ expiresOn: 1, createdAt: 1 })
    .session(session ?? null)
    .lean<ICompOffTransaction[]>();
  const left = new Map(lots.map((l) => [String(l._id), l.remaining]));
  const planned = new Map<string, number>();

  for (const day of days) {
    let need = day.value;
    for (const lot of lots) {
      if (need <= 0) break;
      if (lot.expiresOn! < day.date) continue;
      const free = left.get(String(lot._id))!;
      if (free <= 0) continue;
      const take = Math.min(free, need);
      left.set(String(lot._id), free - take);
      planned.set(String(lot._id), (planned.get(String(lot._id)) ?? 0) + take);
      need -= take;
    }
    if (need > 0) {
      throw unprocessable(`Not enough valid Comp-Off to cover ${day.date}. Expired Comp-Off cannot be used.`, 'INSUFFICIENT_COMPOFF');
    }
  }
  return [...planned.entries()].map(([lot, amount]) => ({ lot: new Types.ObjectId(lot), amount }));
}

interface LeaveRef {
  employee: Types.ObjectId;
  leaveRequest: Types.ObjectId;
  performedBy?: Types.ObjectId | null;
}

async function moveLots(allocations: Allocation[], inc: (amount: number) => Record<string, number>, guard: (amount: number) => Record<string, unknown>, session: ClientSession) {
  for (const a of allocations) {
    const res = await CompOffTransaction.updateOne({ _id: a.lot, ...guard(a.amount) }, { $inc: inc(a.amount) }, { session });
    if (!res.modifiedCount) throw conflict('Comp-Off balance changed. Please retry.', 'COMPOFF_CONFLICT');
  }
}

async function logMovement(type: ICompOffTransaction['type'], amount: number, allocations: Allocation[], ref: LeaveRef, key: string, reason: string, session: ClientSession) {
  await CompOffTransaction.create(
    [{ employee: ref.employee, type, amount, allocations, leaveRequest: ref.leaveRequest, performedBy: ref.performedBy ?? null, idempotencyKey: key, reason }],
    { session },
  );
}

const total = (allocations: Allocation[]) => allocations.reduce((s, a) => s + a.amount, 0);

export async function reserveCompOff(allocations: Allocation[], ref: LeaveRef, session: ClientSession) {
  await moveLots(allocations, (n) => ({ remaining: -n, reserved: n }), (n) => ({ remaining: { $gte: n } }), session);
  await logMovement('RESERVE', -total(allocations), allocations, ref, `compoff:leave:${ref.leaveRequest}:reserve`, 'Held for pending leave', session);
}

export async function releaseCompOff(allocations: Allocation[], ref: LeaveRef, session: ClientSession) {
  await moveLots(allocations, (n) => ({ remaining: n, reserved: -n }), (n) => ({ reserved: { $gte: n } }), session);
  await logMovement('RELEASE', total(allocations), allocations, ref, `compoff:leave:${ref.leaveRequest}:release`, 'Pending leave no longer holds this Comp-Off', session);
}

export async function confirmReservedCompOff(allocations: Allocation[], ref: LeaveRef, session: ClientSession) {
  await moveLots(allocations, (n) => ({ reserved: -n, used: n }), (n) => ({ reserved: { $gte: n } }), session);
  await logMovement('DEBIT', -total(allocations), allocations, ref, `compoff:leave:${ref.leaveRequest}:debit`, 'Used for approved leave', session);
}

export async function consumeCompOff(allocations: Allocation[], ref: LeaveRef, session: ClientSession) {
  await moveLots(allocations, (n) => ({ remaining: -n, used: n }), (n) => ({ remaining: { $gte: n } }), session);
  await logMovement('DEBIT', -total(allocations), allocations, ref, `compoff:leave:${ref.leaveRequest}:debit`, 'Used for approved leave', session);
}

export async function restoreCompOff(allocations: Allocation[], ref: LeaveRef, session: ClientSession) {
  await moveLots(allocations, (n) => ({ remaining: n, used: -n }), (n) => ({ used: { $gte: n } }), session);
  await logMovement('RESTORE', total(allocations), allocations, ref, `compoff:leave:${ref.leaveRequest}:restore`, 'Approved leave cancelled', session);
}

/** Which rule makes this date eligible, or null when it was an ordinary working day. */
async function workedDateOccasion(employee: IEmployee, date: string, settings: Awaited<ReturnType<typeof getSettings>>): Promise<string | null> {
  if (isWeekend(date)) return settings.compOff.allowOnWeeklyOff ? 'Weekly off' : null;
  if (!settings.compOff.allowOnHoliday) return null;
  const holidays = await employeeHolidays(employee, date, date);
  const holiday = holidays.find((h) => h.category !== 'OPTIONAL');
  return holiday ? `Holiday: ${holiday.name}` : null;
}

export interface CompOffApplication {
  workedDate: string;
  dayType: 'FULL' | 'HALF';
  reason: string;
  document?: string | null;
}

export async function applyCompOff(ctx: RequestContext, employeeId: Types.ObjectId, input: CompOffApplication) {
  const employee = await Employee.findById(employeeId).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  if (employee.employmentStatus === 'INACTIVE') throw forbidden('Your employee record is inactive', 'EMPLOYEE_INACTIVE');

  const settings = await getSettings();
  const today = todayIn(settings.timezone);

  if (input.workedDate > today) throw unprocessable('The worked date cannot be in the future', 'FUTURE_DATE');
  if (input.workedDate < employee.joiningDate) throw unprocessable('The worked date is before your joining date', 'BEFORE_JOINING');
  if (diffDays(today, input.workedDate) > settings.compOff.maxClaimAgeDays) {
    throw unprocessable(`Comp-Off must be claimed within ${settings.compOff.maxClaimAgeDays} days of the date worked`, 'CLAIM_TOO_OLD');
  }
  if (input.dayType === 'HALF' && !settings.compOff.allowHalfDay) throw unprocessable('Half-day Comp-Off is not allowed', 'HALF_DAY_NOT_ALLOWED');
  if (settings.compOff.requireDocument && !input.document) throw unprocessable('A supporting document is required', 'DOCUMENT_REQUIRED');
  if (input.document) {
    const file = await StoredFile.findOne({ _id: input.document, owner: ctx.auth?.userId, purpose: { $nin: ['AVATAR', 'PERSONAL'] } });
    if (!file) throw unprocessable('The supporting document was not found', 'DOCUMENT_INVALID');
  }
  const occasion = await workedDateOccasion(employee, input.workedDate, settings);
  if (!occasion) {
    throw unprocessable('Comp-Off can only be earned on an eligible weekly off or company holiday', 'NOT_ELIGIBLE_DATE');
  }

  const request = await withTransaction(async (session) => {
    await Employee.updateOne({ _id: employeeId }, { $inc: { leaveLock: 1 } }, { session });
    const dup = await CompOffRequest.exists({ employee: employeeId, workedDate: input.workedDate, status: { $in: ['PENDING', 'APPROVED'] } }).session(session);
    if (dup) throw conflict('You have already claimed Comp-Off for this date', 'DUPLICATE_COMPOFF');
    const [doc] = await CompOffRequest.create(
      [{
        employee: employeeId,
        workedDate: input.workedDate,
        dayType: input.dayType,
        amount: input.dayType === 'HALF' ? 0.5 : 1,
        reason: input.reason,
        occasion,
        document: input.document ?? null,
      }],
      { session },
    );
    const admins = (await adminsWithPermission(PERMISSIONS.COMPOFF_MANAGE)).filter((id) => String(id) !== String(ctx.auth?.userId));
    await notifyUsers(admins, {
      type: 'COMPOFF_SUBMITTED',
      title: 'New Comp-Off request',
      message: `${employee.fullName} claimed ${doc.amount} day(s) for working on ${input.workedDate}.`,
      link: '/admin/comp-off',
    }, session);
    await audit(ctx, { action: 'COMPOFF_REQUESTED', entityType: 'CompOffRequest', entityId: doc._id, summary: `${employee.fullName} claimed ${input.workedDate}` }, session);
    return doc;
  });
  return request.toObject();
}

export async function approveCompOff(ctx: RequestContext, id: string, input: { expiresOn?: string; comment?: string }) {
  const settings = await getSettings();
  return withTransaction(async (session) => {
    const current = await CompOffRequest.findById(id).session(session).lean<ICompOffRequest>();
    if (!current) throw notFound('Comp-Off request');
    if (String(current.employee) === String(ctx.auth?.employeeId)) throw forbidden('You cannot approve your own Comp-Off request', 'SELF_APPROVAL');
    const expiresOn = input.expiresOn ?? addDays(current.workedDate, settings.compOff.validityDays);
    if (expiresOn < current.workedDate) throw unprocessable('Expiry cannot be before the date worked', 'INVALID_EXPIRY');

    const updated = await CompOffRequest.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      { status: 'APPROVED', expiresOn, decidedBy: ctx.auth?.userId, decidedAt: new Date(), decisionComment: input.comment ?? null },
      { session, returnDocument: 'after' },
    ).lean<ICompOffRequest>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');

    await CompOffTransaction.create(
      [{
        employee: updated.employee,
        type: 'CREDIT',
        amount: updated.amount,
        remaining: updated.amount,
        earnedDate: updated.workedDate,
        expiresOn,
        compOffRequest: updated._id,
        performedBy: ctx.auth?.userId,
        reason: `Worked on ${updated.workedDate} (${updated.occasion})`,
        idempotencyKey: `compoff:request:${updated._id}:credit`,
      }],
      { session },
    );
    const employee = await Employee.findById(updated.employee).select('user fullName').lean<IEmployee>();
    await notifyUsers([employee?.user], {
      type: 'COMPOFF_CREDITED',
      title: 'Comp-Off credited',
      message: `${updated.amount} day(s) credited for ${updated.workedDate}. Valid until ${expiresOn}.`,
      link: '/comp-off',
    }, session);
    await audit(ctx, { action: 'COMPOFF_APPROVED', entityType: 'CompOffRequest', entityId: updated._id, summary: `Approved ${updated.amount} day(s) for ${employee?.fullName}, expires ${expiresOn}` }, session);
    return updated;
  });
}

export async function rejectCompOff(ctx: RequestContext, id: string, reason: string) {
  return withTransaction(async (session) => {
    const current = await CompOffRequest.findById(id).session(session).lean<ICompOffRequest>();
    if (!current) throw notFound('Comp-Off request');
    if (String(current.employee) === String(ctx.auth?.employeeId)) throw forbidden('You cannot decide your own Comp-Off request', 'SELF_APPROVAL');
    const updated = await CompOffRequest.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      { status: 'REJECTED', decidedBy: ctx.auth?.userId, decidedAt: new Date(), decisionComment: reason },
      { session, returnDocument: 'after' },
    ).lean<ICompOffRequest>();
    if (!updated) throw conflict('This request has already been processed', 'ALREADY_PROCESSED');
    const employee = await Employee.findById(updated.employee).select('user fullName').lean<IEmployee>();
    await notifyUsers([employee?.user], {
      type: 'COMPOFF_REJECTED',
      title: 'Comp-Off request rejected',
      message: `Your claim for ${updated.workedDate} was rejected. Reason: ${reason}`,
      link: '/comp-off',
    }, session);
    await audit(ctx, { action: 'COMPOFF_REJECTED', entityType: 'CompOffRequest', entityId: updated._id, summary: `Rejected claim for ${employee?.fullName}: ${reason}` }, session);
    return updated;
  });
}

export interface ManualCompOff {
  employee: string;
  amount: number;
  reason: string;
  earnedDate?: string;
  expiresOn?: string;
  idempotencyKey?: string;
}

/** Positive amounts create a new lot. Negative amounts draw down the earliest-expiring lots. */
export async function adjustCompOff(ctx: RequestContext, input: ManualCompOff) {
  const employee = await Employee.findById(input.employee).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const key = input.idempotencyKey ? `compoff:manual:${input.idempotencyKey}` : null;

  return withTransaction(async (session) => {
    if (key) {
      const seen = await CompOffTransaction.findOne({ idempotencyKey: key }).session(session).lean();
      if (seen) return seen;
    }
    await Employee.updateOne({ _id: employee._id }, { $inc: { leaveLock: 1 } }, { session });
    let tx;
    if (input.amount > 0) {
      const earnedDate = input.earnedDate ?? today;
      const expiresOn = input.expiresOn ?? addDays(earnedDate, settings.compOff.validityDays);
      if (expiresOn < earnedDate) throw unprocessable('Expiry cannot be before the earned date', 'INVALID_EXPIRY');
      [tx] = await CompOffTransaction.create(
        [{ employee: employee._id, type: 'CREDIT', amount: input.amount, remaining: input.amount, earnedDate, expiresOn, reason: input.reason, performedBy: ctx.auth?.userId, idempotencyKey: key }],
        { session },
      );
      await notifyUsers([employee.user], {
        type: 'COMPOFF_CREDITED',
        title: 'Comp-Off credited',
        message: `${input.amount} day(s) added to your Comp-Off, valid until ${expiresOn}. Reason: ${input.reason}`,
        link: '/comp-off',
      }, session);
    } else {
      const lots = await CompOffTransaction.find({ employee: employee._id, type: 'CREDIT', remaining: { $gt: 0 }, expiresOn: { $gte: today } })
        .sort({ expiresOn: 1 }).session(session).lean<ICompOffTransaction[]>();
      let need = -input.amount;
      const allocations: Allocation[] = [];
      for (const lot of lots) {
        if (need <= 0) break;
        const take = Math.min(lot.remaining, need);
        await CompOffTransaction.updateOne({ _id: lot._id, remaining: { $gte: take } }, { $inc: { remaining: -take, adjustedOut: take } }, { session });
        allocations.push({ lot: lot._id, amount: take });
        need -= take;
      }
      if (need > 0) throw unprocessable('The deduction is larger than the available Comp-Off', 'INSUFFICIENT_COMPOFF');
      [tx] = await CompOffTransaction.create(
        [{ employee: employee._id, type: 'ADJUSTMENT', amount: input.amount, allocations, reason: input.reason, performedBy: ctx.auth?.userId, idempotencyKey: key }],
        { session },
      );
    }
    await audit(ctx, {
      action: 'COMPOFF_ADJUSTED',
      entityType: 'CompOffTransaction',
      entityId: tx._id,
      summary: `${input.amount > 0 ? '+' : ''}${input.amount} Comp-Off for ${employee.fullName}: ${input.reason}`,
    }, session);
    return tx.toObject();
  });
}

export async function setLotExpiry(ctx: RequestContext, lotId: string, expiresOn: string) {
  return withTransaction(async (session) => {
    const lot = await CompOffTransaction.findOne({ _id: lotId, type: 'CREDIT' }).session(session);
    if (!lot) throw notFound('Comp-Off credit');
    if (lot.earnedDate && expiresOn < lot.earnedDate) throw unprocessable('Expiry cannot be before the earned date', 'INVALID_EXPIRY');
    const before = lot.expiresOn;
    lot.expiresOn = expiresOn;
    await lot.save({ session });
    await audit(ctx, { action: 'COMPOFF_EXPIRY_CHANGED', entityType: 'CompOffTransaction', entityId: lot._id, before: { expiresOn: before }, after: { expiresOn } }, session);
    return lot.toObject();
  });
}

/** Sweeps the unheld part of past-date lots. Days held by a pending leave stay reserved until it is decided. */
export async function expireCompOffLots(today: string): Promise<number> {
  const lots = await CompOffTransaction.find({ type: 'CREDIT', remaining: { $gt: 0 }, expiresOn: { $lt: today } }).lean<ICompOffTransaction[]>();
  let count = 0;
  for (const lot of lots) {
    await withTransaction(async (session) => {
      const res = await CompOffTransaction.updateOne(
        { _id: lot._id, remaining: lot.remaining },
        { $set: { remaining: 0 }, $inc: { expired: lot.remaining } },
        { session },
      );
      if (!res.modifiedCount) return;
      await CompOffTransaction.create(
        [{ employee: lot.employee, type: 'EXPIRE', amount: -lot.remaining, allocations: [{ lot: lot._id, amount: lot.remaining }], reason: `Expired on ${lot.expiresOn}` }],
        { session },
      );
      count++;
    });
  }
  return count;
}

/** Warns once per lot before it expires. Each notification carries a dedupe key. */
export async function warnExpiringCompOff(today: string): Promise<number> {
  const settings = await getSettings();
  const horizon = addDays(today, settings.compOff.expiryWarningDays);
  const lots = await CompOffTransaction.find({ type: 'CREDIT', remaining: { $gt: 0 }, expiresOn: { $gte: today, $lte: horizon } }).lean<ICompOffTransaction[]>();
  let sent = 0;
  for (const lot of lots) {
    const employee = await Employee.findById(lot.employee).select('user').lean<IEmployee>();
    if (!employee?.user) continue;
    try {
      await notifyUsers([employee.user], {
        type: 'COMPOFF_EXPIRING',
        title: 'Comp-Off expiring soon',
        message: `${lot.remaining} day(s) of Comp-Off expire on ${lot.expiresOn}.`,
        link: '/comp-off',
        dedupeKey: `compoff-expiring:${lot._id}`,
      });
      sent++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return sent;
}
