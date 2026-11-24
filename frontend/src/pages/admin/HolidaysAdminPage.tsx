import { zodResolver } from '@hookform/resolvers/zod';
import enGb from '@fullcalendar/core/locales/en-gb';
import dayGridPlugin from '@fullcalendar/daygrid';
import FullCalendar from '@fullcalendar/react';
import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { api, applyServerErrors, errorMessage } from '../../api/client';
import { Badge, Button, Card, Checkbox, CheckboxGroup, DataTable, Field, Input, Modal, Note, PageHeader, Select, Tabs, Textarea, useConfirm, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import { downloadFile, uploadImport } from '../../services/download';
import type { ApiFieldError, Holiday, Named } from '../../types';
import { addOneDay } from '../../utils/calendar';
import { currentYear, formatDay } from '../../utils/date';
import { EMPLOYEE_CATEGORIES, HOLIDAY_CATEGORIES, titleCase } from '../../utils/labels';
import { HolidayForm, holidaySchema } from '../../validations';

// Stable references, since FullCalendar re-initialises when these options change identity.
const PLUGINS = [dayGridPlugin];
const LOCALES = [enGb];
const TOOLBAR = { left: 'prev,next', center: 'title', right: '' };

export function HolidaysAdminPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [year, setYear] = useState(currentYear());
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [editing, setEditing] = useState<Holiday | 'new' | null>(null);
  const [importResult, setImportResult] = useState<{ total: number; created: number; errors: ApiFieldError[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data, loading, error, reload } = useFetch<Holiday[]>('/holidays', { year, scope: 'all' });
  const locations = useFetch<Named[]>('/locations');
  const departments = useFetch<Named[]>('/departments');

  const names = (ids: string[], list: Named[] | null) => ids.map((id) => list?.find((x) => x._id === id)?.name ?? '').filter(Boolean).join(', ');

  const copyPrevious = async () => {
    if (!(await confirm({ title: `Copy ${year - 1} holidays into ${year}?`, message: 'Festival dates usually move, so check each one afterwards.', confirmLabel: 'Copy holidays' }))) return;
    try {
      const res = await api.post('/holidays/copy', { fromYear: year - 1, toYear: year });
      const { copied, skipped } = res.data.data;
      toast(`${copied} holidays copied${skipped.length ? `, ${skipped.length} skipped` : ''}`);
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const remove = async (h: Holiday) => {
    const note = h.recurring ? 'It repeats every year, so it will be removed from all years. ' : '';
    if (!(await confirm({ title: `Delete ${h.name}?`, message: `${note}Leave already approved keeps its recorded duration.`, confirmLabel: 'Delete holiday', tone: 'danger' }))) return;
    try {
      await api.delete(`/holidays/${h._id}`);
      toast('Holiday deleted');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const onImport = async (file?: File) => {
    if (!file) return;
    try {
      setImportResult(await uploadImport('/holidays/import', file));
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const exportAs = async (format: 'xlsx' | 'csv') => {
    try {
      await downloadFile('/holidays/export', { year, format }, `holidays-${year}.${format}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Holiday calendar"
        subtitle={`${data?.length ?? 0} holidays in ${year}`}
        actions={
          <>
            <Tabs value={view} onChange={setView} tabs={[{ value: 'list', label: 'List' }, { value: 'calendar', label: 'Calendar' }]} />
            <Button variant="primary" onClick={() => setEditing('new')}>Add holiday</Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Year" type="number" className="w-24" value={year} onChange={(e) => setYear(Number(e.target.value) || currentYear())} />
        <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden aria-label="Import holidays file" onChange={(e) => void onImport(e.target.files?.[0])} />
        <Button onClick={() => fileRef.current?.click()}>Import</Button>
        <Button onClick={() => exportAs('xlsx')}>Export Excel</Button>
        <Button onClick={() => exportAs('csv')}>Export CSV</Button>
        <Button onClick={() => copyPrevious()}>Copy from {year - 1}</Button>
      </div>

      {importResult && (
        <div className="mb-3 space-y-1">
          <Note tone={importResult.errors.length ? 'amber' : 'green'}>
            Imported {importResult.created} of {importResult.total} rows.
            {importResult.errors.length > 0 && <ul className="mt-1 list-inside list-disc">{importResult.errors.slice(0, 15).map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}</ul>}
          </Note>
          <p className="text-xs text-muted">Columns: Name, Date, Category, Description, Location, Team, Employee Group, Half Day, Recurring.</p>
        </div>
      )}
      {error && <Note>{error}</Note>}

      {view === 'list' ? (
        <Card flush>
          <DataTable<Holiday>
            rows={data}
            loading={loading}
            rowKey={(h) => h._id + h.occurrenceDate}
            empty={`No holidays for ${year} yet.`}
            columns={[
              { header: 'Date', cell: (h) => formatDay(h.occurrenceDate), className: 'whitespace-nowrap' },
              { header: 'Holiday', cell: (h) => <div><div className="font-medium">{h.name}</div>{h.description && <div className="text-xs text-muted">{h.description}</div>}</div> },
              { header: 'Category', cell: (h) => <Badge tone={h.category === 'OPTIONAL' ? 'sky' : 'gray'}>{titleCase(h.category)}</Badge> },
              {
                header: 'Applies to',
                className: 'text-xs text-muted',
                cell: (h) => [names(h.locations, locations.data), names(h.departments, departments.data), h.employeeCategories.map(titleCase).join(', ')].filter(Boolean).join(' · ') || 'Everyone',
              },
              { header: 'Day', cell: (h) => (h.isHalfDay ? 'Half' : 'Full') },
              { header: 'Repeats', cell: (h) => (h.recurring ? 'Yearly' : '—') },
              {
                header: '',
                align: 'right',
                cell: (h) => (
                  <span className="flex justify-end gap-1">
                    <Button small variant="ghost" onClick={() => setEditing(h)}>Edit</Button>
                    <Button small variant="ghost" className="text-rose" onClick={() => remove(h)}>Delete</Button>
                  </span>
                ),
              },
            ]}
          />
        </Card>
      ) : (
        <Card>
          <FullCalendar
            key={year}
            plugins={PLUGINS}
            locales={LOCALES}
            locale="en-gb"
            initialView="dayGridMonth"
            initialDate={`${year}-01-01`}
            validRange={{ start: `${year}-01-01`, end: `${year + 1}-01-01` }}
            firstDay={1}
            height="auto"
            headerToolbar={TOOLBAR}
            events={(data ?? []).map((h) => ({ id: h._id + h.occurrenceDate, title: h.name, start: h.occurrenceDate, end: addOneDay(h.occurrenceDate), allDay: true, backgroundColor: h.category === 'OPTIONAL' ? '#1d5f8a' : '#a8560a', borderColor: 'transparent', extendedProps: { holiday: h } }))}
            eventClick={(arg) => setEditing(arg.event.extendedProps.holiday as Holiday)}
          />
        </Card>
      )}

      {editing && (
        <HolidayFormModal
          holiday={editing === 'new' ? null : editing}
          year={year}
          locations={locations.data ?? []}
          departments={departments.data ?? []}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); toast('Holiday saved'); void reload(); }}
        />
      )}
    </>
  );
}

function HolidayFormModal({ holiday, year, locations, departments, onClose, onDone }: { holiday: Holiday | null; year: number; locations: Named[]; departments: Named[]; onClose: () => void; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, watch, control, formState: { errors, isSubmitting } } = useForm<HolidayForm>({
    resolver: zodResolver(holidaySchema),
    defaultValues: holiday
      ? {
          name: holiday.name, date: holiday.date, category: holiday.category as HolidayForm['category'], description: holiday.description ?? '',
          isHalfDay: holiday.isHalfDay, halfDaySession: holiday.halfDaySession, recurring: holiday.recurring,
          locations: holiday.locations, departments: holiday.departments, employeeCategories: holiday.employeeCategories as HolidayForm['employeeCategories'],
        }
      : { name: '', date: `${year}-01-01`, category: 'COMPANY', description: '', isHalfDay: false, halfDaySession: 'SECOND', recurring: false, locations: [], departments: [], employeeCategories: [] },
  });

  const onSubmit = async (v: HolidayForm) => {
    setFormError(null);
    const body = { ...v, description: v.description || null };
    try {
      if (holiday) await api.put(`/holidays/${holiday._id}`, body);
      else await api.post('/holidays', body);
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['name', 'date', 'category', 'description'] as const));
    }
  };

  return (
    <Modal
      wide
      title={holiday ? `Edit ${holiday.name}` : 'Add holiday'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="holiday-form" loading={isSubmitting}>Save holiday</Button></>}
    >
      <form id="holiday-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Holiday name" required error={errors.name?.message}><Input {...register('name')} /></Field>
        <Field label="Date" required error={errors.date?.message}><Input type="date" {...register('date')} /></Field>
        <Field label="Category" required hint={watch('category') === 'OPTIONAL' ? 'Optional holidays stay working days unless taken as Optional Holiday leave.' : undefined}>
          <Select {...register('category')}>{HOLIDAY_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</Select>
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <Checkbox label="Half day" {...register('isHalfDay')} />
          <Checkbox label="Repeats every year" {...register('recurring')} />
        </div>
        {watch('isHalfDay') && (
          <Field label="Which half is off">
            <Select {...register('halfDaySession')}><option value="FIRST">First half</option><option value="SECOND">Second half</option></Select>
          </Field>
        )}
        <div className="sm:col-span-2"><Field label="Description"><Textarea rows={2} {...register('description')} /></Field></div>
        <div className="sm:col-span-2 text-xs text-muted">Leave a group below empty to apply to everyone.</div>
        <Field label="Applicable locations">
          <Controller control={control} name="locations" render={({ field }) => <CheckboxGroup value={field.value} onChange={field.onChange} options={locations.map((l) => ({ value: l._id, label: l.name }))} />} />
        </Field>
        <Field label="Applicable teams">
          <Controller control={control} name="departments" render={({ field }) => <CheckboxGroup value={field.value} onChange={field.onChange} options={departments.map((d) => ({ value: d._id, label: d.name }))} />} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Applicable employee groups">
            <Controller control={control} name="employeeCategories" render={({ field }) => <CheckboxGroup value={field.value} onChange={(v) => field.onChange(v)} options={EMPLOYEE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
