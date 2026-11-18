import { model, Schema, Types } from 'mongoose';
import { LEDGER_TYPES, LedgerType } from '../constants';

/**
 * Per employee, leave type and year projection of the ledger. `available` always equals
 * the sum of the matching leaveTransactions amounts; see reconcileBalance.
 */
export interface ILeaveBalance {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  leaveType: Types.ObjectId;
  year: number;
  openingBalance: number;
  entitlement: number;
  credited: number;
  used: number;
  reserved: number;
  carryForward: number;
  expired: number;
  adjustments: number;
  available: number;
}

const balanceSchema = new Schema<ILeaveBalance>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true },
    openingBalance: { type: Number, default: 0 },
    entitlement: { type: Number, default: 0 },
    credited: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    carryForward: { type: Number, default: 0 },
    expired: { type: Number, default: 0 },
    adjustments: { type: Number, default: 0 },
    available: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'leaveBalances' },
);
balanceSchema.index({ employee: 1, leaveType: 1, year: 1 }, { unique: true });
balanceSchema.index({ year: 1, leaveType: 1 });

export const LeaveBalance = model<ILeaveBalance>('LeaveBalance', balanceSchema);

export interface ILeaveTransaction {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  leaveType: Types.ObjectId;
  year: number;
  type: LedgerType;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  leaveRequest: Types.ObjectId | null;
  performedBy: Types.ObjectId | null;
  /** Unique: replaying an operation can never post the same movement twice. */
  idempotencyKey: string | null;
  createdAt: Date;
}

const txSchema = new Schema<ILeaveTransaction>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    reason: { type: String, default: null },
    leaveRequest: { type: Schema.Types.ObjectId, ref: 'LeaveRequest', default: null },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'leaveTransactions' },
);
txSchema.index({ employee: 1, leaveType: 1, year: 1, createdAt: -1 });
txSchema.index({ leaveRequest: 1 });
txSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const LeaveTransaction = model<ILeaveTransaction>('LeaveTransaction', txSchema);
