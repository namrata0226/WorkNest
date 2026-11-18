import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { Button, Card, DataTable, Note, PageHeader, Select, StatusBadge, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import type { ExpenseClaim } from '../../types';
import { formatDate } from '../../utils/date';
import { titleCase } from '../../utils/labels';
import { money, ReceiptLink } from '../ExpensesPage';

export function ExpensesAdminPage() {
  const toast = useToast();
  const [status, setStatus] = useState('APPROVED');
  const { data, loading, error, reload } = useFetch<ExpenseClaim[]>('/expenses', { status });
  const pay = async (c: ExpenseClaim) => {
    try {
      await api.patch(`/expenses/${c._id}/pay`, {});
      toast('Marked as paid');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const total = (data ?? []).reduce((sum, c) => sum + c.amount, 0);
  return (
    <>
      <PageHeader title="Expense claims" subtitle="Approve claims under Approvals, then mark them as paid here" />
      <div className="mb-3 flex items-center justify-between gap-3">
        <Select aria-label="Status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
        <span className="tnum text-[13px] text-muted">Total: <strong className="text-ink">{money(total)}</strong></span>
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<ExpenseClaim>
          rows={data}
          loading={loading}
          rowKey={(c) => c._id}
          empty="No claims match."
          columns={[
            { header: 'Employee', cell: (c) => (typeof c.employee === 'string' ? '—' : <div><div className="font-medium">{c.employee.fullName}</div><div className="text-xs text-muted">{c.employee.employeeId}</div></div>) },
            { header: 'Date', cell: (c) => formatDate(c.expenseDate), className: 'whitespace-nowrap' },
            { header: 'Category', cell: (c) => titleCase(c.category) },
            { header: 'Description', cell: (c) => c.description, className: 'text-muted' },
            { header: 'Amount', align: 'right', cell: (c) => money(c.amount), className: 'tnum' },
            { header: 'Receipt', cell: (c) => <ReceiptLink claim={c} /> },
            { header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
            { header: '', align: 'right', cell: (c) => (c.status === 'APPROVED' ? <Button small variant="primary" onClick={() => void pay(c)}>Mark as paid</Button> : null) },
          ]}
        />
      </Card>
    </>
  );
}
