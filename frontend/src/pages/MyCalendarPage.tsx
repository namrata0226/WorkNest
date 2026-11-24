import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarEvent, CalendarHoliday, LeaveCalendar, VisibleRange } from '../components/LeaveCalendar';
import { Note } from '../components/ui';
import { Planner } from '../components/planner/Planner';
import { useFetch } from '../hooks/useFetch';

export function MyCalendarView() {
  const navigate = useNavigate();
  const [range, setRange] = useState<VisibleRange | null>(null);
  const { data, error } = useFetch<{ events: CalendarEvent[]; holidays: CalendarHoliday[] }>(
    range ? '/calendar/employee' : null,
    range ? { start: range.start, end: range.end } : undefined,
  );
  return (
    <>
      {error && <div className="mb-3"><Note>{error}</Note></div>}
      <LeaveCalendar
        events={data?.events ?? []}
        holidays={data?.holidays ?? []}
        showEmployee={false}
        onRange={setRange}
        onEventClick={(id) => navigate(`/leaves/${id}`)}
      />
    </>
  );
}

/** The full calendar: your own events and tasks, company-wide events, your leave and your holidays. */
export function MyCalendarPage() {
  return (
    <>
      {/* The calendar's own header names the period, so the page title is for screen readers only. */}
      <h1 className="sr-only">Calendar</h1>
      <Planner />
    </>
  );
}
