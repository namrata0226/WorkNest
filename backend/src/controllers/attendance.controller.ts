import { RequestHandler } from 'express';
import * as service from '../services/attendance';
import { ctxOf } from '../services/audit';
import { getSettings } from '../services/settings';
import { todayIn } from '../utils/dates';
import { created, ok, pageMeta, pageOptions } from '../utils/http';
import { WfhRequest } from '../models/Attendance';

const defaultMonth = async () => todayIn((await getSettings()).timezone).slice(0, 7);

export const myMonth: RequestHandler = async (req, res) => {
  ok(res, await service.employeeMonth(req.auth!.employeeId!, req.valid.query.month ?? await defaultMonth()));
};
export const myToday: RequestHandler = async (req, res) => ok(res, await service.todayAttendance(req.auth!.employeeId!));
export const punchIn: RequestHandler = async (req, res) => ok(res, await service.punchIn(ctxOf(req)));
export const punchOut: RequestHandler = async (req, res) => ok(res, await service.punchOut(ctxOf(req)));

export const daily: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const date = q.date ?? todayIn((await getSettings()).timezone);
  const result = await service.dailyAttendance({ date, department: q.department, search: q.search });
  const { skip, limit } = pageOptions(q, [], 'date');
  ok(res, { ...result, rows: result.rows.slice(skip, skip + limit) }, pageMeta(q, result.rows.length));
};

export const employeeMonth: RequestHandler = async (req, res) => {
  ok(res, await service.employeeMonth(req.valid.params.employeeId, req.valid.query.month ?? await defaultMonth()));
};

export const correct: RequestHandler = async (req, res) => {
  ok(res, await service.correctAttendance(ctxOf(req), req.valid.params.employeeId, req.valid.params.date, req.valid.body));
};

export const applyWfh: RequestHandler = async (req, res) => created(res, await service.applyWfh(ctxOf(req), req.valid.body));

export const myWfh: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter = { employee: req.auth!.employeeId };
  const { skip, limit } = pageOptions(q, [], 'createdAt');
  const [items, total] = await Promise.all([WfhRequest.find(filter).sort({ startDate: -1 }).skip(skip).limit(limit).lean(), WfhRequest.countDocuments(filter)]);
  ok(res, items, pageMeta(q, total));
};

export const pendingWfh: RequestHandler = async (req, res) => ok(res, await service.pendingWfh(req.auth!));
export const approveWfh: RequestHandler = async (req, res) => ok(res, await service.approveWfh(ctxOf(req), req.valid.params.id));
export const rejectWfh: RequestHandler = async (req, res) => ok(res, await service.rejectWfh(ctxOf(req), req.valid.params.id, req.valid.body.reason));
export const cancelWfh: RequestHandler = async (req, res) => ok(res, await service.cancelWfh(ctxOf(req), req.valid.params.id));
