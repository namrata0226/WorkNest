import { model, Schema, Types } from 'mongoose';

export const ATTENDANCE_SOURCES = ['WEB', 'HR_CORRECTION'] as const;
export const WFH_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const CORRECTION_STATUSES = WFH_STATUSES;

/** Dates and times are the company's local time as text, so a timezone can never move a punch to another day. */
export interface IAttendanceRecord {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  date: string;
  punchIn: string;
  punchOut: string | null;
  source: (typeof ATTENDANCE_SOURCES)[number];
  ip: string | null;
  correctedBy: Types.ObjectId | null;
  correctionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const recordSchema = new Schema<IAttendanceRecord>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true },
    punchIn: { type: String, required: true },
    punchOut: { type: String, default: null },
    source: { type: String, enum: ATTENDANCE_SOURCES, default: 'WEB' },
    ip: { type: String, default: null },
    correctedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    correctionNote: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true, collection: 'attendanceRecords' },
);
// One record a day per person is what makes a double punch impossible.
recordSchema.index({ employee: 1, date: 1 }, { unique: true });
recordSchema.index({ date: 1 });

export const AttendanceRecord = model<IAttendanceRecord>('AttendanceRecord', recordSchema);

export interface IWfhRequest {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: (typeof WFH_STATUSES)[number];
  decidedBy: Types.ObjectId | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const wfhSchema = new Schema<IWfhRequest>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    totalDays: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: WFH_STATUSES, default: 'PENDING', required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
  },
  { timestamps: true, collection: 'wfhRequests' },
);
wfhSchema.index({ employee: 1, startDate: 1, endDate: 1 });
wfhSchema.index({ status: 1, createdAt: 1 });

export const WfhRequest = model<IWfhRequest>('WfhRequest', wfhSchema);

export interface IAttendanceCorrection {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  date: string;
  punchIn: string;
  punchOut: string | null;
  reason: string;
  status: (typeof CORRECTION_STATUSES)[number];
  decidedBy: Types.ObjectId | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const correctionSchema = new Schema<IAttendanceCorrection>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true },
    punchIn: { type: String, required: true },
    punchOut: { type: String, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: CORRECTION_STATUSES, default: 'PENDING', required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
  },
  { timestamps: true, collection: 'attendanceCorrections' },
);
// One open request per day, which also stops a double submission.
correctionSchema.index({ employee: 1, date: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });
correctionSchema.index({ status: 1, createdAt: 1 });
correctionSchema.index({ employee: 1, createdAt: -1 });

export const AttendanceCorrection = model<IAttendanceCorrection>('AttendanceCorrection', correctionSchema);
