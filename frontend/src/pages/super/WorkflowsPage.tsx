import { useState } from 'react';
import { api, errorMessage, fieldErrors } from '../../api/client';
import { Badge, Button, Card, Checkbox, CheckboxGroup, DataTable, Field, Input, Modal, Note, PageHeader, Select, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import type { LeaveType, Named } from '../../types';

interface Step { order: number; approverType: string; label: string }
interface Workflow { _id: string; name: string; steps: Step[]; leaveTypes: (Named & { code: string })[]; isDefault: boolean; isActive: boolean }

const APPROVERS: Record<string, string> = { REPORTING_MANAGER: 'Reporting manager', HR_ADMIN: 'HR/Admin', SUPER_ADMIN: 'Super Admin' };

export function WorkflowsPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useFetch<Workflow[]>('/workflows');
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);

  return (
    <>
      <PageHeader
        title="Approval workflows"
        subtitle="The steps a request goes through. Each request keeps the steps it started with, so changes here only affect new requests. Nobody can approve their own leave."
        actions={<Button variant="primary" onClick={() => setEditing('new')}>Add workflow</Button>}
      />
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<Workflow>
          rows={data}
          loading={loading}
          rowKey={(w) => w._id}
          onRowClick={setEditing}
          columns={[
            { header: 'Workflow', cell: (w) => <span className="font-medium">{w.name}</span> },
            { header: 'Steps', cell: (w) => [...w.steps].sort((a, b) => a.order - b.order).map((s) => s.label || APPROVERS[s.approverType]).join(' → ') },
            { header: 'Used for', cell: (w) => (w.isDefault ? 'All other leave types' : w.leaveTypes.map((t) => t.code).join(', ') || '—'), className: 'text-muted' },
            { header: 'Status', cell: (w) => <span className="flex gap-1">{w.isDefault && <Badge tone="sky">Default</Badge>}<Badge tone={w.isActive ? 'green' : 'gray'}>{w.isActive ? 'Active' : 'Inactive'}</Badge></span> },
          ]}
        />
      </Card>
      {editing && <WorkflowModal workflow={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast('Workflow saved'); void reload(); }} />}
    </>
  );
}

function WorkflowModal({ workflow, onClose, onDone }: { workflow: Workflow | null; onClose: () => void; onDone: () => void }) {
  const types = useFetch<LeaveType[]>('/leave-types');
  const [name, setName] = useState(workflow?.name ?? '');
  const [steps, setSteps] = useState<Step[]>(workflow ? [...workflow.steps].sort((a, b) => a.order - b.order) : [{ order: 1, approverType: 'HR_ADMIN', label: 'HR approval' }]);
  const [leaveTypes, setLeaveTypes] = useState<string[]>(workflow?.leaveTypes.map((t) => t._id) ?? []);
  const [isDefault, setIsDefault] = useState(workflow?.isDefault ?? false);
  const [isActive, setIsActive] = useState(workflow?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { name, isDefault, isActive, leaveTypes, steps: steps.map((s, i) => ({ order: i + 1, approverType: s.approverType, label: s.label })) };
    try {
      if (workflow) await api.put(`/workflows/${workflow._id}`, body);
      else await api.post('/workflows', body);
      onDone();
    } catch (err) {
      setError(fieldErrors(err)[0]?.message ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={workflow ? `Edit ${workflow.name}` : 'Add workflow'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !steps.length} onClick={() => void save()}>Save</Button></>}
    >
      <div className="space-y-3">
        {error && <Note>{error}</Note>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">Steps, in order</div>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="tnum w-4 text-xs text-muted">{i + 1}</span>
                <Select aria-label={`Step ${i + 1} approver`} value={s.approverType} onChange={(e) => update(i, { approverType: e.target.value })}>
                  {Object.entries(APPROVERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                <Input aria-label={`Step ${i + 1} label`} placeholder="Label" value={s.label} onChange={(e) => update(i, { label: e.target.value })} />
                <Button small variant="ghost" disabled={steps.length === 1} onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>Remove</Button>
              </li>
            ))}
          </ol>
          {steps.length < 5 && <Button small className="mt-2" onClick={() => setSteps((all) => [...all, { order: all.length + 1, approverType: 'HR_ADMIN', label: '' }])}>Add step</Button>}
          <p className="mt-1.5 text-xs text-faint">A manager step is skipped for anyone without a reporting manager.</p>
        </div>
        <div className="space-y-2">
          <Checkbox label="Default for leave types without their own workflow" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <Checkbox label="Active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        </div>
        {!isDefault && (
          <Field label="Used for these leave types">
            <CheckboxGroup value={leaveTypes} onChange={setLeaveTypes} options={(types.data ?? []).filter((t) => t.isActive).map((t) => ({ value: t._id, label: t.name }))} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
