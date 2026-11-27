import { beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '../src/constants';
import { Notification } from '../src/models';
import { agentFor, Agent, baseline, FRI, MON, makePerson, Person, useDatabase } from './helpers';

/**
 * MongoDB has no row-level security of its own, so every query carries the owner check.
 * These tests act as one employee on another's records and expect each to look missing.
 */
useDatabase('rowLevelSecurity');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);

let owner: Person;
let intruder: Person;
let ownerAgent: Agent;
let intruderAgent: Agent;

beforeEach(async () => {
  await baseline();
  owner = await makePerson();
  intruder = await makePerson();
  ownerAgent = await agentFor(owner.email);
  intruderAgent = await agentFor(intruder.email);
});

describe("one employee cannot see or change another's records", () => {
  it('work from home requests', async () => {
    const wfh = await ownerAgent.post('/api/wfh').send({ startDate: MON, endDate: MON, reason: 'Plumber visiting' });
    expect(wfh.status).toBe(201);
    expect((await intruderAgent.patch(`/api/wfh/${wfh.body.data._id}/cancel`).send({})).status).toBe(404);
    expect((await intruderAgent.get('/api/wfh/my')).body.data).toEqual([]);
  });

  it('expense claims', async () => {
    const claim = await ownerAgent.post('/api/expenses').send({ category: 'TRAVEL', expenseDate: '2026-01-05', amount: 100, description: 'Taxi' });
    expect(claim.status).toBe(201);
    expect((await intruderAgent.patch(`/api/expenses/${claim.body.data._id}/cancel`).send({})).status).toBe(404);
    expect((await intruderAgent.patch(`/api/expenses/${claim.body.data._id}/approve`).send({})).status).not.toBe(200);
    expect((await intruderAgent.get('/api/expenses/my')).body.data).toEqual([]);
  });

  it('notifications', async () => {
    const note = await Notification.create({ recipient: owner.userId, type: NOTIFICATION_TYPES[0], title: 'Private', message: 'For the owner only' });
    expect((await intruderAgent.patch(`/api/notifications/${note._id}/read`)).status).toBe(404);
    expect(JSON.stringify((await intruderAgent.get('/api/notifications')).body)).not.toContain('For the owner only');
    await intruderAgent.patch('/api/notifications/read-all');
    expect((await Notification.findById(note._id).lean())!.readAt).toBeNull();
  });

  it('uploaded files', async () => {
    const file = await ownerAgent.post('/api/files').attach('file', PDF, { filename: 'mine.pdf', contentType: 'application/pdf' });
    expect(file.status).toBe(201);
    expect((await intruderAgent.get(`/api/files/${file.body.data.id}`)).status).toBe(404);
    expect((await intruderAgent.delete(`/api/files/${file.body.data.id}`)).status).toBe(404);
    expect((await ownerAgent.get(`/api/files/${file.body.data.id}`)).status).toBe(200);
  });

  it('attendance, balances and personal details', async () => {
    expect((await intruderAgent.get(`/api/attendance/team/${owner.employee._id}`)).status).toBe(404);
    expect((await intruderAgent.get(`/api/attendance/employees/${owner.employee._id}`)).status).toBe(403);
    expect((await intruderAgent.get(`/api/leave-balances/${owner.employee._id}`)).status).toBe(403);
    expect((await intruderAgent.get(`/api/employees/${owner.employee._id}/details`)).status).toBe(403);
    await ownerAgent.put('/api/me/details').send({ personalEmail: 'owner.private@example.com' });
    expect(JSON.stringify((await intruderAgent.get('/api/me/details')).body)).not.toContain('owner.private@example.com');
  });

  it('cannot pass someone else as the owner in a request body', async () => {
    const res = await intruderAgent.post('/api/wfh').send({ startDate: MON, endDate: MON, reason: 'x', employee: String(owner.employee._id) });
    expect(res.status).toBe(400);
  });
});
