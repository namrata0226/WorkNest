import { RequestHandler, Response } from 'express';
import { HOLIDAY_CATEGORIES, HolidayCategory, PERMISSIONS } from '../constants';
import { can } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { Holiday, IHoliday } from '../models/Holiday';
import { Department, Location } from '../models/Org';
import { audit, ctxOf } from '../services/audit';
import { employeeHolidays, holidayOccurrences } from '../services/holiday';
import { buildReport } from '../services/report';
import { companyToday } from '../services/settings';
import { isDateOnly, monthDayOf, normalizeDateCell, yearOf, yearRange } from '../utils/dates';
import { badRequest, ErrorDetail, notFound } from '../utils/errors';
import { created, ok } from '../utils/http';
import { isDuplicateKeyError } from '../utils/transaction';
import { parseTabular, Table, toCsv, toXlsx } from '../utils/tabular';

export async function sendTable(res: Response, table: Table, format: 'csv' | 'xlsx') {
  const file = table.title.replace(/[^\w-]+/g, '_');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
    return res.send(toCsv(table));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
  return res.send(await toXlsx(table));
}

/** Everyone sees the holidays that apply to them. Holiday admins may ask for the whole calendar. */
export const list: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const auth = req.auth!;
  const year = q.year ?? yearOf(await companyToday());
  const { start, end } = yearRange(year);
  const wantsAll = q.scope === 'all' && can(auth, PERMISSIONS.HOLIDAYS_MANAGE);

  let occurrences;
  if (wantsAll || !auth.employeeId) {
    occurrences = await holidayOccurrences(start, end);
  } else {
    const employee = await Employee.findById(auth.employeeId).lean<IEmployee>();
    occurrences = employee ? await employeeHolidays(employee, start, end) : [];
  }
  if (q.category) occurrences = occurrences.filter((h) => h.category === q.category);
  ok(res, occurrences);
};

export const create_: RequestHandler = async (req, res) => {
  const body = req.valid.body;
  const doc = await Holiday.create({ ...body, year: yearOf(body.date) });
  await audit(ctxOf(req), { action: 'HOLIDAY_CREATED', entityType: 'Holiday', entityId: doc._id, summary: `${doc.name} on ${doc.date}` });
  created(res, doc);
};

export const update: RequestHandler = async (req, res) => {
  const body = req.valid.body;
  const before = await Holiday.findById(req.valid.params.id).lean<IHoliday>();
  if (!before) throw notFound('Holiday');
  const set = { ...body, ...(body.date ? { year: yearOf(body.date) } : {}) };
  const doc = await Holiday.findByIdAndUpdate(before._id, { $set: set }, { returnDocument: 'after', runValidators: true }).lean<IHoliday>();
  if (!doc) throw notFound('Holiday');
  await audit(ctxOf(req), {
    action: 'HOLIDAY_UPDATED', entityType: 'Holiday', entityId: before._id, summary: `${doc.name} on ${doc.date}`,
    before: { name: before.name, date: before.date, category: before.category }, after: body,
  });
  ok(res, doc);
};

export const remove: RequestHandler = async (req, res) => {
  const doc = await Holiday.findByIdAndDelete(req.valid.params.id).lean<IHoliday>();
  if (!doc) throw notFound('Holiday');
  await audit(ctxOf(req), { action: 'HOLIDAY_DELETED', entityType: 'Holiday', entityId: doc._id, summary: `${doc.name} on ${doc.date}`, before: doc });
  ok(res, { deleted: true });
};

const truthy = (v: unknown) => ['yes', 'true', '1', 'y'].includes(String(v ?? '').trim().toLowerCase());

export const importFile: RequestHandler = async (req, res) => {
  if (!req.file) throw badRequest('Attach a .csv or .xlsx file');
  const rows = await parseTabular(req.file.buffer, req.file.originalname);
  if (rows.length > 2000) throw badRequest('An import can hold at most 2000 rows');
  const [locations, departments] = await Promise.all([Location.find().lean(), Department.find().lean()]);
  const locId = new Map(locations.map((l) => [l.name.toLowerCase(), l._id]));
  const deptId = new Map(departments.map((d) => [d.name.toLowerCase(), d._id]));
  const errors: ErrorDetail[] = [];
  let createdCount = 0;

  for (const [index, row] of rows.entries()) {
    const path = `row ${index + 2}`;
    const name = String(row.name ?? row.holidayname ?? '').trim();
    const date = normalizeDateCell(row.date);
    const category = String(row.category ?? '').trim().toUpperCase();
    if (!name) { errors.push({ path, message: 'Holiday name is required' }); continue; }
    if (!date) { errors.push({ path, message: 'Date must be a date such as 2026-01-26' }); continue; }
    if (!(HOLIDAY_CATEGORIES as readonly string[]).includes(category)) { errors.push({ path, message: `Unknown category "${String(row.category ?? '')}"` }); continue; }

    const split = (v: unknown) => String(v ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const locs = split(row.location ?? row.locations);
    const depts = split(row.department ?? row.departments);
    const unknownLoc = locs.find((l) => !locId.has(l.toLowerCase()));
    const unknownDept = depts.find((d) => !deptId.has(d.toLowerCase()));
    if (unknownLoc) { errors.push({ path, message: `Unknown location "${unknownLoc}"` }); continue; }
    if (unknownDept) { errors.push({ path, message: `Unknown department "${unknownDept}"` }); continue; }

    try {
      await Holiday.create({
        name, date, category: category as HolidayCategory, year: yearOf(date),
        description: String(row.description ?? '').trim() || null,
        locations: locs.map((l) => locId.get(l.toLowerCase())!),
        departments: depts.map((d) => deptId.get(d.toLowerCase())!),
        employeeCategories: split(row.employeegroup ?? row.employeecategory).map((c) => c.toUpperCase()),
        isHalfDay: truthy(row.halfday ?? row.ishalfday),
        recurring: truthy(row.recurring),
      });
      createdCount++;
    } catch (err) {
      errors.push({ path, message: isDuplicateKeyError(err) ? `"${name}" already exists on ${date}` : 'The row could not be saved' });
    }
  }
  await audit(ctxOf(req), { action: 'HOLIDAYS_IMPORTED', entityType: 'Holiday', summary: `${createdCount} of ${rows.length} rows imported` });
  ok(res, { total: rows.length, created: createdCount, errors });
};

/** Moves each holiday to the same month and day. Recurring ones already repeat, so they are skipped. */
export const copyYear: RequestHandler = async (req, res) => {
  const { fromYear, toYear } = req.valid.body;
  const source = await Holiday.find({ year: fromYear, recurring: false }).lean<IHoliday[]>();
  let copied = 0;
  const skipped: string[] = [];
  for (const h of source) {
    const date = `${toYear}-${monthDayOf(h.date)}`;
    if (!isDateOnly(date)) { skipped.push(`${h.name} (${h.date} does not exist in ${toYear})`); continue; }
    const { _id, createdAt, updatedAt, ...rest } = h as IHoliday & { createdAt?: Date; updatedAt?: Date };
    try {
      await Holiday.create({ ...rest, date, year: toYear });
      copied++;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      skipped.push(`${h.name} (already on ${date})`);
    }
  }
  await audit(ctxOf(req), { action: 'HOLIDAYS_COPIED', entityType: 'Holiday', summary: `${copied} holidays copied from ${fromYear} to ${toYear}` });
  ok(res, { copied, skipped });
};

export const exportList: RequestHandler = async (req, res) => {
  const { year, format } = req.valid.query;
  const table = await buildReport('holidays', { year: year ?? yearOf(await companyToday()) });
  await sendTable(res, table, format);
};
