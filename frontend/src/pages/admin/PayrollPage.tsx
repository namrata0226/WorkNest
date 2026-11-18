import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { Button, Card, DataTable, Input, Note, PageHeader, Select, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import { downloadFile } from '../../services/download';
import type { Named } from '../../types';
import { todayString } from '../../utils/date';

interface Row { employeeId: string; employeeName: string; department: string; employedDays: number; present: number; workFromHome: number; paidLeave: number; unpaidLeave: number; holidays: number; weekends: number; absent: number; lossOfPayDays: number; payableDays: number }

export function PayrollPage() {
  const toast = useToast();
  const [month, setMonth] = useState(todayString().slice(0, 7));
  const [department, setDepartment] = useState('');
  const [search, setSearch] = useState('');
  const departments = useFetch<Named[]>('/departments');
  const { data, loading, error } = useFetch<{ month: string; complete: boolean; rows: Row[] }>('/payroll', { month, department, search });
  const exportFile = async () => {
    try {
      await downloadFile('/payroll/export', { month, department, format: 'xlsx' }, `payroll-${month}.xlsx`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const num = (key: keyof Row, header: string) => ({ header, align: 'right' as const, cell: (r: Row) => r[key], className: 'tnum' });
  return (
    <>
      <PageHeader title="Payroll preparation" subtitle="Payable days are the days employed in the month, less absences and unpaid leave" actions={<Button variant="primary" onClick={() => void exportFile()}>Export to Excel</Button>} />
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <Input aria-label="Month" type="month" value={month} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} />
        <Select aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </Select>
        <Input aria-label="Search" placeholder="Search name or ID" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {data && !data.complete && <div className="mb-3"><Note tone="amber">This month has not finished, so these figures can still change. Days still to come count as payable.</Note></div>}
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<Row>
          rows={data?.rows ?? null}
          loading={loading}
          rowKey={(r) => r.employeeId}
          empty="No employees match."
          columns={[
            { header: 'Employee', cell: (r) => <div><div className="font-medium">{r.employeeName}</div><div className="text-xs text-muted">{r.employeeId}{r.department ? ` · ${r.department}` : ''}</div></div> },
            num('employedDays', 'Employed'), num('present', 'Present'), num('workFromHome', 'WFH'), num('paidLeave', 'Paid leave'), num('unpaidLeave', 'Unpaid leave'), num('absent', 'Absent'),
            { header: 'Loss of pay', align: 'right', cell: (r) => r.lossOfPayDays, className: 'tnum' },
            { header: 'Payable days', align: 'right', cell: (r) => <strong>{r.payableDays}</strong>, className: 'tnum' },
          ]}
        />
      </Card>
    </>
  );
}
