import { beforeEach, describe, expect, it } from 'vitest';
import { Employee, EmployeeLeavePolicy, LeavePolicy, Session, User } from '../src/models';
import { notifyUsers } from '../src/services/notification';
import { agentFor, Agent, app, baseline, makeDepartment, makeLocation, makePerson, makeSuperAdmin, PASSWORD, Person, typeId, useDatabase } from './helpers';
import supertest from 'supertest';

useDatabase('employees');

let hr: Person;
let hrAgent: Agent;

beforeEach(async () => {
  await baseline();
  hr = await makePerson({ role: 'HR_ADMIN' });
  hrAgent = await agentFor(hr.email);
});

const newEmployee = (over: object = {}) => ({ employeeId: 'E100', fullName: 'New Person', email: 'new.person@test.local', joiningDate: '2026-01-15', ...over });

describe('employee directory', () => {
  it('creates an employee and account, with a working one-time activation link', async () => {
    const res = await hrAgent.post('/api/employees').send(newEmployee());
    expect(res.status).toBe(201);
    const user = await User.findOne({ email: 'new.person@test.local' }).lean();
    expect(user!.role).toBe('EMPLOYEE');
    const token = new URL(res.body.data.activationLink).searchParams.get('token');
    const client = supertest.agent(app).set('X-Requested-With', 'WorkNest');
    expect((await client.post('/api/auth/reset-password').send({ token, password: 'My-own-password-1' })).status).toBe(200);
    await agentFor('new.person@test.local', 'My-own-password-1');
  });

  it('refuses duplicate employee IDs and emails', async () => {
    await hrAgent.post('/api/employees').send(newEmployee());
    expect((await hrAgent.post('/api/employees').send(newEmployee({ email: 'other@test.local' }))).status).toBe(409);
    expect((await hrAgent.post('/api/employees').send(newEmployee({ employeeId: 'E200' }))).status).toBe(409);
    expect(await Employee.countDocuments({ fullName: 'New Person' })).toBe(1);
    expect(await User.countDocuments({ email: 'other@test.local' })).toBe(0);
  });

  it('searches, filters, sorts and paginates', async () => {
    const dept = await makeDepartment('Sales');
    const loc = await makeLocation('Pune');
    await makePerson({ name: 'Zed Sales', department: dept, location: loc });
    await makePerson({ name: 'Amy Other' });
    const q = async (s: string) => (await hrAgent.get(`/api/employees?${s}`)).body;
    expect((await q('search=zed')).data).toHaveLength(1);
    expect((await q(`department=${dept}`)).data[0].department.name).toBe('Sales');
    expect((await q(`location=${loc}`)).data).toHaveLength(1);
    expect((await q('sort=fullName&order=asc&limit=1')).data[0].fullName).toBe('Amy Other');
    expect((await q('limit=1&page=2')).meta).toMatchObject({ page: 2, limit: 1, total: 3, totalPages: 3 });
    expect((await hrAgent.get('/api/employees?limit=1000')).status).toBe(400);
  });

  it('updates a profile and keeps the login email in step', async () => {
    const p = await makePerson();
    const res = await hrAgent.put(`/api/employees/${p.employee._id}`).send({ email: 'changed@test.local', designation: 'Lead' });
    expect(res.body.data.designation).toBe('Lead');
    expect((await User.findById(p.userId).lean())!.email).toBe('changed@test.local');
    await agentFor('changed@test.local');
  });

  it('refuses a reporting line that loops', async () => {
    const a = await makePerson();
    const b = await makePerson({ manager: a.employee._id });
    expect((await hrAgent.put(`/api/employees/${a.employee._id}`).send({ reportingManager: String(a.employee._id) })).status).toBe(400);
    expect((await hrAgent.put(`/api/employees/${a.employee._id}`).send({ reportingManager: String(b.employee._id) })).status).toBe(400);
  });

  it('records leave policy assignments with effective dates', async () => {
    const p = await makePerson();
    const policy = await LeavePolicy.create({ name: 'P1', effectiveFrom: '2020-01-01', rules: [{ leaveType: await typeId('CL'), annualEntitlement: 30 }] });
    await hrAgent.put(`/api/employees/${p.employee._id}`).send({ leavePolicy: String(policy._id) });
    const assignment = await EmployeeLeavePolicy.findOne({ employee: p.employee._id }).lean();
    expect(assignment!.effectiveTo).toBeNull();
    const res = await (await agentFor(p.email)).get('/api/leave-balances/my?year=2030');
    expect(res.body.data.find((b: any) => b.leaveType.code === 'CL').entitlement).toBe(30);
  });

  it('deactivation ends sessions and blocks login, reactivation restores it', async () => {
    const p = await makePerson();
    await agentFor(p.email);
    await hrAgent.patch(`/api/employees/${p.employee._id}/status`).send({ status: 'INACTIVE' });
    expect(await Session.countDocuments({ user: p.userId, revokedAt: null })).toBe(0);
    await expect(agentFor(p.email)).rejects.toThrow(/Login failed/);
    await hrAgent.patch(`/api/employees/${p.employee._id}/status`).send({ status: 'ACTIVE' });
    await agentFor(p.email, PASSWORD);
    expect(await Employee.exists({ _id: p.employee._id })).toBeTruthy();
  });

  it('imports from CSV, wiring up managers defined later in the file', async () => {
    const dept = await makeDepartment('Engineering');
    const csv = [
      'Employee ID,Full Name,Email,Joining Date,Department,Reporting Manager,Category',
      'A1,Report One,report1@test.local,2026-01-05,Engineering,M1,',
      'M1,The Manager,manager1@test.local,05/01/2024,Engineering,,permanent',
      'bad id!,Bad,bad@test.local,2026-01-05,,,',
      'A2,No Email,,2026-01-05,,,',
      'A3,Bad Dept,a3@test.local,2026-01-05,Nope,,',
      'A4,Bad Date,a4@test.local,someday,,,',
      `${hr.employee.employeeId},Dup,dup@test.local,2026-01-05,,,`,
    ].join('\n');
    const res = await hrAgent.post('/api/employees/import').attach('file', Buffer.from(csv), { filename: 'staff.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.errors).toHaveLength(5);
    expect(res.body.data.activationLinks).toHaveLength(2);
    const report = await Employee.findOne({ employeeId: 'A1' }).lean();
    const manager = await Employee.findOne({ employeeId: 'M1' }).lean();
    expect(String(report!.reportingManager)).toBe(String(manager!._id));
    expect(String(manager!.department)).toBe(String(dept));
    expect(manager!.joiningDate).toBe('2024-01-05');
  });

  it('reads a Team column, and names an unknown team in the error', async () => {
    const team = await makeDepartment('Platform');
    const csv = [
      'Employee ID,Full Name,Email,Joining Date,Team',
      'T1,Team Member,t1@test.local,2026-01-05,Platform',
      'T2,Lost Member,t2@test.local,2026-01-05,Nowhere',
    ].join('\n');
    const res = await hrAgent.post('/api/employees/import').attach('file', Buffer.from(csv), { filename: 'team.csv', contentType: 'text/csv' });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.errors[0].message).toBe('Unknown team "Nowhere"');
    expect(String((await Employee.findOne({ employeeId: 'T1' }).lean())!.department)).toBe(String(team));
  });
});

describe('Super Admin account management', () => {
  it('creates an HR account with limited permissions and an activation link', async () => {
    const sup = await makeSuperAdmin();
    const agent = await agentFor(sup.email);
    const res = await agent.post('/api/admins').send({ email: 'hr2@test.local', role: 'HR_ADMIN', permissions: ['employees:read'] });
    expect(res.status).toBe(201);
    expect(res.body.data.admin.effectivePermissions).toEqual(['employees:read']);
    expect(res.body.data.activationLink).toContain('/reset-password?token=');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('promotes an existing employee and later returns them to employee', async () => {
    const sup = await makeSuperAdmin();
    const agent = await agentFor(sup.email);
    const p = await makePerson();
    const res = await agent.post('/api/admins').send({ employee: String(p.employee._id), role: 'HR_ADMIN' });
    expect(res.body.data.admin.role).toBe('HR_ADMIN');
    const back = await agent.patch(`/api/admins/${p.userId}`).send({ role: 'EMPLOYEE' });
    expect(back.body.data.effectivePermissions).toEqual([]);
  });

  it('updates global settings and validates them', async () => {
    const sup = await makeSuperAdmin();
    const agent = await agentFor(sup.email);
    const ok = await agent.put('/api/settings').send({ companyName: 'Acme', security: { maxFailedLogins: 3 } });
    expect(ok.body.data.companyName).toBe('Acme');
    expect(ok.body.data.security.maxFailedLogins).toBe(3);
    expect(ok.body.data.security.lockoutMinutes).toBe(15);
    expect((await agent.put('/api/settings').send({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await agent.put('/api/settings').send({ key: 'x' })).status).toBe(400);
  });

  it('keeps one default workflow', async () => {
    const sup = await makeSuperAdmin();
    const agent = await agentFor(sup.email);
    const res = await agent.post('/api/workflows').send({ name: 'Two step', isDefault: true, steps: [{ order: 1, approverType: 'REPORTING_MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }] });
    expect(res.status).toBe(201);
    const list = await agent.get('/api/workflows');
    expect(list.body.data.filter((w: any) => w.isDefault).map((w: any) => w.name)).toEqual(['Two step']);
    expect((await agent.post('/api/workflows').send({ name: 'Empty', steps: [] })).status).toBe(400);
  });
});

describe('notifications', () => {
  it('scopes every read and update to the recipient', async () => {
    const p = await makePerson();
    const other = await makePerson();
    const agent = await agentFor(p.email);
    const otherAgent = await agentFor(other.email);
    await notifyUsers([p.userId], { type: 'HOLIDAY_UPCOMING', title: 'Hi', message: 'There' });
    const list = await agent.get('/api/notifications');
    expect(list.body.meta.unread).toBe(1);
    const id = list.body.data[0]._id;
    expect((await otherAgent.get('/api/notifications')).body.data).toEqual([]);
    expect((await otherAgent.patch(`/api/notifications/${id}/read`)).status).toBe(404);
    expect((await agent.patch(`/api/notifications/${id}/read`)).status).toBe(200);
    expect((await agent.get('/api/notifications/unread-count')).body.data.unread).toBe(0);
  });
});
