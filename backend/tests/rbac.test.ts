import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/constants';
import { Employee, User } from '../src/models';
import { agentFor, Agent, baseline, FRI, fullDay, makePerson, makeSuperAdmin, Person, typeId, useDatabase } from './helpers';

useDatabase('rbac');

const ID = '507f1f77bcf86cd799439011';

let employee: Person;
let other: Person;
let hr: Person;
let employeeAgent: Agent;
let hrAgent: Agent;

beforeEach(async () => {
  await baseline();
  employee = await makePerson();
  other = await makePerson();
  hr = await makePerson({ role: 'HR_ADMIN' });
  employeeAgent = await agentFor(employee.email);
  hrAgent = await agentFor(hr.email);
});

describe('employee restrictions', () => {
  const adminRoutes: [string, string][] = [
    ['get', '/api/employees'],
    ['post', '/api/employees'],
    ['put', `/api/employees/${ID}`],
    ['patch', `/api/employees/${ID}/status`],
    ['post', '/api/employees/import'],
    ['get', '/api/leaves'],
    ['get', '/api/leave-balances'],
    ['get', `/api/leave-balances/${ID}`],
    ['get', `/api/leave-balances/${ID}/transactions`],
    ['post', '/api/leave-balances/adjustment'],
    ['get', '/api/compoff'],
    ['patch', `/api/compoff/${ID}/approve`],
    ['patch', `/api/compoff/${ID}/reject`],
    ['post', '/api/compoff/manual'],
    ['post', '/api/holidays'],
    ['put', `/api/holidays/${ID}`],
    ['delete', `/api/holidays/${ID}`],
    ['post', '/api/holidays/import'],
    ['get', '/api/calendar/company?start=2030-01-01&end=2030-01-31'],
    ['get', '/api/calendar/summary?month=2030-01'],
    ['post', '/api/leave-types'],
    ['put', `/api/leave-types/${ID}`],
    ['get', '/api/leave-policies'],
    ['post', '/api/leave-policies'],
    ['get', '/api/reports/monthly'],
    ['get', '/api/reports/export?report=monthly'],
    ['get', '/api/audit-logs'],
    ['get', '/api/admins'],
    ['post', '/api/admins'],
    ['get', '/api/settings'],
    ['put', '/api/settings'],
    ['get', '/api/workflows'],
    ['post', '/api/workflows'],
    ['patch', `/api/approvals/${ID}/cancellation/approve`],
  ];

  it.each(adminRoutes)('forbids %s %s', async (method, url) => {
    const res = await (employeeAgent as any)[method](url).send({});
    expect(res.status).toBe(403);
  });

  it('cannot read another employee through any id-based route', async () => {
    const type = await typeId('CL');
    const otherAgent = await agentFor(other.email);
    const created = await otherAgent.post('/api/leaves').send(fullDay(type, FRI));
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    expect((await employeeAgent.get(`/api/leaves/${id}`)).status).toBe(404);
    expect((await employeeAgent.patch(`/api/leaves/${id}/cancel`).send({})).status).toBe(404);
    expect((await employeeAgent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'mine now' })).status).toBe(404);
    expect((await employeeAgent.get(`/api/employees/${other.employee._id}`)).status).toBe(404);
    expect((await employeeAgent.get(`/api/calendar/employee?start=2030-01-01&end=2030-12-31&employeeId=${other.employee._id}`)).status).toBe(404);
    expect((await employeeAgent.patch(`/api/approvals/${id}/approve`).send({})).status).toBe(403);
  });

  it('only sees their own lists', async () => {
    const type = await typeId('CL');
    const otherAgent = await agentFor(other.email);
    await otherAgent.post('/api/leaves').send(fullDay(type, FRI));
    const mine = await employeeAgent.get('/api/leaves/my');
    expect(mine.body.data).toEqual([]);
    const pending = await employeeAgent.get('/api/approvals/pending');
    expect(pending.body.data).toEqual([]);
  });

  it('can read their own profile, balances and calendar', async () => {
    expect((await employeeAgent.get(`/api/employees/${employee.employee._id}`)).status).toBe(200);
    expect((await employeeAgent.get('/api/leave-balances/my')).status).toBe(200);
    expect((await employeeAgent.get('/api/calendar/employee?start=2030-01-01&end=2030-01-31')).status).toBe(200);
  });
});

describe('mass assignment', () => {
  it('rejects role or employee ID in an employee update', async () => {
    for (const body of [{ role: 'SUPER_ADMIN' }, { employeeId: 'HACK1' }, { user: ID }, { leaveLock: 5 }]) {
      const res = await hrAgent.put(`/api/employees/${employee.employee._id}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const after = await Employee.findById(employee.employee._id).lean();
    expect(after!.employeeId).toBe(employee.employee.employeeId);
    expect((await User.findById(employee.userId).lean())!.role).toBe('EMPLOYEE');
  });

  it('rejects a client-supplied leave total and status', async () => {
    const type = await typeId('CL');
    for (const extra of [{ totalDays: 0.5 }, { status: 'APPROVED' }, { employee: String(other.employee._id) }]) {
      const res = await employeeAgent.post('/api/leaves').send({ ...fullDay(type, FRI), ...extra });
      expect(res.status).toBe(400);
    }
  });

  it('creates new staff as employees regardless of the request', async () => {
    const res = await hrAgent.post('/api/employees').send({ employeeId: 'NEW1', fullName: 'New', email: 'new@test.local', joiningDate: '2026-01-01', role: 'SUPER_ADMIN' });
    expect(res.status).toBe(400);
  });
});

describe('administrative boundaries', () => {
  it('HR cannot use Super Admin routes', async () => {
    expect((await hrAgent.get('/api/admins')).status).toBe(403);
    expect((await hrAgent.put('/api/settings').send({ companyName: 'Evil' })).status).toBe(403);
    expect((await hrAgent.post('/api/workflows').send({})).status).toBe(403);
    expect((await hrAgent.patch(`/api/admins/${employee.userId}`).send({ role: 'SUPER_ADMIN' })).status).toBe(403);
  });

  it('HR audit view hides security events; Super Admin sees them', async () => {
    const sup = await makeSuperAdmin();
    const superAgent = await agentFor(sup.email);
    const hrLogs = await hrAgent.get('/api/audit-logs?limit=100');
    expect(hrLogs.body.data.every((l: any) => l.category === 'HR')).toBe(true);
    const all = await superAgent.get('/api/audit-logs?limit=100');
    expect(all.body.data.some((l: any) => l.category === 'SECURITY')).toBe(true);
    const asked = await hrAgent.get('/api/audit-logs?category=SECURITY');
    expect(asked.body.data.every((l: any) => l.category === 'HR')).toBe(true);
  });

  it('a Super Admin can narrow HR permissions, and it applies on the next request', async () => {
    const sup = await makeSuperAdmin();
    const superAgent = await agentFor(sup.email);
    expect((await hrAgent.get('/api/reports/monthly')).status).toBe(200);
    const res = await superAgent.patch(`/api/admins/${hr.userId}`).send({ permissions: [PERMISSIONS.EMPLOYEES_READ] });
    expect(res.status).toBe(200);
    expect((await hrAgent.get('/api/reports/monthly')).status).toBe(403);
    expect((await hrAgent.get('/api/employees')).status).toBe(200);
  });

  it('refuses to grant Super Admin only permissions to HR', async () => {
    const sup = await makeSuperAdmin();
    const superAgent = await agentFor(sup.email);
    const res = await superAgent.patch(`/api/admins/${hr.userId}`).send({ permissions: [PERMISSIONS.ADMINS_MANAGE] });
    expect(res.status).toBe(400);
  });

  it('a Super Admin cannot change their own account but can change another', async () => {
    const sup = await makeSuperAdmin();
    const second = await makeSuperAdmin();
    const superAgent = await agentFor(sup.email);
    expect((await superAgent.patch(`/api/admins/${sup.userId}`).send({ role: 'HR_ADMIN' })).status).toBe(403);
    expect((await superAgent.patch(`/api/admins/${sup.userId}`).send({ isActive: false })).status).toBe(403);
    expect((await superAgent.patch(`/api/admins/${second.userId}`).send({ isActive: false })).status).toBe(200);
  });

  it('HR cannot deactivate themselves', async () => {
    expect((await hrAgent.patch(`/api/employees/${hr.employee._id}/status`).send({ status: 'INACTIVE' })).status).toBe(403);
  });
});

describe('input validation', () => {
  it('validates ObjectIds', async () => {
    const res = await hrAgent.get('/api/employees/not-an-id');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('id');
  });

  it('rejects operators hidden in query strings and nested bodies', async () => {
    expect((await hrAgent.get('/api/employees?status[$ne]=ACTIVE')).status).toBe(400);
    expect((await hrAgent.put(`/api/employees/${employee.employee._id}`).send({ fullName: { $gt: '' } })).status).toBe(400);
  });

  it('treats regex characters in search as plain text', async () => {
    const res = await hrAgent.get(`/api/employees?search=${encodeURIComponent('.*(')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('ignores sort fields outside the allowlist', async () => {
    const res = await hrAgent.get('/api/employees?sort=user');
    expect(res.status).toBe(200);
  });

  it('returns field-level errors in a consistent shape', async () => {
    const res = await hrAgent.post('/api/employees').send({ employeeId: '!', fullName: '', email: 'nope', joiningDate: '2026-13-40' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    const paths = res.body.error.details.map((d: any) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['employeeId', 'fullName', 'email', 'joiningDate']));
  });
});

describe('no favours to yourself', () => {
  it('stops HR adding leave or Comp-Off to their own balance, but allows it for others', async () => {
    const cl = await typeId('CL');
    const mine = await hrAgent.post('/api/leave-balances/adjustment').send({ employee: String(hr.employee._id), leaveType: cl, year: 2030, amount: 5, kind: 'CREDIT', reason: 'Bonus' });
    expect(mine.status).toBe(403);
    expect(mine.body.error.code).toBe('OWN_RECORD');
    expect((await hrAgent.post('/api/compoff/manual').send({ employee: String(hr.employee._id), amount: 2, reason: 'Bonus' })).status).toBe(403);
    expect((await hrAgent.post('/api/leave-balances/adjustment').send({ employee: String(other.employee._id), leaveType: cl, year: 2030, amount: 1, kind: 'CREDIT', reason: 'Bonus' })).status).toBe(201);
  });

  it("stops HR editing their own employee record, which decides their leave", async () => {
    const res = await hrAgent.put(`/api/employees/${hr.employee._id}`).send({ gender: 'FEMALE' });
    expect(res.status).toBe(403);
    expect((await hrAgent.put(`/api/employees/${other.employee._id}`).send({ designation: 'Lead' })).status).toBe(200);
  });

  it('still lets a Super Admin edit their own record', async () => {
    const admin = await makePerson({ role: 'SUPER_ADMIN' });
    const agent = await agentFor(admin.email);
    expect((await agent.put(`/api/employees/${admin.employee._id}`).send({ designation: 'Director' })).status).toBe(200);
  });
});
