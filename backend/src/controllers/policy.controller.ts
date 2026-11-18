import { RequestHandler } from 'express';
import { PERMISSIONS } from '../constants';
import { can } from '../middleware/auth';
import { ApprovalWorkflow, ILeavePolicy, ILeaveType, LeavePolicy, LeaveType } from '../models/LeaveConfig';
import { audit, ctxOf } from '../services/audit';
import { companyToday } from '../services/settings';
import { notFound } from '../utils/errors';
import { created, ok } from '../utils/http';
import { withTransaction } from '../utils/transaction';

export const listTypes: RequestHandler = async (req, res) => {
  const filter = can(req.auth!, PERMISSIONS.LEAVE_POLICY_MANAGE) ? {} : { isActive: true };
  ok(res, await LeaveType.find(filter).sort({ name: 1 }).lean());
};

export const createType: RequestHandler = async (req, res) => {
  const today = await companyToday();
  const doc = await LeaveType.create({ effectiveFrom: today, ...req.valid.body });
  await audit(ctxOf(req), { action: 'LEAVE_TYPE_CREATED', entityType: 'LeaveType', entityId: doc._id, summary: `${doc.code} ${doc.name}`, after: req.valid.body });
  created(res, doc);
};

/** The superseded rule set is kept on the document, along with the date the new one takes effect. */
export const updateType: RequestHandler = async (req, res) => {
  const ctx = ctxOf(req);
  const today = await companyToday();
  const updated = await withTransaction(async (session) => {
    const before = await LeaveType.findById(req.valid.params.id).session(session).lean<ILeaveType>();
    if (!before) throw notFound('Leave type');
    const { _id, ...snapshot } = before;
    const doc = await LeaveType.findByIdAndUpdate(
      before._id,
      {
        $set: { ...req.valid.body, effectiveFrom: req.valid.body.effectiveFrom ?? today },
        $push: { history: { changedAt: new Date(), changedBy: ctx.auth?.userId, effectiveFrom: before.effectiveFrom, snapshot } },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean();
    await audit(ctx, { action: 'LEAVE_TYPE_UPDATED', entityType: 'LeaveType', entityId: before._id, summary: `${before.code} ${before.name}`, before: snapshot, after: req.valid.body }, session);
    return doc;
  });
  ok(res, updated);
};

export const listPolicies: RequestHandler = async (_req, res) => {
  ok(res, await LeavePolicy.find().sort({ name: 1 }).populate('departments', 'name').populate('locations', 'name').lean());
};

export const createPolicy: RequestHandler = async (req, res) => {
  const doc = await LeavePolicy.create(req.valid.body);
  await audit(ctxOf(req), { action: 'LEAVE_POLICY_CREATED', entityType: 'LeavePolicy', entityId: doc._id, summary: `${doc.name}, effective ${doc.effectiveFrom}`, after: req.valid.body });
  created(res, doc);
};

export const updatePolicy: RequestHandler = async (req, res) => {
  const before = await LeavePolicy.findById(req.valid.params.id).lean<ILeavePolicy>();
  if (!before) throw notFound('Leave policy');
  const doc = await LeavePolicy.findByIdAndUpdate(before._id, { $set: req.valid.body }, { returnDocument: 'after', runValidators: true }).lean();
  await audit(ctxOf(req), { action: 'LEAVE_POLICY_UPDATED', entityType: 'LeavePolicy', entityId: before._id, summary: before.name, before, after: req.valid.body });
  ok(res, doc);
};

export const listWorkflows: RequestHandler = async (_req, res) => {
  ok(res, await ApprovalWorkflow.find().sort({ isDefault: -1, name: 1 }).populate('leaveTypes', 'name code').lean());
};

/** Only one workflow can be the default, enforced by a partial unique index. */
async function saveWorkflow(id: string | null, body: Record<string, unknown>) {
  return withTransaction(async (session) => {
    if (body.isDefault) await ApprovalWorkflow.updateMany({ isDefault: true, _id: { $ne: id } }, { isDefault: false }, { session });
    if (id) {
      const doc = await ApprovalWorkflow.findByIdAndUpdate(id, { $set: body }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!doc) throw notFound('Workflow');
      return doc;
    }
    const [doc] = await ApprovalWorkflow.create([body], { session });
    return doc.toObject();
  });
}

export const createWorkflow: RequestHandler = async (req, res) => {
  const doc = await saveWorkflow(null, req.valid.body);
  await audit(ctxOf(req), { action: 'WORKFLOW_CREATED', category: 'SYSTEM', entityType: 'ApprovalWorkflow', entityId: doc._id, summary: doc.name, after: req.valid.body });
  created(res, doc);
};

export const updateWorkflow: RequestHandler = async (req, res) => {
  const doc = await saveWorkflow(req.valid.params.id, req.valid.body);
  await audit(ctxOf(req), { action: 'WORKFLOW_UPDATED', category: 'SYSTEM', entityType: 'ApprovalWorkflow', entityId: doc._id, summary: doc.name, after: req.valid.body });
  ok(res, doc);
};
