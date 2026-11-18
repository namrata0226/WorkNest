import { useState } from 'react';
import { api, errorMessage, fieldErrors } from '../../api/client';
import { Badge, Button, Card, Checkbox, CheckboxGroup, DataTable, Field, Input, Modal, Note, PageHeader, Select, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import type { LeaveType, Named } from '../../types';
import { formatDate, todayString } from '../../utils/date';
import { EMPLOYEE_CATEGORIES, titleCase } from '../../utils/labels';

interface PolicyRule {
  leaveType: string;
  isAllowed?: boolean;
  annualEntitlement?: number;
  monthlyAccrual?: number;
  maxDuration?: number | null;
  minNoticeDays?: number;
  maxCarryForward?: number;
}

interface Policy {
  _id: string;
  name: string;
  description: string | null;
  departments: Named[];
  locations: Named[];
  designations: string[];
  categories: string[];
  rules: PolicyRule[];
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export function PoliciesPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useFetch<Policy[]>('/leave-policies');
  const [editing, setEditing] = useState<Policy | 'new' | null>(null);

  const appliesTo = (p: Policy) =>
    [p.departments.map((d) => d.name).join(', '), p.locations.map((l) => l.name).join(', '), p.designations.join(', '), p.categories.map(titleCase).join(', ')].filter(Boolean).join(' · ') || 'Everyone';

  return (
    <>
      <PageHeader
        title="Leave policies"
        subtitle="Override leave type rules for a group. An assignment on the employee wins; otherwise the policy naming the most matching dimensions applies."
        actions={<Button variant="primary" onClick={() => setEditing('new')}>Add policy</Button>}
      />
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<Policy>
          rows={data}
          loading={loading}
          rowKey={(p) => p._id}
          onRowClick={setEditing}
          empty="No policies yet. Everyone follows the leave type defaults."
          columns={[
            { header: 'Policy', cell: (p) => <div><div className="font-medium">{p.name}</div>{p.description && <div className="text-xs text-muted">{p.description}</div>}</div> },
            { header: 'Applies to', cell: appliesTo, className: 'text-muted' },
            { header: 'Effective', cell: (p) => `${formatDate(p.effectiveFrom)}${p.effectiveTo ? ` to ${formatDate(p.effectiveTo)}` : ' onward'}`, className: 'whitespace-nowrap' },
            { header: 'Overrides', align: 'right', cell: (p) => p.rules.length },
            { header: 'Status', cell: (p) => <Badge tone={p.isActive ? 'green' : 'gray'}>{p.isActive ? 'Active' : 'Inactive'}</Badge> },
          ]}
        />
      </Card>
      {editing && <PolicyModal policy={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast('Policy saved'); void reload(); }} />}
    </>
  );
}

const toNumber = (text: string) => (text.trim() === '' ? undefined : Number(text));

function PolicyModal({ policy, onClose, onDone }: { policy: Policy | null; onClose: () => void; onDone: () => void }) {
  const types = useFetch<LeaveType[]>('/leave-types');
  const departments = useFetch<Named[]>('/departments');
  const locations = useFetch<Named[]>('/locations');
  const [name, setName] = useState(policy?.name ?? '');
  const [description, setDescription] = useState(policy?.description ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(policy?.effectiveFrom ?? todayString());
  const [effectiveTo, setEffectiveTo] = useState(policy?.effectiveTo ?? '');
  const [isActive, setIsActive] = useState(policy?.isActive ?? true);
  const [deptIds, setDeptIds] = useState<string[]>(policy?.departments.map((d) => d._id) ?? []);
  const [locIds, setLocIds] = useState<string[]>(policy?.locations.map((l) => l._id) ?? []);
  const [designations, setDesignations] = useState(policy?.designations.join(', ') ?? '');
  const [categories, setCategories] = useState<string[]>(policy?.categories ?? []);
  const [rules, setRules] = useState<Record<string, PolicyRule>>(Object.fromEntries((policy?.rules ?? []).map((r) => [r.leaveType, r])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRule = (typeId: string, patch: Partial<PolicyRule>) =>
    setRules((all) => {
      const next = { ...(all[typeId] ?? { leaveType: typeId }), ...patch };
      return { ...all, [typeId]: next };
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    // A rule with only its leave type overrides nothing, so it is not sent.
    const cleaned = Object.values(rules)
      .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))
      .filter((r) => Object.keys(r).length > 1);
    const body = {
      name, description: description || null, effectiveFrom, effectiveTo: effectiveTo || null, isActive,
      departments: deptIds, locations: locIds, categories,
      designations: designations.split(',').map((d) => d.trim()).filter(Boolean),
      rules: cleaned,
    };
    try {
      if (policy) await api.put(`/leave-policies/${policy._id}`, body);
      else await api.post('/leave-policies', body);
      onDone();
    } catch (err) {
      const first = fieldErrors(err)[0];
      setError(first ? `${first.path}: ${first.message}` : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={policy ? `Edit ${policy.name}` : 'Add leave policy'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !effectiveFrom} onClick={() => void save()}>Save policy</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Note>{error}</Note></div>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Effective from" required><Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
        <Field label="Effective to" hint="Blank means open-ended"><Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Checkbox label="Active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /></div>

        <div className="mt-1 border-t border-line pt-3 text-xs text-muted sm:col-span-2">Applies automatically to people matching all the groups chosen below. Leave a group empty to ignore it.</div>
        <Field label="Departments"><CheckboxGroup value={deptIds} onChange={setDeptIds} options={(departments.data ?? []).map((d) => ({ value: d._id, label: d.name }))} /></Field>
        <Field label="Locations"><CheckboxGroup value={locIds} onChange={setLocIds} options={(locations.data ?? []).map((l) => ({ value: l._id, label: l.name }))} /></Field>
        <Field label="Employee categories"><CheckboxGroup value={categories} onChange={setCategories} options={EMPLOYEE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} /></Field>
        <Field label="Designations" hint="Comma separated"><Input value={designations} onChange={(e) => setDesignations(e.target.value)} /></Field>

        <div className="sm:col-span-2">
          <div className="mb-1 mt-1 border-t border-line pt-3 text-xs text-muted">Overrides. Blank fields inherit from the leave type.</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-2 font-medium">Leave type</th>
                  <th className="px-1 font-medium">Allowed</th>
                  <th className="px-1 font-medium">Per year</th>
                  <th className="px-1 font-medium">Per month</th>
                  <th className="px-1 font-medium">Max days</th>
                  <th className="px-1 font-medium">Notice</th>
                  <th className="px-1 font-medium">Carry</th>
                </tr>
              </thead>
              <tbody>
                {(types.data ?? []).filter((t) => t.isActive).map((t) => {
                  const r = rules[t._id] ?? { leaveType: t._id };
                  const cell = (field: keyof PolicyRule, placeholder: unknown) => (
                    <td className="px-1 py-1">
                      <Input
                        type="number"
                        step="0.25"
                        min={0}
                        className="w-16 px-1.5 py-1"
                        aria-label={`${t.name} ${field}`}
                        placeholder={placeholder == null ? '' : String(placeholder)}
                        value={r[field] === undefined || r[field] === null ? '' : String(r[field])}
                        onChange={(e) => setRule(t._id, { [field]: toNumber(e.target.value) })}
                      />
                    </td>
                  );
                  return (
                    <tr key={t._id}>
                      <td className="whitespace-nowrap py-1 pr-2">{t.name}</td>
                      <td className="px-1 py-1">
                        <Select className="w-20 px-1 py-1" aria-label={`${t.name} allowed`} value={r.isAllowed === undefined ? '' : String(r.isAllowed)} onChange={(e) => setRule(t._id, { isAllowed: e.target.value === '' ? undefined : e.target.value === 'true' })}>
                          <option value="">Yes</option>
                          <option value="false">No</option>
                        </Select>
                      </td>
                      {cell('annualEntitlement', t.annualEntitlement)}
                      {cell('monthlyAccrual', t.monthlyAccrual)}
                      {cell('maxDuration', t.maxDuration)}
                      {cell('minNoticeDays', t.minNoticeDays)}
                      {cell('maxCarryForward', t.maxCarryForward)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Modal>
  );
}
