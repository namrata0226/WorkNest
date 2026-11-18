import { model, Schema, Types } from 'mongoose';
import { ApproverType, APPROVER_TYPES, DAY_TYPES, HALF_SESSIONS, HalfSession, LEAVE_STATUS_VALUES, LeaveStatus } from '../constants';

export interface DayValue {
  date: string;
  value: number;
}

export interface ApprovalStep {
  order: number;
  approverType: ApproverType;
  label: string;
  status: 'WAITING' | 'APPROVED' | 'REJECTED';
  actedBy: Types.ObjectId | null;
  actedByName: string | null;
  comment: string | null;
  actedAt: Date | null;
}

export interface IAllocation {
  lot: Types.ObjectId;
  amount: number;
}

export interface ILeaveRequest {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  leaveType: Types.ObjectId;
  startDate: string;
  endDate: string;
  dayType: (typeof DAY_TYPES)[number];
  halfSession: HalfSession | null;
  reason: string | null;
  handoverNotes: string | null;
  document: Types.ObjectId | null;
  totalDays: number;
  dayBreakdown: DayValue[];
  status: LeaveStatus;
  approvalSteps: ApprovalStep[];
  currentStep: number;
  currentApproverType: ApproverType | null;
  rejectionReason: string | null;
  decidedBy: Types.ObjectId | null;
  decidedAt: Date | null;
  /** Held per leave year while pending. Kept apart from `deductions`, which are confirmed. */
  reservations: { year: number; amount: number }[];
  deductions: { year: number; amount: number }[];
  compOffAllocations: IAllocation[];
  compOffAllocationState: 'NONE' | 'RESERVED' | 'CONSUMED';
  cancellationReason: string | null;
  cancellationRequestedAt: Date | null;
  cancellationDecisionComment: string | null;
  cancellationDecidedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  idempotencyKey: string | null;
  /** The Out of office event in the employee's Outlook calendar, once created. */
  outlookEventId: string | null;
  outlookSyncError: 'MAILBOX_NOT_FOUND' | 'REQUEST_REJECTED' | null;
  createdAt: Date;
  updatedAt: Date;
}

const amountByYear = { _id: false, year: Number, amount: Number };

const schema = new Schema<ILeaveRequest>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    dayType: { type: String, enum: DAY_TYPES, default: 'FULL' },
    halfSession: { type: String, enum: [...HALF_SESSIONS, null], default: null },
    reason: { type: String, default: null, trim: true, maxlength: 1000 },
    handoverNotes: { type: String, default: null, maxlength: 2000 },
    document: { type: Schema.Types.ObjectId, ref: 'StoredFile', default: null },
    totalDays: { type: Number, required: true, min: 0.5 },
    dayBreakdown: { type: [{ _id: false, date: String, value: Number }], required: true },
    status: { type: String, enum: LEAVE_STATUS_VALUES, default: 'PENDING', required: true },
    approvalSteps: {
      type: [{
        _id: false,
        order: Number,
        approverType: { type: String, enum: APPROVER_TYPES },
        label: String,
        status: { type: String, enum: ['WAITING', 'APPROVED', 'REJECTED'], default: 'WAITING' },
        actedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        actedByName: { type: String, default: null },
        comment: { type: String, default: null },
        actedAt: { type: Date, default: null },
      }],
      default: [],
    },
    currentStep: { type: Number, default: 0 },
    currentApproverType: { type: String, enum: [...APPROVER_TYPES, null], default: null },
    rejectionReason: { type: String, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    reservations: { type: [amountByYear], default: [] },
    deductions: { type: [amountByYear], default: [] },
    compOffAllocations: { type: [{ _id: false, lot: { type: Schema.Types.ObjectId, ref: 'CompOffTransaction' }, amount: Number }], default: [] },
    compOffAllocationState: { type: String, enum: ['NONE', 'RESERVED', 'CONSUMED'], default: 'NONE' },
    cancellationReason: { type: String, default: null },
    cancellationRequestedAt: { type: Date, default: null },
    cancellationDecisionComment: { type: String, default: null },
    cancellationDecidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    idempotencyKey: { type: String, default: null },
    outlookEventId: { type: String, default: null },
    outlookSyncError: { type: String, enum: ['MAILBOX_NOT_FOUND', 'REQUEST_REJECTED', null], default: null },
  },
  { timestamps: true, collection: 'leaveRequests' },
);
schema.index({ employee: 1, startDate: 1, endDate: 1 });
schema.index({ status: 1, startDate: 1, endDate: 1 });
schema.index({ startDate: 1, endDate: 1 });
schema.index({ employee: 1, createdAt: -1 });
schema.index({ status: 1, currentApproverType: 1, createdAt: 1 });
schema.index({ 'dayBreakdown.date': 1, status: 1 });
schema.index({ status: 1, outlookEventId: 1 }, { partialFilterExpression: { outlookEventId: { $type: 'string' } } });
schema.index(
  { employee: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const LeaveRequest = model<ILeaveRequest>('LeaveRequest', schema);
