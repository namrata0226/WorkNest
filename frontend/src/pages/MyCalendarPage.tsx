import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarEvent, CalendarHoliday, LeaveCalendar, VisibleRange } from '../components/LeaveCalendar';
import { Card, Note, PageHeader } from '../components/ui';
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

export function MyCalendarPage() {
  return (
    <>
      <PageHeader title="My calendar" subtitle="Your approved and pending leave, with the holidays that apply to you" />
      <Card><MyCalendarView /></Card>
    </>
  );
}
