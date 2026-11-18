import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { api, applyServerErrors } from '../../api/client';
import { Button, Card, DataTable, Field, Input, Modal, Note, PageHeader, Pagination, Select, Textarea, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import type { LeaveType, LeaveTypeRef, Named } from '../../types';
import { currentYear } from '../../utils/date';
import { AdjustmentForm, adjustmentSchema } from '../../validations';
import { yearOptions } from '../BalancesPage';

interface OverviewRow {
  _id: string;
  employeeId: string;
  fullName: string;
  department: string | null;
  balances: { leaveType: LeaveTypeRef; available?: number; used?: number; reserved?: number }[];
}

export function BalancesAdminPage() {
  const navigate = useNavigate();
  const [year, setYear] = useState(currentYear());
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [page, setPage] = useState(1);
  const departments = useFetch<Named[]>('/departments');
  const { data, meta, loading, error } = useFetch<OverviewRow[]>('/leave-balances', { year, search, department, page, limit: 25, sort: 'fullName', order: 'asc' });

  return (
    <>
      <PageHeader title="Leave balances" subtitle="Available days by employee. Open someone to see the full ledger or adjust a balance." />
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <Input aria-label="Search" placeholder="Search name or ID" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <Select aria-label="Department" value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }}>
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </Select>
        <Select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<OverviewRow>
          rows={data}
          loading={loading}
          rowKey={(r) => r._id}
          onRowClick={(r) => navigate(`/admin/employees/${r._id}`)}
          empty="No employees match."
          columns={[
            { header: 'Employee', cell: (r) => <div><div className="font-medium">{r.fullName}</div><div className="text-xs text-muted">{r.employeeId} · {r.department ?? 'No department'}</div></div> },
            {
              header: 'Available days',
              cell: (r) => (
                <div className="flex flex-wrap gap-1.5">
                  {r.balances.filter((b) => b.leaveType.validateBalance !== false).map((b) => (
                    <span key={b.leaveType._id} title={`${b.leaveType.name}: ${b.used ?? 0} used, ${b.reserved ?? 0} held`} className="tnum inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs">
                      <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: b.leaveType.color }} />
                      {b.leaveType.code} <strong className="font-semibold">{b.available ?? 0}</strong>
                    </span>
                  ))}
                </div>
              ),
            },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
    </>
  );
}

const KIND_HELP: Record<AdjustmentForm['kind'], string> = {
  CREDIT: 'Adds days, such as a bonus.',
  DEDUCTION: 'Removes days. Enter a positive number.',
  ADJUSTMENT: 'A signed correction. Use a negative number to reduce.',
  OPENING: 'Sets up a starting balance when moving from another system.',
};

export function AdjustBalanceModal({ employee, year, onClose, onDone }: { employee: { _id: string; fullName: string }; year: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const types = useFetch<LeaveType[]>('/leave-types');
  const [formError, setFormError] = useState<string | null>(null);
  // A double click or retry of this form posts one adjustment.
  const key = useRef(crypto.randomUUID());
  const { register, handleSubmit, setError, watch, formState: { errors, isSubmitting } } = useForm<AdjustmentForm>({
    resolver: zodResolver(adjustmentSchema),
    defaultValues: { kind: 'CREDIT', year, leaveType: '', reason: '' },
  });

  const onSubmit = async (values: AdjustmentForm) => {
    setFormError(null);
    try {
      await api.post('/leave-balances/adjustment', { ...values, employee: employee._id }, { headers: { 'Idempotency-Key': key.current } });
      toast('Balance updated');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['leaveType', 'year', 'amount', 'kind', 'reason'] as const));
      key.current = crypto.randomUUID();
    }
  };

  return (
    <Modal
      title={`Adjust balance: ${employee.fullName}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="adjust-form" loading={isSubmitting}>Post adjustment</Button></>}
    >
      <form id="adjust-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Leave type" required error={errors.leaveType?.message}>
          <Select {...register('leaveType')}>
            <option value="">Choose</option>
            {types.data?.filter((t) => t.kind !== 'COMP_OFF' && t.isActive).map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Year" required error={errors.year?.message}><Input type="number" {...register('year', { valueAsNumber: true })} /></Field>
        <Field label="Kind" required hint={KIND_HELP[watch('kind')]}>
          <Select {...register('kind')}>
            <option value="CREDIT">Credit</option>
            <option value="DEDUCTION">Deduction</option>
            <option value="ADJUSTMENT">Correction</option>
            <option value="OPENING">Opening balance</option>
          </Select>
        </Field>
        <Field label="Days" required error={errors.amount?.message}><Input type="number" step="0.25" {...register('amount', { valueAsNumber: true })} /></Field>
        <div className="sm:col-span-2">
          <Field label="Reason" required hint="Recorded in the ledger and shown to the employee" error={errors.reason?.message}><Textarea {...register('reason')} /></Field>
        </div>
      </form>
    </Modal>
  );
}
