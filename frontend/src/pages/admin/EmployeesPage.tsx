import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { api, applyServerErrors, errorMessage } from '../../api/client';
import { PersonAvatar } from '../../components/Avatar';
import { Button, Card, DataTable, Field, Input, Loading, Modal, Note, PageHeader, Pagination, Select, StatusBadge, useToast } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import { uploadImport } from '../../services/download';
import type { ApiFieldError, Employee, Named } from '../../types';
import { formatDate } from '../../utils/date';
import { EMPLOYEE_CATEGORIES, EMPLOYEE_GENDERS, titleCase } from '../../utils/labels';
import { EmployeeForm, employeeSchema } from '../../validations';

export function EmployeesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [activation, setActivation] = useState<{ email: string; link: string }[] | null>(null);
  const [importResult, setImportResult] = useState<{ total: number; created: number; errors: ApiFieldError[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, meta, loading, error, reload } = useFetch<Employee[]>('/employees', { search, department, location, status, page, limit: 25, sort: 'fullName', order: 'asc' });
  const departments = useFetch<Named[]>('/departments');
  const locations = useFetch<Named[]>('/locations');
  const reset = () => setPage(1);

  const onImport = async (file?: File) => {
    if (!file) return;
    try {
      const result = await uploadImport<{ total: number; created: number; errors: ApiFieldError[]; activationLinks: { email: string; link: string }[] }>('/employees/import', file);
      setImportResult(result);
      if (result.activationLinks.length) setActivation(result.activationLinks);
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle={meta ? `${meta.total} records` : undefined}
        actions={can('employees:write') && (
          <>
            <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden aria-label="Import employees file" onChange={(e) => void onImport(e.target.files?.[0])} />
            <Button onClick={() => fileRef.current?.click()}>Import CSV or Excel</Button>
            <Button variant="primary" onClick={() => setCreating(true)}>Add employee</Button>
          </>
        )}
      />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Search" placeholder="Search name, ID or email" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} />
        <Select aria-label="Department" value={department} onChange={(e) => { setDepartment(e.target.value); reset(); }}>
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </Select>
        <Select aria-label="Location" value={location} onChange={(e) => { setLocation(e.target.value); reset(); }}>
          <option value="">All locations</option>
          {locations.data?.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }}>
          <option value="">Any status</option>
          <option value="ACTIVE">Active</option>
          <option value="ON_NOTICE">On notice</option>
          <option value="INACTIVE">Inactive</option>
        </Select>
      </div>

      {importResult && (
        <div className="mb-3 space-y-1">
          <Note tone={importResult.errors.length ? 'amber' : 'green'}>
            Imported {importResult.created} of {importResult.total} rows.
            {importResult.errors.length > 0 && (
              <ul className="mt-1 list-inside list-disc">
                {importResult.errors.slice(0, 15).map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}
                {importResult.errors.length > 15 && <li>and {importResult.errors.length - 15} more</li>}
              </ul>
            )}
          </Note>
          <p className="text-xs text-muted">Columns: Employee ID, Full Name, Email, Joining Date, Gender, Phone, Department, Designation, Reporting Manager (employee ID), Location, Category, Leave Policy.</p>
        </div>
      )}

      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<Employee>
          rows={data}
          loading={loading}
          rowKey={(e) => e._id}
          onRowClick={(e) => navigate(`/admin/employees/${e._id}`)}
          empty="No employees match."
          columns={[
            { header: 'Name', cell: (e) => <div className="flex items-center gap-2.5"><PersonAvatar person={e} /><div><div className="font-medium">{e.fullName}</div><div className="text-xs text-muted">{e.email}</div></div></div> },
            { header: 'ID', cell: (e) => e.employeeId, className: 'text-muted' },
            { header: 'Gender', cell: (e) => (e.gender ? titleCase(e.gender) : 'Not recorded'), className: 'text-muted' },
            { header: 'Department', cell: (e) => e.department?.name ?? '—' },
            { header: 'Designation', cell: (e) => e.designation ?? '—', className: 'text-muted' },
            { header: 'Location', cell: (e) => e.location?.name ?? '—', className: 'text-muted' },
            { header: 'Joined', cell: (e) => formatDate(e.joiningDate), className: 'whitespace-nowrap text-muted' },
            { header: 'Status', cell: (e) => <StatusBadge status={e.employmentStatus} /> },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>

      {creating && (
        <EmployeeFormModal
          onClose={() => setCreating(false)}
          onSaved={(res) => {
            setCreating(false);
            void reload();
            if (res?.activationLink) setActivation([{ email: res.employee.email, link: res.activationLink }]);
            else toast('Employee added and invited by email');
          }}
        />
      )}
      {activation && <ActivationLinks links={activation} onClose={() => setActivation(null)} />}
    </>
  );
}

export function ActivationLinks({ links, onClose }: { links: { email: string; link: string }[]; onClose: () => void }) {
  return (
    <Modal wide title="Send these activation links" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <p className="mb-3 text-[13px] text-muted">Email is not configured, so send each person their link privately. Each works once and expires in 72 hours. They will not be shown again.</p>
      <ul className="space-y-2">
        {links.map((l) => (
          <li key={l.email}>
            <div className="text-xs font-medium">{l.email}</div>
            <Input readOnly value={l.link} onFocus={(e) => e.target.select()} aria-label={`Activation link for ${l.email}`} />
          </li>
        ))}
      </ul>
    </Modal>
  );
}

const FORM_FIELDS = ['employeeId', 'fullName', 'email', 'phone', 'gender', 'department', 'designation', 'reportingManager', 'joiningDate', 'location', 'category', 'leavePolicy'] as const;

export function EmployeeFormModal({ employee, onClose, onSaved }: { employee?: Employee; onClose: () => void; onSaved: (res?: { employee: Employee; activationLink: string | null }) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const departments = useFetch<Named[]>('/departments');
  const locations = useFetch<Named[]>('/locations');
  const policies = useFetch<Named[]>('/leave-policies');
  const managers = useFetch<Employee[]>('/employees', { status: 'ACTIVE', limit: 200, sort: 'fullName', order: 'asc' });
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<EmployeeForm>({
    resolver: zodResolver(employeeSchema),
    defaultValues: employee
      ? {
          employeeId: employee.employeeId, fullName: employee.fullName, email: employee.email, phone: employee.phone ?? '', gender: employee.gender ?? '',
          department: employee.department?._id ?? '', designation: employee.designation ?? '', reportingManager: employee.reportingManager?._id ?? '',
          joiningDate: employee.joiningDate, location: employee.location?._id ?? '', category: employee.category, leavePolicy: employee.leavePolicy?._id ?? '',
        }
      : { category: 'PERMANENT' },
  });

  const onSubmit = async (v: EmployeeForm) => {
    setFormError(null);
    const body = {
      fullName: v.fullName, email: v.email, phone: v.phone || null, gender: v.gender || null, department: v.department || null, designation: v.designation || null,
      reportingManager: v.reportingManager || null, joiningDate: v.joiningDate, location: v.location || null, category: v.category, leavePolicy: v.leavePolicy || null,
    };
    try {
      if (employee) {
        await api.put(`/employees/${employee._id}`, body);
        onSaved();
      } else {
        const res = await api.post('/employees', { employeeId: v.employeeId, ...body });
        onSaved(res.data.data);
      }
    } catch (err) {
      setFormError(applyServerErrors(err, setError, FORM_FIELDS));
    }
  };

  // Policies need their own permission, so the field is left out for admins without it.
  const showPolicies = !policies.error;
  // A select can only show its saved value once that option exists, so the fields wait for the lists.
  const loadingOptions = departments.loading || locations.loading || policies.loading || managers.loading;

  return (
    <Modal
      wide
      title={employee ? `Edit ${employee.fullName}` : 'Add employee'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="employee-form" loading={isSubmitting} disabled={loadingOptions}>{employee ? 'Save changes' : 'Add employee'}</Button></>}
    >
      {loadingOptions ? <Loading /> : <form id="employee-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Employee ID" required error={errors.employeeId?.message} hint={employee ? 'Cannot be changed' : undefined}><Input disabled={Boolean(employee)} {...register('employeeId')} /></Field>
        <Field label="Full name" required error={errors.fullName?.message}><Input {...register('fullName')} /></Field>
        <Field label="Email" required error={errors.email?.message}><Input type="email" {...register('email')} /></Field>
        <Field label="Phone" error={errors.phone?.message}><Input {...register('phone')} /></Field>
        <Field label="Gender" hint="Decides access to maternity, paternity and menstrual leave" error={errors.gender?.message}>
          <Select {...register('gender')}><option value="">Not recorded</option>{EMPLOYEE_GENDERS.map((g) => <option key={g} value={g}>{titleCase(g)}</option>)}</Select>
        </Field>
        <Field label="Department" error={errors.department?.message}>
          <Select {...register('department')}><option value="">None</option>{departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</Select>
        </Field>
        <Field label="Designation" error={errors.designation?.message}><Input {...register('designation')} /></Field>
        <Field label="Reporting manager" error={errors.reportingManager?.message}>
          <Select {...register('reportingManager')}>
            <option value="">None</option>
            {managers.data?.filter((m) => m._id !== employee?._id).map((m) => <option key={m._id} value={m._id}>{m.fullName} ({m.employeeId})</option>)}
          </Select>
        </Field>
        <Field label="Joining date" required error={errors.joiningDate?.message}><Input type="date" {...register('joiningDate')} /></Field>
        <Field label="Office location" error={errors.location?.message}>
          <Select {...register('location')}><option value="">None</option>{locations.data?.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</Select>
        </Field>
        <Field label="Employee category" required error={errors.category?.message}>
          <Select {...register('category')}>{EMPLOYEE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</Select>
        </Field>
        {showPolicies && (
          <Field label="Assigned leave policy" hint="Blank means the best match for this person's department and location" error={errors.leavePolicy?.message}>
            <Select {...register('leavePolicy')}><option value="">Automatic</option>{policies.data?.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</Select>
          </Field>
        )}
      </form>}
    </Modal>
  );
}
