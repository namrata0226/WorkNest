import { ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PersonAvatar } from '../../components/Avatar';
import { Badge, Button, cx, Empty, Input, Loading, Modal, Note, StatusBadge } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import { formatDate, formatDateTime, formatMonth, formatRange } from '../../utils/date';

export type SummaryKind = 'active' | 'onLeaveMonth' | 'onLeaveToday' | 'approvedDays' | 'pending' | 'peak';

interface Person { _id: string; fullName: string; employeeId: string; department: string | null; designation: string | null; avatarFile: string | null }
interface Leave { requestId: string; status: string; leaveType: { name: string; code: string; color: string } | null; startDate: string; endDate: string; days: number; halfDay: boolean; appliedAt: string }
interface Details {
  people?: (Person | { employee: Person; days: number; leaves: Leave[] })[];
  requests?: { employee: Person; leave: Leave }[];
  peak?: number;
  dates?: { date: string; people: { employee: Person; leaveType: Leave['leaveType']; value: number }[] }[];
  today?: string;
}

const TITLES: Record<SummaryKind, string> = {
  active: 'Active employees',
  onLeaveMonth: 'On leave this month',
  onLeaveToday: 'On leave today',
  approvedDays: 'Approved leave days',
  pending: 'Pending requests',
  peak: 'Highest absence',
};

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

function PersonCell({ person, sub }: { person: Person; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar person={person} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium">{person.fullName}</div>
        <div className="truncate text-[11.5px] text-muted">{sub ?? [person.employeeId, person.department ?? 'No department'].join(' · ')}</div>
      </div>
    </div>
  );
}

function TypePill({ type, halfDay }: { type: Leave['leaveType']; halfDay?: boolean }) {
  if (!type) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium" style={{ backgroundColor: `${type.color}1a`, color: type.color }}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: type.color }} />
      {type.name}{halfDay ? ' · ½' : ''}
    </span>
  );
}

/** The list behind one summary card, with the page's filters applied. Leave rows open the request. */
export function SummaryListModal({ kind, month, filters, onClose, onOpenLeave }: { kind: SummaryKind; month: string; filters: Record<string, string>; onClose: () => void; onOpenLeave: (id: string) => void }) {
  const { data, loading, error } = useFetch<Details>('/calendar/summary/details', { month, kind, ...filters });
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (p: Person) => !q || p.fullName.toLowerCase().includes(q) || p.employeeId.toLowerCase().includes(q) || (p.department ?? '').toLowerCase().includes(q);
  const filtered = Boolean(Object.values(filters).some(Boolean));

  const count = useMemo(() => {
    if (!data) return null;
    if (kind === 'peak') return data.dates?.length ? `${data.peak} people` : null;
    if (kind === 'approvedDays') return days(data.requests?.reduce((s, r) => s + r.leave.days, 0) ?? 0);
    return String(data.people?.length ?? data.requests?.length ?? 0);
  }, [data, kind]);

  const leaveRow = (r: { employee: Person; leave: Leave }, right: ReactNode, sub?: ReactNode) => (
    <li key={r.leave.requestId}>
      <button type="button" onClick={() => onOpenLeave(r.leave.requestId)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-paper sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
        <PersonCell person={r.employee} />
        <div className="hidden min-w-0 sm:block">
          <TypePill type={r.leave.leaveType} halfDay={r.leave.halfDay} />
          <div className="mt-0.5 truncate text-[11.5px] text-muted">{sub ?? formatRange(r.leave.startDate, r.leave.endDate)}</div>
        </div>
        <div className="text-right text-[12.5px]">{right}</div>
      </button>
    </li>
  );

  let body: ReactNode = null;
  if (data) {
    if (kind === 'active') {
      const people = (data.people as Person[]).filter(match);
      body = (
        <ul className="divide-y divide-line">
          {people.map((p) => (
            <li key={p._id}>
              <Link to={`/admin/employees/${p._id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-paper">
                <PersonCell person={p} />
                <span className="hidden truncate text-[12px] text-muted sm:block">{p.designation ?? ''}</span>
              </Link>
            </li>
          ))}
          {!people.length && <Empty>No one matches.</Empty>}
        </ul>
      );
    } else if (kind === 'onLeaveMonth') {
      const people = (data.people as { employee: Person; days: number; leaves: Leave[] }[]).filter((p) => match(p.employee));
      body = (
        <ul className="space-y-2">
          {people.map((p) => (
            <li key={p.employee._id} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <PersonCell person={p.employee} />
                <Badge tone="green">{days(p.days)}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 pl-[38px]">
                {p.leaves.map((l) => (
                  <button key={l.requestId} type="button" onClick={() => onOpenLeave(l.requestId)} className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper/60 px-2 py-1 text-[11.5px] hover:border-line-strong hover:bg-paper">
                    <TypePill type={l.leaveType} halfDay={l.halfDay} />
                    <span className="text-muted">{formatRange(l.startDate, l.endDate)}</span>
                  </button>
                ))}
              </div>
            </li>
          ))}
          {!people.length && <Empty>No one was on leave this month.</Empty>}
        </ul>
      );
    } else if (kind === 'peak') {
      body = !data.dates?.length ? <Empty>No approved leave this month.</Empty> : (
        <div className="space-y-4">
          {data.dates.map((d) => (
            <section key={d.date}>
              <h3 className="mb-1.5 flex items-center justify-between text-[13px] font-semibold">
                {new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`))}
                <Badge tone="amber">{d.people.length} away</Badge>
              </h3>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {d.people.filter((p) => match(p.employee)).map((p) => (
                  <li key={p.employee._id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <PersonCell person={p.employee} />
                    <TypePill type={p.leaveType} halfDay={p.value < 1} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      );
    } else {
      const rows = (data.requests ?? []).filter((r) => match(r.employee));
      const total = rows.reduce((s, r) => s + r.leave.days, 0);
      body = (
        <>
          <ul className="divide-y divide-line">
            {rows.map((r) =>
              kind === 'pending'
                ? leaveRow(r, <><div className="font-semibold">{days(r.leave.days)}</div><div className="text-[11px] text-faint">Applied {formatDateTime(r.leave.appliedAt)}</div></>)
                : kind === 'onLeaveToday'
                  ? leaveRow(r, r.leave.endDate === data.today ? <span className="text-muted">{r.leave.halfDay ? 'Half day' : 'Back tomorrow'}</span> : <span className="text-muted">Until {formatDate(r.leave.endDate)}</span>)
                  : leaveRow(r, <><div className="tnum font-semibold">{days(r.leave.days)}</div><StatusBadge status={r.leave.status} /></>),
            )}
          </ul>
          {!rows.length && <Empty>{kind === 'pending' ? 'No requests are waiting.' : kind === 'onLeaveToday' ? 'Nobody is on leave today.' : 'No approved leave this month.'}</Empty>}
          {kind === 'approvedDays' && rows.length > 0 && (
            <div className="mt-2 flex justify-between border-t border-line px-3 pt-2.5 text-[13px]"><span className="text-muted">{rows.length} requests</span><span className="tnum font-semibold">Total {days(total)}</span></div>
          )}
        </>
      );
    }
  }

  return (
    <Modal
      wide
      title={<span className="flex items-baseline gap-2">{TITLES[kind]}{count && <span className="tnum text-[13px] font-normal text-muted">{count}</span>}</span>}
      onClose={onClose}
      footer={kind === 'pending' && data?.requests?.length ? <Link to="/approvals"><Button variant="primary">Go to approvals</Button></Link> : <Button onClick={onClose}>Close</Button>}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted">
          {kind === 'onLeaveToday' ? 'Today' : formatMonth(month)}
          {filtered ? ' · filters from the page apply' : ''}
          {kind !== 'active' && kind !== 'peak' ? ' · select a row to see the request' : ''}
        </p>
        <Input aria-label="Filter this list" placeholder="Filter by name, ID or department" className={cx('w-64 py-1.5')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && <Note>{error}</Note>}
      {loading && !data ? <Loading /> : <div className="max-h-[60vh] overflow-y-auto">{body}</div>}
    </Modal>
  );
}
