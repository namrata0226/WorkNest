import { useState } from 'react';
import { Card, DataTable, InfiniteLoader, Note, PageHeader, Select, TypeTag } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import { useInfiniteFetch } from '../hooks/useInfiniteFetch';
import type { BalanceRow, LedgerRow } from '../types';
import { currentYear, formatDateTime } from '../utils/date';
import { LEDGER_LABEL } from '../utils/labels';

export const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

export function BalanceTable({ rows, loading }: { rows: BalanceRow[] | null; loading?: boolean }) {
  return (
    <DataTable<BalanceRow>
      rows={rows}
      loading={loading}
      rowKey={(b) => b.leaveType._id}
      empty="No leave types apply."
      columns={[
        { header: 'Leave type', cell: (b) => <TypeTag type={b.leaveType} /> },
        { header: 'Opening', align: 'right', cell: (b) => b.openingBalance ?? 0 },
        { header: 'Entitlement', align: 'right', cell: (b) => b.entitlement ?? 0 },
        { header: 'Credited', align: 'right', cell: (b) => b.credited ?? 0 },
        { header: 'Carried', align: 'right', cell: (b) => b.carryForward ?? 0 },
        { header: 'Adjusted', align: 'right', cell: (b) => b.adjustments ?? 0 },
        { header: 'Used', align: 'right', cell: (b) => b.used ?? 0 },
        { header: 'Held', align: 'right', cell: (b) => b.reserved ?? 0 },
        { header: 'Expired', align: 'right', cell: (b) => b.expired ?? 0 },
        { header: 'Available', align: 'right', cell: (b) => (b.leaveType.validateBalance === false ? <span className="text-faint">Not limited</span> : <span className="font-semibold text-brand">{b.available ?? 0}</span>) },
      ]}
    />
  );
}

export function LedgerTable({ rows, loading, showActor }: { rows: LedgerRow[] | null; loading?: boolean; showActor?: boolean }) {
  return (
    <DataTable<LedgerRow>
      rows={rows}
      loading={loading}
      rowKey={(t) => t._id}
      empty="No movements for this year."
      columns={[
        { header: 'When', cell: (t) => formatDateTime(t.createdAt), className: 'whitespace-nowrap text-muted' },
        { header: 'Type', cell: (t) => t.leaveType?.code },
        { header: 'Movement', cell: (t) => LEDGER_LABEL[t.type] ?? t.type },
        { header: 'Reason', cell: (t) => t.reason ?? '—', className: 'text-muted' },
        ...(showActor ? [{ header: 'By', cell: (t: LedgerRow) => t.performedBy?.email ?? 'System', className: 'text-muted' }] : []),
        { header: 'Days', align: 'right' as const, cell: (t) => signed(t.amount) },
        { header: 'Balance', align: 'right' as const, cell: (t) => t.balanceAfter },
      ]}
    />
  );
}

export const yearOptions = () => {
  const y = currentYear();
  return [y + 1, y, y - 1, y - 2];
};

export function BalancesPage() {
  const [year, setYear] = useState(currentYear());
  const balances = useFetch<BalanceRow[]>('/leave-balances/my', { year });
  const ledger = useInfiniteFetch<LedgerRow[]>('/leave-balances/my/transactions', { year }, { limit: 20 });

  return (
    <>
      <PageHeader
        title="My balances"
        subtitle="Every change is recorded below"
        actions={
          <Select aria-label="Year" value={year} onChange={(e) => { setYear(Number(e.target.value)); }}>
            {yearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        }
      />
      {balances.error && <Note>{balances.error}</Note>}
      <Card flush title="Balances"><BalanceTable rows={balances.data} loading={balances.loading} /></Card>
      <Card flush className="mt-4" title="Transaction history">
        <LedgerTable rows={ledger.data} loading={ledger.loading} />
        <InfiniteLoader list={ledger} />
      </Card>
    </>
  );
}
