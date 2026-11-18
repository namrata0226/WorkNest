import { useState } from 'react';
import { CalendarEvent, CalendarHoliday, LeaveCalendar, VisibleRange } from '../components/LeaveCalendar';
import { Card, Note, PageHeader } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import { addDaysTo } from '../utils/date';

export interface TeamAway { id: string; employeeId: string; employeeName: string; startDate: string; endDate: string; halfDay: boolean }

const AWAY = { name: 'Away', code: 'Away', color: '#0f5c55' };

export function TeamCalendarPage() {
  const [range, setRange] = useState<VisibleRange | null>(null);
  const { data, error } = useFetch<{ events: TeamAway[]; holidays: CalendarHoliday[] }>(range ? '/calendar/team' : null, range ? { start: range.start, end: range.end } : undefined);
  const events: CalendarEvent[] = (data?.events ?? []).map((e) => ({
    id: e.id,
    requestId: e.id,
    start: e.startDate,
    endExclusive: addDaysTo(e.endDate, 1),
    status: 'APPROVED',
    dayType: e.halfDay ? 'HALF' : 'FULL',
    halfSession: null,
    employee: { fullName: e.employeeName, employeeId: e.employeeId, department: null },
    leaveType: AWAY,
  }));
  return (
    <>
      <PageHeader title="Team calendar" subtitle="Who is away from your team and department. Leave types and reasons are kept private." />
      {error && <div className="mb-3"><Note>{error}</Note></div>}
      <Card><LeaveCalendar events={events} holidays={data?.holidays ?? []} onRange={setRange} /></Card>
    </>
  );
}

/** Shown while applying, so people can see who else is out before they choose dates. */
export function AwayNote({ start, end }: { start?: string; end?: string }) {
  const { data } = useFetch<{ events: TeamAway[] }>(start && end && start <= end ? '/calendar/team' : null, { start, end });
  const names = [...new Set((data?.events ?? []).map((e) => e.employeeName))];
  if (!names.length) return null;
  return <Note tone="sky">Also away on these dates: {names.join(', ')}</Note>;
}
