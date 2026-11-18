import { beforeEach, describe, expect, it } from 'vitest';
import { remindUpcomingHolidays, runDailyJobs, syncAllEntitlements } from '../src/jobs';
import { Employee, Holiday, LeaveBalance, LeaveTransaction, LeaveType, Notification } from '../src/models';
import { expireCarryForward, reconcileBalance, runCarryForward } from '../src/services/balance';
import { baseline, makeLocation, makePerson, Person, typeId, useDatabase } from './helpers';

useDatabase('jobs');

let el: string;
let emp: Person;

beforeEach(async () => {
  await baseline();
  el = await typeId('EL');
  emp = await makePerson();
});

const balance = (year: number) => LeaveBalance.findOne({ employee: emp.employee._id, leaveType: el, year }).lean();

describe('entitlements and accrual', () => {
  it('grants annual entitlement once, however often the job runs', async () => {
    await syncAllEntitlements('2030-01-05');
    await syncAllEntitlements('2030-06-05');
    expect((await balance(2030))!.entitlement).toBe(15);
    expect(await LeaveTransaction.countDocuments({ leaveType: el, type: 'ENTITLEMENT', employee: emp.employee._id })).toBe(1);
  });

  it('accrues monthly up to the current month without double crediting', async () => {
    await LeaveType.updateOne({ _id: el }, { monthlyAccrual: 1.25, annualEntitlement: 0 });
    await syncAllEntitlements('2030-03-10');
    expect((await balance(2030))!.credited).toBe(3.75);
    await syncAllEntitlements('2030-03-20');
    expect((await balance(2030))!.credited).toBe(3.75);
    await syncAllEntitlements('2030-05-01');
    expect((await balance(2030))!.credited).toBe(6.25);
    expect(await LeaveTransaction.countDocuments({ leaveType: el, type: 'ACCRUAL', employee: emp.employee._id })).toBe(5);
  });

  it('starts accrual from the joining month', async () => {
    await LeaveType.updateOne({ _id: el }, { monthlyAccrual: 1, annualEntitlement: 0 });
    const joiner = await makePerson({ joiningDate: '2030-03-15' });
    await syncAllEntitlements('2030-05-01');
    const b = await LeaveBalance.findOne({ employee: joiner.employee._id, leaveType: el, year: 2030 }).lean();
    expect(b!.credited).toBe(3);
  });

  it('skips inactive employees', async () => {
    const gone = await makePerson();
    await Employee.updateOne({ _id: gone.employee._id }, { employmentStatus: 'INACTIVE' });
    await syncAllEntitlements('2030-01-05');
    expect(await LeaveBalance.exists({ employee: gone.employee._id })).toBeNull();
  });
});

describe('carry-forward', () => {
  beforeEach(async () => {
    await LeaveType.updateOne({ _id: el }, { maxCarryForward: 5 });
    await syncAllEntitlements('2030-12-01');
  });

  it('carries up to the limit and lapses the rest, once', async () => {
    await runCarryForward(2031);
    await runCarryForward(2031);
    const prev = (await balance(2030))!;
    const next = (await balance(2031))!;
    expect(next.carryForward).toBe(5);
    expect(prev.available).toBe(0);
    expect(prev.expired).toBe(10);
    expect(await LeaveTransaction.countDocuments({ type: 'CARRY_FORWARD', employee: emp.employee._id })).toBe(1);
    const ids = (await LeaveType.findById(el).lean())!._id;
    expect((await reconcileBalance(emp.employee._id, ids, 2030)).matches).toBe(true);
    expect((await reconcileBalance(emp.employee._id, ids, 2031)).matches).toBe(true);
  });

  it('lapses unused balance entirely for a type with no carry-forward', async () => {
    const cl = await typeId('CL');
    await runCarryForward(2031);
    const prev = await LeaveBalance.findOne({ employee: emp.employee._id, leaveType: cl, year: 2030 }).lean();
    expect(prev!.available).toBe(0);
    expect(prev!.expired).toBe(12);
  });

  it('expires carried days unused after the window, counting leave taken first', async () => {
    await LeaveType.updateOne({ _id: el }, { carryForwardExpiryDays: 90 });
    await runCarryForward(2031);
    await syncAllEntitlements('2031-01-02');
    // Ten days after the window closes; used one day of the five carried.
    await LeaveBalance.updateOne({ employee: emp.employee._id, leaveType: el, year: 2031 }, { $inc: { used: 1, available: -1 } });
    expect(await expireCarryForward('2031-01-20')).toBe(0);
    expect(await expireCarryForward('2031-04-10')).toBe(1);
    expect(await expireCarryForward('2031-04-11')).toBe(0);
    const b = (await balance(2031))!;
    expect(b.expired).toBe(4);
    expect(b.available).toBe(15);
  });
});

describe('holiday reminders', () => {
  it('reminds only the people a holiday applies to, once', async () => {
    const mumbai = await makeLocation('Mumbai');
    const local = await makePerson({ location: mumbai });
    await Holiday.create({ name: 'Local', date: '2030-03-05', year: 2030, category: 'REGIONAL', locations: [mumbai] });
    expect(await remindUpcomingHolidays('2030-03-03')).toBe(1);
    expect(await remindUpcomingHolidays('2030-03-03')).toBe(0);
    expect(await Notification.exists({ recipient: local.userId, type: 'HOLIDAY_UPCOMING' })).toBeTruthy();
    expect(await Notification.exists({ recipient: emp.userId, type: 'HOLIDAY_UPCOMING' })).toBeNull();
  });

  it('does not remind beyond the window or for optional holidays', async () => {
    await Holiday.create({ name: 'Far', date: '2030-05-05', year: 2030, category: 'NATIONAL' });
    await Holiday.create({ name: 'Optional', date: '2030-03-05', year: 2030, category: 'OPTIONAL' });
    expect(await remindUpcomingHolidays('2030-03-03')).toBe(0);
  });
});

describe('daily run', () => {
  it('completes and is safe to repeat', async () => {
    await runDailyJobs('2030-03-03');
    const first = await LeaveTransaction.countDocuments();
    await runDailyJobs('2030-03-03');
    expect(await LeaveTransaction.countDocuments()).toBe(first);
  });
});
