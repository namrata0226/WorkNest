import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, DataTable, Empty, Loading, Note, PageHeader, Stat } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import { formatMonth } from '../../utils/date';

interface Insights {
  today: string;
  headcount: number;
  summary: { present: number; workFromHome: number; onLeave: number; absent: number; notPunched: number };
  away: { name: string; status: string }[];
  leaveTrend: { month: string; days: number }[];
  leaveByType: { name: string; days: number }[];
  absenceWindowDays: number;
  frequentAbsent: { _id: string; name: string; employeeId: string; department: string | null; days: number }[];
}

const shortMonth = (month: string) => formatMonth(month).slice(0, 3);

/** One series, so one colour and no legend: the card's title names it. Exact figures are on hover and in the table below. */
function MonthlyBars({ data }: { data: Insights['leaveTrend'] }) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(...data.map((d) => d.days), 1);
  const shown = data.find((d) => d.month === active);
  return (
    <figure className="m-0">
      <div className="mb-1 h-5 text-xs text-muted" aria-live="polite">{shown ? `${formatMonth(shown.month)}: ${shown.days} days` : 'Hover over a bar for its figure'}</div>
      <div className="flex h-44 items-end gap-0.5 border-b border-line">
        {data.map((d) => (
          <button
            key={d.month}
            type="button"
            aria-label={`${formatMonth(d.month)}: ${d.days} days`}
            className="group flex h-full flex-1 items-end focus-visible:outline-none"
            onMouseEnter={() => setActive(d.month)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(d.month)}
            onBlur={() => setActive(null)}
          >
            <span className="block w-full rounded-t bg-brand group-hover:bg-brand-strong group-focus-visible:bg-brand-strong" style={{ height: `${(d.days / max) * 100}%`, minHeight: d.days ? 3 : 0 }} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5 text-[11px] text-muted">{data.map((d, i) => <span key={d.month} className="flex-1 text-center">{(data.length - 1 - i) % 2 ? '' : shortMonth(d.month)}</span>)}</div>
      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer text-xs text-muted">Show as a table</summary>
        <table className="mt-2 w-full text-left text-[13px]"><thead><tr className="text-xs text-muted"><th className="font-medium">Month</th><th className="text-right font-medium">Days</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.month}><td>{formatMonth(d.month)}</td><td className="tnum text-right">{d.days}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

function RankedBars({ rows }: { rows: { key: string; label: React.ReactNode; value: number }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="text-[13px]">
          <div className="mb-1 flex justify-between gap-3"><span className="min-w-0 truncate">{r.label}</span><span className="tnum shrink-0 font-medium">{r.value}</span></div>
          <div className="h-1.5 rounded bg-paper"><div className="h-1.5 rounded bg-brand" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function InsightsPage() {
  const { data, loading, error } = useFetch<Insights>('/insights/hr');
  if (loading && !data) return <Loading />;
  if (error) return <Note>{error}</Note>;
  if (!data) return null;
  const s = data.summary;
  return (
    <>
      <PageHeader title="HR dashboard" subtitle={`Today across ${data.headcount} employees, and leave over the last 12 months`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Present" value={s.present} tone="brand" />
        <Stat label="Work from home" value={s.workFromHome} tone="brand" />
        <Stat label="On leave" value={s.onLeave} />
        <Stat label="Absent" value={s.absent} tone={s.absent ? 'amber' : undefined} />
        <Stat label="Not punched in yet" value={s.notPunched} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Leave days taken per month"><MonthlyBars data={data.leaveTrend} /></Card>
        <Card title="Leave days by type">
          {data.leaveByType.length ? <RankedBars rows={data.leaveByType.map((t) => ({ key: t.name, label: t.name, value: t.days }))} /> : <Empty>No leave taken yet.</Empty>}
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`Most absences, last ${data.absenceWindowDays} days`}>
          {data.frequentAbsent.length
            ? <RankedBars rows={data.frequentAbsent.map((p) => ({ key: p._id, label: <Link className="hover:underline" to={`/admin/employees/${p._id}`}>{p.name}{p.department ? ` · ${p.department}` : ''}</Link>, value: p.days }))} />
            : <Empty>No absences in this period.</Empty>}
          <p className="mt-3 text-xs text-faint">Working days with no punch, leave or work from home. Check for missed punches before raising this with anyone.</p>
        </Card>
        <Card flush title="Not in today">
          <DataTable<Insights['away'][number]>
            rows={data.away}
            rowKey={(r) => r.name}
            empty="Everyone is accounted for."
            columns={[{ header: 'Employee', cell: (r) => r.name }, { header: 'Status', cell: (r) => (r.status === 'ABSENT' ? 'Absent' : r.status === 'HALF_LEAVE' ? 'Half-day leave' : 'On leave') }]}
          />
        </Card>
      </div>
    </>
  );
}
