import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { LeaveRequest } from '../src/models';
import { clearOutlookToken, syncOutlookCalendars } from '../src/services/outlookCalendar';
import { Agent, agentFor, baseline, FRI, fullDay, makePerson, MON, Person, typeId, useDatabase } from './helpers';

useDatabase('outlook_calendar');

interface Call { method: string; url: string; auth: string | null; body: any; prefer: string | null }
let calls: Call[];
let responses: { create: number; remove: number; token: number };
let cl: string;
let emp: Person;
let empAgent: Agent;
let hrAgent: Agent;

const reply = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const graphCalls = (method: string) => calls.filter((c) => c.method === method && c.url.includes('graph.microsoft.com'));
const tokenCalls = () => calls.filter((c) => c.url.includes('login.microsoftonline.com'));

beforeEach(async () => {
  await baseline();
  Object.assign(env, { MS_TENANT_ID: 'tenant', MS_CLIENT_ID: 'client', MS_CLIENT_SECRET: 'secret' });
  clearOutlookToken();
  calls = [];
  responses = { create: 201, remove: 204, token: 200 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: init.method!, url, auth: headers.Authorization ?? null, prefer: headers.Prefer ?? null, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (url.includes('login.microsoftonline.com')) return reply(responses.token, { access_token: 'graph-token', expires_in: 3600 });
    if (init.method === 'POST') return reply(responses.create, { id: `event-${calls.length}` });
    return reply(responses.remove);
  }));
  cl = await typeId('CL');
  emp = await makePerson({ gender: 'FEMALE' });
  empAgent = await agentFor(emp.email);
  hrAgent = await agentFor((await makePerson({ role: 'HR_ADMIN' })).email);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(env, { MS_TENANT_ID: undefined, MS_CLIENT_ID: undefined, MS_CLIENT_SECRET: undefined });
});

const applied = async (body: object = fullDay(cl, FRI)) => {
  const res = await empAgent.post('/api/leaves').send(body);
  expect(res.status).toBe(201);
  return String(res.body.data._id);
};
const approved = async (body?: object) => {
  const id = await applied(body);
  expect((await hrAgent.patch(`/api/approvals/${id}/approve`).send({})).status).toBe(200);
  return id;
};
const stored = async (id: string) => (await LeaveRequest.findById(id).lean())!;

describe('adding Out of office to the calendar', () => {
  it('creates an all-day Out of office event in the employee\'s calendar when leave is approved', async () => {
    const id = await approved(fullDay(cl, FRI, MON));
    expect(await syncOutlookCalendars()).toBe(1);

    const [call] = graphCalls('POST');
    expect(call.url).toBe(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(emp.email)}/events`);
    expect(call.auth).toBe('Bearer graph-token');
    expect(call.body).toEqual({
      subject: 'Out of office',
      showAs: 'oof',
      isReminderOn: false,
      transactionId: id,
      isAllDay: true,
      start: { dateTime: `${FRI}T00:00:00`, timeZone: 'Asia/Kolkata' },
      end: { dateTime: '2030-03-05T00:00:00', timeZone: 'Asia/Kolkata' },
    });
    expect((await stored(id)).outlookEventId).toMatch(/^event-/);
  });

  it('does not create a second event on the next run', async () => {
    await approved();
    await syncOutlookCalendars();
    await syncOutlookCalendars();
    expect(graphCalls('POST')).toHaveLength(1);
  });

  it('never reveals the leave type or reason', async () => {
    const menstrual = await typeId('MNL');
    await applied({ ...fullDay(menstrual, FRI), reason: 'A private reason' });
    await syncOutlookCalendars();
    const sent = JSON.stringify(graphCalls('POST')[0].body);
    expect(sent).not.toMatch(/menstrual|MNL|private reason/i);
  });

  it('covers leave approved automatically', async () => {
    const id = await applied(fullDay(await typeId('MNL'), FRI));
    await syncOutlookCalendars();
    expect((await stored(id)).outlookEventId).toBeTruthy();
  });

  it('marks only the half taken on a half day', async () => {
    await approved({ leaveType: cl, startDate: FRI, endDate: FRI, dayType: 'HALF', halfSession: 'SECOND', reason: 'x' });
    await syncOutlookCalendars();
    expect(graphCalls('POST')[0].body).toMatchObject({
      isAllDay: false,
      start: { dateTime: `${FRI}T13:00:00` },
      end: { dateTime: `${FRI}T18:00:00` },
    });
  });

  it('ignores pending, rejected and finished leave', async () => {
    await applied(fullDay(cl, FRI));
    const rejected = await applied(fullDay(cl, MON));
    await hrAgent.patch(`/api/approvals/${rejected}/reject`).send({ reason: 'No' });
    const past = await approved(fullDay(cl, '2030-03-11'));
    await LeaveRequest.updateOne({ _id: past }, { startDate: '2020-01-06', endDate: '2020-01-06' });
    expect(await syncOutlookCalendars()).toBe(0);
    expect(graphCalls('POST')).toHaveLength(0);
  });

  it('adds approved leave that is still in progress', async () => {
    const id = await approved();
    await LeaveRequest.updateOne({ _id: id }, { startDate: '2020-01-06' });
    await syncOutlookCalendars();
    expect((await stored(id)).outlookEventId).toBeTruthy();
  });
});

describe('removing it again', () => {
  const synced = async () => {
    const id = await approved();
    await syncOutlookCalendars();
    return { id, eventId: (await stored(id)).outlookEventId! };
  };

  it('deletes the event when approved leave is cancelled', async () => {
    const { id, eventId } = await synced();
    expect((await hrAgent.patch(`/api/leaves/${id}/cancel`).send({ reason: 'Plans changed' })).status).toBe(200);
    await syncOutlookCalendars();
    expect(graphCalls('DELETE')[0].url).toBe(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(emp.email)}/events/${eventId}`);
    expect((await stored(id)).outlookEventId).toBeNull();
  });

  it('keeps it while a cancellation is only being requested', async () => {
    const { id } = await synced();
    expect((await empAgent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'Plans changed' })).status).toBe(200);
    await syncOutlookCalendars();
    expect(graphCalls('DELETE')).toHaveLength(0);
    expect((await stored(id)).outlookEventId).toBeTruthy();
  });

  it('accepts that the employee already deleted it', async () => {
    const { id } = await synced();
    await hrAgent.patch(`/api/leaves/${id}/cancel`).send({ reason: 'Plans changed' });
    responses.remove = 404;
    await syncOutlookCalendars();
    const after = await stored(id);
    expect(after.outlookEventId).toBeNull();
    expect(after.outlookSyncError).toBeNull();
  });

  it('retries the delete when Microsoft is down', async () => {
    const { id } = await synced();
    await hrAgent.patch(`/api/leaves/${id}/cancel`).send({ reason: 'Plans changed' });
    responses.remove = 503;
    await syncOutlookCalendars();
    expect((await stored(id)).outlookEventId).toBeTruthy();
    responses.remove = 204;
    await syncOutlookCalendars();
    expect((await stored(id)).outlookEventId).toBeNull();
  });
});

describe('when things go wrong', () => {
  it('records a missing mailbox once, and leaves the approval alone', async () => {
    responses.create = 404;
    const id = await approved();
    expect(await syncOutlookCalendars()).toBe(0);
    await syncOutlookCalendars();
    expect(graphCalls('POST')).toHaveLength(1);
    const after = await stored(id);
    expect(after.outlookSyncError).toBe('MAILBOX_NOT_FOUND');
    expect(after.status).toBe('APPROVED');
  });

  it.each([429, 403, 503])('tries again after a %i', async (status) => {
    responses.create = status;
    const id = await approved();
    await syncOutlookCalendars();
    expect((await stored(id)).outlookSyncError).toBeNull();
    responses.create = 201;
    await syncOutlookCalendars();
    expect((await stored(id)).outlookEventId).toBeTruthy();
  });

  it('marks nothing as failed when the Microsoft sign-in itself fails', async () => {
    responses.token = 401;
    const id = await approved();
    expect(await syncOutlookCalendars()).toBe(0);
    expect(graphCalls('POST')).toHaveLength(0);
    expect((await stored(id)).outlookSyncError).toBeNull();
  });

  it('reuses its sign-in between runs', async () => {
    await approved();
    await syncOutlookCalendars();
    await syncOutlookCalendars();
    expect(tokenCalls()).toHaveLength(1);
  });

  it('does nothing at all until it is configured', async () => {
    env.MS_CLIENT_SECRET = undefined;
    await approved();
    expect(await syncOutlookCalendars()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does not let employees set the calendar fields themselves', async () => {
    const res = await empAgent.post('/api/leaves').send({ ...fullDay(cl, FRI), outlookEventId: 'forged' });
    expect(res.status).toBe(400);
  });
});
