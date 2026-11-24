import { randomUUID } from 'crypto';
import { RequestHandler } from 'express';
import { CompOffRequest, CompOffTransaction } from '../models/CompOff';
import { Employee, IEmployee } from '../models/Employee';
import { refuseOwnRecord } from '../middleware/auth';
import { ctxOf } from '../services/audit';
import * as service from '../services/compoff';
import { companyToday } from '../services/settings';
import { notFound } from '../utils/errors';
import { created, escapeRegex, ok, pageMeta, pageOptions } from '../utils/http';

const withEmployee = <T>(query: T): T =>
  (query as any)
    .populate({ path: 'employee', select: 'employeeId fullName department', populate: { path: 'department', select: 'name' } })
    .populate('document', 'originalName mimeType size');

export const apply: RequestHandler = async (req, res) => {
  created(res, await service.applyCompOff(ctxOf(req), req.auth!.employeeId!, req.valid.body));
};

export const mine: RequestHandler = async (req, res) => {
  const employeeId = req.auth!.employeeId!;
  const [summary, requests, transactions] = await Promise.all([
    service.getCompOffSummary(employeeId, await companyToday()),
    CompOffRequest.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(50).populate('document', 'originalName').lean(),
    CompOffTransaction.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  ok(res, { summary, requests, transactions });
};

export const list: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.employee) filter.employee = q.employee;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    const ids = (await Employee.find({ $or: [{ fullName: rx }, { employeeId: rx }] }).select('_id').lean<IEmployee[]>()).map((e) => e._id);
    filter.employee = { $in: ids };
  }
  const { skip, limit, sort } = pageOptions(q, ['createdAt', 'workedDate', 'status'], 'createdAt');
  const [items, total] = await Promise.all([
    withEmployee(CompOffRequest.find(filter).sort(sort).skip(skip).limit(limit)).lean(),
    CompOffRequest.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q, total));
};

export const transactions: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = {};
  if (q.employee) filter.employee = q.employee;
  const { skip, limit, sort } = pageOptions(q, ['createdAt', 'expiresOn'], 'createdAt');
  const [items, total] = await Promise.all([
    CompOffTransaction.find(filter).sort(sort).skip(skip).limit(limit)
      .populate('employee', 'employeeId fullName')
      .populate('performedBy', 'email')
      .lean(),
    CompOffTransaction.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q, total));
};

export const employeeSummary: RequestHandler = async (req, res) => {
  const employee = await Employee.findById(req.valid.params.employeeId).select('_id').lean<IEmployee>();
  if (!employee) throw notFound('Employee');
  ok(res, await service.getCompOffSummary(employee._id, await companyToday()));
};

export const approve: RequestHandler = async (req, res) => {
  ok(res, await service.approveCompOff(ctxOf(req), req.valid.params.id, req.valid.body));
};

export const reject: RequestHandler = async (req, res) => {
  ok(res, await service.rejectCompOff(ctxOf(req), req.valid.params.id, req.valid.body.reason));
};

export const adjust: RequestHandler = async (req, res) => {
  refuseOwnRecord(req.auth!, req.valid.body.employee, 'You cannot add or remove your own Comp-Off. Ask another administrator.');
  const idempotencyKey = req.get('Idempotency-Key') ?? randomUUID();
  created(res, await service.adjustCompOff(ctxOf(req), { ...req.valid.body, idempotencyKey }));
};

export const setExpiry: RequestHandler = async (req, res) => {
  ok(res, await service.setLotExpiry(ctxOf(req), req.valid.params.id, req.valid.body.expiresOn));
};
