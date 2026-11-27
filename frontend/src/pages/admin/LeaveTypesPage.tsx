import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { api, applyServerErrors, errorMessage } from '../../api/client';
import { Badge, Button, Card, Checkbox, CheckboxGroup, DataTable, Field, Input, Modal, Note, PageHeader, Select, TypeTag, useConfirm, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import type { LeaveType } from '../../types';
import { todayString } from '../../utils/date';
import { EMPLOYEE_CATEGORIES, EMPLOYEE_GENDERS, titleCase } from '../../utils/labels';

type TypeForm = Omit<LeaveType, '_id'> & {
  maxDurationText: string;
  documentAfterText: string;
  carryExpiryText: string;
  maxNegativeText: string;
  maxPerMonthText: string;
};

const blankNumber = (text: string): number | null => (text.trim() === '' ? null : Number(text));
const asText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

const DEFAULTS: Partial<TypeForm> = {
  kind: 'STANDARD', eventBased: false, color: '#0f766e', isPaid: true, annualEntitlement: 0, monthlyAccrual: 0, prorateOnJoining: true, carryForward: false, maxCarryForward: 0,
  minDuration: 0.5, halfDayAllowed: true, requiresDocument: false, minNoticeDays: 0, allowPastDates: false, maxPastDays: 0, validateBalance: true,
  allowNegative: false, requiresApproval: true, applicableCategories: [], applicableGenders: [], isActive: true, maxDurationText: '', documentAfterText: '', carryExpiryText: '', maxNegativeText: '', maxPerMonthText: '',
};

export function LeaveTypesPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useFetch<LeaveType[]>('/leave-types');
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);

  return (
    <>
      <PageHeader title="Leave types" subtitle="Defaults for the whole company. Leave policies can override these for specific groups." actions={<Button variant="primary" onClick={() => setEditing('new')}>Add leave type</Button>} />
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<LeaveType>
          rows={data}
          loading={loading}
          rowKey={(t) => t._id}
          onRowClick={setEditing}
          columns={[
            { header: 'Leave type', cell: (t) => <TypeTag type={t} /> },
            { header: 'Code', cell: (t) => t.code, className: 'text-muted' },
            { header: 'Pay', cell: (t) => (t.isPaid ? 'Paid' : 'Unpaid') },
            { header: 'Per year', align: 'right', cell: (t) => (t.monthlyAccrual > 0 ? `${t.monthlyAccrual}/month` : t.kind === 'COMP_OFF' ? 'Earned' : t.annualEntitlement) },
            { header: 'Carry-forward', cell: (t) => (t.carryForward ? `Up to ${t.maxCarryForward}` : 'No') },
            { header: 'Half day', cell: (t) => (t.halfDayAllowed ? 'Yes' : 'No') },
            { header: 'Status', cell: (t) => <Badge tone={t.isActive ? 'green' : 'gray'}>{t.isActive ? 'Active' : 'Inactive'}</Badge> },
          ]}
        />
      </Card>
      {editing && <TypeModal type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={(message) => { setEditing(null); toast(message); void reload(); }} />}
    </>
  );
}

function TypeModal({ type, onClose, onDone }: { type: LeaveType | null; onClose: () => void; onDone: (message: string) => void }) {
  const confirm = useConfirm();
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!type) return;
    const ok = await confirm({
      title: `Delete ${type.name}?`,
      message: 'This removes the leave type and its unused balances. A type someone has already applied for cannot be deleted. Untick Active to retire it instead.',
      confirmLabel: 'Delete leave type',
      tone: 'danger',
    });
    if (!ok) return;
    setFormError(null);
    setDeleting(true);
    try {
      await api.delete(`/leave-types/${type._id}`);
      onDone(`${type.name} deleted`);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };
  const { register, handleSubmit, setError, control, watch, formState: { errors, isSubmitting } } = useForm<TypeForm>({
    defaultValues: type
      ? { ...type, maxDurationText: asText(type.maxDuration), documentAfterText: asText(type.documentRequiredAfterDays), carryExpiryText: asText(type.carryForwardExpiryDays), maxNegativeText: asText(type.maxNegative), maxPerMonthText: asText(type.maxRequestsPerMonth), effectiveFrom: todayString() }
      : { ...DEFAULTS, effectiveFrom: todayString() },
  });
  const num = { valueAsNumber: true };

  const onSubmit = async (v: TypeForm) => {
    setFormError(null);
    const body = {
      name: v.name, code: v.code, kind: v.kind, eventBased: v.eventBased, description: v.description || null, color: v.color, isActive: v.isActive, effectiveFrom: v.effectiveFrom,
      isPaid: v.isPaid, annualEntitlement: v.annualEntitlement, monthlyAccrual: v.monthlyAccrual, prorateOnJoining: v.prorateOnJoining,
      carryForward: v.carryForward, maxCarryForward: v.maxCarryForward, carryForwardExpiryDays: blankNumber(v.carryExpiryText),
      minDuration: v.minDuration, maxDuration: blankNumber(v.maxDurationText), halfDayAllowed: v.halfDayAllowed,
      requiresDocument: v.requiresDocument, documentRequiredAfterDays: blankNumber(v.documentAfterText),
      minNoticeDays: v.minNoticeDays, allowPastDates: v.allowPastDates, maxPastDays: v.maxPastDays,
      validateBalance: v.validateBalance, allowNegative: v.allowNegative, maxNegative: blankNumber(v.maxNegativeText),
      requiresApproval: v.requiresApproval, applicableCategories: v.applicableCategories, applicableGenders: v.applicableGenders,
      maxRequestsPerMonth: blankNumber(v.maxPerMonthText),
    };
    try {
      if (type) await api.put(`/leave-types/${type._id}`, body);
      else await api.post('/leave-types', body);
      onDone('Leave type saved');
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['name', 'code', 'color'] as const));
    }
  };

  const section = 'sm:col-span-3 mt-2 border-t border-line pt-3 text-xs font-semibold uppercase tracking-wide text-muted';

  return (
    <Modal
      wide
      title={type ? `Edit ${type.name}` : 'Add leave type'}
      onClose={onClose}
      footer={<>
        {type && <Button variant="danger" className="mr-auto" onClick={remove} loading={deleting} disabled={isSubmitting}>Delete</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="type-form" loading={isSubmitting} disabled={deleting}>Save</Button>
      </>}
    >
      <form id="type-form" className="grid gap-3 sm:grid-cols-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-3"><Note>{formError}</Note></div>}
        <Field label="Name" required error={errors.name?.message}><Input {...register('name', { required: 'Name is required' })} /></Field>
        <Field label="Short code" required error={errors.code?.message}><Input {...register('code', { required: 'Code is required' })} /></Field>
        <Field label="Colour" error={errors.color?.message}><Controller control={control} name="color" render={({ field }) => <Input type="color" className="h-[34px] p-1" name={field.name} value={field.value ?? '#0f766e'} onChange={field.onChange} onBlur={field.onBlur} />} /></Field>
        <Field label="Kind">
          <Select {...register('kind')} disabled={Boolean(type)}>
            <option value="STANDARD">Standard</option>
            <option value="COMP_OFF">Comp-Off</option>
            <option value="OPTIONAL_HOLIDAY">Optional holiday</option>
          </Select>
        </Field>
        <Field label="Changes effective from" hint="Recorded in the change history"><Input type="date" {...register('effectiveFrom')} /></Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <Checkbox label="Paid" {...register('isPaid')} />
          <Checkbox label="Active" {...register('isActive')} />
          <Checkbox label="Life-event leave (not in the annual total)" {...register('eventBased')} />
        </div>

        <div className={section}>Entitlement</div>
        <Field label="Annual entitlement (days)"><Input type="number" step="0.25" min={0} {...register('annualEntitlement', num)} /></Field>
        <Field label="Monthly accrual (days)" hint="If set, this replaces the annual grant"><Input type="number" step="0.25" min={0} {...register('monthlyAccrual', num)} /></Field>
        <div className="flex items-end pb-1"><Checkbox label="Prorate for mid-year joiners" {...register('prorateOnJoining')} /></div>

        <div className={section}>Carry-forward and expiry</div>
        <div className="flex items-end pb-1"><Checkbox label="Unused days carry forward" {...register('carryForward')} /></div>
        <Field label="Maximum carried (days)"><Input type="number" step="0.25" min={0} disabled={!watch('carryForward')} {...register('maxCarryForward', num)} /></Field>
        <Field label="Carried days expire after (days)" hint="Blank means they do not expire"><Input type="number" min={0} disabled={!watch('carryForward')} {...register('carryExpiryText')} /></Field>

        <div className={section}>Duration and notice</div>
        <Field label="Minimum duration (days)"><Input type="number" step="0.25" min={0} {...register('minDuration', num)} /></Field>
        <Field label="Maximum duration (days)" hint="Blank means no limit"><Input type="number" step="0.25" min={0} {...register('maxDurationText')} /></Field>
        <Field label="Advance notice (days)"><Input type="number" min={0} {...register('minNoticeDays', num)} /></Field>
        <Field label="Applications per month" hint="Blank means no limit"><Input type="number" min={1} {...register('maxPerMonthText')} /></Field>
        <div className="flex items-end pb-1"><Checkbox label="Half days allowed" {...register('halfDayAllowed')} /></div>
        <div className="flex items-end pb-1"><Checkbox label="Past dates allowed" {...register('allowPastDates')} /></div>
        <Field label="Back-dating limit (days)"><Input type="number" min={0} disabled={!watch('allowPastDates')} {...register('maxPastDays', num)} /></Field>

        <div className={section}>Documents, balance and approval</div>
        <div className="flex items-end pb-1"><Checkbox label="Document always required" {...register('requiresDocument')} /></div>
        <Field label="Document needed above (days)" hint="Blank means no threshold"><Input type="number" min={0} {...register('documentAfterText')} /></Field>
        <div className="flex items-end pb-1"><Checkbox label="Needs approval" {...register('requiresApproval')} /></div>
        <div className="flex items-end pb-1"><Checkbox label="Check balance" {...register('validateBalance')} /></div>
        <div className="flex items-end pb-1"><Checkbox label="Negative balance allowed" {...register('allowNegative')} /></div>
        <Field label="Negative limit (days)" hint="Blank means no limit"><Input type="number" step="0.25" min={0} disabled={!watch('allowNegative')} {...register('maxNegativeText')} /></Field>

        <div className="sm:col-span-3">
          <Field label="Applicable employee groups" hint="Leave empty for everyone">
            <Controller control={control} name="applicableCategories" render={({ field }) => <CheckboxGroup value={field.value ?? []} onChange={field.onChange} options={EMPLOYEE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />} />
          </Field>
        </div>
        <div className="sm:col-span-3">
          <Field label="Applicable genders" hint="Leave empty for everyone">
            <Controller control={control} name="applicableGenders" render={({ field }) => <CheckboxGroup value={field.value ?? []} onChange={field.onChange} options={EMPLOYEE_GENDERS.map((g) => ({ value: g, label: titleCase(g) }))} />} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
