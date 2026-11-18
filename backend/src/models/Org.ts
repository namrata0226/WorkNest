import { model, Schema, Types } from 'mongoose';

export interface IDepartment {
  _id: Types.ObjectId;
  name: string;
  code: string | null;
  isActive: boolean;
}

const departmentSchema = new Schema<IDepartment>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    code: { type: String, default: null, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'departments' },
);

export const Department = model<IDepartment>('Department', departmentSchema);

export interface ILocation {
  _id: Types.ObjectId;
  name: string;
  city: string | null;
  isActive: boolean;
}

const locationSchema = new Schema<ILocation>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    city: { type: String, default: null, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'locations' },
);

export const Location = model<ILocation>('Location', locationSchema);
