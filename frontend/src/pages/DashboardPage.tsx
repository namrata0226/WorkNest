import { Link } from 'react-router-dom';
import { Button, Card, DataTable, Empty, Loading, Note, PageHeader, Stat, StatusBadge, TypeTag } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';
import type { BalanceRow, CompOffRequest, CompOffTx, LedgerRow, LeaveRequest } from '../types';
import { days, formatDate, formatRange } from '../utils/date';
import { LEDGER_LABEL } from '../utils/labels';
import { PunchCard } from './AttendancePage';
import { Planner } from '../components/planner/Planner';

interface Dashboard {
  year: number;
  today: string;
  cards: {
    totalAnnualEntitlement: number;
    casualBalance: number | null;
    sickBalance: number | null;
    earnedBalance: number | null;
    compOffBalance: number;
    totalUsed: number;
    upcomingApproved: number;
    pendingRequests: number;
  };
  balances: BalanceRow[];
  recent: LeaveRequest[];
  upcoming: LeaveRequest[];
  holidays: { id: string; name: string; date: string; category: string; isHalfDay: boolean }[];
  transactions: LedgerRow[];
  compOffHistory: CompOffTx[];
  compOffRequests: CompOffRequest[];
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

export function DashboardPage() {
  const { user } = useAuth();
  const { data, loading, error } = useFetch<Dashboard>('/dashboard');

  if (loading && !data) return <Loading />;
  if (error) return <Note>{error}</Note>;
  if (!data) return null;
  const c = data.cards;
  const balance = (n: number | null) => (n === null ? '—' : n);

  return (
    <>
      <PageHeader
        title={`Hello, ${user?.employee?.fullName.split(' ')[0] ?? 'there'}`}
        subtitle={`Your leave for ${data.year}`}
        actions={<Link to="/apply"><Button variant="primary">Apply for leave</Button></Link>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Annual entitlement" value={c.totalAnnualEntitlement} hint="Excludes life-event leave" />
        <Stat label="Casual leave" value={balance(c.casualBalance)} hint="Days available" tone="brand" />
        <Stat label="Sick leave" value={balance(c.sickBalance)} hint="Days available" tone="brand" />
        <Stat label="Earned leave" value={balance(c.earnedBalance)} hint="Days available" tone="brand" />
        <Stat label="Comp-Off" value={c.compOffBalance} hint="Days available" tone="brand" />
        <Stat label="Leave used" value={c.totalUsed} hint={`Days in ${data.year}`} />
        <Stat label="Upcoming approved" value={c.upcomingApproved} hint="Leaves ahead" />
        <Stat label="Pending requests" value={c.pendingRequests} hint="Awaiting decision" tone={c.pendingRequests ? 'amber' : undefined} />
      </div>

      <div className="mt-4"><PunchCard /></div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Recent applications" flush actions={<Link className="text-xs text-brand hover:underline" to="/leaves">View all</Link>}>
          <DataTable<LeaveRequest>
            rows={data.recent}
            rowKey={(r) => r._id}
            empty="You have not applied for leave yet."
            columns={[
              { header: 'Type', cell: (r) => <TypeTag type={r.leaveType} /> },
              { header: 'Dates', className: 'whitespace-nowrap', cell: (r) => <Link className="hover:underline" to={`/leaves/${r._id}`}>{formatRange(r.startDate, r.endDate)}</Link> },
              { header: 'Days', align: 'right', cell: (r) => r.totalDays },
              { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        </Card>

        <div className="space-y-4">
          <Card title="Upcoming approved leave" flush>
            {data.upcoming.length === 0 ? <Empty>Nothing booked.</Empty> : (
              <ul className="divide-y divide-line text-[13px]">
                {data.upcoming.map((r) => (
                  <li key={r._id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span>{formatRange(r.startDate, r.endDate)}</span>
                    <TypeTag type={{ code: r.leaveType.code, color: r.leaveType.color }} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Upcoming holidays" flush actions={<Link className="text-xs text-brand hover:underline" to="/holidays">Full list</Link>}>
            {data.holidays.length === 0 ? <Empty>None in the next six months.</Empty> : (
              <ul className="divide-y divide-line text-[13px]">
                {data.holidays.map((h) => (
                  <li key={`${h.id}${h.date}`} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span>{h.name}{h.isHalfDay ? ' (half day)' : ''}</span>
                    <span className="tnum whitespace-nowrap text-muted">{formatDate(h.date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-4"><Planner compact /></div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Leave transactions" flush actions={<Link className="text-xs text-brand hover:underline" to="/balances">Balances</Link>}>
          <DataTable<LedgerRow>
            rows={data.transactions}
            rowKey={(t) => t._id}
            empty="No movements yet."
            columns={[
              { header: 'Date', cell: (t) => formatDate(t.createdAt.slice(0, 10)), className: 'whitespace-nowrap' },
              { header: 'Type', cell: (t) => t.leaveType?.code },
              { header: 'Movement', cell: (t) => LEDGER_LABEL[t.type] ?? t.type },
              { header: 'Days', align: 'right', cell: (t) => signed(t.amount) },
            ]}
          />
        </Card>
        <Card title="Comp-Off history" flush actions={<Link className="text-xs text-brand hover:underline" to="/comp-off">Comp-Off</Link>}>
          <DataTable<CompOffTx>
            rows={data.compOffHistory}
            rowKey={(t) => t._id}
            empty="No Comp-Off earned or used yet."
            columns={[
              { header: 'Date', cell: (t) => formatDate(t.createdAt.slice(0, 10)), className: 'whitespace-nowrap' },
              { header: 'Movement', cell: (t) => (t.type === 'CREDIT' ? 'Earned' : LEDGER_LABEL[t.type] ?? t.type) },
              { header: 'Expires', cell: (t) => (t.expiresOn ? formatDate(t.expiresOn) : '—'), className: 'whitespace-nowrap' },
              { header: 'Days', align: 'right', cell: (t) => signed(t.amount) },
            ]}
          />
        </Card>
      </div>
      <p className="mt-3 text-xs text-faint">{days(c.totalUsed)} used so far in {data.year}.</p>
    </>
  );
}
