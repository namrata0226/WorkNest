import { beforeEach, describe, expect, it } from 'vitest';
import { CompOffTransaction, CompanySettings, Holiday, Notification } from '../src/models';
import { expireCompOffLots, warnExpiringCompOff } from '../src/services/compoff';
import { companyToday } from '../src/services/settings';
import { addDays, dayOfWeek, isWeekend } from '../src/utils/dates';
import { agentFor, Agent, baseline, fullDay, makePerson, Person, typeId, useDatabase } from './helpers';

useDatabase('compoff');

let co: string;
let emp: Person;
let hr: Person;
let empAgent: Agent;
let hrAgent: Agent;
let today: string;
let saturday: string;
let weekday: string;
/** A weekday soon, so comp-off expiry dates can sit either side of it. */
let leaveDay: string;

const previous = (from: string, test: (d: string) => boolean) => {
  let d = addDays(from, -1);
  while (!test(d)) d = addDays(d, -1);
  return d;
};
const next = (from: string, test: (d: string) => boolean) => {
  let d = addDays(from, 1);
  while (!test(d)) d = addDays(d, 1);
  return d;
};

beforeEach(async () => {
  await baseline();
  co = await typeId('CO');
  emp = await makePerson();
  hr = await makePerson({ role: 'HR_ADMIN' });
  empAgent = await agentFor(emp.email);
  hrAgent = await agentFor(hr.email);
  today = await companyToday();
  saturday = previous(today, (d) => dayOfWeek(d) === 6);
  weekday = previous(today, (d) => !isWeekend(d));
  leaveDay = next(today, (d) => !isWeekend(d));
});

const claim = (workedDate = saturday, over: object = {}) => empAgent.post('/api/compoff').send({ workedDate, dayType: 'FULL', reason: 'Release support', ...over });
const summary = async () => (await empAgent.get('/api/compoff/my')).body.data.summary;
const credit = (amount: number, expiresOn: string, key = `k-${amount}-${expiresOn}`) =>
  hrAgent.post('/api/compoff/manual').set('Idempotency-Key', key).send({ employee: String(emp.employee._id), amount, reason: 'Manual credit', earnedDate: addDays(today, -5), expiresOn });

describe('earning Comp-Off', () => {
  it('accepts a claim for a weekend and notifies admins', async () => {
    const res = await claim();
    expect(res.status).toBe(201);
    expect(res.body.data.occasion).toBe('Weekly off');
    expect(await Notification.exists({ recipient: hr.userId, type: 'COMPOFF_SUBMITTED' })).toBeTruthy();
  });

  it('accepts a claim for a holiday', async () => {
    await Holiday.create({ name: 'Festival', date: weekday, year: Number(weekday.slice(0, 4)), category: 'FESTIVAL' });
    const res = await claim(weekday);
    expect(res.status).toBe(201);
    expect(res.body.data.occasion).toBe('Holiday: Festival');
  });

  it('refuses an ordinary working day, a future date and a stale date', async () => {
    expect((await claim(weekday)).body.error.code).toBe('NOT_ELIGIBLE_DATE');
    expect((await claim(addDays(today, 3))).body.error.code).toBe('FUTURE_DATE');
    expect((await claim(previous(addDays(today, -60), (d) => dayOfWeek(d) === 6))).body.error.code).toBe('CLAIM_TOO_OLD');
  });

  it('refuses a second claim for the same date, even at the same moment', async () => {
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await claim()).status).toBe(409);
  });

  it('follows the configurable rules', async () => {
    await CompanySettings.updateOne({ key: 'global' }, { 'compOff.allowOnWeeklyOff': false, 'compOff.allowHalfDay': false }, { upsert: true });
    expect((await claim()).body.error.code).toBe('NOT_ELIGIBLE_DATE');
    await CompanySettings.updateOne({ key: 'global' }, { 'compOff.allowOnWeeklyOff': true });
    expect((await claim(saturday, { dayType: 'HALF' })).body.error.code).toBe('HALF_DAY_NOT_ALLOWED');
  });

  it('lets HR change the rules through the API', async () => {
    const res = await hrAgent.put('/api/settings/compoff').send({ validityDays: 45 });
    expect(res.status).toBe(200);
    expect(res.body.data.compOff.validityDays).toBe(45);
    expect((await empAgent.put('/api/settings/compoff').send({ validityDays: 1000 })).status).toBe(403);
  });
});

describe('approving Comp-Off claims', () => {
  it('credits a lot with an expiry and only once', async () => {
    const id = (await claim()).body.data._id;
    expect((await summary()).pendingCredit).toBe(1);
    const results = await Promise.all(Array.from({ length: 4 }, () => hrAgent.patch(`/api/compoff/${id}/approve`).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const s = await summary();
    expect(s.available).toBe(1);
    expect(s.pendingCredit).toBe(0);
    expect(s.nextExpiry).toBe(addDays(saturday, 90));
    expect(await CompOffTransaction.countDocuments({ type: 'CREDIT', compOffRequest: id })).toBe(1);
    expect(await Notification.exists({ recipient: emp.userId, type: 'COMPOFF_CREDITED' })).toBeTruthy();
  });

  it('accepts a custom expiry from the admin', async () => {
    const id = (await claim()).body.data._id;
    const expiresOn = addDays(saturday, 10);
    await hrAgent.patch(`/api/compoff/${id}/approve`).send({ expiresOn });
    expect((await summary()).nextExpiry).toBe(expiresOn);
  });

  it('rejects with a reason and notifies', async () => {
    const id = (await claim()).body.data._id;
    expect((await hrAgent.patch(`/api/compoff/${id}/reject`).send({})).status).toBe(400);
    expect((await hrAgent.patch(`/api/compoff/${id}/reject`).send({ reason: 'No record of this' })).status).toBe(200);
    expect((await summary()).available).toBe(0);
    expect(await Notification.exists({ recipient: emp.userId, type: 'COMPOFF_REJECTED' })).toBeTruthy();
    expect((await claim()).status).toBe(201);
  });

  it('forbids approving your own claim', async () => {
    const id = (await hrAgent.post('/api/compoff').send({ workedDate: saturday, dayType: 'FULL', reason: 'x' })).body.data._id;
    expect((await hrAgent.patch(`/api/compoff/${id}/approve`).send({})).body.error.code).toBe('SELF_APPROVAL');
  });
});

describe('using Comp-Off as leave', () => {
  const far = () => addDays(today, 200);

  it('holds on apply, deducts only after approval, and keeps a full record', async () => {
    await credit(2, far());
    const res = await empAgent.post('/api/leaves').send(fullDay(co, leaveDay));
    expect(res.status).toBe(201);
    let s = await summary();
    expect(s.available).toBe(1);
    expect(s.reserved).toBe(1);
    expect(s.used).toBe(0);

    await hrAgent.patch(`/api/approvals/${res.body.data._id}/approve`).send({});
    s = await summary();
    expect(s.available).toBe(1);
    expect(s.reserved).toBe(0);
    expect(s.used).toBe(1);
    const types = (await CompOffTransaction.find({ leaveRequest: res.body.data._id }).lean()).map((t) => t.type).sort();
    expect(types).toEqual(['DEBIT', 'RESERVE']);
  });

  it('refuses leave beyond the balance', async () => {
    const res = await empAgent.post('/api/leaves').send(fullDay(co, leaveDay));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('refuses expired Comp-Off', async () => {
    await credit(1, addDays(today, -1));
    expect((await summary()).available).toBe(0);
    expect((await summary()).expired).toBe(1);
    expect((await empAgent.post('/api/leaves').send(fullDay(co, leaveDay))).status).toBe(422);
  });

  it('refuses a lot that expires before the leave date', async () => {
    const leave = next(addDays(today, 30), (d) => !isWeekend(d));
    await credit(1, addDays(today, 5));
    const res = await empAgent.post('/api/leaves').send(fullDay(co, leave));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/valid Comp-Off/);
  });

  it('spends the earliest-expiring credit first', async () => {
    await credit(1, far(), 'late-lot');
    await credit(1, addDays(today, 10), 'soon-lot');
    const res = await empAgent.post('/api/leaves').send(fullDay(co, leaveDay));
    const soon = await CompOffTransaction.findOne({ type: 'CREDIT', expiresOn: addDays(today, 10) }).lean();
    expect(res.body.data.compOffAllocations.map((a: any) => a.lot)).toEqual([String(soon!._id)]);
  });

  it('draws one leave from several lots', async () => {
    const leaveEnd = next(leaveDay, (d) => !isWeekend(d));
    await credit(0.5, far(), 'lot-a');
    await credit(1.5, addDays(far(), 1), 'lot-b');
    const res = await empAgent.post('/api/leaves').send(fullDay(co, leaveDay, leaveEnd));
    expect(res.status).toBe(201);
    expect(res.body.data.compOffAllocations).toHaveLength(2);
  });

  it('keeps simultaneous requests from spending the same credit', async () => {
    await credit(1, far());
    const later = next(leaveDay, (d) => !isWeekend(d));
    const results = await Promise.all([
      empAgent.post('/api/leaves').send(fullDay(co, leaveDay)),
      empAgent.post('/api/leaves').send(fullDay(co, later)),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await summary()).available).toBe(0);
    expect((await summary()).reserved).toBe(1);
  });

  it('returns held days on rejection', async () => {
    await credit(1, far());
    const id = (await empAgent.post('/api/leaves').send(fullDay(co, leaveDay))).body.data._id;
    await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'No' });
    const s = await summary();
    expect(s.available).toBe(1);
    expect(s.reserved).toBe(0);
  });

  it('restores used days when approved leave is cancelled', async () => {
    await credit(1, far());
    const id = (await empAgent.post('/api/leaves').send(fullDay(co, leaveDay))).body.data._id;
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    await empAgent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'x' });
    await hrAgent.patch(`/api/approvals/${id}/cancellation/approve`).send({});
    const s = await summary();
    expect(s.available).toBe(1);
    expect(s.used).toBe(0);
  });

  it('shows Comp-Off as its own balance row', async () => {
    await credit(2, far());
    const res = await empAgent.get('/api/leave-balances/my');
    const row = res.body.data.find((b: any) => b.leaveType.code === 'CO');
    expect(row.isCompOff).toBe(true);
    expect(row.available).toBe(2);
    expect((await empAgent.get('/api/leave-balances/my?year=2030')).status).toBe(200);
  });
});

describe('admin Comp-Off tools', () => {
  it('deducts from the earliest lots with a record', async () => {
    await credit(1, addDays(today, 10), 'a');
    await credit(2, addDays(today, 50), 'b');
    const res = await hrAgent.post('/api/compoff/manual').send({ employee: String(emp.employee._id), amount: -2, reason: 'Correction' });
    expect(res.status).toBe(201);
    expect(res.body.data.allocations).toHaveLength(2);
    expect((await summary()).available).toBe(1);
  });

  it('refuses a deduction beyond the balance', async () => {
    await credit(1, addDays(today, 10));
    const res = await hrAgent.post('/api/compoff/manual').send({ employee: String(emp.employee._id), amount: -2, reason: 'x' });
    expect(res.status).toBe(422);
    expect((await summary()).available).toBe(1);
  });

  it('does not repeat a retried manual credit', async () => {
    await credit(1, addDays(today, 10), 'same');
    await credit(1, addDays(today, 10), 'same');
    expect((await summary()).available).toBe(1);
  });

  it('can change an expiry date', async () => {
    const id = (await credit(1, addDays(today, 10))).body.data._id;
    const expiresOn = addDays(today, 40);
    const res = await hrAgent.patch(`/api/compoff/credits/${id}/expiry`).send({ expiresOn });
    expect(res.body.data.expiresOn).toBe(expiresOn);
  });

  it('lists requests and employee records', async () => {
    await claim();
    const list = await hrAgent.get('/api/compoff?status=PENDING');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].employee.fullName).toBe(emp.employee.fullName);
    expect((await hrAgent.get(`/api/compoff/employees/${emp.employee._id}`)).body.data.available).toBe(0);
  });
});

describe('Comp-Off expiry jobs', () => {
  it('expires the unheld balance and records it', async () => {
    await credit(2, addDays(today, -1));
    expect(await expireCompOffLots(today)).toBe(1);
    const s = await summary();
    expect(s.expired).toBe(2);
    expect(s.available).toBe(0);
    expect(await CompOffTransaction.countDocuments({ type: 'EXPIRE' })).toBe(1);
    expect(await expireCompOffLots(today)).toBe(0);
  });

  it('leaves valid lots alone', async () => {
    await credit(2, addDays(today, 1));
    expect(await expireCompOffLots(today)).toBe(0);
    expect((await summary()).available).toBe(2);
  });

  it('keeps days reserved by a pending leave out of the sweep', async () => {
    await credit(2, leaveDay);
    await empAgent.post('/api/leaves').send(fullDay(co, leaveDay));
    expect(await expireCompOffLots(addDays(leaveDay, 1))).toBe(1);
    const lot = await CompOffTransaction.findOne({ type: 'CREDIT' }).lean();
    expect(lot!.reserved).toBe(1);
    expect(lot!.expired).toBe(1);
    expect(lot!.remaining).toBe(0);
  });

  it('warns once before expiry', async () => {
    await credit(1, addDays(today, 3));
    expect(await warnExpiringCompOff(today)).toBe(1);
    expect(await warnExpiringCompOff(today)).toBe(0);
    expect(await Notification.countDocuments({ recipient: emp.userId, type: 'COMPOFF_EXPIRING' })).toBe(1);
  });
});
