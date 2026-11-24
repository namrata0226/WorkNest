import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, CalendarItem } from '../src/models';
import { Agent, agentFor, baseline, makePerson, MON, Person, TUE, useDatabase, WED } from './helpers';

useDatabase('calendar-items');

let hr: Person;
let emp: Person;
let other: Person;
let hrAgent: Agent;
let empAgent: Agent;
let otherAgent: Agent;

beforeEach(async () => {
  await baseline();
  hr = await makePerson({ role: 'HR_ADMIN' });
  emp = await makePerson({ name: 'Emma Employee' });
  other = await makePerson({ name: 'Otto Other' });
  [hrAgent, empAgent, otherAgent] = await Promise.all([agentFor(hr.email), agentFor(emp.email), agentFor(other.email)]);
});

const event = (over: object = {}) => ({ kind: 'EVENT', title: 'Design sync', date: MON, startTime: '13:30', endTime: '14:30', ...over });
const ids = async (agent: Agent, start = MON, end = WED) => (await agent.get('/api/calendar/items').query({ start, end })).body.data.map((i: { _id: string }) => i._id);

describe('personal events and tasks', () => {
  it('adds an event that only its owner sees', async () => {
    const res = await empAgent.post('/api/calendar/items').send(event({ description: 'Review the new dashboard', reminderMinutes: 10 }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Design sync', allDay: false, startTime: '13:30', endTime: '14:30', visibility: 'PRIVATE', ownerName: 'Emma Employee', reminderMinutes: 10 });
    expect(await ids(empAgent)).toEqual([res.body.data._id]);
    expect(await ids(otherAgent)).toEqual([]);
  });

  it('adds a task, which is all day unless it has a due time', async () => {
    const res = await empAgent.post('/api/calendar/items').send({ kind: 'TASK', title: 'Submit receipts', date: TUE });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'TASK', allDay: true, startTime: null, done: false });
    const timed = await empAgent.post('/api/calendar/items').send({ kind: 'TASK', title: 'Call bank', date: TUE, startTime: '10:00', endTime: '11:00' });
    expect(timed.body.data).toMatchObject({ allDay: false, startTime: '10:00', endTime: null });
  });

  it('ticks a task off and back on', async () => {
    const id = (await empAgent.post('/api/calendar/items').send({ kind: 'TASK', title: 'Submit receipts', date: TUE })).body.data._id;
    const done = await empAgent.patch(`/api/calendar/items/${id}/done`).send({ done: true });
    expect(done.body.data.done).toBe(true);
    expect(done.body.data.doneAt).toBeTruthy();
    expect((await empAgent.patch(`/api/calendar/items/${id}/done`).send({ done: false })).body.data).toMatchObject({ done: false, doneAt: null });
  });

  it('refuses to tick off an event', async () => {
    const id = (await empAgent.post('/api/calendar/items').send(event())).body.data._id;
    expect((await empAgent.patch(`/api/calendar/items/${id}/done`).send({ done: true })).body.error.code).toBe('NOT_A_TASK');
  });

  it('edits and deletes its own items, and nobody else\'s', async () => {
    const id = (await empAgent.post('/api/calendar/items').send(event())).body.data._id;
    expect((await otherAgent.put(`/api/calendar/items/${id}`).send(event({ title: 'Hijack' }))).status).toBe(404);
    expect((await otherAgent.delete(`/api/calendar/items/${id}`)).status).toBe(404);
    const edited = await empAgent.put(`/api/calendar/items/${id}`).send(event({ title: 'Design review', startTime: '15:00', endTime: '16:00' }));
    expect(edited.body.data).toMatchObject({ title: 'Design review', startTime: '15:00' });
    expect((await empAgent.delete(`/api/calendar/items/${id}`)).status).toBe(200);
    expect(await CalendarItem.exists({ _id: id })).toBeNull();
  });

  it.each([
    ['an end before the start', event({ endTime: '13:00' }), 'INVALID_TIMES'],
    ['no start time', event({ startTime: null }), 'TIME_REQUIRED'],
    ['no end time', event({ endTime: null }), 'TIME_REQUIRED'],
    ['an end date before the start', { kind: 'EVENT', title: 'Offsite', date: TUE, endDate: MON, allDay: true }, 'INVALID_DATES'],
  ])('refuses an event with %s', async (_name, body, code) => {
    const res = await empAgent.post('/api/calendar/items').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(code);
  });

  it('shows a multi-day event on every day it covers', async () => {
    const id = (await empAgent.post('/api/calendar/items').send({ kind: 'EVENT', title: 'Offsite', date: MON, endDate: WED, allDay: true })).body.data._id;
    expect(await ids(empAgent, TUE, TUE)).toEqual([id]);
  });

  it('refuses very long ranges', async () => {
    expect((await empAgent.get('/api/calendar/items').query({ start: '2030-01-01', end: '2030-06-01' })).status).toBe(400);
  });
});

describe('company-wide items', () => {
  it('lets HR add an item everyone sees, and audits it', async () => {
    const res = await hrAgent.post('/api/calendar/items').send(event({ title: 'All hands', visibility: 'COMPANY' }));
    expect(res.status).toBe(201);
    expect(await ids(empAgent)).toEqual([res.body.data._id]);
    expect(await AuditLog.exists({ action: 'CALENDAR_ITEM_PUBLISHED' })).toBeTruthy();
    expect((await empAgent.delete(`/api/calendar/items/${res.body.data._id}`)).body.error.code).toBe('NOT_OWNER');
  });

  it('stops an employee adding one', async () => {
    const res = await empAgent.post('/api/calendar/items').send(event({ visibility: 'COMPANY' }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ITEM_FORBIDDEN');
  });
});
