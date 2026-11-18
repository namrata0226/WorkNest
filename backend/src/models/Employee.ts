import { model, Schema, Types } from 'mongoose';
import { EMPLOYEE_CATEGORIES, EMPLOYEE_GENDERS, EMPLOYMENT_STATUS } from '../constants';

export interface IEmployee {
  _id: Types.ObjectId;
  employeeId: string;
  fullName: string;
  email: string;
  phone: string | null;
  /** Decides who can take gender-restricted leave types. Null means not recorded. */
  gender: (typeof EMPLOYEE_GENDERS)[number] | null;
  department: Types.ObjectId | null;
  designation: string | null;
  reportingManager: Types.ObjectId | null;
  joiningDate: string;
  location: Types.ObjectId | null;
  employmentStatus: (typeof EMPLOYMENT_STATUS)[number];
  category: (typeof EMPLOYEE_CATEGORIES)[number];
  leavePolicy: Types.ObjectId | null;
  user: Types.ObjectId | null;
  /** Bumped inside leave transactions so concurrent submissions by one employee conflict and retry. */
  leaveLock: number;
  /** The current profile photo, copied here so that lists can show it without another lookup. */
  avatarFile: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IEmployee>(
  {
    employeeId: { type: String, required: true, unique: true, trim: true, uppercase: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: null, trim: true },
    gender: { type: String, enum: [...EMPLOYEE_GENDERS, null], default: null },
    department: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    designation: { type: String, default: null, trim: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    joiningDate: { type: String, required: true },
    location: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
    employmentStatus: { type: String, enum: EMPLOYMENT_STATUS, default: 'ACTIVE' },
    category: { type: String, enum: EMPLOYEE_CATEGORIES, default: 'PERMANENT' },
    leavePolicy: { type: Schema.Types.ObjectId, ref: 'LeavePolicy', default: null },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    leaveLock: { type: Number, default: 0, select: false },
    avatarFile: { type: Schema.Types.ObjectId, ref: 'StoredFile', default: null },
  },
  { timestamps: true, collection: 'employees' },
);
schema.index({ department: 1, employmentStatus: 1 });
schema.index({ location: 1, employmentStatus: 1 });
schema.index({ reportingManager: 1 });
schema.index({ fullName: 1 });

export const Employee = model<IEmployee>('Employee', schema);
