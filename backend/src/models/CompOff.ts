import { model, Schema, Types } from 'mongoose';
import { COMPOFF_REQUEST_STATUS, COMPOFF_TX_TYPES, CompOffTxType, DAY_TYPES } from '../constants';

export interface ICompOffRequest {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  workedDate: string;
  dayType: (typeof DAY_TYPES)[number];
  amount: number;
  reason: string;
  occasion: string;
  document: Types.ObjectId | null;
  status: (typeof COMPOFF_REQUEST_STATUS)[number];
  expiresOn: string | null;
  decidedBy: Types.ObjectId | null;
  decidedAt: Date | null;
  decisionComment: string | null;
  createdAt: Date;
}

const requestSchema = new Schema<ICompOffRequest>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    workedDate: { type: String, required: true },
    dayType: { type: String, enum: DAY_TYPES, default: 'FULL' },
    amount: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    occasion: { type: String, required: true },
    document: { type: Schema.Types.ObjectId, ref: 'StoredFile', default: null },
    status: { type: String, enum: COMPOFF_REQUEST_STATUS, default: 'PENDING' },
    expiresOn: { type: String, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionComment: { type: String, default: null },
  },
  { timestamps: true, collection: 'compOffRequests' },
);
requestSchema.index({ status: 1, createdAt: 1 });
requestSchema.index({ employee: 1, createdAt: -1 });
requestSchema.index(
  { employee: 1, workedDate: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'APPROVED'] } } },
);

export const CompOffRequest = model<ICompOffRequest>('CompOffRequest', requestSchema);

/**
 * Append-only ledger. CREDIT rows are also lots: their lot fields track how much of the
 * credit is left, so each debit is traceable to the credit it consumed and its expiry.
 */
export interface ICompOffTransaction {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  type: CompOffTxType;
  amount: number;
  reason: string | null;
  earnedDate: string | null;
  expiresOn: string | null;
  remaining: number;
  reserved: number;
  used: number;
  expired: number;
  adjustedOut: number;
  allocations: { lot: Types.ObjectId; amount: number }[];
  compOffRequest: Types.ObjectId | null;
  leaveRequest: Types.ObjectId | null;
  performedBy: Types.ObjectId | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

const txSchema = new Schema<ICompOffTransaction>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, enum: COMPOFF_TX_TYPES, required: true },
    amount: { type: Number, required: true },
    reason: { type: String, default: null },
    earnedDate: { type: String, default: null },
    expiresOn: { type: String, default: null },
    remaining: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    used: { type: Number, default: 0, min: 0 },
    expired: { type: Number, default: 0, min: 0 },
    adjustedOut: { type: Number, default: 0, min: 0 },
    allocations: { type: [{ _id: false, lot: { type: Schema.Types.ObjectId, ref: 'CompOffTransaction' }, amount: Number }], default: [] },
    compOffRequest: { type: Schema.Types.ObjectId, ref: 'CompOffRequest', default: null },
    leaveRequest: { type: Schema.Types.ObjectId, ref: 'LeaveRequest', default: null },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'compOffTransactions' },
);
txSchema.index({ employee: 1, type: 1, expiresOn: 1 });
txSchema.index({ type: 1, expiresOn: 1, remaining: 1 });
txSchema.index({ employee: 1, createdAt: -1 });
txSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const CompOffTransaction = model<ICompOffTransaction>('CompOffTransaction', txSchema);
