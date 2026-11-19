import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { api, applyServerErrors, errorMessage } from '../api/client';
import { AttachedDocument, DocumentUpload } from '../components/DocumentUpload';
import { Button, Card, Field, Input, Note, PageHeader, Select, Textarea, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';
import type { ApiFieldError, BalanceRow } from '../types';
import { days, formatDay, todayString } from '../utils/date';
import { LeaveForm, leaveSchema } from '../validations';
import { AwayNote } from './TeamCalendarPage';

interface AvailableType {
  _id: string;
  name: string;
  code: string;
  kind: string;
  isPaid: boolean;
  halfDayAllowed: boolean;
  requiresDocument: boolean;
  documentRequiredAfterDays: number | null;
  minNoticeDays: number;
  description: string | null;
  requiresApproval?: boolean;
  maxRequestsPerMonth?: number | null;
  ineligibleReason?: string | null;
}

interface Preview {
  totalDays: number;
  dayBreakdown: { date: string; value: number }[];
  excluded: { date: string; reason: string; label: string }[];
  documentRequired: boolean;
  halfDayAllowed: boolean;
  issues: ApiFieldError[];
}

const FORM_FIELDS = ['leaveType', 'startDate', 'endDate', 'dayType', 'halfSession', 'reason', 'handoverNotes'] as const;

export function ApplyLeavePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const types = useFetch<AvailableType[]>('/leave-types/available');
  const balances = useFetch<BalanceRow[]>('/leave-balances/my');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [document, setDocument] = useState<AttachedDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // One key per filled-in form, so a retried submission cannot create a second request.
  const idempotencyKey = useRef(crypto.randomUUID());

  const today = todayString();
  // The end date follows the start date until the employee chooses one themselves.
  const endDateChosen = useRef(false);
  const { register, handleSubmit, setValue, getValues, setError, clearErrors, control, formState: { errors, isSubmitting } } = useForm<LeaveForm>({
    resolver: zodResolver(leaveSchema),
    defaultValues: { leaveType: '', startDate: today, endDate: today, dayType: 'FULL', halfSession: null, reason: '', handoverNotes: '' },
  });

  const [leaveType, startDate, endDate, dayType, halfSession] = useWatch({ control, name: ['leaveType', 'startDate', 'endDate', 'dayType', 'halfSession'] });
  const selected = types.data?.find((t) => t._id === leaveType);
  const ineligible = selected?.ineligibleReason ?? null;
  const autoApproved = selected?.requiresApproval === false;
  const endBeforeStart = Boolean(startDate && endDate && endDate < startDate);
  const available = balances.data?.find((b) => b.leaveType._id === leaveType)?.available;

  useEffect(() => {
    if (!startDate) return;
    if (!endDateChosen.current || getValues('endDate') < startDate) {
      setValue('endDate', startDate);
      clearErrors('endDate');
    }
  }, [startDate, getValues, setValue, clearErrors]);

  useEffect(() => {
    setValue('reasonOptional', autoApproved);
    if (autoApproved) clearErrors('reason');
  }, [autoApproved, setValue, clearErrors]);

  // A half day is one date, so the end date follows the start date.
  useEffect(() => {
    if (dayType === 'HALF') setValue('endDate', startDate);
    else setValue('halfSession', null);
  }, [dayType, startDate, setValue]);

  useEffect(() => {
    if (selected && !selected.halfDayAllowed && dayType === 'HALF') setValue('dayType', 'FULL');
  }, [selected, dayType, setValue]);

  // The server calculates the duration, with the employee's own holidays and policy, before submission.
  useEffect(() => {
    const ready = leaveType && !ineligible && startDate && endDate && startDate <= endDate && (dayType === 'FULL' || halfSession);
    if (!ready) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    let stale = false;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api.post('/leaves/preview', { leaveType, startDate, endDate, dayType, halfSession: dayType === 'HALF' ? halfSession : null })
        .then((res) => { if (!stale) { setPreview(res.data.data); setPreviewError(null); } })
        .catch((err) => { if (!stale) { setPreview(null); setPreviewError(errorMessage(err, 'The duration could not be calculated.')); } })
        .finally(() => { if (!stale) setPreviewing(false); });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [leaveType, ineligible, startDate, endDate, dayType, halfSession]);

  const onSubmit = async (values: LeaveForm) => {
    setFormError(null);
    try {
      const res = await api.post('/leaves', {
        leaveType: values.leaveType,
        startDate: values.startDate,
        endDate: values.endDate,
        dayType: values.dayType,
        halfSession: values.dayType === 'HALF' ? values.halfSession : null,
        reason: values.reason || null,
        handoverNotes: values.handoverNotes || null,
        document: document?.id ?? null,
      }, { headers: { 'Idempotency-Key': idempotencyKey.current } });
      toast(res.data.data.status === 'APPROVED' ? 'Leave approved automatically' : 'Leave request submitted');
      navigate('/leaves');
    } catch (err) {
      setFormError(applyServerErrors(err, setError, FORM_FIELDS));
    }
  };

  const blockingIssues = preview?.issues ?? [];

  return (
    <>
      <PageHeader title="Apply for leave" subtitle="Weekends and your applicable holidays are not charged" />
      {(types.error || balances.error) && <div className="mb-4"><Note>{types.error ?? balances.error}</Note></div>}
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Employee"><Input value={user?.employee?.fullName ?? ''} disabled readOnly /></Field>
            <Field label="Employee ID"><Input value={user?.employee?.employeeId ?? ''} disabled readOnly /></Field>

            <div className="sm:col-span-2">
              <Field label="Leave type" required error={ineligible ?? errors.leaveType?.message} hint={selected?.description ?? (selected && !selected.isPaid ? 'This leave is unpaid.' : undefined)}>
                <Select {...register('leaveType')}>
                  <option value="">Choose a leave type</option>
                  {types.data?.map((t) => <option key={t._id} value={t._id}>{t.name} ({t.code})</option>)}
                </Select>
              </Field>
            </div>

            <Field label="Start date" required error={errors.startDate?.message}><Input type="date" {...register('startDate')} /></Field>
            <Field label="End date" required error={errors.endDate?.message ?? (endBeforeStart ? 'The end date cannot be before the start date' : undefined)}>
              <Input type="date" min={startDate} disabled={dayType === 'HALF'} {...register('endDate', { onChange: () => { endDateChosen.current = true; } })} />
            </Field>

            <Field label="Duration" required>
              <Select {...register('dayType')}>
                <option value="FULL">Full day</option>
                <option value="HALF" disabled={selected ? !selected.halfDayAllowed : false}>Half day</option>
              </Select>
            </Field>
            {dayType === 'HALF' && (
              <Field label="Which half" required error={errors.halfSession?.message}>
                <Select value={halfSession ?? ''} onChange={(e) => setValue('halfSession', (e.target.value || null) as LeaveForm['halfSession'], { shouldValidate: true })}>
                  <option value="">Choose</option>
                  <option value="FIRST">First half</option>
                  <option value="SECOND">Second half</option>
                </Select>
              </Field>
            )}

            <div className="sm:col-span-2">
              <Field label="Reason" required={!autoApproved} hint={autoApproved ? 'Optional for this leave.' : undefined} error={errors.reason?.message}><Textarea {...register('reason')} /></Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Handover notes" hint="Optional. Who covers what while you are away."><Textarea rows={2} {...register('handoverNotes')} /></Field>
            </div>
            <div className="sm:col-span-2">
              <DocumentUpload value={document} onChange={setDocument} onUploadingChange={setUploading} required={preview?.documentRequired} error={errors.root?.message} />
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Summary">
            {!preview && previewError && !previewing ? (
              <Note>{previewError}</Note>
            ) : !preview ? (
              <p className="text-[13px] text-faint">{ineligible ? 'You cannot apply for this leave type.' : previewing ? 'Calculating…' : 'Choose a leave type and dates to see the duration.'}</p>
            ) : (
              <div className="space-y-3 text-[13px]">
                <div>
                  <div className="text-xs text-muted">Leave days charged</div>
                  <div className="tnum text-2xl font-semibold text-brand" data-testid="calculated-days">{preview.totalDays}</div>
                </div>
                {available !== undefined && selected?.kind !== 'OPTIONAL' && (
                  <div className="flex justify-between border-t border-line pt-2">
                    <span className="text-muted">Available now</span>
                    <span className="tnum font-medium">{days(available)}</span>
                  </div>
                )}
                {preview.excluded.length > 0 && (
                  <div className="border-t border-line pt-2">
                    <div className="mb-1 text-xs text-muted">Not charged</div>
                    <ul className="space-y-0.5 text-xs">
                      {preview.excluded.slice(0, 10).map((x) => (
                        <li key={x.date} className="flex justify-between gap-2"><span>{formatDay(x.date)}</span><span className="text-muted">{x.reason === 'HALF_DAY_HOLIDAY' ? `${x.label} (half)` : x.label}</span></li>
                      ))}
                      {preview.excluded.length > 10 && <li className="text-faint">and {preview.excluded.length - 10} more</li>}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>

          <AwayNote start={startDate} end={endDate} />
          {selected?.requiresApproval === false && !ineligible && <Note tone="sky">This leave is approved automatically when you submit it.</Note>}
          {blockingIssues.map((i) => <Note key={i.path + i.message} tone="amber">{i.message}</Note>)}
          {preview?.documentRequired && !document && <Note tone="sky">This request needs a supporting document.</Note>}
          {formError && <Note>{formError}</Note>}

          <Button type="submit" variant="primary" className="w-full" loading={isSubmitting} disabled={uploading || Boolean(ineligible) || blockingIssues.length > 0 || !preview}>Submit request</Button>
        </div>
      </form>
    </>
  );
}
