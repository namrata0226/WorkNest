import { useState } from 'react';
import { Button, Card, DataTable, Field, Input, Note, PageHeader, Pagination, Select, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import { downloadFile } from '../../services/download';
import type { Employee, LeaveType, Named } from '../../types';
import { currentYear, todayString } from '../../utils/date';

type Period = 'month' | 'year' | 'range' | 'none';

const REPORTS: { value: string; label: string; period: Period; hint: string }[] = [
  { value: 'monthly', label: 'Monthly leave', period: 'month', hint: 'Days taken per employee and leave type in a month' },
  { value: 'annual', label: 'Annual leave', period: 'year', hint: 'Days taken per employee, month by month' },
  { value: 'employee', label: 'Employee-wise leave', period: 'range', hint: 'Each request, for one person or everyone' },
  { value: 'department', label: 'Department-wise leave', period: 'range', hint: 'Days and headcount by department' },
  { value: 'balances', label: 'Remaining balances', period: 'year', hint: 'Every balance component per employee' },
  { value: 'compoff', label: 'Comp-Off earned and used', period: 'range', hint: 'Lifetime totals, or credits earned within dates' },
  { value: 'compoff-expiry', label: 'Comp-Off expiry', period: 'range', hint: 'Unused credits, soonest expiry first' },
  { value: 'pending', label: 'Pending approvals', period: 'none', hint: 'Everything waiting on a decision' },
  { value: 'holidays', label: 'Holiday calendar', period: 'year', hint: 'All holidays for a year' },
  { value: 'cancellations', label: 'Leave cancellations', period: 'range', hint: 'Cancelled leave and open cancellation requests' },
];

interface ReportData { title: string; columns: { key: string; header: string }[]; rows: Record<string, unknown>[] }

export function ReportsPage() {
  const toast = useToast();
  const [report, setReport] = useState('monthly');
  const [month, setMonth] = useState(todayString().slice(0, 7));
  const [year, setYear] = useState(currentYear());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [employee, setEmployee] = useState('');
  const [department, setDepartment] = useState('');
  const [leaveType, setLeaveType] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<string | null>(null);

  const meta = REPORTS.find((r) => r.value === report)!;
  const period = meta.period === 'month' ? { month } : meta.period === 'year' ? { year } : meta.period === 'range' ? { from, to } : {};
  const filters = { ...period, employee, department, leaveType };

  const { data, meta: pageMeta, loading, error } = useFetch<ReportData>(`/reports/${report}`, { ...filters, page, limit: 50 });
  const employees = useFetch<Employee[]>('/employees', { limit: 200, sort: 'fullName', order: 'asc' });
  const departments = useFetch<Named[]>('/departments');
  const types = useFetch<LeaveType[]>('/leave-types');
  const reset = () => setPage(1);

  const exportAs = async (format: 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await downloadFile('/reports/export', { report, format, ...filters }, `${report}.${format}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const columns = (data?.columns ?? []).map((c) => ({
    header: c.header,
    cell: (row: Record<string, unknown>) => String(row[c.key] ?? (typeof data?.rows[0]?.total === 'number' ? 0 : '')),
    align: ['days', 'total', 'used', 'available', 'earned', 'expired', 'reserved', 'remaining', 'employees', 'entitlement', 'credited', 'openingBalance', 'carryForward', 'adjustments'].includes(c.key) || /^[A-Z0-9-]{1,10}$/.test(c.key) || /^[A-Z][a-z]{2}$/.test(c.key) ? ('right' as const) : undefined,
  }));

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={meta.hint}
        actions={
          <>
            <Button loading={exporting === 'xlsx'} onClick={() => void exportAs('xlsx')}>Export Excel</Button>
            <Button loading={exporting === 'csv'} onClick={() => void exportAs('csv')}>Export CSV</Button>
          </>
        }
      />
      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Report">
            <Select value={report} onChange={(e) => { setReport(e.target.value); reset(); }}>
              {REPORTS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </Field>
          {meta.period === 'month' && <Field label="Month"><Input type="month" value={month} onChange={(e) => { setMonth(e.target.value); reset(); }} /></Field>}
          {meta.period === 'year' && <Field label="Year"><Input type="number" value={year} onChange={(e) => { setYear(Number(e.target.value)); reset(); }} /></Field>}
          {meta.period === 'range' && (
            <>
              <Field label="From"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} /></Field>
              <Field label="To"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} /></Field>
            </>
          )}
          {report !== 'holidays' && (
            <>
              <Field label="Employee">
                <Select value={employee} onChange={(e) => { setEmployee(e.target.value); reset(); }}>
                  <option value="">Everyone</option>
                  {employees.data?.map((e) => <option key={e._id} value={e._id}>{e.fullName} ({e.employeeId})</option>)}
                </Select>
              </Field>
              <Field label="Department">
                <Select value={department} onChange={(e) => { setDepartment(e.target.value); reset(); }}>
                  <option value="">All departments</option>
                  {departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                </Select>
              </Field>
              {!['compoff', 'compoff-expiry'].includes(report) && (
                <Field label="Leave type">
                  <Select value={leaveType} onChange={(e) => { setLeaveType(e.target.value); reset(); }}>
                    <option value="">All leave types</option>
                    {types.data?.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                  </Select>
                </Field>
              )}
            </>
          )}
        </div>
      </Card>
      {error && <Note>{error}</Note>}
      <Card flush title={data?.title}>
        <DataTable<Record<string, unknown>> rows={data?.rows} loading={loading} rowKey={(r) => JSON.stringify(r)} columns={columns} empty="No data for these filters." />
        <Pagination meta={pageMeta} onPage={setPage} />
      </Card>
    </>
  );
}
