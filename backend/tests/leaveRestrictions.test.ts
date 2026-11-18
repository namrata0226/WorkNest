import { beforeEach, describe, expect, it } from 'vitest';
import { LeaveBalance, LeaveRequest, LeaveType, Employee } from '../src/models';
import { reconcileBalance } from '../src/services/balance';
import { ensureBaseline } from '../src/services/baseline';
import { agentFor, Agent, baseline, FRI, fullDay, makePerson, MON, Person, typeId, useDatabase } from './helpers';

useDatabase('leave_restrictions');

const NEXT_MONTH = '2030-04-01';

let menstrual: string;
let woman: Person;
let womanAgent: Agent;
let man: Person;
let manAgent: Agent;
let hrAgent: Agent;

beforeEach(async () => {
  await baseline();
  menstrual = await typeId('MNL');
  woman = await makePerson({ gender: 'FEMALE' });
  womanAgent = await agentFor(woman.email);
  man = await makePerson({ gender: 'MALE' });
  manAgent = await agentFor(man.email);
  hrAgent = await agentFor((await makePerson({ role: 'HR_ADMIN' })).email);
});

const listed = async (agent: Agent) => (await agent.get('/api/leave-types/available')).body.data as { code: string; ineligibleReason: string | null }[];
const available = async (agent: Agent) => (await listed(agent)).filter((t) => !t.ineligibleReason).map((t) => t.code);

describe('menstrual leave', () => {
  it('is approved automatically and charged at once', async () => {
    const res = await womanAgent.post('/api/leaves').send(fullDay(menstrual, FRI));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.totalDays).toBe(1);

    const balance = await LeaveBalance.findOne({ employee: woman.employee._id, leaveType: menstrual, year: 2030 }).lean();
    expect(balance!.used).toBe(1);
    expect(balance!.reserved).toBe(0);
    expect(balance!.available).toBe(11);
    expect((await reconcileBalance(woman.employee._id, balance!.leaveType, 2030)).matches).toBe(true);
    expect((await hrAgent.get('/api/approvals/pending')).body.data).toHaveLength(0);
  });

  it('allows one application a calendar month', async () => {
    expect((await womanAgent.post('/api/leaves').send(fullDay(menstrual, FRI))).status).toBe(201);
    const second = await womanAgent.post('/api/leaves').send(fullDay(menstrual, MON));
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('MONTHLY_LIMIT_REACHED');
    expect((await womanAgent.post('/api/leaves').send(fullDay(menstrual, NEXT_MONTH))).status).toBe(201);
  });

  it('does not need a reason, whether it is left out, blank or null', async () => {
    const { reason: _reason, ...noReason } = fullDay(menstrual, FRI);
    const res = await womanAgent.post('/api/leaves').send(noReason);
    expect(res.status).toBe(201);
    expect(res.body.data.reason).toBeNull();
    for (const [date, reason] of [[NEXT_MONTH, '   '], ['2030-05-01', null]] as const) {
      const again = await womanAgent.post('/api/leaves').send({ ...fullDay(menstrual, date), reason });
      expect(again.status).toBe(201);
      expect(again.body.data.reason).toBeNull();
    }
    expect((await womanAgent.post('/api/leaves').send({ ...fullDay(menstrual, '2030-06-03'), reason: 'x'.repeat(1001) })).status).toBe(400);
  });

  it('keeps a reason when one is given', async () => {
    const res = await womanAgent.post('/api/leaves').send({ ...fullDay(menstrual, FRI), reason: 'Unwell' });
    expect(res.body.data.reason).toBe('Unwell');
  });

  it('still requires a reason for leave that needs approval', async () => {
    const cl = await typeId('CL');
    const { reason: _reason, ...noReason } = fullDay(cl, FRI);
    for (const body of [noReason, { ...noReason, reason: '  ' }, { ...noReason, reason: null }]) {
      const res = await womanAgent.post('/api/leaves').send(body);
      expect(res.status).toBe(422);
      expect(res.body.error.details[0]).toEqual({ path: 'reason', message: 'A reason is required' });
    }
    expect(await LeaveRequest.countDocuments({ employee: woman.employee._id })).toBe(0);
  });

  it('follows a policy that turns approval off or on for this employee', async () => {
    const cl = await typeId('CL');
    await hrAgent.post('/api/leave-policies').send({ name: 'Auto casual', effectiveFrom: '2020-01-01', rules: [{ leaveType: cl, requiresApproval: false }, { leaveType: menstrual, requiresApproval: true }] });
    const { reason: _r1, ...casual } = fullDay(cl, FRI);
    const auto = await womanAgent.post('/api/leaves').send(casual);
    expect(auto.status).toBe(201);
    expect(auto.body.data.status).toBe('APPROVED');
    const { reason: _r2, ...monthly } = fullDay(menstrual, MON);
    expect((await womanAgent.post('/api/leaves').send(monthly)).status).toBe(422);
  });

  it('warns in the preview before submission', async () => {
    await womanAgent.post('/api/leaves').send(fullDay(menstrual, FRI));
    const { leaveType, startDate, endDate, dayType } = fullDay(menstrual, MON);
    const res = await womanAgent.post('/api/leaves/preview').send({ leaveType, startDate, endDate, dayType });
    expect(res.body.data.issues.map((i: { message: string }) => i.message).join()).toMatch(/once a month/);
  });

  it('frees the month again when the leave is cancelled', async () => {
    const id = (await womanAgent.post('/api/leaves').send(fullDay(menstrual, FRI))).body.data._id;
    expect((await hrAgent.patch(`/api/leaves/${id}/cancel`).send({ reason: 'Entered by mistake' })).status).toBe(200);
    expect((await womanAgent.post('/api/leaves').send(fullDay(menstrual, MON))).status).toBe(201);
  });

  it('lets only one of two simultaneous applications through', async () => {
    const results = await Promise.all([FRI, MON].map((d) => womanAgent.post('/api/leaves').send(fullDay(menstrual, d))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await LeaveRequest.countDocuments({ employee: woman.employee._id, leaveType: menstrual })).toBe(1);
  });

  it('is limited to one day and cannot be a half day', async () => {
    expect((await womanAgent.post('/api/leaves').send(fullDay(menstrual, MON, '2030-03-05'))).status).toBe(422);
    const half = await womanAgent.post('/api/leaves').send({ ...fullDay(menstrual, FRI), dayType: 'HALF', halfSession: 'FIRST' });
    expect(half.status).toBe(422);
  });
});

describe('gender rules', () => {
  it('refuses menstrual and maternity leave to a male employee', async () => {
    for (const code of ['MNL', 'ML']) {
      const res = await manAgent.post('/api/leaves').send(fullDay(await typeId(code), FRI));
      expect(res.status).toBe(422);
      expect(res.body.error.details.map((d: { message: string }) => d.message).join()).toMatch(/only available to female employees/);
    }
    expect(await LeaveRequest.countDocuments({ employee: man.employee._id })).toBe(0);
  });

  it('refuses paternity leave to a female employee and allows it for a male one', async () => {
    const pat = await typeId('PAT');
    const refused = await womanAgent.post('/api/leaves').send(fullDay(pat, FRI));
    expect(refused.status).toBe(422);
    expect(refused.body.error.details[0].message).toMatch(/only available to male employees/);
    expect((await manAgent.post('/api/leaves').send(fullDay(pat, FRI))).status).toBe(201);
  });

  it('lists types someone cannot take, with the same reason the server refuses them for', async () => {
    const paternity = (await listed(womanAgent)).find((t) => t.code === 'PAT');
    expect(paternity?.ineligibleReason).toMatch(/only available to male employees/);
    const refused = await womanAgent.post('/api/leaves').send(fullDay(await typeId('PAT'), FRI));
    expect(refused.status).toBe(422);
    expect(refused.body.error.details[0].message).toBe(paternity?.ineligibleReason);
  });

  it('marks as eligible only the types each person can take', async () => {
    const hers = await available(womanAgent);
    expect(hers).toEqual(expect.arrayContaining(['MNL', 'ML', 'CL']));
    expect(hers).not.toContain('PAT');
    const his = await available(manAgent);
    expect(his).toEqual(expect.arrayContaining(['PAT', 'CL']));
    expect(his).not.toContain('MNL');
    expect(his).not.toContain('ML');
  });

  it('asks someone with no recorded gender to contact HR, and restricts them from every gendered type', async () => {
    const unknown = await makePerson();
    const agent = await agentFor(unknown.email);
    const res = await agent.post('/api/leaves').send(fullDay(menstrual, FRI));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].message).toMatch(/ask HR/);
    const types = await available(agent);
    for (const code of ['MNL', 'ML', 'PAT']) expect(types).not.toContain(code);
    expect(types).toContain('CL');
  });

  it('applies to balances, so nobody is shown leave they cannot take', async () => {
    const codes = (await manAgent.get('/api/leave-balances/my')).body.data.map((b: { leaveType: { code: string } }) => b.leaveType.code);
    expect(codes).not.toContain('MNL');
    expect(codes).toContain('PAT');
  });

  it('lets HR record gender, which takes effect immediately', async () => {
    const person = await makePerson();
    const agent = await agentFor(person.email);
    expect(await available(agent)).not.toContain('MNL');
    expect((await hrAgent.put(`/api/employees/${person.employee._id}`).send({ gender: 'FEMALE' })).status).toBe(200);
    expect(await available(agent)).toContain('MNL');
  });

  it('does not let employees change their own gender, and rejects unknown values', async () => {
    expect((await womanAgent.put(`/api/employees/${woman.employee._id}`).send({ gender: 'MALE' })).status).toBe(403);
    expect((await Employee.findById(woman.employee._id).lean())!.gender).toBe('FEMALE');
    expect((await hrAgent.put(`/api/employees/${woman.employee._id}`).send({ gender: 'SOMETHING' })).status).toBe(400);
  });

  it('lets employees update their own name and phone, and nothing else', async () => {
    const res = await womanAgent.patch('/api/employees/me').send({ fullName: 'New Name', phone: '+91 98765 43210' });
    expect(res.status).toBe(200);
    const profile = (await womanAgent.get('/api/auth/me')).body.data.employee;
    expect(profile.fullName).toBe('New Name');
    expect(profile.phone).toBe('+91 98765 43210');
    expect(profile.gender).toBe('FEMALE');

    for (const field of [{ gender: 'MALE' }, { role: 'SUPER_ADMIN' }, { employeeId: 'HACK-1' }, { email: 'other@x.co' }, { department: String(woman.employee._id) }, { reportingManager: null }]) {
      expect((await womanAgent.patch('/api/employees/me').send({ fullName: 'Changed', ...field })).status).toBe(400);
    }
    const after = (await Employee.findById(woman.employee._id).lean())!;
    expect(after.fullName).toBe('New Name');
    expect(after.gender).toBe('FEMALE');
    expect(await available(womanAgent)).toContain('MNL');
  });

  it('validates a profile update and only ever changes the caller', async () => {
    expect((await womanAgent.patch('/api/employees/me').send({ fullName: ' ', phone: null })).status).toBe(400);
    expect((await womanAgent.patch('/api/employees/me').send({ fullName: 'Valid', phone: 'not a phone' })).status).toBe(400);
    expect((await womanAgent.patch(`/api/employees/${man.employee._id}`).send({ fullName: 'Hacked' })).status).toBe(404);
    expect((await Employee.findById(man.employee._id).lean())!.fullName).not.toBe('Hacked');
  });

  it('imports gender from a file and reports an unknown value', async () => {
    const csv = 'Employee ID,Full Name,Email,Joining Date,Gender\nIMP-1,Imported One,imp1@test.local,2024-01-15,Female\nIMP-2,Imported Two,imp2@test.local,2024-01-15,Unknown\n';
    const res = await hrAgent.post('/api/employees/import').attach('file', Buffer.from(csv), { filename: 'people.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.errors[0].message).toMatch(/Unknown gender/);
    expect((await Employee.findOne({ employeeId: 'IMP-1' }).lean())!.gender).toBe('FEMALE');
  });

  it('lets HR change who a leave type applies to, and its monthly limit', async () => {
    const cl = await typeId('CL');
    expect((await hrAgent.put(`/api/leave-types/${cl}`).send({ applicableGenders: ['FEMALE'], maxRequestsPerMonth: 1 })).status).toBe(200);
    expect(await available(manAgent)).not.toContain('CL');
    expect((await womanAgent.post('/api/leaves').send(fullDay(cl, FRI))).status).toBe(201);
    expect((await womanAgent.post('/api/leaves').send(fullDay(cl, MON))).body.error.code).toBe('MONTHLY_LIMIT_REACHED');
  });
});

describe('upgrading an existing installation', () => {
  it('adds the new type and fills missing gender rules, without undoing an admin edit', async () => {
    await LeaveType.deleteOne({ code: 'MNL' });
    await LeaveType.collection.updateOne({ code: 'PAT' }, { $unset: { applicableGenders: '' } });
    await LeaveType.updateOne({ code: 'ML' }, { applicableGenders: [] });

    await ensureBaseline('2026-01-01');

    expect((await LeaveType.findOne({ code: 'MNL' }).lean())!.requiresApproval).toBe(false);
    expect((await LeaveType.findOne({ code: 'PAT' }).lean())!.applicableGenders).toEqual(['MALE']);
    expect((await LeaveType.findOne({ code: 'ML' }).lean())!.applicableGenders).toEqual([]);
  });
});
