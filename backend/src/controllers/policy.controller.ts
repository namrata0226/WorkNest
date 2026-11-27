import { RequestHandler } from 'express';
import { LedgerType, PERMISSIONS } from '../constants';
import { can } from '../middleware/auth';
import { ApprovalWorkflow, ILeavePolicy, ILeaveType, LeavePolicy, LeaveType } from '../models/LeaveConfig';
import { LeaveBalance, LeaveTransaction } from '../models/LeaveLedger';
import { LeaveRequest } from '../models/LeaveRequest';
import { audit, ctxOf } from '../services/audit';
import { companyToday } from '../services/settings';
import { AppError, notFound } from '../utils/errors';
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

/** Ledger rows the system writes on its own. Anything else means a person used or adjusted this type. */
const AUTOMATIC_LEDGER: LedgerType[] = ['ENTITLEMENT', 'ACCRUAL', 'CARRY_FORWARD', 'EXPIRY'];

/**
 * Removes a leave type that was never used, along with its automatic balances and any policy or workflow rules for it.
 * A type with leave history is refused, because past applications and reports still show its name: it can be made inactive instead.
 */
export const deleteType: RequestHandler = async (req, res) => {
  const ctx = ctxOf(req);
  await withTransaction(async (session) => {
    const type = await LeaveType.findById(req.valid.params.id).session(session).lean<ILeaveType>();
    if (!type) throw notFound('Leave type');
    // One session runs one operation at a time, so these are sequential.
    const applications = await LeaveRequest.countDocuments({ leaveType: type._id }).session(session);
    const entries = await LeaveTransaction.countDocuments({ leaveType: type._id, type: { $nin: AUTOMATIC_LEDGER } }).session(session);
    if (applications || entries) {
      const what = applications ? `${applications} leave application${applications === 1 ? '' : 's'}` : `${entries} balance adjustment${entries === 1 ? '' : 's'}`;
      throw new AppError(409, 'LEAVE_TYPE_IN_USE', `${type.name} cannot be deleted because it has ${what}. Mark it inactive instead, so nobody can apply for it and past records keep its name.`, undefined, { applications, entries });
    }
    await LeaveBalance.deleteMany({ leaveType: type._id }, { session });
    await LeaveTransaction.deleteMany({ leaveType: type._id }, { session });
    await LeavePolicy.updateMany({ 'rules.leaveType': type._id }, { $pull: { rules: { leaveType: type._id } } }, { session });
    await ApprovalWorkflow.updateMany({ leaveTypes: type._id }, { $pull: { leaveTypes: type._id } }, { session });
    await LeaveType.deleteOne({ _id: type._id }, { session });
    const { _id, ...snapshot } = type;
    await audit(ctx, { action: 'LEAVE_TYPE_DELETED', entityType: 'LeaveType', entityId: type._id, summary: `${type.code} ${type.name}`, before: snapshot }, session);
  });
  ok(res, { deleted: true });
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
