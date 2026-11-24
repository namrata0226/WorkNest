import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, applyServerErrors, errorMessage } from '../../api/client';
import { PersonAvatar } from '../../components/Avatar';
import { Button, Card, DataTable, Field, Input, Modal, Note, PageHeader, Pagination, Select, Stat, Textarea, useToast } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { monthPeriod, Period, PeriodPicker, periodLabel, periodParams } from '../../components/PeriodPicker';
import { useFetch } from '../../hooks/useFetch';
import type { AttendanceDay, AttendanceMonth, AttendanceSummary, Named } from '../../types';
import { downloadFile } from '../../services/download';
import { formatDay, todayString } from '../../utils/date';
import { AttendanceCorrectionForm, attendanceCorrectionSchema } from '../../validations';
import { attendanceRate, AttendanceBadge, AttendanceTable, formatWorked } from '../AttendancePage';

type Row = AttendanceDay & { employee: { _id: string; fullName: string; employeeId: string; department: string | null; avatarFile?: string | null } };
interface Daily { date: string; today: string; summary: AttendanceSummary & { notPunched: number }; rows: Row[] }
type Who = Pick<Row['employee'], '_id' | 'fullName'>;

function CorrectModal({ who, day, onClose, onDone }: { who: Who; day: Pick<AttendanceDay, 'date' | 'punchIn' | 'punchOut'>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<AttendanceCorrectionForm>({
    resolver: zodResolver(attendanceCorrectionSchema),
    defaultValues: { punchIn: day.punchIn ?? '', punchOut: day.punchOut ?? '', note: '' },
  });

  const onSubmit = async (v: AttendanceCorrectionForm) => {
    setFormError(null);
    try {
      await api.put(`/attendance/employees/${who._id}/${day.date}`, { punchIn: v.punchIn, punchOut: v.punchOut || null, note: v.note });
      toast('Attendance corrected');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['punchIn', 'punchOut', 'note'] as const));
    }
  };

  return (
    <Modal
      title={`Correct ${who.fullName}, ${formatDay(day.date)}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="correct-form" loading={isSubmitting}>Save correction</Button></>}
    >
      <form id="correct-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Punch in" required error={errors.punchIn?.message}><Input type="time" {...register('punchIn')} /></Field>
        <Field label="Punch out" error={errors.punchOut?.message}><Input type="time" {...register('punchOut')} /></Field>
        <div className="sm:col-span-2">
          <Field label="Reason" required hint="The employee can see this, and it is kept in the audit log" error={errors.note?.message}><Textarea {...register('note')} /></Field>
        </div>
      </form>
    </Modal>
  );
}

/** One person's attendance over any period: a month, a preset such as last 7 days, or custom dates. */
function EmployeePeriodModal({ who, base, initial, canCorrect, onClose, onChanged }: { who: Who; base: string; initial: Period; canCorrect: boolean; onClose: () => void; onChanged: () => void }) {
  const [period, setPeriod] = useState<Period>(initial);
  const params = periodParams(period);
  const { data, loading, error, reload } = useFetch<AttendanceMonth>(params ? `${base}/${who._id}` : null, params ?? undefined);
  const [correcting, setCorrecting] = useState<AttendanceDay | null>(null);
  const correctable = (d: AttendanceDay) => canCorrect && data && d.date <= data.today && d.status !== 'NOT_EMPLOYED';
  const s = data?.summary;
  return (
    <Modal wide title={who.fullName} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <PeriodPicker className="mb-3" value={period} onChange={setPeriod} />
      {s && params && (
        <p className="mb-3 text-[13px] text-muted">
          {periodLabel(period)}: <strong className="text-ink">{s.attended}</strong> attended{attendanceRate(s) != null ? ` (${attendanceRate(s)}%)` : ''} · <strong className="text-ink">{s.present}</strong> present · <strong className="text-ink">{s.workFromHome}</strong> work from home · <strong className="text-ink">{s.onLeave}</strong> on leave · <strong className={s.absent ? 'text-amber' : 'text-ink'}>{s.absent}</strong> absent
        </p>
      )}
      {error && <Note>{error}</Note>}
      <AttendanceTable days={data?.days ?? null} loading={loading} actions={(d) => (correctable(d) ? <Button small onClick={() => setCorrecting(d)}>Correct</Button> : null)} />
      {correcting && <CorrectModal who={who} day={correcting} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); void reload(); onChanged(); }} />}
    </Modal>
  );
}

/** Download everyone's attendance (or one department's) for any period, as Excel or CSV. */
function ExportModal({ initial, department, departmentName, onClose }: { initial: Period; department: string; departmentName?: string; onClose: () => void }) {
  const toast = useToast();
  const [period, setPeriod] = useState<Period>(initial);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const params = periodParams(period);
  const download = async () => {
    if (!params) return;
    const name = params.from.slice(0, 7) === params.to.slice(0, 7) && period.kind !== 'custom' && params.from.endsWith('-01') ? params.from.slice(0, 7) : `${params.from}_to_${params.to}`;
    try {
      await downloadFile('/attendance/export', { ...params, department, format }, `attendance-${name}.${format}`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Modal
      title="Export attendance"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!params} onClick={() => download()}>Download</Button></>}
    >
      <div className="space-y-3">
        <div><span className="mb-1 block text-xs font-medium text-muted">Period</span><PeriodPicker value={period} onChange={setPeriod} /></div>
        <Field label="Format">
          <Select className="w-44" value={format} onChange={(e) => setFormat(e.target.value as 'xlsx' | 'csv')}>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV</option>
          </Select>
        </Field>
        <p className="text-[13px] text-muted">
          {departmentName ? `${departmentName} only` : 'All departments'}{params ? `, ${periodLabel(period)}` : ''}. One row per person, with totals and a column for each day.
        </p>
      </div>
    </Modal>
  );
}

function AttendanceBoard({ title, subtitle, dailyUrl, monthBase, manage }: { title: string; subtitle: string; dailyUrl: string; monthBase: string; manage: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const [date, setDate] = useState(todayString());
  const [department, setDepartment] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<Who | null>(null);
  const [correcting, setCorrecting] = useState<Row | null>(null);
  const departments = useFetch<Named[]>(manage ? '/departments' : null);
  const { data, meta, loading, error, reload } = useFetch<Daily>(dailyUrl, { date, ...(manage ? { department } : {}), search, page, limit: 25 });
  const s = data?.summary;
  const isSelf = (id: string) => user?.employee?._id === id;
  const [exporting, setExporting] = useState(false);

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={manage && <Button onClick={() => setExporting(true)}>Export attendance</Button>} />
      <div className={`mb-3 grid gap-2 ${manage ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <Input aria-label="Date" type="date" max={data?.today} value={date} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setPage(1); } }} />
        {manage && (
          <Select aria-label="Department" value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }}>
            <option value="">All departments</option>
            {departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </Select>
        )}
        <Input aria-label="Search" placeholder="Search name or ID" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total attendance" value={s?.attended ?? '—'} hint="In office + work from home" tone="brand" />
        <Stat label="Present" value={s?.present ?? '—'} tone="brand" />
        <Stat label="Work from home" value={s?.workFromHome ?? '—'} tone="brand" />
        <Stat label="On leave" value={s?.onLeave ?? '—'} />
        <Stat label="Absent" value={s?.absent ?? '—'} tone={s?.absent ? 'amber' : undefined} />
        <Stat label="Not punched in yet" value={s?.notPunched ?? '—'} />
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<Row>
          rows={data?.rows ?? null}
          loading={loading}
          rowKey={(r) => r.employee._id}
          onRowClick={(r) => setViewing(r.employee)}
          empty={manage ? 'No employees match.' : 'Nobody reports to you, or no one matches.'}
          columns={[
            { header: 'Employee', cell: (r) => <div className="flex items-center gap-2.5"><PersonAvatar person={r.employee} /><div><div className="font-medium">{r.employee.fullName}</div><div className="text-xs text-muted">{r.employee.employeeId} · {r.employee.department ?? 'No department'}</div></div></div> },
            { header: 'Status', cell: (r) => <AttendanceBadge day={r} /> },
            { header: 'Punch in', cell: (r) => r.punchIn ?? '—', className: 'tnum' },
            { header: 'Punch out', cell: (r) => r.punchOut ?? (r.punchIn ? 'Not recorded' : '—'), className: 'tnum' },
            { header: 'Worked', align: 'right', cell: (r) => formatWorked(r.workedMinutes), className: 'tnum' },
            ...(manage ? [{ header: '', align: 'right' as const, cell: (r: Row) => (isSelf(r.employee._id) ? null : <Button small onClick={(e) => { e.stopPropagation(); setCorrecting(r); }}>Correct</Button>) }] : []),
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {viewing && <EmployeePeriodModal who={viewing} base={monthBase} initial={monthPeriod(date.slice(0, 7))} canCorrect={manage && !isSelf(viewing._id)} onClose={() => setViewing(null)} onChanged={() => void reload()} />}
      {exporting && <ExportModal initial={monthPeriod(date.slice(0, 7))} department={department} departmentName={departments.data?.find((d) => d._id === department)?.name} onClose={() => setExporting(false)} />}
      {correcting && <CorrectModal who={correcting.employee} day={correcting} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); void reload(); }} />}
    </>
  );
}

export const AttendanceAdminPage = () => <AttendanceBoard manage title="Attendance" subtitle="Everyone's attendance for one day. Select a person to see any period." dailyUrl="/attendance" monthBase="/attendance/employees" />;

export const TeamAttendancePage = () => <AttendanceBoard manage={false} title="Team attendance" subtitle="The people who report to you. Select a person to see any period." dailyUrl="/attendance/team" monthBase="/attendance/team" />;
