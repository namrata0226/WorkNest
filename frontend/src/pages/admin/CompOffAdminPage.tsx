import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, applyServerErrors, errorMessage } from '../../api/client';
import { Button, Card, Checkbox, DataTable, Field, Input, Modal, Note, PageHeader, Pagination, Select, StatusBadge, Tabs, Textarea, usePrompt, useSingleFlight, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import type { CompOffRequest, CompOffTx, Employee } from '../../types';
import { formatDate, formatDateTime } from '../../utils/date';
import { LEDGER_LABEL } from '../../utils/labels';
import { CompOffManualForm, compOffManualSchema } from '../../validations';
import { signed } from '../BalancesPage';

type Tab = 'requests' | 'records' | 'rules';

export function CompOffAdminPage() {
  const [tab, setTab] = useState<Tab>('requests');
  const [manual, setManual] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeader
        title="Comp-Off"
        actions={
          <>
            <Tabs value={tab} onChange={setTab} tabs={[{ value: 'requests', label: 'Requests' }, { value: 'records', label: 'Records' }, { value: 'rules', label: 'Rules' }]} />
            <Button variant="primary" onClick={() => setManual(true)}>Add or deduct</Button>
          </>
        }
      />
      {tab === 'requests' && <RequestsTab />}
      {tab === 'records' && <RecordsTab key={version} />}
      {tab === 'rules' && <RulesTab />}
      {manual && <ManualModal onClose={() => setManual(false)} onDone={() => { setManual(false); setVersion((v) => v + 1); }} />}
    </>
  );
}

function RequestsTab() {
  // All statuses by default, so a request stays listed, with its outcome, after it is decided.
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [deciding, setDeciding] = useState<CompOffRequest | null>(null);
  const { data, meta, loading, error, reload } = useFetch<CompOffRequest[]>('/compoff', { status, search, page, limit: 20, sort: 'createdAt', order: status === 'PENDING' ? 'asc' : 'desc' });

  return (
    <>
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <Input aria-label="Search" placeholder="Search name or ID" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </Select>
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<CompOffRequest>
          rows={data}
          loading={loading}
          rowKey={(r) => r._id}
          empty="No requests match."
          columns={[
            { header: 'Employee', cell: (r) => <div><div className="font-medium">{r.employee.fullName}</div><div className="text-xs text-muted">{r.employee.employeeId}</div></div> },
            { header: 'Worked', cell: (r) => <div><div>{formatDate(r.workedDate)}</div><div className="text-xs text-muted">{r.occasion}</div></div> },
            { header: 'Days', align: 'right', cell: (r) => r.amount },
            { header: 'Reason', cell: (r) => r.reason, className: 'max-w-xs text-muted' },
            { header: 'Document', cell: (r) => (r.document ? <a className="text-brand hover:underline" href={`/api/files/${r.document._id}`}>{r.document.originalName}</a> : '—') },
            { header: 'Expires', cell: (r) => formatDate(r.expiresOn), className: 'whitespace-nowrap' },
            { header: 'Status', cell: (r) => (r.status === 'PENDING' ? <Button small variant="primary" onClick={() => setDeciding(r)}>Review</Button> : <StatusBadge status={r.status} />) },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {deciding && <DecideModal request={deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); void reload(); }} />}
    </>
  );
}

function DecideModal({ request, onClose, onDone }: { request: CompOffRequest; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [expiresOn, setExpiresOn] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (approve) await api.patch(`/compoff/${request._id}/approve`, { ...(expiresOn ? { expiresOn } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) });
      else await api.patch(`/compoff/${request._id}/reject`, { reason: comment.trim() });
      toast(approve ? 'Comp-Off credited' : 'Claim rejected');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Comp-Off claim: ${request.employee.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" loading={busy} disabled={!comment.trim()} title={comment.trim() ? undefined : 'Enter a reason to reject'} onClick={() => decide(false)}>Reject</Button>
          <Button variant="primary" loading={busy} onClick={() => decide(true)}>Approve and credit</Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        {error && <Note>{error}</Note>}
        <p>{request.amount} day(s) for working on <strong>{formatDate(request.workedDate)}</strong> ({request.occasion}).</p>
        <p className="text-muted">{request.reason}</p>
        <Field label="Expiry date" hint="Blank uses the company's validity period"><Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></Field>
        <Field label="Comment" hint="Required to reject; shared with the employee"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function RecordsTab() {
  const toast = useToast();
  const prompt = usePrompt();
  const [employee, setEmployee] = useState('');
  const [page, setPage] = useState(1);
  const employees = useFetch<Employee[]>('/employees', { limit: 200, sort: 'fullName', order: 'asc' });
  const { data, meta, loading, error, reload } = useFetch<CompOffTx[]>('/compoff/transactions', { employee, page, limit: 25 });

  const [changeExpiry] = useSingleFlight(async (t: CompOffTx) => {
    const next = await prompt({
      title: 'Change expiry date',
      message: `${t.employee?.fullName ?? 'This credit'}: ${t.remaining} day(s) left.`,
      label: 'New expiry date',
      type: 'date',
      defaultValue: t.expiresOn ?? '',
      required: true,
      confirmLabel: 'Save date',
    });
    if (!next || next === t.expiresOn) return;
    try {
      await api.patch(`/compoff/credits/${t._id}/expiry`, { expiresOn: next });
      toast('Expiry updated');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <>
      <div className="mb-3 max-w-sm">
        <Select aria-label="Employee" value={employee} onChange={(e) => { setEmployee(e.target.value); setPage(1); }}>
          <option value="">All employees</option>
          {employees.data?.map((e) => <option key={e._id} value={e._id}>{e.fullName} ({e.employeeId})</option>)}
        </Select>
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<CompOffTx>
          rows={data}
          loading={loading}
          rowKey={(t) => t._id}
          empty="No records yet."
          columns={[
            { header: 'When', cell: (t) => formatDateTime(t.createdAt), className: 'whitespace-nowrap text-muted' },
            { header: 'Employee', cell: (t) => t.employee?.fullName ?? '—' },
            { header: 'Movement', cell: (t) => (t.type === 'CREDIT' ? 'Earned' : LEDGER_LABEL[t.type] ?? t.type) },
            { header: 'Reason', cell: (t) => t.reason ?? '—', className: 'text-muted' },
            { header: 'Days', align: 'right', cell: (t) => signed(t.amount) },
            { header: 'Left', align: 'right', cell: (t) => (t.type === 'CREDIT' ? t.remaining : '') },
            {
              header: 'Expires',
              cell: (t) => (t.type === 'CREDIT' ? (
                <button type="button" className="whitespace-nowrap text-brand hover:underline" onClick={() => void changeExpiry(t)}>{formatDate(t.expiresOn)}</button>
              ) : ''),
            },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
    </>
  );
}

interface Rules {
  validityDays: number;
  allowOnWeeklyOff: boolean;
  allowOnHoliday: boolean;
  allowHalfDay: boolean;
  maxClaimAgeDays: number;
  requireDocument: boolean;
  expiryWarningDays: number;
}

function RulesTab() {
  const toast = useToast();
  const { data, error } = useFetch<{ compOff: Rules }>('/settings/company');
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm<Rules>();
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (data) reset(data.compOff);
  }, [data, reset]);

  const onSubmit = async (values: Rules) => {
    setFormError(null);
    try {
      await api.put('/settings/compoff', values);
      toast('Comp-Off rules saved');
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  if (error) return <Note>{error}</Note>;
  return (
    <Card title="Earning and validity rules">
      <form className="grid max-w-2xl gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Validity (days after the date worked)"><Input type="number" min={1} {...register('validityDays', { valueAsNumber: true })} /></Field>
        <Field label="Claim within (days of the date worked)"><Input type="number" min={0} {...register('maxClaimAgeDays', { valueAsNumber: true })} /></Field>
        <Field label="Warn before expiry (days)"><Input type="number" min={0} {...register('expiryWarningDays', { valueAsNumber: true })} /></Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox label="Can be earned on weekly offs" {...register('allowOnWeeklyOff')} />
          <Checkbox label="Can be earned on company holidays" {...register('allowOnHoliday')} />
          <Checkbox label="Half-day claims allowed" {...register('allowHalfDay')} />
          <Checkbox label="Supporting document required" {...register('requireDocument')} />
        </div>
        <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={isSubmitting}>Save rules</Button></div>
      </form>
    </Card>
  );
}

function ManualModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const employees = useFetch<Employee[]>('/employees', { status: 'ACTIVE', limit: 200, sort: 'fullName', order: 'asc' });
  const [formError, setFormError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const { register, handleSubmit, setError, watch, formState: { errors, isSubmitting } } = useForm<CompOffManualForm>({ resolver: zodResolver(compOffManualSchema), defaultValues: { employee: '', reason: '' } });
  const adding = !(watch('amount') < 0);

  const onSubmit = async (v: CompOffManualForm) => {
    setFormError(null);
    try {
      await api.post('/compoff/manual', {
        employee: v.employee, amount: v.amount, reason: v.reason,
        ...(v.amount > 0 && v.earnedDate ? { earnedDate: v.earnedDate } : {}),
        ...(v.amount > 0 && v.expiresOn ? { expiresOn: v.expiresOn } : {}),
      }, { headers: { 'Idempotency-Key': key.current } });
      toast('Comp-Off updated');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['employee', 'amount', 'reason', 'earnedDate', 'expiresOn'] as const));
      key.current = crypto.randomUUID();
    }
  };

  return (
    <Modal
      title="Add or deduct Comp-Off"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="manual-form" loading={isSubmitting}>Save</Button></>}
    >
      <form id="manual-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <div className="sm:col-span-2">
          <Field label="Employee" required error={errors.employee?.message}>
            <Select {...register('employee')}>
              <option value="">Choose</option>
              {employees.data?.map((e) => <option key={e._id} value={e._id}>{e.fullName} ({e.employeeId})</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Days" required hint="Negative to deduct" error={errors.amount?.message}><Input type="number" step="0.5" {...register('amount', { valueAsNumber: true })} /></Field>
        {adding && <Field label="Earned on" hint="Blank means today"><Input type="date" {...register('earnedDate')} /></Field>}
        {adding && <Field label="Expires on" hint="Blank uses the validity period"><Input type="date" {...register('expiresOn')} /></Field>}
        <div className="sm:col-span-2"><Field label="Reason" required error={errors.reason?.message}><Textarea {...register('reason')} /></Field></div>
      </form>
    </Modal>
  );
}
