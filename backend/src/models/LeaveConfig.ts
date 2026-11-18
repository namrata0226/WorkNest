import { model, Schema, Types } from 'mongoose';
import { APPROVER_TYPES, ApproverType, EMPLOYEE_CATEGORIES, EMPLOYEE_GENDERS, LEAVE_KINDS, LeaveKind } from '../constants';

/** The rule fields a leave type defines and a policy may override. */
export interface LeaveRule {
  isPaid: boolean;
  annualEntitlement: number;
  monthlyAccrual: number;
  prorateOnJoining: boolean;
  carryForward: boolean;
  maxCarryForward: number;
  carryForwardExpiryDays: number | null;
  minDuration: number;
  maxDuration: number | null;
  halfDayAllowed: boolean;
  requiresDocument: boolean;
  documentRequiredAfterDays: number | null;
  minNoticeDays: number;
  allowPastDates: boolean;
  maxPastDays: number;
  validateBalance: boolean;
  allowNegative: boolean;
  maxNegative: number | null;
  requiresApproval: boolean;
  applicableCategories: string[];
}

export interface ILeaveType extends LeaveRule {
  _id: Types.ObjectId;
  name: string;
  code: string;
  kind: LeaveKind;
  /** Granted for a life event, such as maternity, so it is not part of the yearly allowance total. */
  eventBased: boolean;
  /** Empty means everyone. Set on the type only, so a policy cannot widen it. */
  applicableGenders: string[];
  /** Applications allowed per calendar month, counted by start date. Null means no limit. */
  maxRequestsPerMonth: number | null;
  description: string | null;
  color: string;
  isActive: boolean;
  effectiveFrom: string;
  history: { changedAt: Date; changedBy: Types.ObjectId | null; effectiveFrom: string; snapshot: Record<string, unknown> }[];
  createdAt: Date;
  updatedAt: Date;
}

const typeSchema = new Schema<ILeaveType>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    kind: { type: String, enum: LEAVE_KINDS, default: 'STANDARD' },
    eventBased: { type: Boolean, default: false },
    applicableGenders: { type: [String], enum: EMPLOYEE_GENDERS, default: [] },
    maxRequestsPerMonth: { type: Number, default: null, min: 1 },
    description: { type: String, default: null },
    color: { type: String, default: '#0f766e', match: /^#[0-9a-fA-F]{6}$/ },
    isPaid: { type: Boolean, default: true },
    annualEntitlement: { type: Number, default: 0, min: 0 },
    monthlyAccrual: { type: Number, default: 0, min: 0 },
    prorateOnJoining: { type: Boolean, default: true },
    carryForward: { type: Boolean, default: false },
    maxCarryForward: { type: Number, default: 0, min: 0 },
    carryForwardExpiryDays: { type: Number, default: null },
    minDuration: { type: Number, default: 0.5, min: 0 },
    maxDuration: { type: Number, default: null },
    halfDayAllowed: { type: Boolean, default: true },
    requiresDocument: { type: Boolean, default: false },
    documentRequiredAfterDays: { type: Number, default: null },
    minNoticeDays: { type: Number, default: 0, min: 0 },
    allowPastDates: { type: Boolean, default: false },
    maxPastDays: { type: Number, default: 0, min: 0 },
    validateBalance: { type: Boolean, default: true },
    allowNegative: { type: Boolean, default: false },
    maxNegative: { type: Number, default: null },
    requiresApproval: { type: Boolean, default: true },
    applicableCategories: { type: [String], enum: EMPLOYEE_CATEGORIES, default: [] },
    isActive: { type: Boolean, default: true },
    effectiveFrom: { type: String, required: true },
    history: {
      type: [{ _id: false, changedAt: Date, changedBy: Schema.Types.ObjectId, effectiveFrom: String, snapshot: Schema.Types.Mixed }],
      default: [],
      select: false,
    },
  },
  { timestamps: true, collection: 'leaveTypes' },
);
typeSchema.index({ kind: 1, isActive: 1 });

export const LeaveType = model<ILeaveType>('LeaveType', typeSchema);

export interface PolicyRule extends Partial<LeaveRule> {
  leaveType: Types.ObjectId;
  isAllowed?: boolean;
}

export interface ILeavePolicy {
  _id: Types.ObjectId;
  name: string;
  description: string | null;
  departments: Types.ObjectId[];
  locations: Types.ObjectId[];
  designations: string[];
  categories: string[];
  rules: PolicyRule[];
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

const ruleSchema = new Schema<PolicyRule>(
  {
    leaveType: { type: Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    isAllowed: Boolean,
    isPaid: Boolean,
    annualEntitlement: { type: Number, min: 0 },
    monthlyAccrual: { type: Number, min: 0 },
    prorateOnJoining: Boolean,
    carryForward: Boolean,
    maxCarryForward: { type: Number, min: 0 },
    carryForwardExpiryDays: Number,
    minDuration: { type: Number, min: 0 },
    maxDuration: Number,
    halfDayAllowed: Boolean,
    requiresDocument: Boolean,
    documentRequiredAfterDays: Number,
    minNoticeDays: { type: Number, min: 0 },
    allowPastDates: Boolean,
    maxPastDays: { type: Number, min: 0 },
    validateBalance: Boolean,
    allowNegative: Boolean,
    maxNegative: Number,
    requiresApproval: Boolean,
  },
  { _id: false },
);

const policySchema = new Schema<ILeavePolicy>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: null },
    departments: [{ type: Schema.Types.ObjectId, ref: 'Department' }],
    locations: [{ type: Schema.Types.ObjectId, ref: 'Location' }],
    designations: { type: [String], default: [] },
    categories: { type: [String], default: [] },
    rules: { type: [ruleSchema], default: [] },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'leavePolicies' },
);
policySchema.index({ isActive: 1, effectiveFrom: 1 });

export const LeavePolicy = model<ILeavePolicy>('LeavePolicy', policySchema);

export interface IEmployeeLeavePolicy {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  policy: Types.ObjectId;
  effectiveFrom: string;
  effectiveTo: string | null;
  assignedBy: Types.ObjectId | null;
}

const assignmentSchema = new Schema<IEmployeeLeavePolicy>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    policy: { type: Schema.Types.ObjectId, ref: 'LeavePolicy', required: true },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'employeeLeavePolicies' },
);
assignmentSchema.index({ employee: 1, effectiveFrom: -1 });

export const EmployeeLeavePolicy = model<IEmployeeLeavePolicy>('EmployeeLeavePolicy', assignmentSchema);

export interface WorkflowStep {
  order: number;
  approverType: ApproverType;
  label: string;
}

export interface IApprovalWorkflow {
  _id: Types.ObjectId;
  name: string;
  steps: WorkflowStep[];
  leaveTypes: Types.ObjectId[];
  isDefault: boolean;
  isActive: boolean;
}

const workflowSchema = new Schema<IApprovalWorkflow>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    steps: {
      type: [{ _id: false, order: { type: Number, required: true }, approverType: { type: String, enum: APPROVER_TYPES, required: true }, label: { type: String, default: '' } }],
      required: true,
    },
    leaveTypes: [{ type: Schema.Types.ObjectId, ref: 'LeaveType' }],
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'approvalWorkflows' },
);
workflowSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

export const ApprovalWorkflow = model<IApprovalWorkflow>('ApprovalWorkflow', workflowSchema);
