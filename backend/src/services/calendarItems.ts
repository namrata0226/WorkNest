import { PERMISSIONS } from '../constants';
import { AuthContext, can } from '../middleware/auth';
import { CalendarItem, ICalendarItem } from '../models/CalendarItem';
import { Employee, IEmployee } from '../models/Employee';
import { forbidden, notFound, unprocessable } from '../utils/errors';
import { audit, RequestContext } from './audit';

export type CalendarItemInput = Pick<ICalendarItem, 'kind' | 'title' | 'date' | 'allDay' | 'color' | 'visibility'> & {
  description?: string | null;
  location?: string | null;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  reminderMinutes?: number | null;
};

const canPublish = (auth: AuthContext) => can(auth, PERMISSIONS.ANNOUNCEMENTS_MANAGE);

const nameOf = async (auth: AuthContext) => {
  const me = auth.employeeId ? await Employee.findById(auth.employeeId).select('fullName').lean<IEmployee>() : null;
  return me?.fullName ?? auth.email;
};

/** Times only matter for timed events; tasks may have a due time but no end; all-day items have neither. */
function normalize(input: CalendarItemInput) {
  const endDate = input.endDate || input.date;
  if (endDate < input.date) throw unprocessable('The end date cannot be before the start date', 'INVALID_DATES');
  const allDay = input.allDay || (input.kind === 'TASK' && !input.startTime);
  if (!allDay && !input.startTime) throw unprocessable('Choose a start time, or mark it as all day', 'TIME_REQUIRED');
  let endTime = allDay ? null : input.endTime ?? null;
  if (!allDay && input.kind === 'EVENT') {
    if (!endTime) throw unprocessable('Choose an end time', 'TIME_REQUIRED');
    if (endDate === input.date && endTime <= input.startTime!) throw unprocessable('The end time must be after the start time', 'INVALID_TIMES');
  }
  if (input.kind === 'TASK') endTime = null;
  return {
    kind: input.kind,
    title: input.title,
    description: input.description || null,
    location: input.location || null,
    date: input.date,
    // Timed items stay on one day, so the week grid can place them.
    endDate: allDay ? endDate : input.date,
    allDay,
    startTime: allDay ? null : input.startTime!,
    endTime,
    color: input.color,
    visibility: input.visibility,
    reminderMinutes: allDay ? null : input.reminderMinutes ?? null,
  };
}

/** The caller's own items and every company-wide item that touches the range. */
export function listItems(auth: AuthContext, start: string, end: string) {
  return CalendarItem.find({
    $or: [{ owner: auth.userId }, { visibility: 'COMPANY' }],
    date: { $lte: end },
    endDate: { $gte: start },
  }).sort({ date: 1, allDay: -1, startTime: 1, createdAt: 1 }).limit(1000).lean();
}

/** Only the owner changes their own items; company-wide ones may also be changed by anyone allowed to publish. */
async function editable(auth: AuthContext, id: string) {
  const item = await CalendarItem.findById(id).lean<ICalendarItem>();
  const mine = item && String(item.owner) === String(auth.userId);
  if (!item || (!mine && item.visibility !== 'COMPANY')) throw notFound('Item');
  if (!mine && !canPublish(auth)) throw forbidden('Only the person who added this can change it', 'NOT_OWNER');
  return item;
}

export async function createItem(ctx: RequestContext, input: CalendarItemInput) {
  const auth = ctx.auth!;
  if (input.visibility === 'COMPANY' && !canPublish(auth)) throw forbidden('Only HR can add items for the whole company', 'COMPANY_ITEM_FORBIDDEN');
  const doc = await CalendarItem.create({ ...normalize(input), owner: auth.userId, ownerName: await nameOf(auth) });
  if (doc.visibility === 'COMPANY') await audit(ctx, { action: 'CALENDAR_ITEM_PUBLISHED', entityType: 'CalendarItem', entityId: doc._id, summary: `${doc.title} (${doc.date})` });
  return doc.toObject();
}

export async function updateItem(ctx: RequestContext, id: string, input: CalendarItemInput) {
  const auth = ctx.auth!;
  const item = await editable(auth, id);
  if (input.visibility === 'COMPANY' && item.visibility !== 'COMPANY' && !canPublish(auth)) throw forbidden('Only HR can add items for the whole company', 'COMPANY_ITEM_FORBIDDEN');
  const next = normalize(input);
  // A task that is no longer a task cannot stay ticked off.
  const done = next.kind === 'TASK' ? item.done : false;
  const updated = await CalendarItem.findByIdAndUpdate(id, { ...next, done, doneAt: done ? item.doneAt : null }, { returnDocument: 'after' }).lean();
  if (item.visibility === 'COMPANY' || next.visibility === 'COMPANY') await audit(ctx, { action: 'CALENDAR_ITEM_UPDATED', entityType: 'CalendarItem', entityId: item._id, summary: `${next.title} (${next.date})` });
  return updated;
}

export async function setDone(ctx: RequestContext, id: string, done: boolean) {
  const item = await editable(ctx.auth!, id);
  if (item.kind !== 'TASK') throw unprocessable('Only tasks can be marked as done', 'NOT_A_TASK');
  return CalendarItem.findByIdAndUpdate(id, { done, doneAt: done ? new Date() : null }, { returnDocument: 'after' }).lean();
}

export async function deleteItem(ctx: RequestContext, id: string) {
  const item = await editable(ctx.auth!, id);
  await CalendarItem.deleteOne({ _id: item._id });
  if (item.visibility === 'COMPANY') await audit(ctx, { action: 'CALENDAR_ITEM_DELETED', entityType: 'CalendarItem', entityId: item._id, summary: `${item.title} (${item.date})` });
}
