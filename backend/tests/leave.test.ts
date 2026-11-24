import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalWorkflow, Employee, Holiday, LeaveBalance, LeaveRequest, LeaveTransaction, LeaveType, Notification, AuditLog, CompanySettings, StoredFile } from '../src/models';
import { reconcileBalance } from '../src/services/balance';
import { agentFor, Agent, baseline, FRI, fullDay, makeDepartment, makeLocation, makePerson, MON, Person, THU, TUE, typeId, useDatabase, WED } from './helpers';

useDatabase('leave');

let cl: string;
let emp: Person;
let hr: Person;
let empAgent: Agent;
let hrAgent: Agent;

beforeEach(async () => {
  await baseline();
  cl = await typeId('CL');
  emp = await makePerson();
  hr = await makePerson({ role: 'HR_ADMIN' });
  empAgent = await agentFor(emp.email);
  hrAgent = await agentFor(hr.email);
});

const balanceOf = async (person = emp, type = cl, year = 2030) => LeaveBalance.findOne({ employee: person.employee._id, leaveType: type, year }).lean();
const apply = (body: Record<string, unknown>, agent = empAgent) => agent.post('/api/leaves').send(body);
async function applied(start = FRI, end = start) {
  const res = await apply(fullDay(cl, start, end));
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}
const assertLedgerConsistent = async (person = emp, type = cl, year = 2030) => {
  const r = await reconcileBalance(person.employee._id, (await LeaveType.findById(type).lean())!._id, year);
  expect(r.matches).toBe(true);
};

describe('applying for leave', () => {
  it('calculates days on the server: Friday to Monday is two days', async () => {
    const res = await apply(fullDay(cl, FRI, MON));
    expect(res.status).toBe(201);
    expect(res.body.data.totalDays).toBe(2);
    expect(res.body.data.status).toBe('PENDING');
  });

  it('previews the same number the submission will use', async () => {
    const res = await empAgent.post('/api/leaves/preview').send({ leaveType: cl, startDate: FRI, endDate: MON });
    expect(res.status).toBe(200);
    expect(res.body.data.totalDays).toBe(2);
    expect(res.body.data.excluded.map((e: any) => e.label)).toEqual(['Saturday', 'Sunday']);
    expect(res.body.data.issues).toEqual([]);
  });

  it('rejects a range with no working days', async () => {
    const res = await apply(fullDay(cl, '2030-03-02', '2030-03-03'));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no working days/);
  });

  it('rejects end before start', async () => {
    expect((await apply(fullDay(cl, MON, FRI))).status).toBe(422);
  });

  it('excludes company holidays', async () => {
    await Holiday.create({ name: 'Festival', date: TUE, year: 2030, category: 'FESTIVAL' });
    const res = await apply(fullDay(cl, MON, WED));
    expect(res.body.data.totalDays).toBe(2);
  });

  it('only excludes holidays applicable to the employee location', async () => {
    const mumbai = await makeLocation('Mumbai');
    const blr = await makeLocation('Bengaluru');
    await Holiday.create({ name: 'Regional', date: TUE, year: 2030, category: 'REGIONAL', locations: [mumbai] });
    const inMumbai = await makePerson({ location: mumbai });
    const inBlr = await makePerson({ location: blr });
    const a = await apply(fullDay(cl, MON, WED), await agentFor(inMumbai.email));
    const b = await apply(fullDay(cl, MON, WED), await agentFor(inBlr.email));
    expect(a.body.data.totalDays).toBe(2);
    expect(b.body.data.totalDays).toBe(3);
  });

  it('does not exclude optional holidays automatically', async () => {
    await Holiday.create({ name: 'Optional', date: TUE, year: 2030, category: 'OPTIONAL' });
    expect((await apply(fullDay(cl, MON, WED))).body.data.totalDays).toBe(3);
  });

  it('allows Optional Holiday leave only on an optional holiday', async () => {
    const oh = await typeId('OH');
    await Holiday.create({ name: 'Optional', date: TUE, year: 2030, category: 'OPTIONAL' });
    expect((await apply(fullDay(oh, WED))).status).toBe(422);
    expect((await apply(fullDay(oh, TUE))).status).toBe(201);
  });

  it('enforces half-day rules', async () => {
    const half = (over: object) => apply({ leaveType: cl, startDate: FRI, endDate: FRI, dayType: 'HALF', halfSession: 'FIRST', reason: 'x', ...over });
    expect((await half({ endDate: MON })).status).toBe(422);
    expect((await half({ halfSession: null })).status).toBe(422);
    const ok = await half({});
    expect(ok.status).toBe(201);
    expect(ok.body.data.totalDays).toBe(0.5);
    const noHalf = await apply({ leaveType: await typeId('PAT'), startDate: MON, endDate: MON, dayType: 'HALF', halfSession: 'FIRST', reason: 'x' });
    expect(noHalf.status).toBe(422);
  });

  it('enforces past dates, notice and maximum duration from policy', async () => {
    expect((await apply(fullDay(cl, '2020-03-02'))).body.error.message).toMatch(/past dates/);
    await LeaveType.updateOne({ _id: cl }, { maxDuration: 1 });
    expect((await apply(fullDay(cl, MON, TUE))).body.error.message).toMatch(/maximum of 1/);
    await LeaveType.updateOne({ _id: cl }, { maxDuration: null, minNoticeDays: 100000 });
    expect((await apply(fullDay(cl, FRI))).body.error.message).toMatch(/advance notice/);
  });

  it('allows back-dated sick leave within its window only', async () => {
    const sl = await typeId('SL');
    expect((await apply(fullDay(sl, '2020-03-02'))).body.error.message).toMatch(/back-dated/);
  });

  it('refuses leave before the joining date and for inactive employees', async () => {
    const newcomer = await makePerson({ joiningDate: '2031-01-01' });
    expect((await apply(fullDay(cl, FRI), await agentFor(newcomer.email))).body.error.message).toMatch(/joining date/);
    await Employee.updateOne({ _id: emp.employee._id }, { employmentStatus: 'INACTIVE' });
    expect((await apply(fullDay(cl, FRI))).body.error.message).toMatch(/inactive/);
  });

  it('requires a document when the policy says so, and it must be the applicant\'s', async () => {
    await LeaveType.updateOne({ _id: cl }, { requiresDocument: true });
    const missing = await apply(fullDay(cl, FRI));
    expect(missing.body.error.details[0].path).toBe('document');
    const someoneElses = await StoredFile.create({ owner: hr.userId, originalName: 'a.pdf', storedName: 'a.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x' });
    const res = await apply({ ...fullDay(cl, FRI), document: String(someoneElses._id) });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/document was not found/);
  });

  it('honours category restrictions on a leave type', async () => {
    await LeaveType.updateOne({ _id: cl }, { applicableCategories: ['CONTRACT'] });
    expect((await apply(fullDay(cl, FRI))).body.error.message).toMatch(/not available/);
  });

  it('notifies the employee and the approvers, and writes an audit entry', async () => {
    await applied();
    expect(await Notification.exists({ recipient: emp.userId, type: 'LEAVE_SUBMITTED' })).toBeTruthy();
    expect(await Notification.exists({ recipient: hr.userId, type: 'APPROVAL_REQUIRED' })).toBeTruthy();
    expect(await AuditLog.exists({ action: 'LEAVE_APPLIED' })).toBeTruthy();
  });
});

describe('overlaps and duplicates', () => {
  it('rejects overlapping requests', async () => {
    await applied(MON, WED);
    const res = await apply(fullDay(cl, TUE, THU));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERLAPPING_REQUEST');
  });

  it('allows opposite half days on one date but not the same half', async () => {
    const half = (halfSession: string) => apply({ leaveType: cl, startDate: FRI, endDate: FRI, dayType: 'HALF', halfSession, reason: 'x' });
    expect((await half('FIRST')).status).toBe(201);
    expect((await half('FIRST')).status).toBe(409);
    expect((await half('SECOND')).status).toBe(201);
  });

  it('allows the dates again after rejection', async () => {
    const id = await applied();
    await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'No' });
    expect((await apply(fullDay(cl, FRI))).status).toBe(201);
  });

  it('replays with the same idempotency key without creating a second request', async () => {
    const send = () => empAgent.post('/api/leaves').set('Idempotency-Key', 'retry-key-123').send(fullDay(cl, FRI));
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.meta.replayed).toBe(true);
    expect(second.body.data._id).toBe(first.body.data._id);
    expect(await LeaveRequest.countDocuments()).toBe(1);
    expect((await balanceOf())!.reserved).toBe(1);
  });

  it('lets only one of several simultaneous overlapping submissions through', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => apply(fullDay(cl, FRI))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await LeaveRequest.countDocuments()).toBe(1);
    expect((await balanceOf())!.reserved).toBe(1);
    await assertLedgerConsistent();
  });
});

describe('balances', () => {
  it('grants the entitlement through the ledger and reads it back', async () => {
    const res = await empAgent.get('/api/leave-balances/my?year=2030');
    const row = res.body.data.find((b: any) => b.leaveType.code === 'CL');
    expect(row.entitlement).toBe(12);
    expect(row.available).toBe(12);
    expect(await LeaveTransaction.countDocuments({ employee: emp.employee._id, leaveType: cl, type: 'ENTITLEMENT' })).toBe(1);
  });

  it('grants once no matter how often it is read', async () => {
    await Promise.all(Array.from({ length: 5 }, () => empAgent.get('/api/leave-balances/my?year=2030')));
    expect(await LeaveTransaction.countDocuments({ employee: emp.employee._id, leaveType: cl, type: 'ENTITLEMENT' })).toBe(1);
    expect((await balanceOf())!.available).toBe(12);
    await assertLedgerConsistent();
  });

  it('prorates the entitlement for a mid-year joiner', async () => {
    const joiner = await makePerson({ joiningDate: '2030-07-15' });
    const res = await (await agentFor(joiner.email)).get('/api/leave-balances/my?year=2030');
    expect(res.body.data.find((b: any) => b.leaveType.code === 'CL').entitlement).toBe(6);
  });

  it('rejects leave beyond the balance', async () => {
    await LeaveType.updateOne({ _id: cl }, { annualEntitlement: 1 });
    const res = await apply(fullDay(cl, MON, TUE));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('holds pending days apart from used days', async () => {
    await applied(MON, TUE);
    const b = (await balanceOf())!;
    expect(b.reserved).toBe(2);
    expect(b.used).toBe(0);
    expect(b.available).toBe(10);
    await assertLedgerConsistent();
  });

  it('stops pending requests from overspending together', async () => {
    await LeaveType.updateOne({ _id: cl }, { annualEntitlement: 2 });
    await applied(FRI, MON);
    const res = await apply(fullDay(cl, TUE));
    expect(res.status).toBe(422);
  });

  it('allows negative balance only up to the policy limit', async () => {
    await LeaveType.updateOne({ _id: cl }, { annualEntitlement: 1, allowNegative: true, maxNegative: 1 });
    expect((await apply(fullDay(cl, FRI, MON))).status).toBe(201);
    expect((await balanceOf())!.available).toBe(-1);
    expect((await apply(fullDay(cl, TUE))).status).toBe(422);
  });

  it('does not check a balance for unpaid leave but still records it', async () => {
    const lwp = await typeId('LWP');
    const res = await apply(fullDay(lwp, MON, TUE));
    expect(res.status).toBe(201);
    await hrAgent.patch(`/api/approvals/${res.body.data._id}/approve`).send({});
    expect((await balanceOf(emp, lwp))!.used).toBe(2);
  });

  it('charges a leave crossing the new year against each year', async () => {
    const res = await apply(fullDay(cl, '2030-12-30', '2031-01-01'));
    expect(res.status).toBe(201);
    expect((await balanceOf(emp, cl, 2030))!.reserved).toBe(2);
    expect((await balanceOf(emp, cl, 2031))!.reserved).toBe(1);
    await hrAgent.patch(`/api/approvals/${res.body.data._id}/approve`).send({});
    expect((await balanceOf(emp, cl, 2030))!.used).toBe(2);
    expect((await balanceOf(emp, cl, 2031))!.used).toBe(1);
  });

  it('works without reservations when the company turns them off', async () => {
    await CompanySettings.updateOne({ key: 'global' }, { reserveBalanceOnPending: false }, { upsert: true });
    const id = await applied(MON, TUE);
    expect((await balanceOf())!.reserved).toBe(0);
    expect((await balanceOf())!.available).toBe(12);
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect((await balanceOf())!.used).toBe(2);
    expect((await balanceOf())!.available).toBe(10);
  });

  it('records manual adjustments with reasons in the ledger', async () => {
    await empAgent.get('/api/leave-balances/my?year=2030');
    const adjust = (body: object) => hrAgent.post('/api/leave-balances/adjustment').send({ employee: String(emp.employee._id), leaveType: cl, year: 2030, ...body });
    expect((await adjust({ amount: 2, kind: 'CREDIT', reason: 'Bonus' })).status).toBe(201);
    expect((await adjust({ amount: 1, kind: 'DEDUCTION', reason: 'Correction' })).status).toBe(201);
    expect((await adjust({ amount: 1, kind: 'CREDIT' })).status).toBe(400);
    expect((await adjust({ amount: 0.3, kind: 'CREDIT', reason: 'x' })).status).toBe(400);
    const b = (await balanceOf())!;
    expect(b.credited).toBe(2);
    expect(b.adjustments).toBe(-1);
    expect(b.available).toBe(13);
    const history = await hrAgent.get(`/api/leave-balances/${emp.employee._id}/transactions?year=2030`);
    expect(history.body.data.map((t: any) => t.reason)).toEqual(expect.arrayContaining(['Bonus', 'Correction']));
    await assertLedgerConsistent();
  });

  it('refuses a deduction larger than the balance', async () => {
    await empAgent.get('/api/leave-balances/my?year=2030');
    const res = await hrAgent.post('/api/leave-balances/adjustment').send({ employee: String(emp.employee._id), leaveType: cl, year: 2030, amount: 100, kind: 'DEDUCTION', reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('does not repeat an adjustment when retried with the same key', async () => {
    await empAgent.get('/api/leave-balances/my?year=2030');
    const send = () => hrAgent.post('/api/leave-balances/adjustment').set('Idempotency-Key', 'adjust-key-1').send({ employee: String(emp.employee._id), leaveType: cl, year: 2030, amount: 2, kind: 'CREDIT', reason: 'Bonus' });
    await send();
    await send();
    expect((await balanceOf())!.credited).toBe(2);
  });
});

describe('approval', () => {
  it('moves days from reserved to used, notifies and audits', async () => {
    const id = await applied(MON, TUE);
    const res = await hrAgent.patch(`/api/approvals/${id}/approve`).send({ comment: 'Have a good break' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    const b = (await balanceOf())!;
    expect(b.reserved).toBe(0);
    expect(b.used).toBe(2);
    expect(b.available).toBe(10);
    expect(await Notification.exists({ recipient: emp.userId, type: 'LEAVE_APPROVED' })).toBeTruthy();
    expect(await AuditLog.exists({ action: 'LEAVE_APPROVED', entityId: id })).toBeTruthy();
    await assertLedgerConsistent();
  });

  it('refuses a second approval', async () => {
    const id = await applied();
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    const again = await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PROCESSED');
    expect((await balanceOf())!.used).toBe(1);
  });

  it('deducts exactly once under simultaneous approvals', async () => {
    const id = await applied(MON, WED);
    const results = await Promise.all(Array.from({ length: 6 }, () => hrAgent.patch(`/api/approvals/${id}/approve`).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const b = (await balanceOf())!;
    expect(b.used).toBe(3);
    expect(b.reserved).toBe(0);
    expect(await LeaveTransaction.countDocuments({ leaveRequest: id, type: 'DEBIT' })).toBe(1);
    await assertLedgerConsistent();
  });

  it('handles approve racing reject: exactly one wins', async () => {
    const id = await applied();
    const [a, r] = await Promise.all([
      hrAgent.patch(`/api/approvals/${id}/approve`).send({}),
      hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'No' }),
    ]);
    expect([a.status, r.status].sort()).toEqual([200, 409]);
    const b = (await balanceOf())!;
    expect(b.reserved).toBe(0);
    expect(b.used).toBe(a.status === 200 ? 1 : 0);
    await assertLedgerConsistent();
  });

  it('rolls everything back when any write in the approval fails', async () => {
    const id = await applied(MON, TUE);
    const before = (await balanceOf())!;
    const spy = vi.spyOn(Notification, 'insertMany').mockRejectedValueOnce(new Error('simulated failure mid-transaction'));
    const res = await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect((await LeaveRequest.findById(id).lean())!.status).toBe('PENDING');
    const after = (await balanceOf())!;
    expect(after.used).toBe(before.used);
    expect(after.reserved).toBe(before.reserved);
    expect(await LeaveTransaction.countDocuments({ leaveRequest: id, type: 'DEBIT' })).toBe(0);
    expect(await AuditLog.exists({ action: 'LEAVE_APPROVED', entityId: id })).toBeNull();

    // And it can be retried cleanly.
    expect((await hrAgent.patch(`/api/approvals/${id}/approve`).send({})).status).toBe(200);
    expect((await balanceOf())!.used).toBe(2);
    await assertLedgerConsistent();
  });

  it('rolls back a submission when its notification fails', async () => {
    const spy = vi.spyOn(Notification, 'insertMany').mockRejectedValueOnce(new Error('simulated failure'));
    const res = await apply(fullDay(cl, FRI));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await LeaveRequest.countDocuments()).toBe(0);
    expect((await balanceOf())!.reserved).toBe(0);
  });

  it('never lets anyone decide their own leave', async () => {
    const res = await apply(fullDay(cl, FRI), hrAgent);
    const id = res.body.data._id;
    const self = await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    expect((await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'x' })).status).toBe(403);
    expect((await hrAgent.get('/api/approvals/pending')).body.data.map((r: any) => r._id)).not.toContain(id);
  });

  it('re-derives the cost if a holiday was added while pending', async () => {
    const id = await applied(MON, WED);
    await Holiday.create({ name: 'Announced late', date: TUE, year: 2030, category: 'COMPANY' });
    const res = await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect(res.body.data.totalDays).toBe(2);
    const b = (await balanceOf())!;
    expect(b.used).toBe(2);
    expect(b.reserved).toBe(0);
    expect(b.available).toBe(10);
    await assertLedgerConsistent();
  });

  it('requires a reason to reject and returns the held days', async () => {
    const id = await applied(MON, TUE);
    expect((await hrAgent.patch(`/api/approvals/${id}/reject`).send({})).status).toBe(400);
    expect((await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: '   ' })).status).toBe(400);
    const res = await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'Team is short' });
    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.rejectionReason).toBe('Team is short');
    const b = (await balanceOf())!;
    expect(b.reserved).toBe(0);
    expect(b.available).toBe(12);
    await assertLedgerConsistent();
  });

  it('auto-approves when the leave type needs no approval', async () => {
    await LeaveType.updateOne({ _id: cl }, { requiresApproval: false });
    const res = await apply(fullDay(cl, FRI));
    expect(res.body.data.status).toBe('APPROVED');
    expect((await balanceOf())!.used).toBe(1);
  });
});

describe('approval workflows', () => {
  let manager: Person;
  let report: Person;
  let reportAgent: Agent;
  let managerAgent: Agent;

  beforeEach(async () => {
    manager = await makePerson();
    report = await makePerson({ manager: manager.employee._id });
    reportAgent = await agentFor(report.email);
    managerAgent = await agentFor(manager.email);
    await ApprovalWorkflow.updateOne({ isDefault: true }, { steps: [{ order: 1, approverType: 'REPORTING_MANAGER', label: 'Manager' }, { order: 2, approverType: 'HR_ADMIN', label: 'HR' }] });
  });

  it('walks through both steps, deducting only at the end', async () => {
    const id = (await apply(fullDay(cl, FRI), reportAgent)).body.data._id;
    expect((await managerAgent.get('/api/approvals/pending')).body.data.map((r: any) => r._id)).toContain(id);

    const step1 = await managerAgent.patch(`/api/approvals/${id}/approve`).send({ comment: 'Fine by me' });
    expect(step1.body.data.status).toBe('PENDING');
    expect(step1.body.data.currentApproverType).toBe('HR_ADMIN');
    expect((await balanceOf(report))!.used).toBe(0);
    expect(await Notification.exists({ recipient: hr.userId, title: 'Leave request needs your approval' })).toBeTruthy();

    // The manager's turn has passed.
    expect((await managerAgent.patch(`/api/approvals/${id}/approve`).send({})).status).toBe(403);

    const step2 = await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect(step2.body.data.status).toBe('APPROVED');
    expect((await balanceOf(report))!.used).toBe(1);
    expect(step2.body.data.approvalSteps.map((s: any) => s.status)).toEqual(['APPROVED', 'APPROVED']);
  });

  it('lets a manager read but only for their own reports', async () => {
    const id = (await apply(fullDay(cl, FRI), reportAgent)).body.data._id;
    expect((await managerAgent.get(`/api/leaves/${id}`)).status).toBe(200);
    const stranger = await agentFor((await makePerson()).email);
    expect((await stranger.get(`/api/leaves/${id}`)).status).toBe(404);
    expect((await stranger.patch(`/api/approvals/${id}/approve`).send({})).status).toBe(403);
  });

  it('skips the manager step for someone with no manager', async () => {
    const res = await apply(fullDay(cl, FRI));
    expect(res.body.data.approvalSteps).toHaveLength(1);
    expect(res.body.data.currentApproverType).toBe('HR_ADMIN');
  });
});

describe('cancellation', () => {
  it('lets an employee withdraw a pending request and returns the days', async () => {
    const id = await applied(MON, TUE);
    const res = await empAgent.patch(`/api/leaves/${id}/cancel`).send({});
    expect(res.body.data.status).toBe('CANCELLED');
    expect((await balanceOf())!.available).toBe(12);
    await assertLedgerConsistent();
  });

  it('makes approved leave go through a request, then restores on approval', async () => {
    const id = await applied(MON, TUE);
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    expect((await empAgent.patch(`/api/leaves/${id}/cancel`).send({})).body.error.code).toBe('CANCELLATION_REQUEST_REQUIRED');

    const req = await empAgent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'Plans changed' });
    expect(req.body.data.status).toBe('CANCELLATION_REQUESTED');
    expect(await Notification.exists({ recipient: hr.userId, type: 'CANCELLATION_REQUESTED' })).toBeTruthy();
    expect((await balanceOf())!.used).toBe(2);

    const done = await hrAgent.patch(`/api/approvals/${id}/cancellation/approve`).send({});
    expect(done.body.data.status).toBe('CANCELLED');
    const b = (await balanceOf())!;
    expect(b.used).toBe(0);
    expect(b.available).toBe(12);
    expect(await Notification.exists({ recipient: emp.userId, type: 'CANCELLATION_APPROVED' })).toBeTruthy();
    await assertLedgerConsistent();
  });

  it('keeps the leave when a cancellation is declined', async () => {
    const id = await applied();
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    await empAgent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'Plans changed' });
    const res = await hrAgent.patch(`/api/approvals/${id}/cancellation/reject`).send({ reason: 'Already staffed around it' });
    expect(res.body.data.status).toBe('APPROVED');
    expect((await balanceOf())!.used).toBe(1);
    expect(await Notification.exists({ recipient: emp.userId, type: 'CANCELLATION_REJECTED' })).toBeTruthy();
  });

  it('restores only once under simultaneous cancellation decisions', async () => {
    const id = await applied(MON, TUE);
    await hrAgent.patch(`/api/approvals/${id}/approve`).send({});
    await empAgent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'x' });
    const results = await Promise.all(Array.from({ length: 4 }, () => hrAgent.patch(`/api/approvals/${id}/cancellation/approve`).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await balanceOf())!.available).toBe(12);
    expect(await LeaveTransaction.countDocuments({ leaveRequest: id, type: 'RESTORE' })).toBe(1);
    await assertLedgerConsistent();
  });

  it('frees the dates once cancelled', async () => {
    const id = await applied();
    await empAgent.patch(`/api/leaves/${id}/cancel`).send({});
    expect((await apply(fullDay(cl, FRI))).status).toBe(201);
  });

  it('withdraws open requests when an employee is deactivated, keeping history', async () => {
    const pending = await applied(MON);
    const approved = await applied(WED);
    await hrAgent.patch(`/api/approvals/${approved}/approve`).send({});
    const res = await hrAgent.patch(`/api/employees/${emp.employee._id}/status`).send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect((await LeaveRequest.findById(pending).lean())!.status).toBe('CANCELLED');
    expect((await LeaveRequest.findById(approved).lean())!.status).toBe('APPROVED');
    expect((await empAgent.get('/api/auth/me')).status).toBe(401);
    const history = await hrAgent.get(`/api/leaves?employee=${emp.employee._id}`);
    expect(history.body.data).toHaveLength(2);
  });
});

describe('leave policies', () => {
  it('overrides the leave type for a matching department, with the most specific policy winning', async () => {
    const dept = await makeDepartment('Sales');
    const person = await makePerson({ department: dept });
    const agent = await agentFor(person.email);
    const create = (name: string, over: object, annualEntitlement: number) =>
      hrAgent.post('/api/leave-policies').send({ name, effectiveFrom: '2020-01-01', rules: [{ leaveType: cl, annualEntitlement }], ...over });
    expect((await create('Company', {}, 20)).status).toBe(201);
    expect((await create('Sales', { departments: [String(dept)] }, 25)).status).toBe(201);
    const res = await agent.get('/api/leave-balances/my?year=2030');
    expect(res.body.data.find((b: any) => b.leaveType.code === 'CL').entitlement).toBe(25);
    const other = await agentFor((await makePerson()).email);
    const otherRes = await other.get('/api/leave-balances/my?year=2030');
    expect(otherRes.body.data.find((b: any) => b.leaveType.code === 'CL').entitlement).toBe(20);
  });

  it('can bar a group from a leave type', async () => {
    await hrAgent.post('/api/leave-policies').send({ name: 'No casual', effectiveFrom: '2020-01-01', rules: [{ leaveType: cl, isAllowed: false }] });
    expect((await apply(fullDay(cl, FRI))).body.error.message).toMatch(/not available/);
    const types = await empAgent.get('/api/leave-types/available');
    expect(types.body.data.find((t: any) => t.code === 'CL').ineligibleReason).toMatch(/not available/);
  });

  it('ignores policies outside their effective dates', async () => {
    await hrAgent.post('/api/leave-policies').send({ name: 'Old', effectiveFrom: '2020-01-01', effectiveTo: '2020-12-31', rules: [{ leaveType: cl, maxDuration: 0.5 }] });
    expect((await apply(fullDay(cl, FRI))).status).toBe(201);
  });

  it('keeps the previous rules and an audit trail when a leave type changes', async () => {
    const res = await hrAgent.put(`/api/leave-types/${cl}`).send({ annualEntitlement: 20, effectiveFrom: '2030-01-01' });
    expect(res.body.data.annualEntitlement).toBe(20);
    const doc = await LeaveType.findById(cl).select('+history').lean();
    expect(doc!.history[0].snapshot.annualEntitlement).toBe(12);
    expect(await AuditLog.exists({ action: 'LEAVE_TYPE_UPDATED' })).toBeTruthy();
  });

  it('supports unlimited custom leave types', async () => {
    const res = await hrAgent.post('/api/leave-types').send({ name: 'Study Leave', code: 'stud', annualEntitlement: 3, color: '#123456' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('STUD');
    expect((await apply(fullDay(res.body.data._id, FRI))).status).toBe(201);
  });
});

describe('dashboard', () => {
  it('leaves life-event leave out of the annual entitlement total', async () => {
    const agent = await agentFor((await makePerson({ gender: 'FEMALE' })).email);
    const res = await agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    // CL 12 + SL 10 + EL 15 + Optional Holiday 2, without Maternity, Menstrual, Paternity or Bereavement.
    expect(res.body.data.cards.totalAnnualEntitlement).toBe(39);
    expect(res.body.data.balances.some((b: any) => b.leaveType.code === 'ML')).toBe(true);
    expect(res.body.data.balances.some((b: any) => b.leaveType.code === 'MNL')).toBe(true);
  });

  it('counts only confirmed days as used, and pending requests separately', async () => {
    const today = (await empAgent.get('/api/dashboard')).body.data.today as string;
    const year = Number(today.slice(0, 4)) + 1;
    const first = `${year}-03-01`;
    const res = await apply(fullDay(cl, first));
    const d = (await empAgent.get('/api/dashboard')).body.data.cards;
    expect(res.status).toBe(201);
    expect(d.pendingRequests).toBe(1);
    expect(d.totalUsed).toBe(0);
  });
});

describe('reading balances', () => {
  it('writes nothing once everything owed has been granted', async () => {
    await empAgent.get('/api/leave-balances/my?year=2030');
    const spy = vi.spyOn(LeaveBalance, 'updateOne');
    await empAgent.get('/api/leave-balances/my?year=2030');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the top of the hierarchy', () => {
  it('approves a Super Admin with no manager automatically, as nobody is above them', async () => {
    const top = await makePerson({ role: 'SUPER_ADMIN', name: 'Amudha Top' });
    const agent = await agentFor(top.email);
    const res = await agent.post('/api/leaves').send({ ...fullDay(cl, MON), reason: undefined });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', approvalSteps: [] });
  });

  it('sends a Super Admin with a manager to that manager as usual', async () => {
    const top = await makePerson({ role: 'SUPER_ADMIN', name: 'Amudha Top' });
    const second = await makePerson({ role: 'SUPER_ADMIN', name: 'Dinjit Second', manager: top.employee._id });
    const res = await (await agentFor(second.email)).post('/api/leaves').send(fullDay(cl, TUE));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    // Amudha can take it through every step on her own, so Dinjit's leave never gets stuck.
    const topAgent = await agentFor(top.email);
    for (let step = 0; step < 5 && (await LeaveRequest.findById(res.body.data._id).lean())!.status === 'PENDING'; step++) {
      expect((await topAgent.patch(`/api/approvals/${res.body.data._id}/approve`).send({})).status).toBe(200);
    }
    expect((await LeaveRequest.findById(res.body.data._id).lean())!.status).toBe('APPROVED');
  });
});
