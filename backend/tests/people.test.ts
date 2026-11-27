import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { remindMissingPunches, remindPendingApprovals } from '../src/jobs';
import {
  Announcement, AttendanceRecord, AuditLog, Employee, EmployeeDetails, EmailActionToken, ExpenseClaim, LeaveRequest, Notification, User, WfhRequest,
} from '../src/models';
import { CompanySettings } from '../src/models/System';
import { flushEmailOutbox } from '../src/services/email';
import { getSettings } from '../src/services/settings';
import { Agent, agentFor, app, baseline, FRI, fullDay, makeDepartment, makePerson, makeSuperAdmin, MON, Person, TUE, typeId, useDatabase, WED } from './helpers';
import supertest from 'supertest';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

useDatabase('people');

const MONDAY = '2030-03-04T04:00:00Z';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);

let hr: Person;
let manager: Person;
let emp: Person;
let other: Person;
let hrAgent: Agent;
let managerAgent: Agent;
let empAgent: Agent;
let otherAgent: Agent;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MONDAY));
  await baseline();
  hr = await makePerson({ role: 'HR_ADMIN' });
  manager = await makePerson({ name: 'Manny Manager' });
  emp = await makePerson({ manager: manager.employee._id, joiningDate: '2020-01-01', name: 'Emma Employee', gender: 'FEMALE' });
  other = await makePerson({ name: 'Otto Other' });
  hrAgent = await agentFor(hr.email);
  managerAgent = await agentFor(manager.email);
  empAgent = await agentFor(emp.email);
  otherAgent = await agentFor(other.email);
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(env, { SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, APP_URL: 'http://localhost:5173' });
});

const correction = (over: object = {}) => empAgent.post('/api/attendance/corrections').send({ date: FRI, punchIn: '09:00', punchOut: '18:00', reason: 'Forgot to punch', ...over });
const dayOf = async (date: string) => (await empAgent.get('/api/attendance/my').query({ month: date.slice(0, 7) })).body.data.days.find((d: { date: string }) => d.date === date);

describe('attendance correction requests', () => {
  it('changes nothing until approved, then updates the day and tells the employee', async () => {
    const res = await correction();
    expect(res.status).toBe(201);
    expect((await dayOf(FRI)).status).toBe('ABSENT');
    expect(await Notification.exists({ recipient: manager.userId, type: 'ATTENDANCE_CORRECTION_REQUESTED' })).toBeTruthy();
    expect(await Notification.exists({ recipient: hr.userId, type: 'ATTENDANCE_CORRECTION_REQUESTED' })).toBeTruthy();

    expect((await managerAgent.patch(`/api/attendance/corrections/${res.body.data._id}/approve`).send({})).status).toBe(200);
    expect(await dayOf(FRI)).toMatchObject({ status: 'PRESENT', punchIn: '09:00', punchOut: '18:00', corrected: true });
    expect(await Notification.exists({ recipient: emp.userId, title: 'Attendance correction approved' })).toBeTruthy();
    expect(await AuditLog.exists({ action: 'ATTENDANCE_CORRECTED' })).toBeTruthy();
  });

  it('leaves the day alone when rejected, and needs a reason', async () => {
    const id = (await correction()).body.data._id;
    expect((await hrAgent.patch(`/api/attendance/corrections/${id}/reject`).send({})).status).toBe(400);
    expect((await hrAgent.patch(`/api/attendance/corrections/${id}/reject`).send({ reason: 'No evidence' })).status).toBe(200);
    expect((await dayOf(FRI)).status).toBe('ABSENT');
  });

  it('allows one open request per day and one decision', async () => {
    const id = (await correction()).body.data._id;
    const again = await correction();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_CORRECTION');
    const results = await Promise.all(Array.from({ length: 4 }, () => hrAgent.patch(`/api/attendance/corrections/${id}/approve`).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await AttendanceRecord.countDocuments({ employee: emp.employee._id })).toBe(1);
  });

  it('refuses the applicant and unrelated employees, and hides requests from them', async () => {
    const id = (await correction()).body.data._id;
    expect((await empAgent.patch(`/api/attendance/corrections/${id}/approve`).send({})).status).toBe(403);
    expect((await otherAgent.patch(`/api/attendance/corrections/${id}/approve`).send({})).status).toBe(404);
    expect((await otherAgent.get('/api/attendance/corrections/pending')).body.data).toEqual([]);
    expect((await managerAgent.get('/api/attendance/corrections/pending')).body.data).toHaveLength(1);
    expect((await otherAgent.patch(`/api/attendance/corrections/${id}/cancel`).send({})).status).toBe(404);
  });

  it('refuses future dates, dates before joining, bad times and extra fields', async () => {
    expect((await correction({ date: WED })).body.error.code).toBe('FUTURE_DATE');
    expect((await correction({ date: '2019-01-07' })).body.error.code).toBe('BEFORE_JOINING');
    expect((await correction({ punchIn: '18:00', punchOut: '09:00' })).body.error.code).toBe('INVALID_TIMES');
    expect((await correction({ status: 'APPROVED' })).status).toBe(400);
    expect((await correction({ employee: String(other.employee._id) })).status).toBe(400);
  });

  it('can be withdrawn by its owner', async () => {
    const id = (await correction()).body.data._id;
    expect((await empAgent.patch(`/api/attendance/corrections/${id}/cancel`).send({})).status).toBe(200);
    expect((await hrAgent.patch(`/api/attendance/corrections/${id}/approve`).send({})).status).toBe(409);
  });
});

describe('monthly attendance export', () => {
  it('gives HR a workbook with totals and a column per day', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    const res = await hrAgent.get('/api/attendance/export').query({ month: '2030-03' }).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.worksheets[0];
    const headers = sheet.getRow(1).values as string[];
    expect(headers).toEqual(expect.arrayContaining(['Employee ID', 'Present', 'Absent', '01', '31']));
    const row = sheet.getRows(2, sheet.rowCount)!.find((r) => r.getCell(2).value === 'Emma Employee')!;
    expect(row.getCell(headers.indexOf('Present')).value).toBe(1);
    expect(row.getCell(headers.indexOf('04')).value).toBe('P');
    expect(row.getCell(headers.indexOf('02')).value).toBe('W');
    expect(row.getCell(headers.indexOf('01')).value).toBe('A');
  });

  it('exports any range of dates, naming days across months', async () => {
    const res = await hrAgent.get('/api/attendance/export').query({ from: '2030-02-27', to: '2030-03-04' }).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const headers = (wb.worksheets[0].getRow(1).values as string[]).filter(Boolean);
    expect(headers.slice(-6)).toEqual(['27/02', '28/02', '01/03', '02/03', '03/03', '04/03']);
  });

  it('needs a month or a range to export', async () => {
    expect((await hrAgent.get('/api/attendance/export')).status).toBe(400);
  });

  it('is only for those with the permission', async () => {
    expect((await empAgent.get('/api/attendance/export').query({ month: '2030-03' })).status).toBe(403);
    expect((await managerAgent.get('/api/attendance/export').query({ month: '2030-03' })).status).toBe(403);
  });
});

describe('team attendance', () => {
  it('shows a manager only their own reports', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    const res = await managerAgent.get('/api/attendance/team').query({ date: MON });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r: { employee: { fullName: string } }) => r.employee.fullName)).toEqual(['Emma Employee']);
    expect(res.body.data.rows[0].status).toBe('PRESENT');
  });

  it('lists only the people behind a card, while the totals still cover everyone', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    const names = async (status: string) => {
      const res = await hrAgent.get('/api/attendance').query({ date: MON, status });
      expect(res.status).toBe(200);
      return { names: res.body.data.rows.map((r: { employee: { fullName: string } }) => r.employee.fullName), summary: res.body.data.summary };
    };
    const present = await names('present');
    expect(present.names).toEqual(['Emma Employee']);
    expect(present.summary.notPunched).toBeGreaterThan(0);
    expect((await names('notPunched')).names).not.toContain('Emma Employee');
    expect((await names('absent')).names).toEqual([]);
    expect((await hrAgent.get('/api/attendance').query({ date: MON, status: 'bogus' })).status).toBe(400);
    expect((await managerAgent.get('/api/attendance/team').query({ date: MON, status: 'present' })).body.data.rows).toHaveLength(1);
  });

  it('opens a report\'s month, but not anyone else\'s', async () => {
    expect((await managerAgent.get(`/api/attendance/team/${emp.employee._id}`).query({ month: '2030-03' })).status).toBe(200);
    expect((await managerAgent.get(`/api/attendance/team/${other.employee._id}`)).status).toBe(404);
    expect((await empAgent.get(`/api/attendance/team/${manager.employee._id}`)).status).toBe(404);
  });

  it('shows nothing to someone with no reports, and marks who is a manager', async () => {
    expect((await otherAgent.get('/api/attendance/team').query({ date: MON })).body.data.rows).toEqual([]);
    expect((await managerAgent.get('/api/auth/me')).body.data.isManager).toBe(true);
    expect((await otherAgent.get('/api/auth/me')).body.data.isManager).toBe(false);
  });

  it('never lets a manager correct attendance', async () => {
    expect((await managerAgent.put(`/api/attendance/employees/${emp.employee._id}/${FRI}`).send({ punchIn: '09:00', note: 'x' })).status).toBe(403);
  });
});

describe('deciding from an email', () => {
  const tokenFor = async (to: string) => {
    Object.assign(env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', APP_URL: 'http://app.test' });
    await CompanySettings.updateOne({ key: 'global' }, { $set: { 'notifications.emailEnabled': true } }, { upsert: true });
    return to;
  };
  const leave = async () => {
    await tokenFor('');
    sendMail.mockReset().mockResolvedValue({});
    const id = String((await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED))).body.data._id);
    await flushEmailOutbox();
    const mail = sendMail.mock.calls.map(([m]) => m).find((m) => m.to === hr.email)!;
    const token = /email-action\?token=([\w-]+)&amp;decision=approve/.exec(mail.html)![1];
    return { id, token, mail };
  };
  const anon = () => supertest(app);
  const post = (path: string, body: object) => anon().post(`/api/email-actions/${path}`).set('X-Requested-With', 'WorkNest').send(body);

  it('puts Approve and Reject links in the approver\'s email only, and stores just a hash', async () => {
    const { token, mail } = await leave();
    expect(mail.html).toContain('decision=reject');
    const toEmployee = sendMail.mock.calls.map(([m]) => m).find((m) => m.to === emp.email)!;
    expect(toEmployee.html).not.toContain('email-action');
    const stored = (await EmailActionToken.findOne().lean())!;
    expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await Notification.find().lean())).not.toContain(token);
  });

  it('previews without changing anything', async () => {
    const { id, token } = await leave();
    const res = await post('preview', { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: 'Leave request', decidable: true });
    expect((await LeaveRequest.findById(id).lean())!.status).toBe('PENDING');
  });

  it('approves once, without a session, recorded against the approver', async () => {
    const { id, token } = await leave();
    expect((await post('decide', { token, decision: 'approve' })).status).toBe(200);
    expect((await LeaveRequest.findById(id).lean())!.status).toBe('APPROVED');
    const audit = (await AuditLog.findOne({ action: 'DECIDED_FROM_EMAIL' }).lean())!;
    expect(String(audit.actor)).toBe(String(hr.userId));

    const again = await post('decide', { token, decision: 'approve' });
    expect(again.status).toBe(410);
    expect((await post('preview', { token })).status).toBe(410);
  });

  it('rejects with a required reason', async () => {
    const { id, token } = await leave();
    expect((await post('decide', { token, decision: 'reject' })).status).toBe(422);
    expect((await LeaveRequest.findById(id).lean())!.status).toBe('PENDING');
    expect((await post('decide', { token, decision: 'reject', reason: 'Busy' })).status).toBe(200);
    expect((await LeaveRequest.findById(id).lean())!.rejectionReason).toBe('Busy');
  });

  it('refuses wrong, expired and deactivated-approver links with the same answer', async () => {
    const { id, token } = await leave();
    const wrong = await post('decide', { token: 'x'.repeat(43), decision: 'approve' });
    expect(wrong.status).toBe(410);

    await User.updateOne({ _id: hr.userId }, { isActive: false });
    const inactive = await post('decide', { token, decision: 'approve' });
    expect(inactive.status).toBe(410);
    expect(inactive.body.error.message).toBe(wrong.body.error.message);
    await User.updateOne({ _id: hr.userId }, { isActive: true });

    await EmailActionToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await post('decide', { token, decision: 'approve' })).status).toBe(410);
    expect((await LeaveRequest.findById(id).lean())!.status).toBe('PENDING');
  });

  it('respects permissions taken away after the email was sent', async () => {
    const { id, token } = await leave();
    await User.updateOne({ _id: hr.userId }, { permissions: ['employees:read'] });
    expect((await post('decide', { token, decision: 'approve' })).status).toBe(403);
    expect((await LeaveRequest.findById(id).lean())!.status).toBe('PENDING');
  });

  it('shows that a request decided in the app can no longer be decided', async () => {
    const { id, token } = await leave();
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect((await post('preview', { token })).body.data.decidable).toBe(false);
    expect((await post('decide', { token, decision: 'reject', reason: 'x' })).status).toBe(409);
  });

  it('needs the CSRF header', async () => {
    const res = await anon().post('/api/email-actions/preview').send({ token: 'x'.repeat(43) });
    expect(res.status).toBe(403);
  });
});

describe('pending request reminders', () => {
  const later = (days: number) => new Date(new Date(MONDAY).getTime() + days * 86_400_000);
  const waitingWfh = async () => empAgent.post('/api/wfh').send({ startDate: WED, endDate: WED, reason: 'Visit' });

  it('stays quiet at first, then reminds approvers once, then escalates once', async () => {
    await waitingWfh();
    await makeSuperAdmin();
    expect(await remindPendingApprovals(later(1))).toBe(0);

    expect(await remindPendingApprovals(later(3))).toBe(2);
    expect(await Notification.exists({ recipient: manager.userId, type: 'APPROVAL_REMINDER' })).toBeTruthy();
    expect(await remindPendingApprovals(later(3))).toBe(0);

    expect(await remindPendingApprovals(later(6))).toBe(1);
    expect(await Notification.countDocuments({ title: /^Overdue/ })).toBe(1);
    expect(await remindPendingApprovals(later(7))).toBe(0);
  });

  it('never reminds someone about their own request, or decided ones', async () => {
    const res = await waitingWfh();
    await WfhRequest.updateOne({ _id: res.body.data._id }, { status: 'APPROVED' });
    expect(await remindPendingApprovals(later(10))).toBe(0);
    await empAgent.post('/api/wfh').send({ startDate: TUE, endDate: TUE, reason: 'Visit' });
    await remindPendingApprovals(later(10));
    expect(await Notification.exists({ recipient: emp.userId, type: 'APPROVAL_REMINDER' })).toBeNull();
  });

  it('covers leave, corrections and expenses', async () => {
    await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED));
    await correction();
    await empAgent.post('/api/expenses').send({ category: 'FOOD', expenseDate: FRI, amount: 100, description: 'Lunch' });
    await remindPendingApprovals(later(3));
    const titles = (await Notification.find({ type: 'APPROVAL_REMINDER' }).lean()).map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(['Reminder: leave request waiting', 'Reminder: attendance correction waiting', 'Reminder: expense claim waiting']));
  });

  it('uses the defaults on a settings record saved before these options existed', async () => {
    await CompanySettings.collection.updateOne({ key: 'global' }, { $unset: { 'notifications.approvalReminderDays': '', 'notifications.punchReminderTime': '' } }, { upsert: true });
    expect((await getSettings()).notifications).toMatchObject({ approvalReminderDays: 2, punchReminderTime: '11:00' });
  });
});

describe('forgot-to-punch reminder', () => {
  const at = (iso: string) => new Date(iso);
  const NOON = at('2030-03-04T06:30:00Z');

  it('waits for the set time, then nudges once a day only those who have not punched in', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    expect(await remindMissingPunches(at('2030-03-04T04:00:00Z'))).toBe(0);
    const sent = await remindMissingPunches(NOON);
    expect(sent).toBeGreaterThan(0);
    expect(await Notification.exists({ recipient: emp.userId, type: 'PUNCH_REMINDER' })).toBeNull();
    expect(await Notification.exists({ recipient: other.userId, type: 'PUNCH_REMINDER' })).toBeTruthy();
    expect(await remindMissingPunches(NOON)).toBe(0);
  });

  it('skips people on leave or approved work from home, and weekends', async () => {
    const wfh = await otherAgent.post('/api/wfh').send({ startDate: MON, endDate: MON, reason: 'Visit' });
    await hrAgent.patch(`/api/wfh/${wfh.body.data._id}/approve`).send({});
    await remindMissingPunches(NOON);
    expect(await Notification.exists({ recipient: other.userId, type: 'PUNCH_REMINDER' })).toBeNull();
    expect(await remindMissingPunches(at('2030-03-02T06:30:00Z'))).toBe(0);
  });

  it('can be turned off', async () => {
    await CompanySettings.updateOne({ key: 'global' }, { $set: { 'notifications.punchReminderEnabled': false } }, { upsert: true });
    expect(await remindMissingPunches(NOON)).toBe(0);
  });
});

describe('team calendar', () => {
  it('shows colleagues away without the leave type or reason', async () => {
    const dept = await makeDepartment('Sales');
    const a = await makePerson({ department: dept, name: 'Asha' });
    const b = await makePerson({ department: dept, name: 'Bala', gender: 'FEMALE' });
    const outsider = await makePerson({ name: 'Zed' });
    const bAgent = await agentFor(b.email);
    const zAgent = await agentFor(outsider.email);
    const applied = await bAgent.post('/api/leaves').send({ ...fullDay(await typeId('MNL'), MON), reason: 'Very private' });
    expect(applied.status).toBe(201);
    await zAgent.post('/api/leaves').send(fullDay(await typeId('MNL'), MON));

    const aAgent = await agentFor(a.email);
    const res = await aAgent.get('/api/calendar/team').query({ start: '2030-03-01', end: '2030-03-31' });
    expect(res.body.data.events.map((e: { employeeName: string }) => e.employeeName)).toEqual(['Bala']);
    const text = JSON.stringify(res.body.data.events);
    expect(text).not.toMatch(/Very private|Menstrual|MNL|leaveType|reason/);
  });

  it('shows the whole company to anyone, filtered by team if asked, still without private details', async () => {
    const sales = await makeDepartment('Sales');
    const ops = await makeDepartment('Ops');
    const a = await makePerson({ department: sales, name: 'Asha' });
    const z = await makePerson({ department: ops, name: 'Zed' });
    const zAgent = await agentFor(z.email);
    const leave = await zAgent.post('/api/leaves').send({ ...fullDay(await typeId('CL'), MON), reason: 'Very private' });
    expect(leave.status).toBe(201);
    expect((await hrAgent.patch(`/api/approvals/${leave.body.data._id}/approve`).send({})).status).toBe(200);
    const aAgent = await agentFor(a.email);
    const range = { start: '2030-03-01', end: '2030-03-31' };

    expect((await aAgent.get('/api/calendar/team').query(range)).body.data.events).toEqual([]);
    const company = await aAgent.get('/api/calendar/team').query({ ...range, scope: 'company' });
    expect(company.status).toBe(200);
    expect(company.body.data.events.map((e: { employeeName: string; team: string }) => [e.employeeName, e.team])).toEqual([['Zed', 'Ops']]);
    expect(JSON.stringify(company.body.data.events)).not.toMatch(/Very private|leaveType|reason|CL/);
    expect((await aAgent.get('/api/calendar/team').query({ ...range, scope: 'company', department: String(sales) })).body.data.events).toEqual([]);
    expect((await aAgent.get('/api/calendar/team').query({ ...range, scope: 'everything' })).status).toBe(400);
  });

  it('leaves out pending leave and needs dates', async () => {
    const res = await managerAgent.get('/api/calendar/team').query({ start: '2030-03-01', end: '2030-03-31' });
    expect(res.body.data.events).toEqual([]);
    await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED));
    expect((await managerAgent.get('/api/calendar/team').query({ start: '2030-03-01', end: '2030-03-31' })).body.data.events).toEqual([]);
    expect((await managerAgent.get('/api/calendar/team')).status).toBe(400);
  });
});

describe('HR dashboard', () => {
  it('reports today, leave trends and frequent absences', async () => {
    await empAgent.post('/api/attendance/punch-in').send({});
    const id = (await otherAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED))).body.data._id;
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    await Employee.updateOne({ _id: other.employee._id }, { joiningDate: '2020-01-01' });

    const res = await hrAgent.get('/api/insights/hr');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.summary.present).toBe(1);
    expect(d.leaveTrend).toHaveLength(12);
    expect(d.leaveTrend.at(-1)).toEqual({ month: '2030-03', days: 1 });
    expect(d.leaveByType).toEqual([{ name: 'Casual Leave', days: 1 }]);
    expect(d.frequentAbsent.find((p: { name: string }) => p.name === 'Otto Other').days).toBeGreaterThan(0);
  });

  it('is not for employees or managers', async () => {
    expect((await empAgent.get('/api/insights/hr')).status).toBe(403);
    expect((await managerAgent.get('/api/insights/hr')).status).toBe(403);
  });
});

describe('colleagues\' profile photos', () => {
  const photo = (agent: Agent) => agent.put('/api/me/avatar').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });

  it('shows in lists and to colleagues, and goes when removed', async () => {
    await photo(empAgent);
    const row = (await hrAgent.get('/api/employees')).body.data.find((e: { _id: string }) => e._id === String(emp.employee._id));
    expect(row.avatarFile).toBeTruthy();
    expect((await otherAgent.get(`/api/employees/${emp.employee._id}/avatar`)).status).toBe(200);
    await empAgent.delete('/api/me/avatar');
    expect((await otherAgent.get(`/api/employees/${emp.employee._id}/avatar`)).status).toBe(404);
  });

  it('appears on approval lists', async () => {
    await photo(empAgent);
    await empAgent.post('/api/wfh').send({ startDate: WED, endDate: WED, reason: 'Visit' });
    expect((await hrAgent.get('/api/wfh/pending')).body.data[0].employee.avatarFile).toBeTruthy();
  });

  it('needs a session', async () => {
    expect((await supertest(app).get(`/api/employees/${emp.employee._id}/avatar`)).status).toBe(401);
  });
});

describe('employee self-service', () => {
  const details = { bank: { holderName: 'Emma', bankName: 'HDFC', ifsc: 'hdfc0001234', accountNumber: '123456789012' }, emergencyContacts: [{ name: 'Sam', relationship: 'Brother', phone: '+91 98765 43210' }], address: '1 Main St' };

  it('encrypts the account number and only ever returns the last four digits', async () => {
    const res = await empAgent.put('/api/me/details').send(details);
    expect(res.status).toBe(200);
    expect(res.body.data.bank).toEqual({ holderName: 'Emma', bankName: 'HDFC', ifsc: 'HDFC0001234', accountLast4: '9012' });
    const stored = (await EmployeeDetails.findOne({ employee: emp.employee._id }).lean())!;
    expect(JSON.stringify(stored)).not.toContain('123456789012');
    expect(JSON.stringify((await empAgent.get('/api/me/details')).body)).not.toContain('123456789012');
    expect(JSON.stringify(await AuditLog.find({ action: 'EMPLOYEE_DETAILS_UPDATED' }).lean())).not.toContain('123456789012');
  });

  it('keeps the account number when it is left out, and needs one the first time', async () => {
    const { accountNumber: _a, ...rest } = details.bank;
    expect((await empAgent.put('/api/me/details').send({ bank: rest })).body.error.code).toBe('ACCOUNT_REQUIRED');
    await empAgent.put('/api/me/details').send(details);
    await empAgent.put('/api/me/details').send({ bank: { ...rest, bankName: 'SBI' } });
    const res = await hrAgent.post(`/api/employees/${emp.employee._id}/details/reveal-bank`).send({});
    expect(res.body.data.accountNumber).toBe('123456789012');
  });

  it('lets only permitted HR read them, and logs each view', async () => {
    await empAgent.put('/api/me/details').send(details);
    expect((await otherAgent.get(`/api/employees/${emp.employee._id}/details`)).status).toBe(403);
    expect((await managerAgent.get(`/api/employees/${emp.employee._id}/details`)).status).toBe(403);
    expect((await managerAgent.post(`/api/employees/${emp.employee._id}/details/reveal-bank`).send({})).status).toBe(403);
    const res = await hrAgent.get(`/api/employees/${emp.employee._id}/details`);
    expect(res.status).toBe(200);
    expect(res.body.data.bank.accountNumber).toBeUndefined();
    await hrAgent.post(`/api/employees/${emp.employee._id}/details/reveal-bank`).send({});
    expect(await AuditLog.exists({ action: 'EMPLOYEE_DETAILS_VIEWED' })).toBeTruthy();
    expect(await AuditLog.exists({ action: 'BANK_ACCOUNT_VIEWED' })).toBeTruthy();
  });

  it('refuses a bank save with no encryption key, rather than storing it in plain text', async () => {
    const key = env.FIELD_ENCRYPTION_KEY;
    env.FIELD_ENCRYPTION_KEY = '';
    const res = await empAgent.put('/api/me/details').send(details);
    env.FIELD_ENCRYPTION_KEY = key;
    expect(res.status).toBe(503);
    expect(await EmployeeDetails.countDocuments()).toBe(0);
  });

  it('validates input and rejects extra fields', async () => {
    expect((await empAgent.put('/api/me/details').send({ bank: { ...details.bank, ifsc: 'BAD' } })).status).toBe(400);
    expect((await empAgent.put('/api/me/details').send({ bank: { ...details.bank, accountNumber: '12ab' } })).status).toBe(400);
    expect((await empAgent.put('/api/me/details').send({ employee: String(other.employee._id) })).status).toBe(400);
  });

  it('keeps personal documents between the employee and permitted HR', async () => {
    const res = await empAgent.post('/api/me/documents').attach('file', PDF, { filename: 'id.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    expect((await empAgent.get('/api/me/documents')).body.data).toHaveLength(1);
    expect((await empAgent.get(`/api/files/${id}`).buffer(true)).status).toBe(200);
    expect((await hrAgent.get(`/api/files/${id}`).buffer(true)).status).toBe(200);
    expect((await otherAgent.get(`/api/files/${id}`)).status).toBe(404);
    expect((await managerAgent.get(`/api/files/${id}`)).status).toBe(404);
    expect((await hrAgent.get(`/api/employees/${emp.employee._id}/details`)).body.data.documents).toHaveLength(1);

    const leave = await empAgent.post('/api/leaves').send({ ...fullDay(await typeId('CL'), WED), document: id });
    expect(leave.status).toBe(422);
    expect((await otherAgent.delete(`/api/me/documents/${id}`)).status).toBe(404);
    expect((await empAgent.delete(`/api/me/documents/${id}`)).status).toBe(200);
  });
});

describe('onboarding and exit checklists', () => {
  const start = (kind = 'ONBOARDING') => hrAgent.post(`/api/employees/${emp.employee._id}/checklists`).send({ kind });
  const item = (doc: { items: { _id: string; owner: string }[] }, owner: string) => doc.items.find((i) => i.owner === owner)!._id;

  it('starts from a standard list and tells the employee', async () => {
    const res = await start();
    expect(res.status).toBe(201);
    expect(res.body.data.items.map((i: { label: string }) => i.label)).toContain('Issue laptop and equipment');
    expect(await Notification.exists({ recipient: emp.userId, type: 'CHECKLIST_UPDATED' })).toBeTruthy();
    expect((await start()).status).toBe(409);
    expect((await start('EXIT')).body.data.items.map((i: { label: string }) => i.label)).toContain('Final settlement');
  });

  it('lets employees tick only their own items, and HR any', async () => {
    const doc = (await start()).body.data;
    const mine = await empAgent.patch(`/api/me/checklists/${doc._id}/items/${item(doc, 'EMPLOYEE')}`).send({ done: true });
    expect(mine.status).toBe(200);
    expect(mine.body.data.items.find((i: { done: boolean }) => i.done).doneByName).toBe('Emma Employee');
    const hrs = await empAgent.patch(`/api/me/checklists/${doc._id}/items/${item(doc, 'HR')}`).send({ done: true });
    expect(hrs.status).toBe(403);
    expect((await hrAgent.patch(`/api/employees/${emp.employee._id}/checklists/${doc._id}/items/${item(doc, 'HR')}`).send({ done: true })).status).toBe(200);
  });

  it('does not let another employee reach it', async () => {
    const doc = (await start()).body.data;
    expect((await otherAgent.patch(`/api/me/checklists/${doc._id}/items/${item(doc, 'EMPLOYEE')}`).send({ done: true })).status).toBe(404);
    expect((await otherAgent.get(`/api/employees/${emp.employee._id}/checklists`)).status).toBe(403);
    expect((await otherAgent.post(`/api/employees/${emp.employee._id}/checklists`).send({ kind: 'EXIT' })).status).toBe(403);
    expect((await otherAgent.get('/api/me/checklists')).body.data).toEqual([]);
  });

  it('lets HR add an item', async () => {
    const doc = (await start()).body.data;
    const res = await hrAgent.post(`/api/employees/${emp.employee._id}/checklists/${doc._id}/items`).send({ label: 'Order business cards', owner: 'HR' });
    expect(res.body.data.items.at(-1).label).toBe('Order business cards');
  });
});

describe('payroll preparation', () => {
  it('does not take pay for days before attendance began', async () => {
    await Employee.updateOne({ _id: emp.employee._id }, { joiningDate: '2030-03-01' });
    await CompanySettings.updateOne({ key: 'global' }, { $set: { attendanceStartDate: MON } }, { upsert: true });
    const r = (await hrAgent.get('/api/payroll').query({ month: '2030-03' })).body.data.rows.find((x: { employeeName: string }) => x.employeeName === 'Emma Employee');
    expect(r).toMatchObject({ employedDays: 31, absent: 0, payableDays: 31 });
    expect((await hrAgent.get('/api/insights/hr')).body.data.frequentAbsent).toEqual([]);
  });

  const row = async (month = '2030-03') => (await hrAgent.get('/api/payroll').query({ month })).body.data.rows.find((r: { employeeName: string }) => r.employeeName === 'Emma Employee');

  it('takes absences and unpaid leave off the days employed', async () => {
    await Employee.updateOne({ _id: emp.employee._id }, { joiningDate: '2030-03-01' });
    const before = await row();
    expect(before.employedDays).toBe(31);
    expect(before.absent).toBe(1); // Friday 1 March; today is the 4th
    expect(before.payableDays).toBe(30);

    const paid = await empAgent.post('/api/leaves').send(fullDay(await typeId('CL'), WED));
    await hrAgent.patch(`/api/approvals/${paid.body.data._id}/approve`).send({});
    const unpaid = await empAgent.post('/api/leaves').send(fullDay(await typeId('LWP'), TUE));
    expect(unpaid.status).toBe(201);
    await hrAgent.patch(`/api/approvals/${unpaid.body.data._id}/approve`).send({});

    const after = await row();
    expect(after.paidLeave).toBe(1);
    expect(after.unpaidLeave).toBe(1);
    expect(after.lossOfPayDays).toBe(2);
    expect(after.payableDays).toBe(29);
  });

  it('counts only days since joining, and warns while the month is unfinished', async () => {
    await Employee.updateOne({ _id: emp.employee._id }, { joiningDate: '2030-03-11' });
    expect((await row()).employedDays).toBe(21);
    expect((await hrAgent.get('/api/payroll').query({ month: '2030-03' })).body.data.complete).toBe(false);
    expect((await hrAgent.get('/api/payroll').query({ month: '2030-02' })).body.data.complete).toBe(true);
  });

  it('exports, with an audit entry, and is limited to those with the permission', async () => {
    const res = await hrAgent.get('/api/payroll/export').query({ month: '2030-03', format: 'csv' }).buffer(true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Payable Days');
    expect(await AuditLog.exists({ action: 'PAYROLL_EXPORTED' })).toBeTruthy();
    expect((await managerAgent.get('/api/payroll')).status).toBe(403);
    expect((await empAgent.get('/api/payroll/export').query({ month: '2030-03' })).status).toBe(403);
  });
});

describe('expense claims', () => {
  const claim = (over: object = {}, agent = empAgent) => agent.post('/api/expenses').send({ category: 'TRAVEL', expenseDate: FRI, amount: 1250.5, description: 'Taxi to client', ...over });

  it('runs from claim to approval to payment, telling the employee', async () => {
    const res = await claim();
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    expect((await hrAgent.patch(`/api/expenses/${res.body.data._id}/pay`).send({})).status).toBe(409);
    expect((await managerAgent.patch(`/api/expenses/${res.body.data._id}/approve`).send({})).status).toBe(200);
    expect((await hrAgent.patch(`/api/expenses/${res.body.data._id}/pay`).send({})).status).toBe(200);
    expect(await Notification.exists({ recipient: emp.userId, type: 'EXPENSE_APPROVED' })).toBeTruthy();
    expect(await Notification.exists({ recipient: emp.userId, type: 'EXPENSE_PAID' })).toBeTruthy();
    expect((await ExpenseClaim.findById(res.body.data._id).lean())!.status).toBe('PAID');
  });

  it('keeps people from deciding or paying their own claim, or others\'', async () => {
    const id = (await claim()).body.data._id;
    expect((await empAgent.patch(`/api/expenses/${id}/approve`).send({})).status).toBe(403);
    expect((await otherAgent.patch(`/api/expenses/${id}/approve`).send({})).status).toBe(404);
    expect((await managerAgent.patch(`/api/expenses/${id}/pay`).send({})).status).toBe(403);
    const own = (await claim({}, hrAgent)).body.data._id;
    expect((await hrAgent.patch(`/api/expenses/${own}/approve`).send({})).status).toBe(403);
  });

  it('needs a reason to reject, and can be withdrawn only while pending', async () => {
    const id = (await claim()).body.data._id;
    expect((await hrAgent.patch(`/api/expenses/${id}/reject`).send({})).status).toBe(400);
    const second = (await claim()).body.data._id;
    expect((await empAgent.patch(`/api/expenses/${second}/cancel`).send({})).status).toBe(200);
    expect((await hrAgent.patch(`/api/expenses/${id}/approve`).send({})).status).toBe(200);
    expect((await empAgent.patch(`/api/expenses/${id}/cancel`).send({})).status).toBe(404);
  });

  it('validates amounts, dates and extra fields', async () => {
    expect((await claim({ amount: -5 })).status).toBe(400);
    expect((await claim({ amount: 10.123 })).status).toBe(400);
    expect((await claim({ expenseDate: WED })).body.error.code).toBe('FUTURE_DATE');
    expect((await claim({ status: 'PAID' })).status).toBe(400);
  });

  it('protects receipts: the owner, their manager and expense staff, nobody else', async () => {
    const upload = await empAgent.post('/api/files').attach('file', PDF, { filename: 'r.pdf', contentType: 'application/pdf' });
    const id = upload.body.data.id;
    expect((await claim({ receipt: id })).status).toBe(201);
    expect((await managerAgent.get(`/api/files/${id}`).buffer(true)).status).toBe(200);
    expect((await hrAgent.get(`/api/files/${id}`).buffer(true)).status).toBe(200);
    expect((await otherAgent.get(`/api/files/${id}`)).status).toBe(404);
    expect((await empAgent.delete(`/api/files/${id}`)).status).toBe(409);
    const foreign = await otherAgent.post('/api/files').attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect((await claim({ receipt: foreign.body.data.id })).body.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('shows each person only what they may see', async () => {
    await claim();
    expect((await otherAgent.get('/api/expenses/my')).body.data).toEqual([]);
    expect((await otherAgent.get('/api/expenses/pending')).body.data).toEqual([]);
    expect((await managerAgent.get('/api/expenses/pending')).body.data).toHaveLength(1);
    expect((await otherAgent.get('/api/expenses')).status).toBe(403);
    expect((await hrAgent.get('/api/expenses')).body.data).toHaveLength(1);
  });
});

describe('announcements and policies', () => {
  const publish = (over: object = {}) => hrAgent.post('/api/announcements').send({ kind: 'POLICY', title: 'Leave policy 2030', body: 'Please read.', requiresAck: true, ...over });

  it('publishes to everyone and notifies them', async () => {
    expect((await publish()).status).toBe(201);
    expect((await empAgent.get('/api/announcements')).body.data[0]).toMatchObject({ title: 'Leave policy 2030', acknowledged: false });
    expect(await Notification.exists({ recipient: emp.userId, type: 'ANNOUNCEMENT' })).toBeTruthy();
    expect(await Notification.exists({ recipient: hr.userId, type: 'ANNOUNCEMENT' })).toBeNull();
  });

  it('tracks who has confirmed, and confirming twice is harmless', async () => {
    const id = (await publish()).body.data._id;
    expect((await empAgent.post(`/api/announcements/${id}/acknowledge`).send({})).status).toBe(200);
    expect((await empAgent.post(`/api/announcements/${id}/acknowledge`).send({})).status).toBe(200);
    expect((await empAgent.get('/api/announcements')).body.data[0].acknowledged).toBe(true);
    const readers = (await hrAgent.get(`/api/announcements/${id}/readers`)).body.data;
    expect(readers.confirmed.map((r: { name: string }) => r.name)).toEqual(['Emma Employee']);
    expect(readers.waiting.map((r: { name: string }) => r.name)).toContain('Otto Other');
  });

  it('lets everyone open a published document', async () => {
    const id = (await hrAgent.post('/api/files').attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' })).body.data.id;
    expect((await otherAgent.get(`/api/files/${id}`)).status).toBe(404);
    expect((await publish({ document: id })).status).toBe(201);
    expect((await otherAgent.get(`/api/files/${id}`).buffer(true)).status).toBe(200);
  });

  it('is managed only by those with the permission', async () => {
    const id = (await publish()).body.data._id;
    expect((await empAgent.post('/api/announcements').send({ kind: 'POLICY', title: 'x', body: 'y', requiresAck: false })).status).toBe(403);
    expect((await empAgent.get(`/api/announcements/${id}/readers`)).status).toBe(403);
    expect((await empAgent.delete(`/api/announcements/${id}`)).status).toBe(403);
    expect((await hrAgent.delete(`/api/announcements/${id}`)).status).toBe(200);
    expect(await Announcement.countDocuments()).toBe(0);
  });
});

