import { DatesSetArg, DayCellContentArg, EventClickArg, EventInput } from '@fullcalendar/core';
import enGb from '@fullcalendar/core/locales/en-gb';
import dayGridPlugin from '@fullcalendar/daygrid';
import FullCalendar from '@fullcalendar/react';
import { useCallback, useMemo, useRef } from 'react';
import { addOneDay } from '../utils/calendar';
import { toDateOnly } from '../utils/date';

export interface CalendarEvent {
  id: string;
  requestId: string;
  start: string;
  endExclusive: string;
  status: string;
  dayType: 'FULL' | 'HALF';
  halfSession: string | null;
  employee: { fullName: string; employeeId: string; department: string | null };
  leaveType: { name: string; code: string; color: string };
}

export interface CalendarHoliday {
  id: string;
  name: string;
  date: string;
  category: string;
  isHalfDay: boolean;
}

export interface VisibleRange {
  start: string;
  end: string;
  month: string;
}

interface Props {
  events: CalendarEvent[];
  holidays: CalendarHoliday[];
  onRange: (range: VisibleRange) => void;
  onEventClick?: (requestId: string) => void;
  /** Personal calendars label entries by leave type, as the name would just repeat. */
  showEmployee?: boolean;
}

/*
 * Module-level on purpose. A new `locales` array makes FullCalendar rebuild and fire datesSet again,
 * which loops through the parent's state, so option objects are kept stable as a rule.
 */
const PLUGINS = [dayGridPlugin];
const LOCALES = [enGb];
const TOOLBAR = { left: 'prev,next today', center: 'title', right: 'dayGridMonth,dayGridWeek,dayGridDay' };
const BUTTONS = { today: 'Today', month: 'Month', week: 'Week', day: 'Day' };
const HEADER_FORMAT = { weekday: 'short' } as const;
const VIEWS = {
  dayGridWeek: { dayHeaderFormat: { weekday: 'short', day: 'numeric', month: 'short' } },
  dayGridDay: { dayHeaderFormat: { weekday: 'long', day: 'numeric', month: 'long' }, dayMaxEvents: false },
} as const;

export function toFullCalendarEvents(events: CalendarEvent[], holidays: CalendarHoliday[], showEmployee: boolean): EventInput[] {
  return [
    ...events.map((e) => {
      const pending = e.status === 'PENDING';
      const half = e.dayType === 'HALF' ? ` (${e.halfSession === 'FIRST' ? '1st' : '2nd'} half)` : '';
      return {
        id: e.id,
        title: `${showEmployee ? `${e.employee.fullName} · ${e.leaveType.code}` : e.leaveType.name}${half}${pending ? ' · pending' : ''}`,
        start: e.start,
        end: e.endExclusive,
        allDay: true,
        backgroundColor: e.leaveType.color,
        borderColor: e.leaveType.color,
        textColor: '#fff',
        classNames: [pending ? 'leave-pending' : 'leave-approved'],
        extendedProps: { requestId: e.requestId },
      };
    }),
    ...holidays.map((h) => ({
      id: `holiday-${h.id}-${h.date}`,
      start: h.date,
      end: addOneDay(h.date),
      allDay: true,
      display: 'background',
      classNames: ['holiday-event'],
    })),
  ];
}

export function LeaveCalendar({ events, holidays, onRange, onEventClick, showEmployee = true }: Props) {
  const fcEvents = useMemo(() => toFullCalendarEvents(events, holidays, showEmployee), [events, holidays, showEmployee]);

  const holidayNames = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const h of holidays) names.set(h.date, [...(names.get(h.date) ?? []), `${h.name}${h.isHalfDay ? ' (half day)' : ''}`]);
    return names;
  }, [holidays]);

  // Named in the day header rather than on the background event, where leave bars would cover it.
  const dayCell = useCallback((arg: DayCellContentArg) => {
    const names = holidayNames.get(toDateOnly(arg.date));
    return (
      <>
        <span className="holiday-name" title={names?.join(', ')}>{names?.join(', ')}</span>
        <span>{arg.dayNumberText}</span>
      </>
    );
  }, [holidayNames]);

  const lastRange = useRef('');
  const datesSet = useCallback((arg: DatesSetArg) => {
    // view.currentStart is the 1st of the month being looked at, unlike the grid's leading days.
    const next = { start: toDateOnly(arg.start), end: toDateOnly(new Date(arg.end.getTime() - 86_400_000)), month: toDateOnly(arg.view.currentStart).slice(0, 7) };
    // Only real navigation is reported, so nothing here can feed back into a render loop.
    const key = `${next.start}|${next.end}|${next.month}`;
    if (key === lastRange.current) return;
    lastRange.current = key;
    onRange(next);
  }, [onRange]);

  const eventClick = (arg: EventClickArg) => {
    const id = arg.event.extendedProps.requestId as string | undefined;
    if (id && onEventClick) onEventClick(id);
  };

  return (
    <FullCalendar
      plugins={PLUGINS}
      locales={LOCALES}
      locale="en-gb"
      initialView="dayGridMonth"
      headerToolbar={TOOLBAR}
      buttonText={BUTTONS}
      dayHeaderFormat={HEADER_FORMAT}
      views={VIEWS}
      firstDay={1}
      height="auto"
      dayMaxEvents={4}
      fixedWeekCount={false}
      events={fcEvents}
      dayCellContent={dayCell}
      datesSet={datesSet}
      eventClick={eventClick}
    />
  );
}

export function CalendarLegend({ types }: { types: { code: string; name: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
      {types.map((t) => (
        <span key={t.code} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: t.color }} />{t.name}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-4 rounded-sm border-[1.5px] border-dashed border-faint" />Pending</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-[#f9e7cf]" />Holiday</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-[#ebe9e2]" />Weekend</span>
    </div>
  );
}
