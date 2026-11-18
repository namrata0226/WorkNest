import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { Notification } from '../src/models';
import { CompanySettings } from '../src/models/System';
import { flushEmailOutbox } from '../src/services/email';
import { Agent, agentFor, baseline, FRI, fullDay, makePerson, makeSuperAdmin, Person, typeId, useDatabase } from './helpers';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

useDatabase('email');

let cl: string;
let emp: Person;
let hr: Person;
let empAgent: Agent;
let hrAgent: Agent;

interface Sent { to: string; subject: string; text: string; html: string }
const sent = (): Sent[] => sendMail.mock.calls.map(([mail]) => mail);
const mailsTo = (to: string) => sent().filter((m) => m.to === to);

beforeEach(async () => {
  await baseline();
  await CompanySettings.updateOne({ key: 'global' }, { $set: { 'notifications.emailEnabled': true } }, { upsert: true });
  Object.assign(env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'user', SMTP_PASS: 'secret', EMAIL_REDIRECT_TO: '', APP_URL: 'http://app.test' });
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
  cl = await typeId('CL');
  hr = await makePerson({ role: 'HR_ADMIN' });
  emp = await makePerson();
  hrAgent = await agentFor(hr.email);
  empAgent = await agentFor(emp.email);
});

afterEach(() => {
  Object.assign(env, { SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, EMAIL_REDIRECT_TO: undefined });
});

const applyLeave = async () => {
  const res = await empAgent.post('/api/leaves').send(fullDay(cl, FRI));
  expect(res.status).toBe(201);
  return String(res.body.data._id);
};

describe('leave emails', () => {
  it('sends HR a button that opens the request, and tells the employee it was submitted', async () => {
    const id = await applyLeave();
    await flushEmailOutbox();

    const [toHr] = mailsTo(hr.email);
    expect(toHr.subject).toBe('New leave request');
    expect(toHr.html).toContain(`href="http://app.test/approvals?request=${id}"`);
    expect(toHr.html).toContain('Review request');
    expect(toHr.text).toContain(`http://app.test/approvals?request=${id}`);
    expect(mailsTo(emp.email)[0].subject).toBe('Leave request submitted');
  });

  it('tells the employee when leave is approved, with a link to it', async () => {
    const id = await applyLeave();
    await flushEmailOutbox();
    sendMail.mockClear();
    expect((await hrAgent.patch(`/api/approvals/${id}/approve`).send({})).status).toBe(200);
    await flushEmailOutbox();

    const [mail] = mailsTo(emp.email);
    expect(mail.subject).toBe('Leave approved');
    expect(mail.html).toContain(`href="http://app.test/leaves/${id}"`);
    expect(mail.html).toContain('View in WorkNest');
  });

  it('tells the employee when leave is rejected and why, with the reason made safe', async () => {
    const id = await applyLeave();
    await flushEmailOutbox();
    sendMail.mockClear();
    expect((await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'Busy <script>alert(1)</script>' })).status).toBe(200);
    await flushEmailOutbox();

    const [mail] = mailsTo(emp.email);
    expect(mail.subject).toBe('Leave rejected');
    expect(mail.html).toContain('Busy &lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain('Busy <script>');
  });

  it('sends each email once', async () => {
    await applyLeave();
    await flushEmailOutbox();
    const count = sent().length;
    expect(count).toBeGreaterThan(0);
    await flushEmailOutbox();
    expect(sent()).toHaveLength(count);
  });

  it('sends each email once when several senders run at the same time', async () => {
    await applyLeave();
    await Promise.all([flushEmailOutbox(), flushEmailOutbox(), flushEmailOutbox()]);
    const subjects = sent().map((m) => `${m.to}|${m.subject}`);
    expect(subjects.length).toBeGreaterThan(0);
    expect(new Set(subjects).size).toBe(subjects.length);
    expect(await Notification.countDocuments({ emailStatus: 'PENDING' })).toBe(0);
  });

  it('goes to a Super Admin when the only HR person applies, since they cannot decide it', async () => {
    const admin = await makeSuperAdmin();
    expect((await hrAgent.post('/api/leaves').send(fullDay(cl, FRI))).status).toBe(201);
    expect(await Notification.exists({ recipient: admin.userId, type: 'APPROVAL_REQUIRED' })).toBeTruthy();
    expect(await Notification.exists({ recipient: hr.userId, type: 'APPROVAL_REQUIRED' })).toBeNull();
  });
});

describe('test mode', () => {
  it('delivers everything to one inbox and says who each email was meant for', async () => {
    env.EMAIL_REDIRECT_TO = 'tester@test.local';
    await applyLeave();
    await flushEmailOutbox();

    expect(sent().length).toBeGreaterThan(1);
    expect(sent().every((m) => m.to === 'tester@test.local')).toBe(true);
    const toHr = sent().find((m) => m.subject === 'New leave request')!;
    expect(toHr.html).toContain(`Test mode: this email was meant for ${hr.email}`);
    expect(toHr.text).toContain(`Test mode: this email was meant for ${hr.email}`);
  });

  it('cannot be left on in production', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_REDIRECT_TO', 'tester@test.local');
    await expect(import('../src/config/env.js')).rejects.toThrow(/testing only/);
    vi.unstubAllEnvs();
  });
});

describe('delivery problems', () => {
  it('keeps emails queued, without using up retries, until the SMTP password is set', async () => {
    env.SMTP_PASS = '';
    await applyLeave();
    expect(await flushEmailOutbox()).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    const queued = await Notification.find({ emailStatus: 'PENDING' }).lean();
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((n) => n.emailAttempts === 0)).toBe(true);

    env.SMTP_PASS = 'secret';
    expect(await flushEmailOutbox()).toBe(queued.length);
  });

  it('retries a failed send, then stops, and the leave request itself is unaffected', async () => {
    sendMail.mockRejectedValue(new Error('SMTP down'));
    const id = await applyLeave();
    for (let i = 0; i < 5; i++) await flushEmailOutbox();
    expect(await Notification.countDocuments({ emailStatus: 'FAILED' })).toBeGreaterThan(0);
    expect(await Notification.countDocuments({ emailStatus: 'PENDING' })).toBe(0);
    expect((await empAgent.get(`/api/leaves/${id}`)).body.data.status).toBe('PENDING');
  });

  it('sends nothing when email is switched off in settings', async () => {
    await CompanySettings.updateOne({ key: 'global' }, { $set: { 'notifications.emailEnabled': false } });
    await applyLeave();
    await flushEmailOutbox();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
