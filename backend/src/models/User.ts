import { model, Schema, Types } from 'mongoose';
import { Role, ROLE_VALUES, ROLES } from '../constants';

export interface IUser {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  role: Role;
  /** Null means the role's default permissions. Only meaningful for HR_ADMIN. */
  permissions: string[] | null;
  employee: Types.ObjectId | null;
  isActive: boolean;
  failedLoginAttempts: number;
  lockUntil: Date | null;
  passwordChangedAt: Date | null;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  avatarFile: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_VALUES, default: ROLES.EMPLOYEE, required: true },
    permissions: { type: [String], default: null },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    isActive: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
    avatarFile: { type: Schema.Types.ObjectId, ref: 'StoredFile', default: null },
  },
  { timestamps: true, collection: 'users' },
);
schema.index({ employee: 1 }, { unique: true, partialFilterExpression: { employee: { $type: 'objectId' } } });
schema.index({ role: 1, isActive: 1 });

export const User = model<IUser>('User', schema);
