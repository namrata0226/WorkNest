import { MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import type { CalendarItem } from '../../types';
import { addDaysTo, formatDate, formatRange, todayString } from '../../utils/date';
import { daysFrom, formatDuration, formatHour, formatReminder, formatTime, formatTimeRange, fromMinutes, layoutLanes, monthGrid, shiftMonth, toMinutes, weekStart } from '../../utils/planner';
import { titleCase } from '../../utils/labels';
import { Avatar } from '../Avatar';
import { Icon, IconName } from '../icons';
import type { CalendarEvent, CalendarHoliday } from '../LeaveCalendar';
import { Button, Card, cx, Modal, Note, Select, Spinner, StatusBadge, Tabs, useConfirm, useToast } from '../ui';
import { ItemDraft, ItemModal } from './ItemModal';
import { TONES } from './tones';

export type PlannerView = 'day' | 'week' | 'month';
type Filter = 'all' | 'events' | 'tasks' | 'away';

/** One thing on the calendar, whatever it came from. */
interface Entry {
  key: string;
  type: 'EVENT' | 'TASK' | 'LEAVE' | 'HOLIDAY';
  title: string;
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  tone: keyof typeof TONES;
  /** A leave type's own colour, used instead of a tone. */
  color?: string;
  done?: boolean;
  item?: CalendarItem;
  leave?: CalendarEvent;
  holiday?: CalendarHoliday;
}

const HOUR_PX = 72;
const GUTTER = 72;
const TASK_MINUTES = 30;

const covers = (e: Entry, day: string) => e.date <= day && e.endDate >= day;
const startOf = (e: Entry) => toMinutes(e.startTime!);
const endOf = (e: Entry) => (e.endTime ? toMinutes(e.endTime) : startOf(e) + TASK_MINUTES);

const MONTH_SHORT = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const MONTH_LONG = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const LONG_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const WEEKDAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const utc = (d: string) => new Date(`${d}T00:00:00Z`);

function toEntries(items: CalendarItem[], leave: CalendarEvent[], holidays: CalendarHoliday[]): Entry[] {
  return [
    ...holidays.map((h): Entry => ({ key: `h-${h.id}-${h.date}`, type: 'HOLIDAY', title: `${h.name}${h.isHalfDay ? ' (half day)' : ''}`, date: h.date, endDate: h.date, allDay: true, startTime: null, endTime: null, tone: 'holiday', holiday: h })),
    ...leave.map((l): Entry => {
      const half = l.dayType === 'HALF' ? ` (${l.halfSession === 'FIRST' ? '1st' : '2nd'} half)` : '';
      return { key: `l-${l.id}`, type: 'LEAVE', title: `${l.leaveType.name}${half}`, date: l.start, endDate: addDaysTo(l.endExclusive, -1), allDay: true, startTime: null, endTime: null, tone: 'slate', color: l.leaveType.color, leave: l };
    }),
    ...items.map((i): Entry => ({ key: `i-${i._id}`, type: i.kind, title: i.title, date: i.date, endDate: i.endDate, allDay: i.allDay, startTime: i.startTime, endTime: i.endTime, tone: i.color, done: i.done, item: i })),
  ];
}

const FILTERS: Record<Filter, (e: Entry) => boolean> = {
  all: () => true,
  events: (e) => e.type === 'EVENT',
  tasks: (e) => e.type === 'TASK',
  away: (e) => e.type === 'LEAVE' || e.type === 'HOLIDAY',
};

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useWide() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const list = window.matchMedia(query);
    const on = () => setWide(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return wide;
}

export function Planner() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const wide = useWide();
  const today = todayString();
  const [cursor, setCursor] = useState(today);
  const [view, setView] = useState<PlannerView>(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 'day' : 'week'));
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item?: CalendarItem; draft?: ItemDraft } | null>(null);

  // One fetch covers the six-week month grid around the cursor, which always contains its week and day.
  const grid = useMemo(() => monthGrid(cursor.slice(0, 7)), [cursor]);
  const range = { start: grid[0], end: grid[grid.length - 1] };
  const items = useFetch<CalendarItem[]>('/calendar/items', range);
  const away = useFetch<{ events: CalendarEvent[]; holidays: CalendarHoliday[] }>(user?.employee ? '/calendar/employee' : null, range);

  const all = useMemo(() => toEntries(items.data ?? [], away.data?.events ?? [], away.data?.holidays ?? []), [items.data, away.data]);
  const entries = useMemo(() => all.filter(FILTERS[filter]), [all, filter]);
  const selected = all.find((e) => e.key === selectedKey) ?? null;

  const days = view === 'day' ? [cursor] : view === 'week' ? daysFrom(weekStart(cursor), 7) : grid;
  const move = (by: number) => {
    setSelectedKey(null);
    if (view === 'day') setCursor(addDaysTo(cursor, by));
    else if (view === 'week') setCursor(addDaysTo(cursor, by * 7));
    else setCursor(`${shiftMonth(cursor.slice(0, 7), by)}-01`);
  };
  const title = view === 'month' ? MONTH_LONG.format(utc(cursor)) : view === 'week' ? formatRange(days[0], days[6]) : LONG_DATE.format(utc(cursor));

  const reload = async () => {
    await items.reload();
  };
  const add = (draft: ItemDraft) => setEditing({ draft });

  const toggleDone = async (item: CalendarItem) => {
    try {
      await api.patch(`/calendar/items/${item._id}/done`, { done: !item.done });
      toast(item.done ? 'Task reopened' : 'Task done');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const remove = async (item: CalendarItem) => {
    const noun = item.kind === 'TASK' ? 'task' : 'event';
    const ok = await confirm({
      title: `Delete this ${noun}?`,
      message: `"${item.title}" will be removed${item.visibility === 'COMPANY' ? ' from everyone’s calendar' : ''}. This cannot be undone.`,
      confirmLabel: `Delete ${noun}`,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/calendar/items/${item._id}`);
      toast(`${noun === 'task' ? 'Task' : 'Event'} deleted`);
      setSelectedKey(null);
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const canEdit = (item: CalendarItem) => String(item.owner) === String(user?.id) || (item.visibility === 'COMPANY' && Boolean(user?.permissions.includes('announcements:manage')));

  const details = selected ? (
    <EntryDetails entry={selected} meId={user?.id} canEdit={selected.item ? canEdit(selected.item) : false} onEdit={(item) => setEditing({ item })} onDelete={remove} onToggle={toggleDone} onClose={() => setSelectedKey(null)} />
  ) : null;

  return (
    <Card flush>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <DateBadge date={cursor} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight">{title}</div>
          <div className="text-[13px] text-muted">{view === 'day' ? WEEKDAY_LONG.format(utc(cursor)) : view === 'week' ? `Week of ${DAY_MONTH.format(utc(days[0]))}` : `${entries.filter((e) => grid.some((d) => covers(e, d))).length} items`}</div>
        </div>
        <div className="order-3 w-full xl:order-none xl:w-auto">
          <Tabs<Filter>
            value={filter}
            onChange={(f) => { setFilter(f); setSelectedKey(null); }}
            tabs={[{ value: 'all', label: 'All' }, { value: 'events', label: 'Events' }, { value: 'tasks', label: 'Tasks' }, { value: 'away', label: 'Leave & holidays' }]}
          />
        </div>
        {(items.loading || away.loading) && <span className="text-brand"><Spinner small /></span>}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-line-strong bg-surface">
            <button type="button" aria-label={`Previous ${view}`} onClick={() => move(-1)} className="rounded-l-lg p-2 text-muted hover:bg-paper hover:text-ink"><Icon name="chevronLeft" size={16} /></button>
            <button type="button" onClick={() => { setCursor(today); setSelectedKey(null); }} className="border-x border-line px-3 py-1.5 text-[13px] font-medium hover:bg-paper">Today</button>
            <button type="button" aria-label={`Next ${view}`} onClick={() => move(1)} className="rounded-r-lg p-2 text-muted hover:bg-paper hover:text-ink"><Icon name="chevronRight" size={16} /></button>
          </div>
          <Select aria-label="View" className="w-32" value={view} onChange={(e) => setView(e.target.value as PlannerView)}>
            <option value="day">Day view</option>
            <option value="week">Week view</option>
            <option value="month">Month view</option>
          </Select>
          <Button variant="primary" aria-label="Add an event or task" onClick={() => add({ kind: 'EVENT', date: cursor < today && view !== 'day' ? today : cursor })}><Icon name="plus" size={16} /><span className="hidden sm:inline">Add</span></Button>
        </div>
      </div>

      {(items.error || away.error) && <div className="px-4 pt-3 sm:px-5"><Note>{items.error ?? away.error}</Note></div>}

      <div className="grid lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Side panel */}
        <aside className="order-2 border-t border-line lg:order-1 lg:border-r lg:border-t-0">
          <MiniMonth cursor={cursor} today={today} entries={all} onPick={(d) => { setCursor(d); setSelectedKey(null); }} />
          <div className="border-t border-line p-4">
            {wide && details ? details : (
              <div className="space-y-5">
                <Agenda date={cursor} today={today} entries={entries} onSelect={setSelectedKey} onAdd={() => add({ kind: 'EVENT', date: cursor })} />
                <TaskList entries={all} days={days} onSelect={setSelectedKey} onToggle={toggleDone} onAdd={() => add({ kind: 'TASK', date: cursor })} />
              </div>
            )}
          </div>
        </aside>

        {/* Main grid */}
        <div className="order-1 min-w-0 lg:order-2">
          {view === 'month' ? (
            <MonthGrid days={grid} month={cursor.slice(0, 7)} today={today} entries={entries} selectedKey={selectedKey} onSelect={setSelectedKey} onDay={(d) => { setCursor(d); setView('day'); }} onAdd={(d) => add({ kind: 'EVENT', date: d, allDay: true })} />
          ) : (
            <TimeGrid days={days} today={today} entries={entries} selectedKey={selectedKey} onSelect={setSelectedKey} onToggle={toggleDone} onAdd={(date, start) => add({ kind: 'EVENT', date, startTime: start, endTime: fromMinutes(toMinutes(start) + 60) })} onDay={(d) => { setCursor(d); setView('day'); }} />
          )}
        </div>
      </div>

      {!wide && selected && <Modal title={selected.type === 'TASK' ? 'Task' : selected.type === 'EVENT' ? 'Event' : selected.type === 'LEAVE' ? 'Leave' : 'Holiday'} onClose={() => setSelectedKey(null)}>{details}</Modal>}
      {editing && (
        <ItemModal
          item={editing.item}
          draft={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setCursor(saved.date);
            setSelectedKey(`i-${saved._id}`);
            void reload();
          }}
        />
      )}
    </Card>
  );
}

export function DateBadge({ date }: { date: string }) {
  return (
    <div aria-hidden className="w-14 shrink-0 overflow-hidden rounded-xl border border-line text-center shadow-[0_1px_2px_rgba(16,24,40,0.06)]">
      <div className="bg-rose py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-white">{MONTH_SHORT.format(utc(date))}</div>
      <div className="tnum bg-surface py-1 text-[20px] font-bold leading-tight">{Number(date.slice(8))}</div>
    </div>
  );
}

/* Mini month */

function MiniMonth({ cursor, today, entries, onPick }: { cursor: string; today: string; entries: Entry[]; onPick: (date: string) => void }) {
  const month = cursor.slice(0, 7);
  const grid = monthGrid(month);
  const busy = new Set(grid.filter((d) => entries.some((e) => covers(e, d) && e.type !== 'HOLIDAY')));
  const holiday = new Set(grid.filter((d) => entries.some((e) => covers(e, d) && e.type === 'HOLIDAY')));
  // Five rows are enough when the month fits, so the panel does not end on a row of next month.
  const rows = grid.slice(35).every((d) => !d.startsWith(month)) ? grid.slice(0, 35) : grid;
  return (
    <div className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" aria-label="Previous month" onClick={() => onPick(`${shiftMonth(month, -1)}-01`)} className="rounded-md p-1.5 text-muted hover:bg-paper hover:text-ink"><Icon name="chevronLeft" size={16} /></button>
        <div className="text-[14px] font-semibold">{MONTH_LONG.format(utc(`${month}-01`))}</div>
        <button type="button" aria-label="Next month" onClick={() => onPick(`${shiftMonth(month, 1)}-01`)} className="rounded-md p-1.5 text-muted hover:bg-paper hover:text-ink"><Icon name="chevronRight" size={16} /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11.5px] font-semibold text-muted">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => <div key={d} className="py-1.5">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[13px]">
        {rows.map((d) => {
          const inMonth = d.startsWith(month);
          const isCursor = d === cursor;
          const isToday = d === today;
          return (
            <button
              key={d}
              type="button"
              aria-label={formatDate(d)}
              aria-pressed={isCursor}
              onClick={() => onPick(d)}
              className={cx(
                'tnum relative mx-auto flex h-9 w-9 items-center justify-center rounded-full transition-colors',
                isCursor ? 'bg-ink font-semibold text-white' : isToday ? 'bg-brand-soft font-semibold text-brand-strong' : 'hover:bg-paper',
                !inMonth && !isCursor && 'text-faint',
              )}
            >
              {Number(d.slice(8))}
              {(busy.has(d) || holiday.has(d)) && <span aria-hidden className={cx('absolute bottom-1 h-1 w-1 rounded-full', isCursor ? 'bg-white' : holiday.has(d) && !busy.has(d) ? TONES.holiday.dot : 'bg-ink')} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* Side panel: details of the selected entry */

function DetailRow({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <div className="flex items-start gap-2.5 text-[13px] text-muted"><Icon name={icon} size={16} className="mt-0.5 shrink-0 text-faint" /><div className="min-w-0">{children}</div></div>;
}

function EntryDetails({ entry, meId, canEdit, onEdit, onDelete, onToggle, onClose }: { entry: Entry; meId?: string; canEdit: boolean; onEdit: (item: CalendarItem) => void; onDelete: (item: CalendarItem) => Promise<void>; onToggle: (item: CalendarItem) => Promise<void>; onClose: () => void }) {
  const { item, leave } = entry;
  const when = entry.date === entry.endDate ? `${WEEKDAY_SHORT.format(utc(entry.date))}, ${formatDate(entry.date)}` : formatRange(entry.date, entry.endDate);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{entry.type === 'TASK' ? 'Task' : entry.type === 'EVENT' ? 'Event' : entry.type === 'LEAVE' ? 'Leave' : 'Holiday'}</div>
          <h3 className={cx('text-[16px] font-semibold leading-snug', entry.done && 'text-muted line-through')}>{entry.title}</h3>
        </div>
        <button type="button" aria-label="Close details" onClick={onClose} className="hidden rounded-md p-1 text-faint hover:bg-paper hover:text-ink lg:block">✕</button>
      </div>
      {item?.reminderMinutes != null && !item.allDay && (
        <div className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-rose"><Icon name="alarm" size={15} />{formatReminder(item.reminderMinutes)}</div>
      )}
      <DetailRow icon="calendar">{when}</DetailRow>
      {!entry.allDay && entry.startTime && (
        <DetailRow icon="clock">{entry.endTime ? `${formatDuration(entry.startTime, entry.endTime)} (${formatTimeRange(entry.startTime, entry.endTime)})` : `Due ${formatTime(entry.startTime)}`}</DetailRow>
      )}
      {item?.location && <DetailRow icon="pin"><span className="break-words">{item.location}</span></DetailRow>}
      {item?.visibility === 'COMPANY' && <DetailRow icon="users">Everyone in the company can see this</DetailRow>}
      {item && (
        <div className="flex items-center gap-2.5 rounded-lg bg-paper px-2.5 py-2 text-[13px]">
          <Avatar name={item.ownerName} />
          <div className="min-w-0">
            <div className="text-[11px] text-muted">Added by</div>
            <div className="truncate font-medium">{item.ownerName}{String(item.owner) === String(meId) ? ' (you)' : ''}</div>
          </div>
        </div>
      )}
      {item?.description && (
        <div>
          <div className="mb-1 text-[13px] font-semibold">{entry.type === 'TASK' ? 'Notes' : 'About this event'}</div>
          <p className="whitespace-pre-wrap break-words text-[13px] text-muted">{item.description}</p>
        </div>
      )}
      {leave && (
        <>
          <div className="flex items-center gap-2"><StatusBadge status={leave.status} />{leave.status === 'PENDING' && <span className="text-xs text-muted">Waiting for approval</span>}</div>
          <Link to={`/leaves/${leave.requestId}`} className="inline-flex text-[13px] font-medium text-brand hover:underline">Open leave request →</Link>
        </>
      )}
      {entry.holiday && <DetailRow icon="users">{entry.holiday.isHalfDay ? 'Half-day holiday' : 'Holiday'} · {titleCase(entry.holiday.category)}</DetailRow>}
      {item && canEdit && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {item.kind === 'TASK' && <Button small variant={item.done ? 'secondary' : 'primary'} onClick={() => onToggle(item)}><Icon name="check" size={14} />{item.done ? 'Mark not done' : 'Mark as done'}</Button>}
          <Button small onClick={() => onEdit(item)}><Icon name="pencil" size={14} />Edit</Button>
          <Button small variant="ghost" className="text-rose" onClick={() => onDelete(item)}><Icon name="trash" size={14} />Delete</Button>
        </div>
      )}
      {item && !canEdit && <p className="text-xs text-faint">Added by {item.ownerName}. Only they can change it.</p>}
    </div>
  );
}

/* Side panel: the selected day's schedule and the tasks in view */

/** "Namrata" with initials, for cards where space is short; the full name is in the tooltip. */
function Owner({ name, full }: { name: string; full?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted" title={`Added by ${name}`}>
      <Avatar name={name} size="xs" />
      <span className="truncate">{full ? name : name.split(' ')[0]}</span>
    </span>
  );
}

function Agenda({ date, today, entries, onSelect, onAdd }: { date: string; today: string; entries: Entry[]; onSelect: (key: string) => void; onAdd: () => void }) {
  const items = entries
    .filter((e) => e.type !== 'TASK' && covers(e, date))
    .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const label = date === today ? 'Today' : `${WEEKDAY_SHORT.format(utc(date))}, ${DAY_MONTH.format(utc(date))}`;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold">Schedule <span className="ml-1 text-[12px] font-normal text-muted">{label}</span></h3>
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-brand hover:bg-brand-soft"><Icon name="plus" size={14} />Add event</button>
      </div>
      {!items.length && <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-faint">Nothing scheduled. Click a time on the calendar to add something.</p>}
      <ul className="space-y-1.5">
        {items.map((e) => {
          const tone = TONES[e.tone];
          return (
            <li key={e.key}>
              <button type="button" onClick={() => onSelect(e.key)} className="flex w-full items-stretch gap-2.5 rounded-lg border border-line bg-surface p-2 text-left transition-colors hover:border-line-strong hover:bg-paper">
                <span aria-hidden className={cx('w-1 shrink-0 rounded-full', !e.color && tone.swatch)} style={e.color ? { backgroundColor: e.color } : undefined} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{e.title}</span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="tnum text-[11.5px] text-muted">{e.allDay ? (e.type === 'LEAVE' ? 'Leave · all day' : e.type === 'HOLIDAY' ? 'Holiday' : 'All day') : formatTimeRange(e.startTime, e.endTime)}</span>
                    {e.item && <Owner name={e.item.ownerName} />}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskList({ entries, days, onSelect, onToggle, onAdd }: { entries: Entry[]; days: string[]; onSelect: (key: string) => void; onToggle: (item: CalendarItem) => Promise<void>; onAdd: () => void }) {
  const [showDone, setShowDone] = useState(false);
  const first = days[0];
  const last = days[days.length - 1];
  const tasks = entries
    .filter((e) => e.type === 'TASK' && e.date >= first && e.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const period = days.length === 1 ? 'day' : days.length === 7 ? 'week' : 'month';

  const row = (t: Entry) => (
    <li key={t.key} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-paper">
      <TaskCheck done={Boolean(t.done)} onToggle={() => onToggle(t.item!)} label={t.title} />
      <button type="button" onClick={() => onSelect(t.key)} className="min-w-0 flex-1 text-left">
        <div className={cx('truncate text-[13px] font-medium', t.done && 'text-faint line-through')}>{t.title}</div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cx('tnum text-[11.5px]', !t.done && t.date < todayString() ? 'font-medium text-rose' : 'text-muted')}>
            {!t.done && t.date < todayString() ? 'Overdue · ' : ''}{DAY_MONTH.format(utc(t.date))}{t.startTime ? ` · ${formatTime(t.startTime)}` : ''}
          </span>
          {t.item && <Owner name={t.item.ownerName} />}
        </div>
      </button>
    </li>
  );

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold">Tasks <span className="ml-1 text-[12px] font-normal text-muted">{open.length} open</span></h3>
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-brand hover:bg-brand-soft"><Icon name="plus" size={14} />Add task</button>
      </div>
      {!open.length && <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-faint">{done.length ? `All done for this ${period}.` : `No tasks this ${period}.`}</p>}
      <ul className="space-y-0.5">{open.map(row)}</ul>
      {done.length > 0 && (
        <div className="mt-2">
          <button type="button" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} className="flex items-center gap-1 px-2 py-1 text-[12px] font-medium text-muted hover:text-ink">
            <Icon name={showDone ? 'chevronLeft' : 'chevronRight'} size={13} className={showDone ? '-rotate-90' : ''} />
            Completed ({done.length})
          </button>
          {showDone && <ul className="space-y-0.5">{done.map(row)}</ul>}
        </div>
      )}
    </section>
  );
}

function TaskCheck({ done, onToggle, label }: { done: boolean; onToggle: () => Promise<void> | void; label: string }) {
  const [busy, setBusy] = useState(false);
  const click = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onToggle();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`${done ? 'Reopen' : 'Complete'} ${label}`}
      disabled={busy}
      onClick={click}
      className={cx('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors disabled:opacity-50', done ? 'border-brand bg-brand text-white' : 'border-faint hover:border-brand')}
    >
      {done && <Icon name="check" size={11} strokeWidth={3} />}
    </button>
  );
}

/* Week and day views */

function EntryChip({ entry, selected, onSelect, onToggle, compact }: { entry: Entry; selected: boolean; onSelect: () => void; onToggle?: (item: CalendarItem) => Promise<void>; compact?: boolean }) {
  const tone = TONES[entry.tone];
  const style = entry.color ? { backgroundColor: `${entry.color}1f`, color: entry.color } : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      title={entry.title}
      style={style}
      className={cx('flex w-full cursor-pointer items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-left text-[11.5px] font-medium', !entry.color && tone.card, !entry.color && tone.title, selected && 'ring-2 ring-ink/70', entry.leave?.status === 'PENDING' && 'border border-dashed border-current')}
    >
      {entry.type === 'TASK' && onToggle && <TaskCheck done={Boolean(entry.done)} onToggle={() => onToggle(entry.item!)} label={entry.title} />}
      {compact && entry.startTime && <span className="tnum shrink-0 opacity-75">{formatTime(entry.startTime).replace(':00', '')}</span>}
      <span className={cx('min-w-0 flex-1 truncate', entry.done && 'line-through opacity-60')}>{entry.title}</span>
      {entry.type === 'TASK' && entry.item && !compact && <span className="hidden sm:inline" title={`Added by ${entry.item.ownerName}`}><Avatar name={entry.item.ownerName} size="xs" /></span>}
    </div>
  );
}

/**
 * Where an event sits among the ones it overlaps. A wide single-day column splits them side by side; the narrow
 * week columns stack them with a small offset, newest on top, so each title stays readable.
 */
function placement(lane: number, lanes: number, wide: boolean) {
  if (lanes === 1) return { left: 3, width: 'calc(100% - 6px)' };
  if (wide) return { left: `calc(${(lane / lanes) * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` };
  const step = Math.min(18, 36 / (lanes - 1));
  return { left: 3 + lane * step, width: `calc(100% - ${6 + lane * step}px)`, zIndex: lane + 1 };
}

function TimeGrid({ days, today, entries, selectedKey, onSelect, onToggle, onAdd, onDay }: { days: string[]; today: string; entries: Entry[]; selectedKey: string | null; onSelect: (key: string) => void; onToggle: (item: CalendarItem) => Promise<void>; onAdd: (date: string, start: string) => void; onDay: (date: string) => void }) {
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  const visible = entries.filter((e) => days.some((d) => covers(e, d)));
  const timed = visible.filter((e) => !e.allDay && e.startTime);
  const firstHour = Math.min(8, ...timed.map((e) => Math.floor(startOf(e) / 60)));
  const lastHour = Math.max(19, ...timed.map((e) => Math.ceil(endOf(e) / 60)));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNow = days.includes(today) && nowMinutes >= firstHour * 60 && nowMinutes <= lastHour * 60;
  const nowTop = ((nowMinutes - firstHour * 60) / 60) * HOUR_PX;
  const columns = { gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))` };

  // Open at the current time when today is shown, otherwise at the first thing that happens.
  const anchor = showNow ? nowMinutes - 60 : timed.length ? Math.min(...timed.map(startOf)) - 30 : 9 * 60;
  const key = days.join();
  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, ((anchor - firstHour * 60) / 60) * HOUR_PX) });
    // Only when the days shown change, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const allDayFor = (d: string) => visible.filter((e) => (e.allDay || !e.startTime) && covers(e, d));
  const hasAllDay = days.some((d) => allDayFor(d).length > 0);

  // The half hour under the pointer, previewed as a dashed "+ time" box before a click adds an event there.
  const [hover, setHover] = useState<{ date: string; minutes: number } | null>(null);
  const slotAt = (e: ReactMouseEvent<HTMLDivElement>) => firstHour * 60 + Math.floor((e.nativeEvent.offsetY / HOUR_PX) * 2) * 30;
  const slotClick = (date: string) => (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    onAdd(date, fromMinutes(slotAt(e)));
  };
  const slotHover = (date: string) => (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return setHover(null);
    const minutes = slotAt(e);
    if (hover?.date !== date || hover.minutes !== minutes) setHover({ date, minutes });
  };

  return (
    <div className="overflow-x-auto">
      <div className={days.length > 1 ? 'min-w-[760px]' : ''}>
        {/* Day headings */}
        <div className="grid border-b border-line" style={columns}>
          <div />
          {days.map((d) => {
            const isToday = d === today;
            return (
              <button key={d} type="button" onClick={() => onDay(d)} title="Open this day" className={cx('group flex flex-col items-center gap-1 border-l border-line px-1 py-2.5 transition-colors hover:bg-paper', isToday && 'bg-brand-soft/40')}>
                <span className={cx('text-[11.5px] font-semibold uppercase tracking-wider', isToday ? 'text-brand-strong' : 'text-muted')}>{days.length === 1 ? WEEKDAY_LONG.format(utc(d)) : WEEKDAY_SHORT.format(utc(d))}</span>
                <span className={cx('tnum flex h-9 min-w-9 items-center justify-center rounded-full px-1.5 text-[19px] font-semibold leading-none', isToday ? 'bg-brand text-white' : 'text-ink group-hover:bg-line/60')}>{Number(d.slice(8))}</span>
              </button>
            );
          })}
        </div>

        {/* All-day row: leave, holidays, all-day events and tasks without a time */}
        {hasAllDay && (
          <div className="grid border-b border-line bg-paper/40" style={columns}>
            <div className="px-2 py-1.5 text-right text-[10.5px] font-medium uppercase tracking-wide text-faint">All day</div>
            {days.map((d) => (
              <div key={d} className="min-w-0 space-y-1 border-l border-line p-1">
                {allDayFor(d).map((e) => <EntryChip key={e.key} entry={e} selected={selectedKey === e.key} onSelect={() => onSelect(e.key)} onToggle={onToggle} />)}
              </div>
            ))}
          </div>
        )}

        {/* Hours */}
        <div ref={scroller} className="relative h-[max(480px,calc(100vh-290px))] overflow-y-auto">
          <div className="relative grid" style={columns}>
            <div>
              {hours.map((h) => (
                <div key={h} className="relative border-b border-transparent pr-2 text-right" style={{ height: HOUR_PX }}>
                  <span className="relative -top-2 text-[11px] font-medium text-faint">{h === firstHour || (showNow && Math.abs(nowMinutes - h * 60) < 20) ? '' : formatHour(h)}</span>
                </div>
              ))}
            </div>
            {days.map((d) => {
              const laid = layoutLanes(timed.filter((e) => covers(e, d)).map((e) => ({ ...e, id: e.key, start: startOf(e), end: Math.max(endOf(e), startOf(e) + 20) })));
              // Stacking hides the lower card's title when two start close together, so those sit side by side.
              const sideBySide = days.length === 1 || laid.some((a) => laid.some((b) => a !== b && a.lanes > 1 && Math.abs(a.start - b.start) < 30 && a.start < b.end && b.start < a.end));
              return (
                <div
                  key={d}
                  onClick={slotClick(d)}
                  onMouseMove={slotHover(d)}
                  onMouseLeave={() => setHover(null)}
                  className={cx('relative cursor-cell border-l border-line', d === today && 'bg-brand-soft/20')}
                  style={{ height: hours.length * HOUR_PX, backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--color-line) ${HOUR_PX - 1}px, var(--color-line) ${HOUR_PX}px)` }}
                >
                  {hover?.date === d && (
                    <div aria-hidden className="pointer-events-none absolute inset-x-1 flex items-start rounded-md border border-dashed border-brand/60 bg-brand-soft/60 px-2 py-1 text-[11.5px] font-medium text-brand-strong" style={{ top: ((hover.minutes - firstHour * 60) / 60) * HOUR_PX + 1, height: HOUR_PX / 2 - 2 }}>
                      + {formatTime(fromMinutes(hover.minutes))}
                    </div>
                  )}
                  {laid.map((e) => {
                    const top = ((e.start - firstHour * 60) / 60) * HOUR_PX;
                    const height = Math.max(24, ((e.end - e.start) / 60) * HOUR_PX - 3);
                    const tone = TONES[e.tone];
                    const short = height < 44;
                    const roomy = height >= 84;
                    return (
                      <div
                        key={e.key}
                        role="button"
                        tabIndex={0}
                        aria-label={`${e.title}, ${formatTimeRange(e.startTime, e.endTime)}`}
                        onClick={(ev) => { ev.stopPropagation(); onSelect(e.key); }}
                        onKeyDown={(ev) => { if (ev.key === 'Enter') onSelect(e.key); }}
                        className={cx('absolute cursor-pointer overflow-hidden rounded-lg border border-line/70 border-t-[3px] px-2 py-1 shadow-[0_1px_2px_rgba(16,24,40,0.06)] transition-shadow hover:z-20 hover:shadow-md', tone.card, tone.accent, selectedKey === e.key ? 'z-20 ring-2 ring-ink/70' : 'ring-1 ring-surface')}
                        style={{ top: top + 1, height, ...placement(e.lane, e.lanes, sideBySide) }}
                      >
                        <div className="flex items-start gap-1.5">
                          {e.type === 'TASK' && <TaskCheck done={Boolean(e.done)} onToggle={() => onToggle(e.item!)} label={e.title} />}
                          <div className="min-w-0 flex-1">
                            <div className={cx('text-[12px] font-semibold leading-tight', tone.title, short ? 'truncate' : 'line-clamp-2', e.done && 'line-through opacity-60')}>{e.title}</div>
                            {!short && <div className={cx('tnum mt-0.5 truncate text-[11px] opacity-80', tone.title)}>{formatTimeRange(e.startTime, e.endTime)}</div>}
                          </div>
                          {/* Tasks are short, so their author is a small avatar beside the title. */}
                          {!roomy && e.item && e.type === 'TASK' && (e.lanes === 1 || !sideBySide) && <span title={`Added by ${e.item.ownerName}`}><Avatar name={e.item.ownerName} size="xs" /></span>}
                        </div>
                        {roomy && e.item && <div className="absolute inset-x-2 bottom-1.5"><Owner name={e.item.ownerName} /></div>}
                        {!short && height > 104 && e.item?.location && <div className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted"><Icon name="pin" size={12} />{e.item.location}</div>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {showNow && (
              <div aria-hidden className="pointer-events-none absolute right-0 z-10" style={{ top: nowTop, left: GUTTER - 4 }}>
                <div className="relative h-0 border-t-2 border-ink">
                  <span className="tnum absolute -top-[11px] left-[-66px] rounded-md bg-ink px-1.5 py-0.5 text-[10.5px] font-semibold text-white">{formatTime(fromMinutes(nowMinutes))}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Month view */

function MonthGrid({ days, month, today, entries, selectedKey, onSelect, onDay, onAdd }: { days: string[]; month: string; today: string; entries: Entry[]; selectedKey: string | null; onSelect: (key: string) => void; onDay: (date: string) => void; onAdd: (date: string) => void }) {
  const rows = days.slice(35).every((d) => !d.startsWith(month)) ? days.slice(0, 35) : days;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-7 border-b border-line text-center text-[12px] font-medium text-muted">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-l border-line py-2 first:border-l-0">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {rows.map((d, i) => {
            const dayEntries = entries
              .filter((e) => covers(e, d))
              .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
            const more = dayEntries.length - 3;
            const weekend = i % 7 >= 5;
            return (
              <div
                key={d}
                onClick={(e) => { if (e.target === e.currentTarget) onAdd(d); }}
                title="Click to add an event"
                className={cx('min-h-[132px] cursor-cell border-b border-l border-line p-1.5 [&:nth-child(7n+1)]:border-l-0', weekend && 'bg-paper/50', !d.startsWith(month) && 'opacity-55')}
              >
                <button type="button" onClick={() => onDay(d)} className={cx('tnum mb-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12px] font-semibold hover:bg-paper', d === today ? 'bg-ink text-white hover:bg-ink' : 'text-muted')}>{Number(d.slice(8))}</button>
                <div className="space-y-0.5">
                  {dayEntries.slice(0, 3).map((e) => <EntryChip key={e.key} compact entry={e} selected={selectedKey === e.key} onSelect={() => onSelect(e.key)} />)}
                  {more > 0 && <button type="button" onClick={() => onDay(d)} className="px-1.5 text-[11px] font-medium text-brand hover:underline">+{more} more</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

