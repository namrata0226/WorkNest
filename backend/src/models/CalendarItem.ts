import { model, Schema, Types } from 'mongoose';

export const CALENDAR_ITEM_KINDS = ['EVENT', 'TASK'] as const;
/** PRIVATE: only the owner sees it. COMPANY: everyone sees it; only people who may publish announcements can set it. */
export const CALENDAR_ITEM_VISIBILITY = ['PRIVATE', 'COMPANY'] as const;
export const CALENDAR_ITEM_COLORS = ['brand', 'sky', 'violet', 'amber', 'rose', 'slate'] as const;

export interface ICalendarItem {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  ownerName: string;
  kind: (typeof CALENDAR_ITEM_KINDS)[number];
  title: string;
  description: string | null;
  location: string | null;
  /** The day it happens, or a task's due date. */
  date: string;
  /** Last day of a multi-day all-day event. Equal to `date` otherwise. */
  endDate: string;
  allDay: boolean;
  /** HH:MM, null when all day. */
  startTime: string | null;
  endTime: string | null;
  color: (typeof CALENDAR_ITEM_COLORS)[number];
  visibility: (typeof CALENDAR_ITEM_VISIBILITY)[number];
  /** Minutes before the start to show a reminder in the app. */
  reminderMinutes: number | null;
  done: boolean;
  doneAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ICalendarItem>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: { type: String, required: true },
    kind: { type: String, enum: CALENDAR_ITEM_KINDS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, trim: true, maxlength: 2000 },
    location: { type: String, default: null, trim: true, maxlength: 200 },
    date: { type: String, required: true },
    endDate: { type: String, required: true },
    allDay: { type: Boolean, default: false },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    color: { type: String, enum: CALENDAR_ITEM_COLORS, default: 'brand' },
    visibility: { type: String, enum: CALENDAR_ITEM_VISIBILITY, default: 'PRIVATE' },
    reminderMinutes: { type: Number, default: null, min: 0, max: 10_080 },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'calendarItems' },
);
// A range query by owner, and the company-wide items everyone sees.
schema.index({ owner: 1, date: 1 });
schema.index({ visibility: 1, date: 1 });
export const CalendarItem = model<ICalendarItem>('CalendarItem', schema);
