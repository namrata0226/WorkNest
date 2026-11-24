import { addDaysTo } from './date';

/** Weeks start on Monday, as in the rest of the app. */
export function weekStart(date: string): string {
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDaysTo(date, -weekday);
}

export const daysFrom = (start: string, count: number) => Array.from({ length: count }, (_, i) => addDaysTo(start, i));

/** The six weeks shown for a month, Monday first, including the days either side that fill the grid. */
export const monthGrid = (month: string) => daysFrom(weekStart(`${month}-01`), 42);

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export const fromMinutes = (minutes: number) => {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
};

/** "13:30" as "1:30 PM". */
export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export const formatHour = (hour: number) => (hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`);

/** "9:00 – 10:00 AM", or "11:30 AM – 12:30 PM" when the range crosses noon. */
export function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return 'All day';
  if (!end) return formatTime(start);
  const a = formatTime(start);
  const b = formatTime(end);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

/** "1 hour", "1 hour 30 min", "45 min". */
export function formatDuration(start: string, end: string): string {
  const total = toMinutes(end) - toMinutes(start);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}

export function formatReminder(minutes: number): string {
  if (minutes === 0) return 'At start time';
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`;
  return `${minutes} min before`;
}

export interface Timed { id: string; start: number; end: number }

/**
 * Side-by-side placement for overlapping items in one day column. Each item gets a lane and the number of
 * lanes in its group of overlaps, so its width is 1/lanes and its left edge lane/lanes.
 */
export function layoutLanes<T extends Timed>(items: T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const placed: (T & { lane: number; lanes: number })[] = [];
  let group: (T & { lane: number; lanes: number })[] = [];
  let groupEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const g of group) g.lanes = lanes;
    group = [];
  };
  for (const item of sorted) {
    if (item.start >= groupEnd) {
      close();
      groupEnd = -1;
    }
    const taken = new Set(group.filter((g) => g.end > item.start).map((g) => g.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    const entry = { ...item, lane, lanes: 1 };
    group.push(entry);
    placed.push(entry);
    groupEnd = Math.max(groupEnd, item.end);
  }
  close();
  return placed;
}
