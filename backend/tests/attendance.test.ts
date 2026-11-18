import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendanceRecord, AuditLog, Employee, Notification, WfhRequest } from '../src/models';
import { dayStatus } from '../src/services/attendance';
import { Agent, agentFor, baseline, FRI, fullDay, MON, makePerson, Person, THU, TUE, typeId, useDatabase, WED } from './helpers';

useDatabase('attendance');

let emp: Person;
let manager: Person;
let hr: Person;
let empAgent: Agent;
let managerAgent: Agent;
let hrAgent: Agent;

/** 09:30 on Monday 4 March 2030 in India. */
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const MONDAY_MORNING = '2030-03-04T04:00:00Z';
const MONDAY_EVENING = '2030-03-04T12:45:00Z';
/** Moving the clock this far expires the access token, so sign in again. */
const later = async (iso: string) => { at(iso); empAgent = await agentFor(emp.email); };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(MONDAY_MORNING);
  await baseline();
  hr = await makePerson({ role: 'HR_ADMIN' });
  manager = await makePerson();
  emp = await makePerson({ manager: manager.employee._id, joiningDate: '2020-01-01' });
  empAgent = await agentFor(emp.email);
  managerAgent = await agentFor(manager.email);
  hrAgent = await agentFor(hr.email);
});

afterEach(() => vi.useRealTimers());

const dayOf = async (date: string, agent = empAgent) => {
  const res = await agent.get('/api/attendance/my').query({ month: date.slice(0, 7) });
  return res.body.data.days.find((d: { date: string }) => d.date === date);
};
const applyWfh = (startDate: string, endDate = startDate, agent = empAgent) => agent.post('/api/wfh').send({ startDate, endDate, reason: 'Internet engineer visiting' });

describe('punching', () => {
  it('records the server time in the company timezone', async () => {
    const res = await empAgent.post('/api/attendance/punch-in').send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ date: MON, punchIn: '09:30', punchOut: null });

    await later(MONDAY_EVENING);
    const out = await empAgent.post('/api/attendance/punch-out').send({});
    expect(out.body.data).toMatchObject({ punchIn: '09:30', punchOut: '18:15', workedMinutes: 525 });
    const day = await dayOf(MON);
    expect(day).toMatchObject({ status: 'PRESENT', punchIn: '09:30', punchOut: '18:15', workedMinutes: 525 });
  });

  it('files a punch under the company date even when UTC is still the day before', async () => {
    await later('2030-03-04T19:00:00Z'); // 00:30 on the 5th in India
    const res = await empAgent.post('/api/attendance/punch-in').send({});
    expect(res.body.data).toMatchObject({ date: TUE, punchIn: '00:30' });
  });

  it('refuses a client-supplied time or date', async () => {
    expect((await empAgent.post('/api/attendance/punch-in').send({ punchIn: '08:00' })).status).toBe(400);
    expect((await empAgent.post('/api/attendance/punch-in').send({ date: FRI })).status).toBe(400);
    expect(await AttendanceRecord.countDocuments()).toBe(0);
  });

  it('allows one punch in and out a day, even when sent at the same moment', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => empAgent.post('/api/attendance/punch-in').send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'ALREADY_PUNCHED_IN')).toHaveLength(4);
    expect(await AttendanceRecord.countDocuments({ employee: emp.employee._id })).toBe(1);

    await empAgent.post('/api/attendance/punch-out').send({});
    const again = await empAgent.post('/api/attendance/punch-out').send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PUNCHED_OUT');
  });

  it('needs a punch in first', async () => {
    const res = await empAgent.post('/api/attendance/punch-out').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_PUNCHED_IN');
  });

  it('starts fresh the next day, leaving a forgotten punch out visible', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    await later('2030-03-05T04:00:00Z');
    expect((await empAgent.post('/api/attendance/punch-in').send({})).status).toBe(200);
    expect((await dayOf(MON)).punchOut).toBeNull();
  });

  it('needs an employee profile and a session', async () => {
    const admin = await agentFor((await makePerson({ role: 'SUPER_ADMIN' })).email);
    expect((await admin.post('/api/attendance/punch-in').send({})).status).toBe(200);
  });
});

describe('what each day shows', () => {
  const base = { date: MON, today: TUE, joiningDate: '2020-01-01', hasPunch: false, leaveValue: 0, wfh: false, fullHoliday: false };

  it.each([
    ['a punch', { hasPunch: true }, 'PRESENT'],
    ['a punch while working from home', { hasPunch: true, wfh: true }, 'WFH'],
    ['approved work from home with no punch', { wfh: true }, 'WFH'],
    ['approved leave', { leaveValue: 1 }, 'ON_LEAVE'],
    ['leave over work from home', { leaveValue: 1, wfh: true }, 'ON_LEAVE'],
    ['half-day leave', { leaveValue: 0.5 }, 'HALF_LEAVE'],
    ['half-day leave with a punch', { leaveValue: 0.5, hasPunch: true }, 'HALF_LEAVE'],
    ['a holiday', { fullHoliday: true }, 'HOLIDAY'],
    ['a holiday over work from home', { fullHoliday: true, wfh: true }, 'HOLIDAY'],
    ['a weekend', { date: '2030-03-02', today: TUE }, 'WEEKEND'],
    ['working on a weekend', { date: '2030-03-02', hasPunch: true }, 'PRESENT'],
    ['a past working day with nothing', {}, 'ABSENT'],
    ['today with no punch yet', { today: MON }, 'UPCOMING'],
    ['a future day', { today: FRI }, 'UPCOMING'],
    ['before joining', { joiningDate: WED }, 'NOT_EMPLOYED'],
    ['before attendance began', { trackingFrom: TUE }, 'NOT_TRACKED'],
    ['on the day attendance began', { date: MON, today: WED, trackingFrom: MON }, 'ABSENT'],
    ['a punch before attendance began', { trackingFrom: TUE, hasPunch: true }, 'PRESENT'],
  ])('%s', (_name, over, expected) => {
    expect(dayStatus({ ...base, ...over })).toBe(expected);
  });

  it('shows real approved leave', async () => {
    const res = await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED));
    await hrAgent.patch(`/api/approvals/${res.body.data._id}/approve`).send({});
    expect((await dayOf(WED)).status).toBe('ON_LEAVE');
  });

  it('does not count pending leave', async () => {
    await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED));
    expect((await dayOf(WED)).status).toBe('UPCOMING');
  });

  it('adds up the month', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    const res = await empAgent.get('/api/attendance/my').query({ month: '2030-03' });
    expect(res.body.data.summary.present).toBe(1);
    expect(res.body.data.summary.absent).toBe(1); // Friday 1 March
  });
});

describe('work from home', () => {
  it('counts working days on the server and tells the approvers', async () => {
    const res = await applyWfh(FRI, MON);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', totalDays: 2 });
    expect(await Notification.exists({ recipient: manager.userId, type: 'WFH_REQUESTED' })).toBeTruthy();
    expect(await Notification.exists({ recipient: hr.userId, type: 'WFH_REQUESTED' })).toBeTruthy();
    expect(await AuditLog.exists({ action: 'WFH_APPLIED' })).toBeTruthy();
  });

  it('does not mark attendance until approved, then marks it', async () => {
    const id = (await applyWfh(WED, THU)).body.data._id;
    expect((await dayOf(WED)).status).toBe('UPCOMING');

    const res = await hrAgent.patch(`/api/wfh/${id}/approve`).send({});
    expect(res.status).toBe(200);
    expect((await dayOf(WED)).status).toBe('WFH');
    expect((await dayOf(THU)).status).toBe('WFH');
    expect(await Notification.exists({ recipient: emp.userId, type: 'WFH_APPROVED' })).toBeTruthy();
  });

  it('never marks the weekend inside a range', async () => {
    const id = (await applyWfh(FRI, MON)).body.data._id;
    await hrAgent.patch(`/api/wfh/${id}/approve`).send({});
    expect((await dayOf('2030-03-02')).status).toBe('WEEKEND');
    expect((await dayOf(FRI)).status).toBe('WFH');
  });

  it('keeps the punch times on a work from home day', async () => {
    const id = (await applyWfh(MON)).body.data._id;
    await hrAgent.patch(`/api/wfh/${id}/approve`).send({});
    await empAgent.post('/api/attendance/punch-in').send({});
    expect(await dayOf(MON)).toMatchObject({ status: 'WFH', punchIn: '09:30' });
  });

  it('leaves attendance alone when rejected, and requires a reason', async () => {
    const id = (await applyWfh(WED)).body.data._id;
    expect((await hrAgent.patch(`/api/wfh/${id}/reject`).send({})).status).toBe(400);
    expect((await hrAgent.patch(`/api/wfh/${id}/reject`).send({ reason: 'Team day' })).status).toBe(200);
    expect((await dayOf(WED)).status).toBe('UPCOMING');
    expect((await Notification.findOne({ recipient: emp.userId, type: 'WFH_REJECTED' }).lean())!.message).toContain('Team day');
  });

  it('corrects attendance by itself when cancelled', async () => {
    const id = (await applyWfh(WED)).body.data._id;
    await hrAgent.patch(`/api/wfh/${id}/approve`).send({});
    expect((await empAgent.patch(`/api/wfh/${id}/cancel`).send({})).status).toBe(200);
    expect((await dayOf(WED)).status).toBe('UPCOMING');
  });

  it('refuses to cancel approved dates already passed', async () => {
    const id = (await applyWfh(WED)).body.data._id;
    await hrAgent.patch(`/api/wfh/${id}/approve`).send({});
    await later('2030-03-08T04:00:00Z');
    const res = await empAgent.patch(`/api/wfh/${id}/cancel`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WFH_IN_PAST');
  });

  it('decides once: six approvals give one success', async () => {
    const id = (await applyWfh(WED)).body.data._id;
    const results = await Promise.all(Array.from({ length: 6 }, () => hrAgent.patch(`/api/wfh/${id}/approve`).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await Notification.countDocuments({ recipient: emp.userId, type: 'WFH_APPROVED' })).toBe(1);
  });

  it('lets the reporting manager decide, but not other employees or the applicant', async () => {
    const id = (await applyWfh(WED)).body.data._id;
    const other = await agentFor((await makePerson()).email);
    expect((await other.patch(`/api/wfh/${id}/approve`).send({})).status).toBe(404);
    const own = await empAgent.patch(`/api/wfh/${id}/approve`).send({});
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SELF_APPROVAL');
    expect((await managerAgent.patch(`/api/wfh/${id}/approve`).send({})).status).toBe(200);
  });

  it('stops HR deciding their own request', async () => {
    const id = (await applyWfh(WED, WED, hrAgent)).body.data._id;
    expect((await hrAgent.patch(`/api/wfh/${id}/approve`).send({})).status).toBe(403);
  });

  it('shows each person only the requests they can decide', async () => {
    const id = String((await applyWfh(WED)).body.data._id);
    const ids = async (agent: Agent) => (await agent.get('/api/wfh/pending')).body.data.map((r: { _id: string }) => r._id);
    expect(await ids(managerAgent)).toEqual([id]);
    expect(await ids(hrAgent)).toEqual([id]);
    expect(await ids(empAgent)).toEqual([]);
    expect(await ids(await agentFor((await makePerson()).email))).toEqual([]);
    const row = (await hrAgent.get('/api/wfh/pending')).body.data[0];
    expect(row.employee.fullName).toBe(emp.employee.fullName);
  });

  it('hides one person\'s requests from another, and cancelling them', async () => {
    const id = (await applyWfh(WED)).body.data._id;
    const other = await agentFor((await makePerson()).email);
    expect((await other.get('/api/wfh/my')).body.data).toEqual([]);
    expect((await other.patch(`/api/wfh/${id}/cancel`).send({})).status).toBe(404);
    expect((await WfhRequest.findById(id).lean())!.status).toBe('PENDING');
  });

  it.each([
    ['ends before it starts', THU, WED, 'INVALID_DATES'],
    ['only a weekend', '2030-03-02', '2030-03-03', 'NO_WORKING_DAYS'],
    ['too long', '2030-03-04', '2030-04-10', 'WFH_TOO_LONG'],
    ['too far back', '2030-01-07', '2030-01-07', 'WFH_TOO_OLD'],
  ])('refuses a request that is %s', async (_name, start, end, code) => {
    const res = await applyWfh(start, end);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(code);
  });

  it('refuses overlaps with its own requests and full-day leave, but allows half-day leave', async () => {
    await applyWfh(MON, TUE);
    expect((await applyWfh(TUE, WED)).body.error.code).toBe('OVERLAPPING_REQUEST');

    await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), '2030-03-08'));
    expect((await applyWfh('2030-03-08')).body.error.code).toBe('OVERLAPPING_LEAVE');

    await empAgent.post('/api/leaves').send({ leaveType: await typeId('CL'), startDate: THU, endDate: THU, dayType: 'HALF', halfSession: 'FIRST', reason: 'x' });
    expect((await applyWfh(THU)).status).toBe(201);
  });

  it('lets only one of two simultaneous overlapping requests through', async () => {
    const results = await Promise.all([applyWfh(WED), applyWfh(WED)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('rejects extra fields such as a day count or status', async () => {
    expect((await empAgent.post('/api/wfh').send({ startDate: WED, endDate: WED, reason: 'x', totalDays: 99 })).status).toBe(400);
    expect((await empAgent.post('/api/wfh').send({ startDate: WED, endDate: WED, reason: 'x', status: 'APPROVED' })).status).toBe(400);
    expect((await empAgent.post('/api/wfh').send({ startDate: WED, endDate: WED })).status).toBe(400);
  });
});

describe('HR view and corrections', () => {
  it('shows everyone for a day, with totals', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    const wfhId = (await applyWfh(MON, MON, managerAgent)).body.data._id;
    await hrAgent.patch(`/api/wfh/${wfhId}/approve`).send({});

    const res = await hrAgent.get('/api/attendance').query({ date: MON });
    expect(res.status).toBe(200);
    const row = (p: Person) => res.body.data.rows.find((r: { employee: { _id: string } }) => r.employee._id === String(p.employee._id));
    expect(row(emp)).toMatchObject({ status: 'PRESENT', punchIn: '09:30' });
    expect(row(manager).status).toBe('WFH');
    expect(row(hr).status).toBe('UPCOMING');
    expect(res.body.data.summary).toMatchObject({ present: 1, workFromHome: 1 });
    expect(res.body.meta.total).toBe(3);
  });

  it('searches, and leaves out inactive employees', async () => {
    await Employee.updateOne({ _id: manager.employee._id }, { employmentStatus: 'INACTIVE' });
    const all = await hrAgent.get('/api/attendance').query({ date: MON });
    expect(all.body.meta.total).toBe(2);
    const found = await hrAgent.get('/api/attendance').query({ date: MON, search: emp.employee.employeeId });
    expect(found.body.data.rows).toHaveLength(1);
  });

  it('keeps it from employees and managers', async () => {
    expect((await empAgent.get('/api/attendance')).status).toBe(403);
    expect((await managerAgent.get(`/api/attendance/employees/${emp.employee._id}`)).status).toBe(403);
    expect((await empAgent.put(`/api/attendance/employees/${emp.employee._id}/${MON}`).send({ punchIn: '09:00', note: 'x' })).status).toBe(403);
  });

  it('lets HR add a missed day, with an audit entry and a notification', async () => {
    const res = await hrAgent.put(`/api/attendance/employees/${emp.employee._id}/${FRI}`).send({ punchIn: '09:00', punchOut: '18:00', note: 'Forgot to punch' });
    expect(res.status).toBe(200);
    expect(await dayOf(FRI)).toMatchObject({ status: 'PRESENT', punchIn: '09:00', workedMinutes: 540, corrected: true, correctionNote: 'Forgot to punch' });
    expect(await AuditLog.exists({ action: 'ATTENDANCE_CORRECTED' })).toBeTruthy();
    expect(await Notification.exists({ recipient: emp.userId, type: 'ATTENDANCE_CORRECTED' })).toBeTruthy();
  });

  it('lets HR fix a forgotten punch out, recording what it was', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    await hrAgent.put(`/api/attendance/employees/${emp.employee._id}/${MON}`).send({ punchIn: '09:30', punchOut: '18:00', note: 'Forgot' });
    expect(await AttendanceRecord.countDocuments({ employee: emp.employee._id })).toBe(1);
    const log = (await AuditLog.findOne({ action: 'ATTENDANCE_CORRECTED' }).lean())!;
    expect(log.before).toEqual({ punchIn: '09:30', punchOut: null });
    const again = await empAgent.post('/api/attendance/punch-out').send({});
    expect(again.status).toBe(409);
  });

  it('refuses bad corrections, including HR correcting themselves', async () => {
    const put = (body: object, date = FRI, who = emp) => hrAgent.put(`/api/attendance/employees/${who.employee._id}/${date}`).send(body);
    expect((await put({ punchIn: '18:00', punchOut: '09:00', note: 'x' })).body.error.code).toBe('INVALID_TIMES');
    expect((await put({ punchIn: '09:00', note: 'x' }, WED)).body.error.code).toBe('FUTURE_DATE');
    expect((await put({ punchIn: '09:00', note: 'x' }, '2019-01-07')).body.error.code).toBe('BEFORE_JOINING');
    expect((await put({ punchIn: '25:00', note: 'x' })).status).toBe(400);
    expect((await put({ punchIn: '09:00' })).status).toBe(400);
    expect((await put({ punchIn: '09:00', note: 'x' }, FRI, hr)).body.error.code).toBe('SELF_CORRECTION');
  });
});
