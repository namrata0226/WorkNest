import { model, Schema, Types } from 'mongoose';
import { AUDIT_CATEGORIES, AuditCategory, EMAIL_ACTION_KINDS, EmailActionKind, NOTIFICATION_TYPES, NotificationType } from '../constants';

export interface INotification {
  _id: Types.ObjectId;
  recipient: Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  readAt: Date | null;
  /** Unique when set, so scheduled reminders are delivered once across restarts. */
  dedupeKey: string | null;
  action: { kind: EmailActionKind; id: Types.ObjectId } | null;
  /** Transactional outbox: rows commit with the change that caused them, then the job sends. */
  emailStatus: 'NONE' | 'PENDING' | 'SENT' | 'FAILED';
  emailAttempts: number;
  /** Set while one sender is delivering it, so two senders running at once never send it twice. */
  emailClaimedUntil: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    link: { type: String, default: null },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String, default: null },
    action: { type: new Schema({ kind: { type: String, enum: EMAIL_ACTION_KINDS }, id: Schema.Types.ObjectId }, { _id: false }), default: null },
    emailStatus: { type: String, enum: ['NONE', 'PENDING', 'SENT', 'FAILED'], default: 'NONE' },
    emailAttempts: { type: Number, default: 0 },
    emailClaimedUntil: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'notifications' },
);
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1 });
notificationSchema.index({ emailStatus: 1, createdAt: 1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

export const Notification = model<INotification>('Notification', notificationSchema);

export interface IAuditLog {
  _id: Types.ObjectId;
  actor: Types.ObjectId | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  category: AuditCategory;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: Date;
}

const auditSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: null },
    actorRole: { type: String, default: null },
    action: { type: String, required: true },
    category: { type: String, enum: AUDIT_CATEGORIES, default: 'HR' },
    entityType: { type: String, default: null },
    entityId: { type: String, default: null },
    summary: { type: String, default: null },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: { type: String, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'auditLogs' },
);
auditSchema.index({ createdAt: -1 });
auditSchema.index({ category: 1, createdAt: -1 });
auditSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditSchema.index({ actor: 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditSchema);

export interface ICompanySettings {
  _id: Types.ObjectId;
  key: 'global';
  companyName: string;
  timezone: string;
  reserveBalanceOnPending: boolean;
  /** Days before this are not attendance records, so they cannot count as absences. Null means no limit. */
  attendanceStartDate: string | null;
  compOff: {
    validityDays: number;
    allowOnWeeklyOff: boolean;
    allowOnHoliday: boolean;
    allowHalfDay: boolean;
    maxClaimAgeDays: number;
    requireDocument: boolean;
    expiryWarningDays: number;
  };
  security: {
    maxFailedLogins: number;
    lockoutMinutes: number;
    minPasswordLength: number;
  };
  notifications: {
    emailEnabled: boolean;
    holidayReminderDays: number;
    approvalReminderDays: number;
    approvalEscalationDays: number;
    punchReminderEnabled: boolean;
    punchReminderTime: string;
  };
}

const settingsSchema = new Schema<ICompanySettings>(
  {
    key: { type: String, enum: ['global'], default: 'global', unique: true },
    companyName: { type: String, default: 'WorkNest' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    attendanceStartDate: { type: String, default: null },
    reserveBalanceOnPending: { type: Boolean, default: true },
    compOff: {
      validityDays: { type: Number, default: 90, min: 1 },
      allowOnWeeklyOff: { type: Boolean, default: true },
      allowOnHoliday: { type: Boolean, default: true },
      allowHalfDay: { type: Boolean, default: true },
      maxClaimAgeDays: { type: Number, default: 30, min: 0 },
      requireDocument: { type: Boolean, default: false },
      expiryWarningDays: { type: Number, default: 14, min: 0 },
    },
    security: {
      maxFailedLogins: { type: Number, default: 3, min: 1 },
      lockoutMinutes: { type: Number, default: 15, min: 1 },
      minPasswordLength: { type: Number, default: 10, min: 8 },
    },
    notifications: {
      emailEnabled: { type: Boolean, default: false },
      holidayReminderDays: { type: Number, default: 3, min: 0 },
      approvalReminderDays: { type: Number, default: 2, min: 1 },
      approvalEscalationDays: { type: Number, default: 5, min: 1 },
      punchReminderEnabled: { type: Boolean, default: true },
      punchReminderTime: { type: String, default: '11:00' },
    },
  },
  { timestamps: true, collection: 'companySettings' },
);

export const CompanySettings = model<ICompanySettings>('CompanySettings', settingsSchema);

export interface IStoredFile {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  ownerEmployee: Types.ObjectId | null;
  originalName: string;
  storedName: string;
  storage: 'LOCAL' | 'CLOUDINARY';
  purpose: 'DOCUMENT' | 'AVATAR' | 'PERSONAL';
  mimeType: string;
  size: number;
  sha256: string;
  scanStatus: 'CLEAN' | 'NOT_SCANNED';
  createdAt: Date;
}

const fileSchema = new Schema<IStoredFile>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ownerEmployee: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    originalName: { type: String, required: true },
    storedName: { type: String, required: true, unique: true },
    storage: { type: String, enum: ['LOCAL', 'CLOUDINARY'], default: 'LOCAL' },
    purpose: { type: String, enum: ['DOCUMENT', 'AVATAR', 'PERSONAL'], default: 'DOCUMENT' },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    scanStatus: { type: String, enum: ['CLEAN', 'NOT_SCANNED'], default: 'NOT_SCANNED' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'storedFiles' },
);

export const StoredFile = model<IStoredFile>('StoredFile', fileSchema);
