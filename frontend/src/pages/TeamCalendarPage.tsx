import { DatesSetArg, DayCellContentArg, EventClickArg, EventContentArg, EventInput } from '@fullcalendar/core';
import enGb from '@fullcalendar/core/locales/en-gb';
import dayGridPlugin from '@fullcalendar/daygrid';
import FullCalendar from '@fullcalendar/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/icons';
import type { CalendarHoliday } from '../components/LeaveCalendar';
import { DateBadge } from '../components/planner/Planner';
import { Card, cx, Note, Select, Spinner } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import { addDaysTo, formatDate, formatRange, toDateOnly, todayString } from '../utils/date';

export interface TeamAway { id: string; employeeId: string; employeeName: string; avatarFile?: string | null; startDate: string; endDate: string; halfDay: boolean }

/* Module-level, so FullCalendar is not rebuilt on every render (a new options object makes it fire datesSet again). */
const PLUGINS = [dayGridPlugin];
const LOCALES = [enGb];
const HEADER_FORMAT = { weekday: 'short' } as const;
const VIEWS = { dayGridWeek: { dayHeaderFormat: { weekday: 'short', day: 'numeric' } } } as const;

/** One colour per person, the same every visit, so someone's leave is easy to follow across weeks. */
const PALETTE = ['#0f5c55', '#1d5f8a', '#6d4fd3', '#a8560a', '#b4233c', '#2f7d4f', '#8a4fb0', '#0e7490', '#9a3412', '#4d5f1f'];
const colourFor = (id: string) => PALETTE[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
const workingDays = (start: string, end: string, half: boolean) => {
  if (half) return 0.5;
  let n = 0;
  for (let d = start; d <= end; d = addDaysTo(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
};
const dayLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

type View = 'dayGridMonth' | 'dayGridWeek';

export function TeamCalendarPage() {
  const ref = useRef<FullCalendar>(null);
  const today = todayString();
  const [range, setRange] = useState<{ start: string; end: string; title: string; anchor: string } | null>(null);
  const [view, setView] = useState<View>('dayGridMonth');
  const [focus, setFocus] = useState<string | null>(null);
  // Always include the next two weeks, so "Coming up" works whichever month is on screen.
  const fetchRange = range ? { start: range.start < today ? range.start : today, end: range.end > addDaysTo(today, 14) ? range.end : addDaysTo(today, 14) } : null;
  const { data, error, loading } = useFetch<{ events: TeamAway[]; holidays: CalendarHoliday[] }>(fetchRange ? '/calendar/team' : null, fetchRange ?? undefined);
  const events = useMemo(() => data?.events ?? [], [data]);
  const holidays = useMemo(() => data?.holidays ?? [], [data]);

  const people = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatarFile?: string | null; leaves: TeamAway[] }>();
    for (const e of events) {
      const p = map.get(e.employeeId) ?? { id: e.employeeId, name: e.employeeName, avatarFile: e.avatarFile, leaves: [] };
      p.leaves.push(e);
      map.set(e.employeeId, p);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [events]);

  const awayToday = events.filter((e) => e.startDate <= today && e.endDate >= today);
  const comingUp = events.filter((e) => e.startDate > today && e.startDate <= addDaysTo(today, 14)).sort((a, b) => a.startDate.localeCompare(b.startDate));

  const fcEvents = useMemo<EventInput[]>(() => [
    ...events.map((e) => ({
      id: e.id,
      title: e.employeeName,
      start: e.startDate,
      end: addDaysTo(e.endDate, 1),
      allDay: true,
      backgroundColor: colourFor(e.employeeId),
      borderColor: colourFor(e.employeeId),
      textColor: '#fff',
      classNames: ['team-away', ...(focus && focus !== e.employeeId ? ['team-away-dim'] : [])],
      extendedProps: { person: e.employeeId, half: e.halfDay },
    })),
    ...holidays.map((h) => ({ id: `holiday-${h.id}`, start: h.date, end: addDaysTo(h.date, 1), allDay: true, display: 'background', classNames: ['holiday-event'] })),
  ], [events, holidays, focus]);

  const holidayNames = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const h of holidays) names.set(h.date, [...(names.get(h.date) ?? []), `${h.name}${h.isHalfDay ? ' (half day)' : ''}`]);
    return names;
  }, [holidays]);

  const dayCell = useCallback((arg: DayCellContentArg) => {
    const names = holidayNames.get(toDateOnly(arg.date));
    return (
      <>
        <span className="holiday-name" title={names?.join(', ')}>{names?.join(', ')}</span>
        <span className="team-day-number">{arg.dayNumberText}</span>
      </>
    );
  }, [holidayNames]);

  const eventContent = useCallback((arg: EventContentArg) => (
    <div className="flex min-w-0 items-center gap-1.5 px-1 py-[3px]">
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-white/25 text-[9px] font-bold">{initials(arg.event.title)}</span>
      <span className="truncate text-[12px] font-medium">{arg.event.title}</span>
      {arg.event.extendedProps.half && <span className="shrink-0 rounded bg-white/25 px-1 text-[10px] font-semibold">½ day</span>}
    </div>
  ), []);

  const lastKey = useRef('');
  const datesSet = useCallback((arg: DatesSetArg) => {
    const next = { start: toDateOnly(arg.start), end: toDateOnly(new Date(arg.end.getTime() - 86_400_000)), title: arg.view.title, anchor: toDateOnly(arg.view.currentStart) };
    const key = `${next.start}|${next.end}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setRange(next);
  }, []);

  const eventClick = useCallback((arg: EventClickArg) => {
    const person = arg.event.extendedProps.person as string | undefined;
    if (person) setFocus((f) => (f === person ? null : person));
  }, []);

  const api = () => ref.current?.getApi();
  const changeView = (v: View) => { setView(v); api()?.changeView(v); };
  const focused = people.find((p) => p.id === focus) ?? null;

  return (
    <>
      <h1 className="sr-only">Team calendar</h1>
      <Card flush>
        {/* Toolbar, matching My calendar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
          <DateBadge date={today} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[20px] font-semibold tracking-tight">{range?.title ?? ' '}</div>
            <div className="text-[13px] text-muted">Who is away from your team and department. Leave types and reasons stay private.</div>
          </div>
          {loading && <span className="text-brand"><Spinner small /></span>}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-lg border border-line-strong bg-surface">
              <button type="button" aria-label="Previous" onClick={() => api()?.prev()} className="rounded-l-lg p-2 text-muted hover:bg-paper hover:text-ink"><Icon name="chevronLeft" size={16} /></button>
              <button type="button" onClick={() => api()?.today()} className="border-x border-line px-3 py-1.5 text-[13px] font-medium hover:bg-paper">Today</button>
              <button type="button" aria-label="Next" onClick={() => api()?.next()} className="rounded-r-lg p-2 text-muted hover:bg-paper hover:text-ink"><Icon name="chevronRight" size={16} /></button>
            </div>
            <Select aria-label="View" className="w-32" value={view} onChange={(e) => changeView(e.target.value as View)}>
              <option value="dayGridMonth">Month view</option>
              <option value="dayGridWeek">Week view</option>
            </Select>
          </div>
        </div>
        {error && <div className="px-4 pt-3 sm:px-5"><Note>{error}</Note></div>}

        <div className="grid lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* Side panel */}
          <aside className="order-2 space-y-5 border-t border-line p-4 lg:order-1 lg:border-r lg:border-t-0">
            <section>
              <h3 className="mb-2 flex items-center justify-between text-[14px] font-semibold">
                Away today
                <span className={cx('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', awayToday.length ? 'bg-amber-soft text-amber' : 'bg-brand-soft text-brand-strong')}>{awayToday.length ? `${awayToday.length} away` : 'Everyone in'}</span>
              </h3>
              {!awayToday.length && <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-faint">Nobody on your team is away today.</p>}
              <ul className="space-y-1">
                {awayToday.map((e) => (
                  <PersonRow key={e.id} leave={e} active={focus === e.employeeId} onClick={() => setFocus(focus === e.employeeId ? null : e.employeeId)} note={e.endDate === today ? (e.halfDay ? 'Half day today' : 'Back tomorrow') : `Back ${formatDate(addDaysTo(e.endDate, 1))}`} />
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-[14px] font-semibold">Coming up <span className="ml-1 text-[12px] font-normal text-muted">next 2 weeks</span></h3>
              {!comingUp.length && <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-faint">No leave planned in the next two weeks.</p>}
              <ul className="space-y-1">
                {comingUp.map((e) => (
                  <PersonRow key={e.id} leave={e} active={focus === e.employeeId} onClick={() => setFocus(focus === e.employeeId ? null : e.employeeId)} note={`${formatRange(e.startDate, e.endDate)} · ${dayLabel(workingDays(e.startDate, e.endDate, e.halfDay))}`} />
                ))}
              </ul>
            </section>

            {people.length > 0 && (
              <section>
                <h3 className="mb-2 flex items-center justify-between text-[14px] font-semibold">
                  People
                  {focus && <button type="button" onClick={() => setFocus(null)} className="text-[12px] font-medium text-brand hover:underline">Show everyone</button>}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {people.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={focus === p.id}
                      onClick={() => setFocus(focus === p.id ? null : p.id)}
                      className={cx('inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[12px] font-medium transition-colors', focus === p.id ? 'border-ink bg-ink text-white' : focus ? 'border-line text-faint hover:text-ink' : 'border-line text-ink hover:bg-paper')}
                    >
                      <span aria-hidden className="h-5 w-5 rounded-full" style={{ backgroundColor: colourFor(p.id) }} />
                      {p.name.split(' ')[0]}
                    </button>
                  ))}
                </div>
                {focused && (
                  <div className="mt-3 rounded-lg bg-paper p-3 text-[12.5px]">
                    <div className="mb-1.5 font-semibold">{focused.name}</div>
                    <ul className="space-y-1 text-muted">
                      {focused.leaves.sort((a, b) => a.startDate.localeCompare(b.startDate)).map((l) => (
                        <li key={l.id} className="flex justify-between gap-2"><span>{formatRange(l.startDate, l.endDate)}</span><span className="tnum">{dayLabel(workingDays(l.startDate, l.endDate, l.halfDay))}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </aside>

          {/* Calendar */}
          <div className="team-cal order-1 min-w-0 p-3 sm:p-4 lg:order-2">
            <FullCalendar
              ref={ref}
              plugins={PLUGINS}
              locales={LOCALES}
              locale="en-gb"
              initialView="dayGridMonth"
              headerToolbar={false}
              dayHeaderFormat={HEADER_FORMAT}
              views={VIEWS}
              firstDay={1}
              height="auto"
              dayMaxEvents={4}
              fixedWeekCount={false}
              events={fcEvents}
              dayCellContent={dayCell}
              eventContent={eventContent}
              datesSet={datesSet}
              eventClick={eventClick}
            />
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-[#f9e7cf]" />Holiday</span>
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-[#ebe9e2]" />Weekend</span>
              <span>Click a person to highlight their leave.</span>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

function PersonRow({ leave, note, active, onClick }: { leave: TeamAway; note: string; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-pressed={active} className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors', active ? 'bg-brand-soft' : 'hover:bg-paper')}>
        <span className="relative">
          <Avatar name={leave.employeeName} url={leave.avatarFile ? `/employees/${leave.employeeId}/avatar?v=${leave.avatarFile}` : null} />
          <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface" style={{ backgroundColor: colourFor(leave.employeeId) }} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{leave.employeeName}{leave.halfDay ? ' · ½ day' : ''}</span>
          <span className="block truncate text-[11.5px] text-muted">{note}</span>
        </span>
      </button>
    </li>
  );
}

/** Shown while applying, so people can see who else is out before they choose dates. */
export function AwayNote({ start, end }: { start?: string; end?: string }) {
  const { data } = useFetch<{ events: TeamAway[] }>(start && end && start <= end ? '/calendar/team' : null, { start, end });
  const names = [...new Set((data?.events ?? []).map((e) => e.employeeName))];
  if (!names.length) return null;
  return <Note tone="sky">Also away on these dates: {names.join(', ')}</Note>;
}
