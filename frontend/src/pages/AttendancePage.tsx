import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { api, applyServerErrors, errorMessage } from '../api/client';
import { Badge, Button, Card, DataTable, Field, Input, Modal, Note, PageHeader, Pagination, Stat, StatusBadge, Textarea, useToast } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import type { AttendanceCorrection, AttendanceDay, AttendanceMonth, AttendanceStatus, AttendanceToday, WfhRequest } from '../types';
import { formatDay, formatRange, todayString } from '../utils/date';
import { CorrectionRequestForm, correctionRequestSchema, WfhForm, wfhSchema } from '../validations';

const STATUS: Record<AttendanceStatus, { label: string; tone: React.ComponentProps<typeof Badge>['tone'] }> = {
  PRESENT: { label: 'Present', tone: 'green' },
  WFH: { label: 'Work from home', tone: 'sky' },
  ON_LEAVE: { label: 'On leave', tone: 'amber' },
  HALF_LEAVE: { label: 'Half-day leave', tone: 'amber' },
  HOLIDAY: { label: 'Holiday', tone: 'gray' },
  WEEKEND: { label: 'Weekend', tone: 'gray' },
  ABSENT: { label: 'Absent', tone: 'rose' },
  UPCOMING: { label: '—', tone: 'gray' },
  NOT_EMPLOYED: { label: '—', tone: 'gray' },
  NOT_TRACKED: { label: '—', tone: 'gray' },
};

export const AttendanceBadge = ({ day }: { day: Pick<AttendanceDay, 'status' | 'holiday'> }) =>
  (STATUS[day.status].label === '—'
    ? <span className="text-faint">—</span>
    : <Badge tone={STATUS[day.status].tone}>{day.status === 'HOLIDAY' && day.holiday ? day.holiday : STATUS[day.status].label}</Badge>);

export const formatWorked = (minutes: number | null) => (minutes == null ? '—' : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`);

/** Times come from the server, in the company's timezone. */
export function PunchCard({ onChange }: { onChange?: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useFetch<AttendanceToday>('/attendance/my/today');
  const [busy, setBusy] = useState(false);

  const punch = async (kind: 'in' | 'out') => {
    setBusy(true);
    try {
      await api.post(`/attendance/punch-${kind}`, {});
      toast(kind === 'in' ? 'Punched in' : 'Punched out');
      onChange?.();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      await reload();
    }
  };

  if (error) return <Note>{error}</Note>;
  return (
    <Card title="Today's attendance" actions={<Link className="text-xs text-brand hover:underline" to="/attendance">View attendance</Link>}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
          <div><dt className="text-xs text-muted">Punch in</dt><dd className="tnum mt-0.5 font-semibold" data-testid="punch-in">{data?.punchIn ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted">Punch out</dt><dd className="tnum mt-0.5 font-semibold" data-testid="punch-out">{data?.punchOut ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted">Worked</dt><dd className="tnum mt-0.5 font-semibold">{formatWorked(data?.workedMinutes ?? null)}</dd></div>
        </dl>
        {data && !data.punchIn && <Button variant="primary" loading={busy} onClick={() => void punch('in')}>Punch in</Button>}
        {data?.punchIn && !data.punchOut && <Button variant="primary" loading={busy} onClick={() => void punch('out')}>Punch out</Button>}
        {data?.punchOut && <Badge tone="green">Done for today</Badge>}
      </div>
    </Card>
  );
}

export function AttendanceTable({ days, loading, actions }: { days: AttendanceDay[] | null; loading?: boolean; actions?: (day: AttendanceDay) => React.ReactNode }) {
  return (
    <DataTable<AttendanceDay>
      rows={days}
      loading={loading}
      rowKey={(d) => d.date}
      empty="No days to show."
      columns={[
        { header: 'Date', cell: (d) => formatDay(d.date), className: 'whitespace-nowrap' },
        { header: 'Status', cell: (d) => <AttendanceBadge day={d} /> },
        { header: 'Punch in', cell: (d) => d.punchIn ?? '—', className: 'tnum' },
        { header: 'Punch out', cell: (d) => d.punchOut ?? (d.punchIn ? 'Not recorded' : '—'), className: 'tnum' },
        { header: 'Worked', align: 'right', cell: (d) => formatWorked(d.workedMinutes), className: 'tnum' },
        { header: 'Note', cell: (d) => (d.corrected ? `Corrected by HR: ${d.correctionNote ?? ''}` : ''), className: 'text-xs text-muted' },
        ...(actions ? [{ header: '', align: 'right' as const, cell: actions }] : []),
      ]}
    />
  );
}

function ApplyWfhModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const today = todayString();
  const { register, handleSubmit, setError, setValue, getValues, formState: { errors, isSubmitting } } = useForm<WfhForm>({
    resolver: zodResolver(wfhSchema),
    defaultValues: { startDate: today, endDate: today, reason: '' },
  });

  const onSubmit = async (values: WfhForm) => {
    setFormError(null);
    try {
      await api.post('/wfh', values);
      toast('Work from home request submitted');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['startDate', 'endDate', 'reason'] as const));
    }
  };

  return (
    <Modal
      title="Apply for work from home"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="wfh-form" loading={isSubmitting}>Submit request</Button></>}
    >
      <form id="wfh-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Start date" required error={errors.startDate?.message}>
          <Input type="date" {...register('startDate', { onChange: (e) => { if (getValues('endDate') < e.target.value) setValue('endDate', e.target.value); } })} />
        </Field>
        <Field label="End date" required error={errors.endDate?.message}><Input type="date" {...register('endDate')} /></Field>
        <div className="sm:col-span-2">
          <Field label="Reason" required error={errors.reason?.message}><Textarea {...register('reason')} /></Field>
        </div>
        <p className="text-xs text-muted sm:col-span-2">Your attendance shows these days as work from home once the request is approved. Weekends and holidays are not counted.</p>
      </form>
    </Modal>
  );
}

export function RequestCorrectionModal({ date, punchIn, punchOut, onClose, onDone }: { date?: string; punchIn?: string | null; punchOut?: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<CorrectionRequestForm>({
    resolver: zodResolver(correctionRequestSchema),
    defaultValues: { date: date ?? todayString(), punchIn: punchIn ?? '', punchOut: punchOut ?? '', reason: '' },
  });
  const onSubmit = async (v: CorrectionRequestForm) => {
    setFormError(null);
    try {
      await api.post('/attendance/corrections', { date: v.date, punchIn: v.punchIn, punchOut: v.punchOut || null, reason: v.reason });
      toast('Correction request sent');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['date', 'punchIn', 'punchOut', 'reason'] as const));
    }
  };
  return (
    <Modal title="Request an attendance correction" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="correction-form" loading={isSubmitting}>Send request</Button></>}>
      <form id="correction-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <div className="sm:col-span-2"><Field label="Date" required error={errors.date?.message}><Input type="date" max={todayString()} {...register('date')} /></Field></div>
        <Field label="Punch in" required error={errors.punchIn?.message}><Input type="time" {...register('punchIn')} /></Field>
        <Field label="Punch out" error={errors.punchOut?.message}><Input type="time" {...register('punchOut')} /></Field>
        <div className="sm:col-span-2"><Field label="Reason" required error={errors.reason?.message}><Textarea rows={2} {...register('reason')} /></Field></div>
      </form>
    </Modal>
  );
}

function CorrectionsCard({ reloadKey }: { reloadKey: number }) {
  const toast = useToast();
  const { data, reload } = useFetch<AttendanceCorrection[]>('/attendance/corrections/my', { reloadKey });
  const cancel = async (id: string) => {
    try {
      await api.patch(`/attendance/corrections/${id}/cancel`, {});
      toast('Request cancelled');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  if (!Array.isArray(data) || !data.length) return null;
  return (
    <Card className="mt-4" flush title="My correction requests">
      <DataTable<AttendanceCorrection>
        rows={data}
        rowKey={(r) => r._id}
        columns={[
          { header: 'Date', cell: (r) => formatDay(r.date), className: 'whitespace-nowrap' },
          { header: 'Punch in', cell: (r) => r.punchIn, className: 'tnum' },
          { header: 'Punch out', cell: (r) => r.punchOut ?? '—', className: 'tnum' },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Reason', cell: (r) => (r.rejectionReason ? `${r.reason}. Rejected: ${r.rejectionReason}` : r.reason), className: 'text-muted' },
          { header: '', align: 'right', cell: (r) => (r.status === 'PENDING' ? <Button small onClick={() => void cancel(r._id)}>Cancel</Button> : null) },
        ]}
      />
    </Card>
  );
}

function WfhCard({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [applying, setApplying] = useState(false);
  const { data, meta, loading, error, reload } = useFetch<WfhRequest[]>('/wfh/my', { page, limit: 5 });
  const today = todayString();
  const changed = () => { void reload(); onChange(); };

  const cancel = async (r: WfhRequest) => {
    if (!window.confirm(`Cancel your work from home for ${formatRange(r.startDate, r.endDate)}?`)) return;
    try {
      await api.patch(`/wfh/${r._id}/cancel`, {});
      toast('Request cancelled');
      changed();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <Card className="mt-4" flush title="Work from home" actions={<Button small variant="primary" onClick={() => setApplying(true)}>Apply for work from home</Button>}>
      {error && <Note>{error}</Note>}
      <DataTable<WfhRequest>
        rows={data}
        loading={loading}
        rowKey={(r) => r._id}
        empty="No work from home requests yet."
        columns={[
          { header: 'Dates', cell: (r) => formatRange(r.startDate, r.endDate), className: 'whitespace-nowrap' },
          { header: 'Days', align: 'right', cell: (r) => r.totalDays },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Reason', cell: (r) => (r.rejectionReason ? `${r.reason}. Rejected: ${r.rejectionReason}` : r.reason), className: 'text-muted' },
          { header: '', align: 'right', cell: (r) => ((r.status === 'PENDING' || (r.status === 'APPROVED' && r.endDate >= today)) ? <Button small onClick={() => void cancel(r)}>Cancel</Button> : null) },
        ]}
      />
      <Pagination meta={meta} onPage={setPage} />
      {applying && <ApplyWfhModal onClose={() => setApplying(false)} onDone={() => { setApplying(false); changed(); }} />}
    </Card>
  );
}

export function AttendancePage() {
  const [month, setMonth] = useState(todayString().slice(0, 7));
  const { data, loading, error, reload } = useFetch<AttendanceMonth>('/attendance/my', { month });
  const [fixing, setFixing] = useState<AttendanceDay | null>(null);
  const [corrections, setCorrections] = useState(0);
  const s = data?.summary;
  // Punches can be wrong on any past or current working day, so any of them can be raised.
  const canFix = (d: AttendanceDay) => Boolean(data) && d.date <= data!.today && !['NOT_EMPLOYED', 'ON_LEAVE', 'HOLIDAY'].includes(d.status) && (d.status !== 'WEEKEND' || Boolean(d.punchIn));
  return (
    <>
      <PageHeader title="Attendance" subtitle="Punch in when you start and punch out when you finish" />
      <PunchCard onChange={() => void reload()} />
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Present" value={s?.present ?? '—'} hint="Days this month" tone="brand" />
        <Stat label="Work from home" value={s?.workFromHome ?? '—'} hint="Days this month" tone="brand" />
        <Stat label="On leave" value={s?.onLeave ?? '—'} hint="Days this month" />
        <Stat label="Absent" value={s?.absent ?? '—'} hint="Days this month" tone={s?.absent ? 'amber' : undefined} />
      </div>
      <WfhCard onChange={() => void reload()} />
      <CorrectionsCard reloadKey={corrections} />
      <Card
        className="mt-4"
        flush
        title="Daily record"
        actions={<Input aria-label="Month" type="month" className="w-40 py-1" value={month} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} />}
      >
        {error && <Note>{error}</Note>}
        <AttendanceTable days={data?.days ?? null} loading={loading} actions={(d) => (canFix(d) ? <Button small onClick={() => setFixing(d)}>Fix</Button> : null)} />
      </Card>
      {fixing && <RequestCorrectionModal date={fixing.date} punchIn={fixing.punchIn} punchOut={fixing.punchOut} onClose={() => setFixing(null)} onDone={() => { setFixing(null); setCorrections((n) => n + 1); }} />}
    </>
  );
}
