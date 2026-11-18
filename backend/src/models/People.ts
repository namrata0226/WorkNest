import { model, Schema, Types } from 'mongoose';
import { EMAIL_ACTION_KINDS, EmailActionKind } from '../constants';

/** One-time link behind the Approve and Reject buttons in an email. Only a hash is kept, as with password links. */
export interface IEmailActionToken {
  _id: Types.ObjectId;
  tokenHash: string;
  user: Types.ObjectId;
  kind: EmailActionKind;
  target: Types.ObjectId;
  usedAt: Date | null;
  expiresAt: Date;
}
const emailActionSchema = new Schema<IEmailActionToken>(
  {
    tokenHash: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: EMAIL_ACTION_KINDS, required: true },
    target: { type: Schema.Types.ObjectId, required: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'emailActionTokens' },
);
emailActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });
export const EmailActionToken = model<IEmailActionToken>('EmailActionToken', emailActionSchema);

export interface IEmployeeDetails {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  bank: { holderName: string; bankName: string; ifsc: string; accountEncrypted: string; accountLast4: string } | null;
  emergencyContacts: { name: string; relationship: string; phone: string }[];
  address: string | null;
}
const detailsSchema = new Schema<IEmployeeDetails>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, unique: true },
    bank: {
      type: new Schema({ holderName: String, bankName: String, ifsc: String, accountEncrypted: String, accountLast4: String }, { _id: false }),
      default: null,
    },
    emergencyContacts: { type: [{ _id: false, name: String, relationship: String, phone: String }], default: [] },
    address: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true, collection: 'employeeDetails' },
);
export const EmployeeDetails = model<IEmployeeDetails>('EmployeeDetails', detailsSchema);

export const CHECKLIST_KINDS = ['ONBOARDING', 'EXIT'] as const;
export const CHECKLIST_OWNERS = ['HR', 'EMPLOYEE'] as const;
export interface IChecklistItem { _id: Types.ObjectId; label: string; owner: (typeof CHECKLIST_OWNERS)[number]; done: boolean; doneByName: string | null; doneAt: Date | null }
export interface IChecklist {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  kind: (typeof CHECKLIST_KINDS)[number];
  items: IChecklistItem[];
  createdAt: Date;
}
const checklistSchema = new Schema<IChecklist>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    kind: { type: String, enum: CHECKLIST_KINDS, required: true },
    items: {
      type: [{ label: { type: String, required: true, maxlength: 200 }, owner: { type: String, enum: CHECKLIST_OWNERS, default: 'HR' }, done: { type: Boolean, default: false }, doneByName: { type: String, default: null }, doneAt: { type: Date, default: null } }],
      default: [],
    },
  },
  { timestamps: true, collection: 'checklists' },
);
checklistSchema.index({ employee: 1, kind: 1 }, { unique: true });
export const Checklist = model<IChecklist>('Checklist', checklistSchema);

export const EXPENSE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'] as const;
export const EXPENSE_CATEGORIES = ['TRAVEL', 'FOOD', 'ACCOMMODATION', 'SUPPLIES', 'INTERNET_PHONE', 'OTHER'] as const;
export interface IExpenseClaim {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  category: (typeof EXPENSE_CATEGORIES)[number];
  expenseDate: string;
  amount: number;
  description: string;
  receipt: Types.ObjectId | null;
  status: (typeof EXPENSE_STATUSES)[number];
  decidedBy: Types.ObjectId | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
  paidAt: Date | null;
  createdAt: Date;
}
const expenseSchema = new Schema<IExpenseClaim>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    expenseDate: { type: String, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    description: { type: String, required: true, trim: true, maxlength: 1000 },
    receipt: { type: Schema.Types.ObjectId, ref: 'StoredFile', default: null },
    status: { type: String, enum: EXPENSE_STATUSES, default: 'PENDING', required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'expenseClaims' },
);
expenseSchema.index({ employee: 1, createdAt: -1 });
expenseSchema.index({ status: 1, createdAt: 1 });
expenseSchema.index({ receipt: 1 }, { partialFilterExpression: { receipt: { $type: 'objectId' } } });
export const ExpenseClaim = model<IExpenseClaim>('ExpenseClaim', expenseSchema);

export const ANNOUNCEMENT_KINDS = ['ANNOUNCEMENT', 'POLICY'] as const;
export interface IAnnouncement {
  _id: Types.ObjectId;
  kind: (typeof ANNOUNCEMENT_KINDS)[number];
  title: string;
  body: string;
  document: Types.ObjectId | null;
  requiresAck: boolean;
  publishedBy: Types.ObjectId;
  publishedByName: string;
  createdAt: Date;
}
const announcementSchema = new Schema<IAnnouncement>(
  {
    kind: { type: String, enum: ANNOUNCEMENT_KINDS, default: 'ANNOUNCEMENT' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 10_000 },
    document: { type: Schema.Types.ObjectId, ref: 'StoredFile', default: null },
    requiresAck: { type: Boolean, default: false },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedByName: { type: String, required: true },
  },
  { timestamps: true, collection: 'announcements' },
);
announcementSchema.index({ createdAt: -1 });
announcementSchema.index({ document: 1 }, { partialFilterExpression: { document: { $type: 'objectId' } } });
export const Announcement = model<IAnnouncement>('Announcement', announcementSchema);

export interface IAnnouncementAck { _id: Types.ObjectId; announcement: Types.ObjectId; user: Types.ObjectId; createdAt: Date }
const ackSchema = new Schema<IAnnouncementAck>(
  {
    announcement: { type: Schema.Types.ObjectId, ref: 'Announcement', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'announcementAcks' },
);
ackSchema.index({ announcement: 1, user: 1 }, { unique: true });
ackSchema.index({ user: 1 });
export const AnnouncementAck = model<IAnnouncementAck>('AnnouncementAck', ackSchema);
