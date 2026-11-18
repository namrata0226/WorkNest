import { model, Schema, Types } from 'mongoose';
import { HALF_SESSIONS, HalfSession, HOLIDAY_CATEGORIES, HolidayCategory } from '../constants';

export interface IHoliday {
  _id: Types.ObjectId;
  name: string;
  date: string;
  year: number;
  category: HolidayCategory;
  description: string | null;
  /** Empty means the holiday applies to everyone on that dimension. */
  locations: Types.ObjectId[];
  departments: Types.ObjectId[];
  employeeCategories: string[];
  isHalfDay: boolean;
  /** Which half of the day is off, when isHalfDay is set. */
  halfDaySession: HalfSession;
  recurring: boolean;
}

const schema = new Schema<IHoliday>(
  {
    name: { type: String, required: true, trim: true },
    date: { type: String, required: true },
    year: { type: Number, required: true },
    category: { type: String, enum: HOLIDAY_CATEGORIES, required: true },
    description: { type: String, default: null },
    locations: [{ type: Schema.Types.ObjectId, ref: 'Location' }],
    departments: [{ type: Schema.Types.ObjectId, ref: 'Department' }],
    employeeCategories: { type: [String], default: [] },
    isHalfDay: { type: Boolean, default: false },
    halfDaySession: { type: String, enum: HALF_SESSIONS, default: 'SECOND' },
    recurring: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'holidays' },
);
schema.index({ date: 1, name: 1 }, { unique: true });
schema.index({ date: 1, locations: 1 });
schema.index({ year: 1, date: 1 });
schema.index({ recurring: 1, date: 1 });

export const Holiday = model<IHoliday>('Holiday', schema);
