import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Holiday } from '../src/models';
import { toSegments } from '../src/services/calendar';
import { agentFor, Agent, app, baseline, FRI, fullDay, makeDepartment, makePerson, MON, Person, TUE, typeId, useDatabase, WED } from './helpers';
import supertest from 'supertest';

useDatabase('calendar');

let cl: string;
let sl: string;
let hrAgent: Agent;
let hr: Person;
let eng: Person;
let sales: Person;
let engDept: unknown;

beforeEach(async () => {
  await baseline();
  cl = await typeId('CL');
  sl = await typeId('SL');
  hr = await makePerson({ role: 'HR_ADMIN' });
  hrAgent = await agentFor(hr.email);
  engDept = await makeDepartment('Engineering');
  const salesDept = await makeDepartment('Sales');
  eng = await makePerson({ name: 'Asha Engineer', department: engDept as any });
  sales = await makePerson({ name: 'Ben Seller', department: salesDept });
});

async function leaveFor(person: Person, type: string, start: string, end: string, approve = true) {
  const agent = await agentFor(person.email);
  const res = await agent.post('/api/leaves').send(fullDay(type, start, end));
  expect(res.status).toBe(201);
  if (approve) expect((await hrAgent.patch(`/api/approvals/${res.body.data._id}/approve`).send({})).status).toBe(200);
  return res.body.data._id as string;
}

const RANGE = 'start=2030-03-01&end=2030-03-31';

describe('company calendar', () => {
  it('splits a leave around the weekend so it is never drawn over one', () => {
    expect(toSegments([{ date: FRI, value: 1 }, { date: MON, value: 1 }, { date: TUE, value: 1 }])).toEqual([
      { start: FRI, end: FRI, days: 1 },
      { start: MON, end: TUE, days: 2 },
    ]);
  });

  it('returns real entries with names, colours and status, and no weekend days', async () => {
    await leaveFor(eng, cl, FRI, MON);
    const res = await hrAgent.get(`/api/calendar/company?${RANGE}`);
    expect(res.status).toBe(200);
    const events = res.body.data.events;
    expect(events).toHaveLength(2);
    expect(events[0].employee.fullName).toBe('Asha Engineer');
    expect(events[0].leaveType.code).toBe('CL');
    expect(events[0].leaveType.color).toMatch(/^#/);
    expect(events[0].status).toBe('APPROVED');
    expect(events.map((e: any) => [e.start, e.end])).toEqual([[FRI, FRI], [MON, MON]]);
    expect(events[0].endExclusive).toBe('2030-03-02');
  });

  it('shows pending and approved together and several people on one date', async () => {
    await leaveFor(eng, cl, MON, MON);
    await leaveFor(sales, sl, MON, MON, false);
    const events = (await hrAgent.get(`/api/calendar/company?${RANGE}`)).body.data.events;
    expect(events.map((e: any) => e.status).sort()).toEqual(['APPROVED', 'PENDING']);
    expect(new Set(events.map((e: any) => e.start)).size).toBe(1);
  });

  it('leaves out rejected and cancelled leave', async () => {
    const id = await leaveFor(eng, cl, MON, MON, false);
    await hrAgent.patch(`/api/approvals/${id}/reject`).send({ reason: 'No' });
    expect((await hrAgent.get(`/api/calendar/company?${RANGE}`)).body.data.events).toEqual([]);
  });

  it('filters by department, leave type, status, name and employee ID', async () => {
    await leaveFor(eng, cl, MON, MON);
    await leaveFor(sales, sl, TUE, TUE, false);
    const names = async (q: string) => (await hrAgent.get(`/api/calendar/company?${RANGE}&${q}`)).body.data.events.map((e: any) => e.employee.fullName);
    expect(await names(`department=${engDept}`)).toEqual(['Asha Engineer']);
    expect(await names(`leaveType=${sl}`)).toEqual(['Ben Seller']);
    expect(await names('status=PENDING')).toEqual(['Ben Seller']);
    expect(await names('status=APPROVED')).toEqual(['Asha Engineer']);
    expect(await names('search=ben')).toEqual(['Ben Seller']);
    expect(await names(`search=${eng.employee.employeeId}`)).toEqual(['Asha Engineer']);
  });

  it('only returns entries inside the requested range', async () => {
    await leaveFor(eng, cl, MON, MON);
    expect((await hrAgent.get('/api/calendar/company?start=2030-04-01&end=2030-04-30')).body.data.events).toEqual([]);
    expect((await hrAgent.get('/api/calendar/company?start=2030-04-01&end=2030-03-01')).status).toBe(400);
    expect((await hrAgent.get('/api/calendar/company?start=2030-01-01&end=2032-01-01')).status).toBe(400);
  });

  it('includes holidays for highlighting', async () => {
    await Holiday.create({ name: 'Festival', date: WED, year: 2030, category: 'FESTIVAL' });
    const res = await hrAgent.get(`/api/calendar/company?${RANGE}`);
    expect(res.body.data.holidays).toEqual([expect.objectContaining({ name: 'Festival', date: WED })]);
  });

  it('gives an employee their personal calendar only', async () => {
    await leaveFor(eng, cl, MON, MON);
    await leaveFor(sales, cl, TUE, TUE);
    const res = await (await agentFor(eng.email)).get(`/api/calendar/employee?${RANGE}`);
    expect(res.body.data.events.map((e: any) => e.employee.fullName)).toEqual(['Asha Engineer']);
  });
});

describe('monthly summary', () => {
  it('computes the cards and table accurately', async () => {
    await leaveFor(eng, cl, FRI, MON); // 2 days
    await leaveFor(eng, sl, TUE, TUE); // 1 day
    await leaveFor(sales, cl, TUE, TUE); // 1 day
    await leaveFor(sales, sl, WED, WED, false); // pending, not counted as taken

    const res = await hrAgent.get('/api/calendar/summary?month=2030-03');
    const { cards, rows } = res.body.data;
    expect(cards.totalActiveEmployees).toBe(3);
    expect(cards.employeesOnLeaveThisMonth).toBe(2);
    expect(cards.totalApprovedLeaveDays).toBe(4);
    expect(cards.pendingLeaveRequests).toBe(1);
    expect(cards.maxAbsence).toEqual({ count: 2, dates: [TUE] });

    const asha = rows.find((r: any) => r.employeeName === 'Asha Engineer');
    expect(asha).toMatchObject({ casual: 2, sick: 1, earned: 0, compOff: 0, total: 3, department: 'Engineering' });
    expect(rows.find((r: any) => r.employeeName === 'Ben Seller').total).toBe(1);
    expect(rows.find((r: any) => r.employeeId === hr.employee.employeeId).total).toBe(0);
  });

  it('counts only the days inside the month for a leave crossing it', async () => {
    // Thu 28 Feb to Fri 1 Mar 2030.
    await leaveFor(eng, cl, '2030-02-28', '2030-03-01');
    const march = (await hrAgent.get('/api/calendar/summary?month=2030-03')).body.data;
    const feb = (await hrAgent.get('/api/calendar/summary?month=2030-02')).body.data;
    expect(march.cards.totalApprovedLeaveDays).toBe(1);
    expect(feb.cards.totalApprovedLeaveDays).toBe(1);
  });

  it('removes a cancelled leave from the totals', async () => {
    const id = await leaveFor(eng, cl, MON, MON);
    await hrAgent.patch(`/api/leaves/${id}/cancel`).send({ reason: 'Admin correction' });
    expect((await hrAgent.get('/api/calendar/summary?month=2030-03')).body.data.cards.totalApprovedLeaveDays).toBe(0);
  });

  it('lists the people and requests behind each card, matching its number', async () => {
    await leaveFor(eng, cl, FRI, MON); // 2 days
    await leaveFor(eng, sl, TUE, TUE); // 1 day
    await leaveFor(sales, cl, TUE, TUE); // 1 day
    await leaveFor(sales, sl, WED, WED, false); // pending
    const detail = async (kind: string) => (await hrAgent.get(`/api/calendar/summary/details?month=2030-03&kind=${kind}`)).body.data;

    expect((await detail('active')).people).toHaveLength(3);

    const month = await detail('onLeaveMonth');
    expect(month.people.map((p: any) => [p.employee.fullName, p.days, p.leaves.length])).toEqual([['Asha Engineer', 3, 2], ['Ben Seller', 1, 1]]);

    const approved = await detail('approvedDays');
    expect(approved.requests.reduce((s: number, r: any) => s + r.leave.days, 0)).toBe(4);
    expect(approved.requests[0].leave.leaveType.code).toBeTruthy();

    const pending = await detail('pending');
    expect(pending.requests.map((r: any) => [r.employee.fullName, r.leave.status])).toEqual([['Ben Seller', 'PENDING']]);

    const peak = await detail('peak');
    expect(peak.peak).toBe(2);
    expect(peak.dates.map((d: any) => [d.date, d.people.map((p: any) => p.employee.fullName)])).toEqual([[TUE, ['Asha Engineer', 'Ben Seller']]]);
  });

  it('applies the page filters to the lists', async () => {
    await leaveFor(eng, cl, MON, MON);
    await leaveFor(sales, cl, MON, MON);
    const res = await hrAgent.get(`/api/calendar/summary/details?month=2030-03&kind=approvedDays&department=${engDept}`);
    expect(res.body.data.requests.map((r: any) => r.employee.fullName)).toEqual(['Asha Engineer']);
  });

  it('keeps the lists for those who can read the company calendar', async () => {
    const agent = await agentFor(eng.email);
    expect((await agent.get('/api/calendar/summary/details?month=2030-03&kind=active')).status).toBe(403);
    expect((await hrAgent.get('/api/calendar/summary/details?month=2030-03&kind=nope')).status).toBe(400);
  });

  it('paginates the employee table', async () => {
    const res = await hrAgent.get('/api/calendar/summary?month=2030-03&limit=2&page=2');
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.meta.totalPages).toBe(2);
  });

  it('exports the same table as CSV and Excel', async () => {
    await leaveFor(eng, cl, FRI, MON);
    const csv = await hrAgent.get('/api/calendar/export?month=2030-03&format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Employee Name,Employee ID,Team,Casual Leave');
    expect(csv.text).toMatch(/Asha Engineer,T\d+,Engineering,2,0,0,0,0,2/);

    const xlsx = await hrAgent.get('/api/calendar/export?month=2030-03&format=xlsx').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    const sheet = wb.worksheets[0];
    expect(sheet.getRow(1).getCell(1).value).toBe('Employee Name');
    expect(sheet.getRow(2).getCell(1).value).toBe('Asha Engineer');
    expect(sheet.getRow(2).getCell(9).value).toBe(2);
  });
});

describe('reports', () => {
  beforeEach(async () => {
    await leaveFor(eng, cl, FRI, MON);
    await leaveFor(sales, sl, TUE, TUE, false);
  });
  const report = async (name: string, q = '') => (await hrAgent.get(`/api/reports/${name}?${q}`)).body.data;

  it('builds the monthly report, charging confirmed days only', async () => {
    const r = await report('monthly', 'month=2030-03');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ employeeName: 'Asha Engineer', CL: 2, total: 2 });
  });

  it('builds the annual report by month', async () => {
    const r = await report('annual', 'year=2030');
    expect(r.rows[0]).toMatchObject({ Mar: 2, total: 2 });
  });

  it('builds employee, department and pending reports', async () => {
    const byEmp = await report('employee', `employee=${eng.employee._id}&year=2030`);
    expect(byEmp.rows).toHaveLength(1);
    expect((await report('department', 'year=2030')).rows[0]).toMatchObject({ department: 'Engineering', leaveType: 'CL', days: 2, employees: 1 });
    const pending = await report('pending');
    expect(pending.rows.map((x: any) => x.employeeName)).toEqual(['Ben Seller']);
  });

  it('builds the remaining balance report', async () => {
    const r = await report('balances', `year=2030&leaveType=${cl}`);
    expect(r.rows.find((x: any) => x.employeeName === 'Asha Engineer')).toMatchObject({ used: 2, available: 10 });
  });

  it('builds the cancellation report', async () => {
    const id = await leaveFor(eng, cl, WED, WED);
    const agent = await agentFor(eng.email);
    await agent.post(`/api/leaves/${id}/cancellation-request`).send({ reason: 'Trip moved' });
    expect((await report('cancellations', 'year=2030')).rows[0]).toMatchObject({ status: 'CANCELLATION_REQUESTED', reason: 'Trip moved' });
  });

  it('builds the holiday report with recurring dates', async () => {
    await Holiday.create({ name: 'Republic Day', date: '2029-01-26', year: 2029, category: 'NATIONAL', recurring: true });
    const r = await report('holidays', 'year=2030');
    expect(r.rows[0]).toMatchObject({ date: '2030-01-26', name: 'Republic Day' });
  });

  it('applies date and department filters', async () => {
    expect((await report('employee', 'from=2031-01-01&to=2031-12-31')).rows).toEqual([]);
    expect((await report('department', `year=2030&department=${engDept}`)).rows).toHaveLength(1);
  });

  it('rejects an unknown report name', async () => {
    expect((await hrAgent.get('/api/reports/secrets')).status).toBe(400);
  });

  it('neutralises spreadsheet formulas in exported text', async () => {
    const evil = await makePerson({ name: '=HYPERLINK("http://evil","x")' });
    await leaveFor(evil, cl, WED, WED);
    const csv = await hrAgent.get('/api/reports/export?report=monthly&month=2030-03&format=csv');
    expect(csv.text).toContain(`'=HYPERLINK`);
    expect(csv.text).not.toMatch(/(^|,|")=HYPERLINK/m);
  });

  it('needs a login to export', async () => {
    expect((await supertest(app).get('/api/reports/export?report=monthly')).status).toBe(401);
  });
});
