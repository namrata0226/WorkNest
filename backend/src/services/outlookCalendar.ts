import { env } from '../config/env';
import { logger } from '../config/logger';
import { CONFIRMED_LEAVE_STATUSES, LEAVE_STATUS } from '../constants';
import { IEmployee } from '../models/Employee';
import { ILeaveRequest, LeaveRequest } from '../models/LeaveRequest';
import { addDays } from '../utils/dates';
import { companyToday, getSettings } from './settings';

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 15_000;
const HALF_DAY_HOURS = { FIRST: ['09:00:00', '13:00:00'], SECOND: ['13:00:00', '18:00:00'] } as const;
const IMMUTABLE_ID = { Prefer: 'IdType="ImmutableId"' };

class GraphError extends Error {
  constructor(public readonly status: number) {
    super(`Microsoft Graph returned ${status}`);
  }
}

/** Retrying cannot help these. Auth errors stay retryable, as an admin's permission change can take hours to apply. */
const isPermanent = (err: unknown) =>
  err instanceof GraphError && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status);

export const outlookConfigured = () => Boolean(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID!)}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID!,
      client_secret: env.MS_CLIENT_SECRET!,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Microsoft sign-in returned ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token || typeof body.expires_in !== 'number') throw new Error('Microsoft sign-in returned no access token');
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return body.access_token;
}

export const clearOutlookToken = () => { cachedToken = null; };

async function graph(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${GRAPH_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...IMMUTABLE_ID },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GraphError(res.status);
  return res;
}

/** Colleagues can see this, so it never says what kind of leave it is or why. */
export function outOfOfficeEvent(request: Pick<ILeaveRequest, '_id' | 'startDate' | 'endDate' | 'dayType' | 'halfSession'>, timeZone: string) {
  const half = request.dayType === 'HALF' && request.halfSession ? HALF_DAY_HOURS[request.halfSession] : null;
  const at = (date: string, time: string) => ({ dateTime: `${date}T${time}`, timeZone });
  return {
    subject: 'Out of office',
    showAs: 'oof',
    isReminderOn: false,
    // Lets Microsoft ignore a repeat if a create succeeded but its answer never reached us.
    transactionId: String(request._id),
    ...(half
      ? { isAllDay: false, start: at(request.startDate, half[0]), end: at(request.startDate, half[1]) }
      // An all-day event ends at midnight on the following day.
      : { isAllDay: true, start: at(request.startDate, '00:00:00'), end: at(addDays(request.endDate, 1), '00:00:00') }),
  };
}

type Populated = Omit<ILeaveRequest, 'employee'> & { employee: Pick<IEmployee, 'email'> };

const mailboxPath = (email: string) => `/users/${encodeURIComponent(email)}/events`;

async function attempt(request: Populated, work: () => Promise<void>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (err) {
    if (isPermanent(err)) {
      await LeaveRequest.updateOne({ _id: request._id }, { outlookSyncError: (err as GraphError).status === 404 ? 'MAILBOX_NOT_FOUND' : 'REQUEST_REJECTED' });
    }
    logger.warn({ leaveRequest: String(request._id), err: (err as Error).message }, 'Outlook calendar update failed');
    return false;
  }
}

/** Brings calendars in line with leave status, so a Microsoft outage never affects approving or cancelling leave. */
export async function syncOutlookCalendars(limit = 50): Promise<number> {
  if (!outlookConfigured()) return 0;
  let token: string;
  try {
    token = await accessToken();
  } catch (err) {
    // A wrong secret is no fault of any one request, so none of them are marked as failed.
    logger.error({ err: (err as Error).message }, 'Could not sign in to Microsoft');
    return 0;
  }

  const [today, settings] = await Promise.all([companyToday(), getSettings()]);
  let changed = 0;

  const toRemove = await LeaveRequest.find({ status: { $nin: CONFIRMED_LEAVE_STATUSES }, outlookEventId: { $type: 'string' }, outlookSyncError: null })
    .limit(limit).populate('employee', 'email').lean<Populated[]>();
  for (const request of toRemove) {
    const done = await attempt(request, async () => {
      try {
        await graph('DELETE', `${mailboxPath(request.employee.email)}/${encodeURIComponent(request.outlookEventId!)}`, token);
      } catch (err) {
        // Someone already deleted it from their calendar, which is the result we wanted.
        if (!(err instanceof GraphError && err.status === 404)) throw err;
      }
      await LeaveRequest.updateOne({ _id: request._id }, { outlookEventId: null });
    });
    if (done) changed++;
  }

  const toAdd = await LeaveRequest.find({ status: LEAVE_STATUS.APPROVED, outlookEventId: null, outlookSyncError: null, endDate: { $gte: today } })
    .sort({ startDate: 1 }).limit(limit).populate('employee', 'email').lean<Populated[]>();
  for (const request of toAdd) {
    const done = await attempt(request, async () => {
      const res = await graph('POST', mailboxPath(request.employee.email), token, outOfOfficeEvent(request, settings.timezone));
      const event = (await res.json()) as { id?: string };
      // Without an id the event could never be removed later, so this counts as a failed attempt and is retried.
      if (!event.id) throw new Error('Microsoft Graph returned an event with no id');
      await LeaveRequest.updateOne({ _id: request._id }, { outlookEventId: event.id });
    });
    if (done) changed++;
  }
  return changed;
}
