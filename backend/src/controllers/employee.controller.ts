import { RequestHandler } from 'express';
import { PERMISSIONS, ROLES } from '../constants';
import { can, refuseOwnRecord } from '../middleware/auth';
import { Employee, IEmployee } from '../models/Employee';
import { Department, Location } from '../models/Org';
import { ctxOf, audit } from '../services/audit';
import { createPasswordLink } from '../services/auth';
import { emailConfigured, sendEmail } from '../services/email';
import * as service from '../services/employee';
import { badRequest, notFound } from '../utils/errors';
import { created, escapeRegex, ok, pageMeta, pageOptions } from '../utils/http';
import { parseTabular } from '../utils/tabular';

const SORTABLE = ['employeeId', 'fullName', 'joiningDate', 'createdAt', 'employmentStatus'];

const populateEmployee = <T>(query: T): T =>
  (query as any)
    .populate('department', 'name')
    .populate('location', 'name')
    .populate('reportingManager', 'fullName employeeId')
    .populate('leavePolicy', 'name');

export const list: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = {};
  if (q.department) filter.department = q.department;
  if (q.location) filter.location = q.location;
  if (q.status) filter.employmentStatus = q.status;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ fullName: rx }, { employeeId: rx }, { email: rx }];
  }
  const { skip, limit, sort } = pageOptions(q, SORTABLE, 'fullName');
  const [items, total] = await Promise.all([
    populateEmployee(Employee.find(filter).sort(sort).skip(skip).limit(limit)).lean(),
    Employee.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q, total));
};

/** Employees can read their own profile; a mismatched id reads as not found rather than forbidden. */
export const getOne: RequestHandler = async (req, res) => {
  const auth = req.auth!;
  const { id } = req.valid.params;
  const isSelf = auth.employeeId && String(auth.employeeId) === id;
  if (!isSelf && !can(auth, PERMISSIONS.EMPLOYEES_READ)) throw notFound('Employee');
  const employee = await populateEmployee(Employee.findById(id)).lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  ok(res, employee);
};

export const create: RequestHandler = async (req, res) => {
  created(res, await service.createEmployee(ctxOf(req), req.valid.body));
};

/** HR cannot change their own gender, policy, manager or dates, which decide their leave. A Super Admin is the top of the chain and may. */
export const update: RequestHandler = async (req, res) => {
  if (req.auth!.role !== ROLES.SUPER_ADMIN) refuseOwnRecord(req.auth!, req.valid.params.id, 'You cannot change your own employee record. Ask another administrator, or edit your name and phone under My account.');
  ok(res, await service.updateEmployee(ctxOf(req), req.valid.params.id, req.valid.body));
};

/** The id comes from the session, never the request, so this can only ever change the caller. */
export const updateOwnProfile: RequestHandler = async (req, res) => {
  ok(res, await service.updateEmployee(ctxOf(req), String(req.auth!.employeeId), req.valid.body));
};

export const setStatus: RequestHandler = async (req, res) => {
  ok(res, await service.setEmployeeStatus(ctxOf(req), req.valid.params.id, req.valid.body.status));
};

export const importFile: RequestHandler = async (req, res) => {
  if (!req.file) throw badRequest('Attach a .csv or .xlsx file');
  const rows = await parseTabular(req.file.buffer, req.file.originalname);
  ok(res, await service.importEmployees(ctxOf(req), rows));
};

export const sendActivation: RequestHandler = async (req, res) => {
  const employee = await Employee.findById(req.valid.params.id).lean<IEmployee>();
  if (!employee?.user) throw notFound('Employee account');
  const link = await createPasswordLink(employee.user, 'ACTIVATION');
  const sent = await sendEmail({ to: employee.email, subject: 'Set your WorkNest password', text: `Set your password with this link, which works once and expires in 72 hours:\n\n${link}`, devLink: link });
  await audit(ctxOf(req), { action: 'ACTIVATION_LINK_ISSUED', category: 'SECURITY', entityType: 'Employee', entityId: employee._id, summary: employee.email });
  ok(res, { emailed: sent, activationLink: sent || emailConfigured() ? null : link });
};

export const listDepartments: RequestHandler = async (_req, res) => ok(res, await Department.find().sort({ name: 1 }).lean());
export const listLocations: RequestHandler = async (_req, res) => ok(res, await Location.find().sort({ name: 1 }).lean());

export const createDepartment: RequestHandler = async (req, res) => {
  const doc = await Department.create(req.valid.body);
  await audit(ctxOf(req), { action: 'TEAM_CREATED', entityType: 'Team', entityId: doc._id, summary: doc.name });
  created(res, doc);
};

export const updateDepartment: RequestHandler = async (req, res) => {
  const doc = await Department.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: 'after', runValidators: true }).lean();
  if (!doc) throw notFound('Team');
  await audit(ctxOf(req), { action: 'TEAM_UPDATED', entityType: 'Team', entityId: doc._id, summary: doc.name, after: req.valid.body });
  ok(res, doc);
};

export const createLocation: RequestHandler = async (req, res) => {
  const doc = await Location.create(req.valid.body);
  await audit(ctxOf(req), { action: 'LOCATION_CREATED', entityType: 'Location', entityId: doc._id, summary: doc.name });
  created(res, doc);
};

export const updateLocation: RequestHandler = async (req, res) => {
  const doc = await Location.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: 'after', runValidators: true }).lean();
  if (!doc) throw notFound('Location');
  await audit(ctxOf(req), { action: 'LOCATION_UPDATED', entityType: 'Location', entityId: doc._id, summary: doc.name, after: req.valid.body });
  ok(res, doc);
};
