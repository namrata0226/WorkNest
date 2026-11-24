import { useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/ui';
import type { CalendarItem } from '../types';
import { todayString } from '../utils/date';
import { formatTime, toMinutes } from '../utils/planner';

const REFRESH_MS = 5 * 60_000;
const CHECK_MS = 30_000;
/** A reminder missed while the tab was closed still shows up to this long after its start. */
const GRACE_MINUTES = 5;
const STORAGE_KEY = 'worknest.remindersShown';

function shownToday(): Set<string> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as { day?: string; ids?: string[] };
    return new Set(saved.day === todayString() ? saved.ids ?? [] : []);
  } catch {
    return new Set();
  }
}

function remember(ids: Set<string>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ day: todayString(), ids: [...ids] }));
  } catch {
    // Private windows can refuse storage; the reminder may then repeat after a reload, which is harmless.
  }
}

/** Shows an in-app toast when one of today's events or tasks reaches its reminder time. */
export function useCalendarReminders(enabled: boolean) {
  const toast = useToast();
  const items = useRef<CalendarItem[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const shown = shownToday();

    const refresh = async () => {
      const today = todayString();
      try {
        const res = await api.get('/calendar/items', { params: { start: today, end: today } });
        if (!cancelled) items.current = res.data.data as CalendarItem[];
      } catch {
        // Reminders are a convenience; a failed refresh just tries again later.
      }
    };

    const check = () => {
      const now = new Date();
      const today = todayString();
      const minutes = now.getHours() * 60 + now.getMinutes();
      for (const item of items.current) {
        if (item.done || item.allDay || !item.startTime || item.reminderMinutes == null || item.date !== today || shown.has(item._id)) continue;
        const start = toMinutes(item.startTime);
        if (minutes >= start - item.reminderMinutes && minutes <= start + GRACE_MINUTES) {
          shown.add(item._id);
          remember(shown);
          const left = start - minutes;
          const when = left > 0 ? `in ${left} min (${formatTime(item.startTime)})` : `now (${formatTime(item.startTime)})`;
          toast(`${item.kind === 'TASK' ? 'Task due' : 'Starting'} ${when}: ${item.title}`, 'info');
        }
      }
    };

    void refresh().then(check);
    const refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
    const checkTimer = setInterval(check, CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
      clearInterval(checkTimer);
    };
  }, [enabled, toast]);
}
