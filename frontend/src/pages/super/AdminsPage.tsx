import { useState } from 'react';
import { api, errorMessage, fieldErrors } from '../../api/client';
import { Badge, Button, Card, CheckboxGroup, DataTable, Field, Input, Modal, Note, PageHeader, Pagination, Select, useToast } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import type { Employee, Role } from '../../types';
import { formatDateTime } from '../../utils/date';
import { PERMISSION_LABEL, ROLE_LABEL } from '../../utils/labels';
import { ActivationLinks } from '../admin/EmployeesPage';

interface AdminRow {
  _id: string;
  email: string;
  role: Role;
  customPermissions: string[] | null;
  effectivePermissions: string[];
  isActive: boolean;
  lastLoginAt: string | null;
  employee: { _id: string; employeeId: string; fullName: string } | null;
}

export function AdminsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const { data, meta, loading, error, reload } = useFetch<AdminRow[]>('/admins', { page, search, limit: 25 });
  const catalog = useFetch<{ assignable: string[] }>('/admins/permissions');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminRow | null>(null);
  const [links, setLinks] = useState<{ email: string; link: string }[] | null>(null);

  return (
    <>
      <PageHeader title="Admin accounts" subtitle="HR/Admin and Super Admin accounts, with what each can do" actions={<Button variant="primary" onClick={() => setCreating(true)}>Add admin</Button>} />
      <div className="mb-3 max-w-sm"><Input aria-label="Search" placeholder="Search email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<AdminRow>
          rows={data}
          loading={loading}
          rowKey={(a) => a._id}
          onRowClick={(a) => (a._id === user?.id ? toast('You cannot change your own account here', 'error') : setEditing(a))}
          columns={[
            { header: 'Account', cell: (a) => <div><div className="font-medium">{a.employee?.fullName ?? a.email}</div><div className="text-xs text-muted">{a.email}</div></div> },
            { header: 'Role', cell: (a) => <Badge tone={a.role === 'SUPER_ADMIN' ? 'sky' : 'green'}>{ROLE_LABEL[a.role]}</Badge> },
            { header: 'Permissions', cell: (a) => (a.role === 'SUPER_ADMIN' ? 'Everything' : a.customPermissions ? `${a.customPermissions.length} selected` : 'Standard HR set'), className: 'text-muted' },
            { header: 'Last sign-in', cell: (a) => formatDateTime(a.lastLoginAt), className: 'whitespace-nowrap text-muted' },
            { header: 'Status', cell: (a) => <Badge tone={a.isActive ? 'green' : 'gray'}>{a.isActive ? 'Active' : 'Inactive'}</Badge> },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {creating && (
        <CreateModal
          assignable={catalog.data?.assignable ?? []}
          onClose={() => setCreating(false)}
          onDone={(link, email) => {
            setCreating(false);
            void reload();
            if (link) setLinks([{ email, link }]);
            else toast('Admin added');
          }}
        />
      )}
      {editing && <EditModal admin={editing} assignable={catalog.data?.assignable ?? []} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast('Account updated'); void reload(); }} />}
      {links && <ActivationLinks links={links} onClose={() => setLinks(null)} />}
    </>
  );
}

function PermissionPicker({ assignable, custom, setCustom }: { assignable: string[]; custom: string[] | null; setCustom: (v: string[] | null) => void }) {
  return (
    <div className="space-y-2">
      <Select aria-label="Permission set" value={custom ? 'custom' : 'standard'} onChange={(e) => setCustom(e.target.value === 'custom' ? [...assignable] : null)}>
        <option value="standard">Standard HR set (everything HR can do)</option>
        <option value="custom">Choose specific permissions</option>
      </Select>
      {custom && <CheckboxGroup value={custom} onChange={setCustom} options={assignable.map((p) => ({ value: p, label: PERMISSION_LABEL[p] ?? p }))} />}
    </div>
  );
}

function CreateModal({ assignable, onClose, onDone }: { assignable: string[]; onClose: () => void; onDone: (link: string | null, email: string) => void }) {
  const employees = useFetch<Employee[]>('/employees', { status: 'ACTIVE', limit: 200, sort: 'fullName', order: 'asc' });
  const [mode, setMode] = useState<'new' | 'employee'>('new');
  const [email, setEmail] = useState('');
  const [employee, setEmployee] = useState('');
  const [role, setRole] = useState<'HR_ADMIN' | 'SUPER_ADMIN'>('HR_ADMIN');
  const [custom, setCustom] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/admins', {
        role,
        ...(mode === 'new' ? { email } : { employee }),
        ...(role === 'HR_ADMIN' ? { permissions: custom } : {}),
      });
      onDone(res.data.data.activationLink, res.data.data.admin.email);
    } catch (err) {
      setError(fieldErrors(err)[0]?.message ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add admin"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={mode === 'new' ? !email : !employee} onClick={() => void save()}>Add admin</Button></>}
    >
      <div className="space-y-3">
        {error && <Note>{error}</Note>}
        <Field label="Who">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'employee')}>
            <option value="new">A new account, with no employee record</option>
            <option value="employee">An existing employee</option>
          </Select>
        </Field>
        {mode === 'new' ? (
          <Field label="Email" required><Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        ) : (
          <Field label="Employee" required>
            <Select value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">Choose</option>
              {employees.data?.map((e) => <option key={e._id} value={e._id}>{e.fullName} ({e.employeeId})</option>)}
            </Select>
          </Field>
        )}
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as 'HR_ADMIN' | 'SUPER_ADMIN')}>
            <option value="HR_ADMIN">HR/Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </Select>
        </Field>
        {role === 'HR_ADMIN' && <Field label="Permissions"><PermissionPicker assignable={assignable} custom={custom} setCustom={setCustom} /></Field>}
      </div>
    </Modal>
  );
}

function EditModal({ admin, assignable, onClose, onDone }: { admin: AdminRow; assignable: string[]; onClose: () => void; onDone: () => void }) {
  const [role, setRole] = useState<Role>(admin.role);
  const [isActive, setIsActive] = useState(admin.isActive);
  const [custom, setCustom] = useState<string[] | null>(admin.customPermissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/admins/${admin._id}`, { role, isActive, ...(role === 'HR_ADMIN' ? { permissions: custom } : {}) });
      onDone();
    } catch (err) {
      setError(fieldErrors(err)[0]?.message ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit ${admin.email}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></>}
    >
      <div className="space-y-3">
        {error && <Note>{error}</Note>}
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="HR_ADMIN">HR/Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
            {admin.employee && <option value="EMPLOYEE">Employee (remove admin access)</option>}
          </Select>
        </Field>
        {role === 'HR_ADMIN' && <Field label="Permissions"><PermissionPicker assignable={assignable} custom={custom} setCustom={setCustom} /></Field>}
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Account active</label>
      </div>
    </Modal>
  );
}
