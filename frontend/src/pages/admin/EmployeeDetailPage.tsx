import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import { Button, Card, DataTable, Loading, Note, PageHeader, Pagination, Select, StatusBadge, TypeTag, useToast } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import type { BalanceRow, Employee, LedgerRow, LeaveRequest } from '../../types';
import { currentYear, formatDate, formatRange } from '../../utils/date';
import { titleCase } from '../../utils/labels';
import { BalanceTable, LedgerTable, yearOptions } from '../BalancesPage';
import { AdjustBalanceModal } from './BalancesAdminPage';
import { EmployeeChecklists, PrivateDetailsCard } from './EmployeePeopleCards';
import { ActivationLinks, EmployeeFormModal } from './EmployeesPage';

export function EmployeeDetailPage() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const toast = useToast();
  const [year, setYear] = useState(currentYear());
  const [leavePage, setLeavePage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [links, setLinks] = useState<{ email: string; link: string }[] | null>(null);

  const employee = useFetch<Employee>(`/employees/${id}`);
  const canBalances = can('balances:read');
  const balances = useFetch<{ balances: BalanceRow[] }>(canBalances ? `/leave-balances/${id}` : null, { year });
  const ledger = useFetch<LedgerRow[]>(canBalances ? `/leave-balances/${id}/transactions` : null, { year, page: ledgerPage, limit: 15 });
  const leaves = useFetch<LeaveRequest[]>(can('leave:read_all') ? '/leaves' : null, { employee: id, page: leavePage, limit: 10, sort: 'startDate', order: 'desc' });

  if (employee.loading && !employee.data) return <Loading />;
  if (employee.error) return <Note>{employee.error}</Note>;
  const e = employee.data;
  if (!e) return null;
  const isSelf = user?.employee?._id === e._id;

  const setStatus = async (status: Employee['employmentStatus']) => {
    if (status === 'INACTIVE' && !window.confirm(`Deactivate ${e.fullName}? They lose access at once and pending requests are withdrawn. Their history is kept.`)) return;
    try {
      await api.patch(`/employees/${e._id}/status`, { status });
      toast(status === 'INACTIVE' ? 'Employee deactivated' : 'Status updated');
      await employee.reload();
      await leaves.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const sendLink = async () => {
    try {
      const res = await api.post(`/employees/${e._id}/activation-link`);
      if (res.data.data.activationLink) setLinks([{ email: e.email, link: res.data.data.activationLink }]);
      else toast('Activation email sent');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const facts: [string, React.ReactNode][] = [
    ['Employee ID', e.employeeId], ['Email', e.email], ['Phone', e.phone ?? '—'], ['Gender', e.gender ? titleCase(e.gender) : 'Not recorded'], ['Department', e.department?.name ?? '—'],
    ['Designation', e.designation ?? '—'], ['Reporting manager', e.reportingManager ? <Link key="m" className="text-brand hover:underline" to={`/admin/employees/${e.reportingManager._id}`}>{e.reportingManager.fullName}</Link> : '—'],
    ['Location', e.location?.name ?? '—'], ['Joined', formatDate(e.joiningDate)], ['Category', titleCase(e.category)], ['Leave policy', e.leavePolicy?.name ?? 'Automatic'],
  ];

  return (
    <>
      <PageHeader
        title={e.fullName}
        subtitle={<StatusBadge status={e.employmentStatus} />}
        actions={can('employees:write') && (
          <>
            <Button onClick={() => void sendLink()}>Send password link</Button>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            {!isSelf && (e.employmentStatus === 'INACTIVE'
              ? <Button onClick={() => void setStatus('ACTIVE')}>Reactivate</Button>
              : <Button variant="danger" onClick={() => void setStatus('INACTIVE')}>Deactivate</Button>)}
          </>
        )}
      />
      <Card title="Profile">
        <dl className="grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-line pb-1.5">
              <dt className="text-muted">{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {can('employee_private:read') && <PrivateDetailsCard employeeId={e._id} />}
      <EmployeeChecklists employeeId={e._id} />

      {canBalances && (
        <Card
          className="mt-4"
          flush
          title="Leave balances"
          actions={
            <div className="flex items-center gap-2">
              <Select aria-label="Year" className="py-1" value={year} onChange={(ev) => { setYear(Number(ev.target.value)); setLedgerPage(1); }}>
                {yearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
              {can('balances:adjust') && <Button small onClick={() => setAdjusting(true)}>Adjust balance</Button>}
            </div>
          }
        >
          {balances.error && <Note>{balances.error}</Note>}
          <BalanceTable rows={balances.data?.balances ?? null} loading={balances.loading} />
        </Card>
      )}

      {can('leave:read_all') && (
        <Card className="mt-4" flush title="Leave history">
          <DataTable<LeaveRequest>
            rows={leaves.data}
            loading={leaves.loading}
            rowKey={(r) => r._id}
            empty="No leave requests."
            columns={[
              { header: 'Type', cell: (r) => <TypeTag type={r.leaveType} /> },
              { header: 'Dates', cell: (r) => <Link className="hover:underline" to={`/leaves/${r._id}`}>{formatRange(r.startDate, r.endDate)}</Link> },
              { header: 'Days', align: 'right', cell: (r) => r.totalDays },
              { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
          <Pagination meta={leaves.meta} onPage={setLeavePage} />
        </Card>
      )}

      {canBalances && (
        <Card className="mt-4" flush title={`Transaction history, ${year}`}>
          <LedgerTable rows={ledger.data} loading={ledger.loading} showActor />
          <Pagination meta={ledger.meta} onPage={setLedgerPage} />
        </Card>
      )}

      {editing && <EmployeeFormModal employee={e} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Employee updated'); void employee.reload(); }} />}
      {adjusting && <AdjustBalanceModal employee={e} year={year} onClose={() => setAdjusting(false)} onDone={() => { setAdjusting(false); void balances.reload(); void ledger.reload(); }} />}
      {links && <ActivationLinks links={links} onClose={() => setLinks(null)} />}
    </>
  );
}
