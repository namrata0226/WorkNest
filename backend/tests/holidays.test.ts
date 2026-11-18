import { beforeEach, describe, expect, it } from 'vitest';
import { holidayOccurrences } from '../src/services/holiday';
import { AuditLog, Holiday } from '../src/models';
import { agentFor, Agent, baseline, makeDepartment, makeLocation, makePerson, Person, useDatabase } from './helpers';

useDatabase('holidays');

let hrAgent: Agent;
let emp: Person;
let empAgent: Agent;

beforeEach(async () => {
  await baseline();
  hrAgent = await agentFor((await makePerson({ role: 'HR_ADMIN' })).email);
  emp = await makePerson();
  empAgent = await agentFor(emp.email);
});

const body = (over: object = {}) => ({ name: 'Festival', date: '2030-03-05', category: 'FESTIVAL', ...over });

describe('holiday management', () => {
  it('adds, edits and deletes with an audit trail', async () => {
    const created = await hrAgent.post('/api/holidays').send(body({ description: 'A festival' }));
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    const updated = await hrAgent.put(`/api/holidays/${id}`).send({ name: 'Renamed', date: '2031-03-05' });
    expect(updated.body.data.name).toBe('Renamed');
    expect(updated.body.data.year).toBe(2031);
    expect((await hrAgent.delete(`/api/holidays/${id}`)).status).toBe(200);
    expect(await Holiday.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ entityType: 'Holiday' })).toBe(3);
  });

  it('validates its fields and refuses exact duplicates', async () => {
    expect((await hrAgent.post('/api/holidays').send(body({ category: 'MADE_UP' }))).status).toBe(400);
    expect((await hrAgent.post('/api/holidays').send(body({ date: '2030-02-31' }))).status).toBe(400);
    await hrAgent.post('/api/holidays').send(body());
    expect((await hrAgent.post('/api/holidays').send(body())).status).toBe(409);
  });

  it('repeats a recurring holiday in later years but not earlier ones', async () => {
    await Holiday.create({ name: 'Republic Day', date: '2030-01-26', year: 2030, category: 'NATIONAL', recurring: true });
    const list = async (year: number) => (await hrAgent.get(`/api/holidays?year=${year}&scope=all`)).body.data.map((h: any) => h.occurrenceDate);
    expect(await list(2030)).toEqual(['2030-01-26']);
    expect(await list(2032)).toEqual(['2032-01-26']);
    expect(await list(2029)).toEqual([]);
  });

  it('prefers an explicit entry over a recurring copy of itself', async () => {
    await Holiday.create({ name: 'Day', date: '2030-01-26', year: 2030, category: 'NATIONAL', recurring: true });
    await Holiday.create({ name: 'Day', date: '2031-01-26', year: 2031, category: 'COMPANY' });
    const found = await holidayOccurrences('2031-01-01', '2031-12-31');
    expect(found).toHaveLength(1);
    expect(found[0].category).toBe('COMPANY');
  });

  it('skips a recurring 29 February in non-leap years', async () => {
    await Holiday.create({ name: 'Leap', date: '2028-02-29', year: 2028, category: 'CUSTOM', recurring: true });
    expect(await holidayOccurrences('2029-01-01', '2029-12-31')).toEqual([]);
    expect(await holidayOccurrences('2032-01-01', '2032-12-31')).toHaveLength(1);
  });

  it('shows employees only the holidays that apply to them', async () => {
    const mumbai = await makeLocation('Mumbai');
    const eng = await makeDepartment('Engineering');
    await Holiday.create({ name: 'Everyone', date: '2030-03-05', year: 2030, category: 'NATIONAL' });
    await Holiday.create({ name: 'Mumbai only', date: '2030-03-06', year: 2030, category: 'REGIONAL', locations: [mumbai] });
    await Holiday.create({ name: 'Engineering only', date: '2030-03-07', year: 2030, category: 'COMPANY', departments: [eng] });
    await Holiday.create({ name: 'Contractors only', date: '2030-03-08', year: 2030, category: 'COMPANY', employeeCategories: ['CONTRACT'] });
    const names = async (agent: Agent) => (await agent.get('/api/holidays?year=2030')).body.data.map((h: any) => h.name);
    expect(await names(empAgent)).toEqual(['Everyone']);
    const m = await makePerson({ location: mumbai, department: eng, category: 'CONTRACT' });
    expect(await names(await agentFor(m.email))).toEqual(['Everyone', 'Mumbai only', 'Engineering only', 'Contractors only']);
    // Asking for the whole calendar without the permission still shows only their own.
    expect((await empAgent.get('/api/holidays?year=2030&scope=all')).body.data.map((h: any) => h.name)).toEqual(['Everyone']);
  });

  it('copies the previous year, skipping recurring, duplicates and impossible dates', async () => {
    await Holiday.create({ name: 'Copy me', date: '2028-03-05', year: 2028, category: 'FESTIVAL' });
    await Holiday.create({ name: 'Leap', date: '2028-02-29', year: 2028, category: 'CUSTOM' });
    await Holiday.create({ name: 'Recurring', date: '2028-01-26', year: 2028, category: 'NATIONAL', recurring: true });
    const res = await hrAgent.post('/api/holidays/copy').send({ fromYear: 2028, toYear: 2029 });
    expect(res.body.data.copied).toBe(1);
    expect(res.body.data.skipped[0]).toMatch(/Leap/);
    const again = await hrAgent.post('/api/holidays/copy').send({ fromYear: 2028, toYear: 2029 });
    expect(again.body.data.copied).toBe(0);
    expect(await Holiday.countDocuments({ year: 2029 })).toBe(1);
  });

  it('imports from CSV, reporting the bad rows and keeping the good ones', async () => {
    await makeLocation('Mumbai');
    const csv = [
      'Name,Date,Category,Description,Location,Half Day,Recurring',
      'Holi,2030-03-20,Festival,Colours,Mumbai,no,no',
      'Eve,24/12/2030,company,,,yes,yes',
      ',2030-05-01,Festival,,,,',
      'Bad date,31-31-2030,Festival,,,,',
      'Bad category,2030-06-01,Nope,,,,',
      'Bad place,2030-07-01,Festival,,Atlantis,,',
    ].join('\n');
    const res = await hrAgent.post('/api/holidays/import').attach('file', Buffer.from(csv), { filename: 'h.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.errors.map((e: any) => e.path)).toEqual(['row 4', 'row 5', 'row 6', 'row 7']);
    const eve = await Holiday.findOne({ name: 'Eve' }).lean();
    expect(eve).toMatchObject({ date: '2030-12-24', isHalfDay: true, recurring: true, category: 'COMPANY' });
    expect((await Holiday.findOne({ name: 'Holi' }).lean())!.locations).toHaveLength(1);
  });

  it('rejects an import that is not a spreadsheet', async () => {
    const res = await hrAgent.post('/api/holidays/import').attach('file', Buffer.from('x'), { filename: 'h.exe', contentType: 'application/octet-stream' });
    expect(res.status).toBe(400);
  });

  it('exports the list', async () => {
    await Holiday.create({ name: 'Festival', date: '2030-03-05', year: 2030, category: 'FESTIVAL' });
    const res = await hrAgent.get('/api/holidays/export?year=2030&format=csv');
    expect(res.text).toContain('2030-03-05,Festival,FESTIVAL');
    expect((await empAgent.get('/api/holidays/export?year=2030')).status).toBe(403);
  });
});
