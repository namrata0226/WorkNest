import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, applyServerErrors } from '../api/client';
import { AttachedDocument, DocumentUpload } from '../components/DocumentUpload';
import { Button, Card, DataTable, Field, Input, Modal, Note, PageHeader, Select, Stat, StatusBadge, Textarea, useToast } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import type { CompOffRequest, CompOffSummary, CompOffTx } from '../types';
import { formatDate, formatDateTime } from '../utils/date';
import { LEDGER_LABEL } from '../utils/labels';
import { CompOffForm, compOffSchema } from '../validations';
import { signed } from './BalancesPage';

interface CompOffData { summary: CompOffSummary; requests: CompOffRequest[]; transactions: CompOffTx[] }

export function CompOffPage() {
  const { data, error, loading, reload } = useFetch<CompOffData>('/compoff/my');
  const company = useFetch<{ compOff: { validityDays: number; maxClaimAgeDays: number; requireDocument: boolean } }>('/settings/company');
  const [claiming, setClaiming] = useState(false);
  const s = data?.summary;

  return (
    <>
      <PageHeader
        title="Comp-Off"
        subtitle={company.data ? `Earned for working a weekly off or holiday. Valid for ${company.data.compOff.validityDays} days, and claim within ${company.data.compOff.maxClaimAgeDays} days.` : undefined}
        actions={<Button variant="primary" onClick={() => setClaiming(true)}>Claim Comp-Off</Button>}
      />
      {error && <Note>{error}</Note>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Available" value={s?.available ?? 0} tone="brand" hint={s?.nextExpiry ? `Next expiry ${formatDate(s.nextExpiry)}` : 'Nothing expiring'} />
        <Stat label="Earned" value={s?.earned ?? 0} hint="All time" />
        <Stat label="Used" value={s?.used ?? 0} hint="All time" />
        <Stat label="Pending" value={(s?.pendingCredit ?? 0) + (s?.reserved ?? 0)} hint={`${s?.pendingCredit ?? 0} to credit, ${s?.reserved ?? 0} held`} />
        <Stat label="Expired" value={s?.expired ?? 0} hint="All time" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Active credits and expiry" flush>
          <DataTable
            rows={s?.lots}
            loading={loading}
            rowKey={(l) => l.id}
            empty="You have no unused Comp-Off."
            columns={[
              { header: 'Earned', cell: (l) => formatDate(l.earnedDate) },
              { header: 'Expires', cell: (l) => formatDate(l.expiresOn) },
              { header: 'Days left', align: 'right', cell: (l) => l.remaining },
            ]}
          />
        </Card>
        <Card title="My claims" flush>
          <DataTable<CompOffRequest>
            rows={data?.requests}
            loading={loading}
            rowKey={(r) => r._id}
            empty="You have not claimed any Comp-Off."
            columns={[
              { header: 'Worked', cell: (r) => <div><div>{formatDate(r.workedDate)}</div><div className="text-xs text-muted">{r.occasion}</div></div> },
              { header: 'Days', align: 'right', cell: (r) => r.amount },
              { header: 'Status', cell: (r) => <div><StatusBadge status={r.status} />{r.decisionComment && <div className="mt-0.5 text-xs text-muted">{r.decisionComment}</div>}</div> },
            ]}
          />
        </Card>
      </div>

      <Card className="mt-4" title="Transaction history" flush>
        <DataTable<CompOffTx>
          rows={data?.transactions}
          loading={loading}
          rowKey={(t) => t._id}
          empty="No movements yet."
          columns={[
            { header: 'When', cell: (t) => formatDateTime(t.createdAt), className: 'whitespace-nowrap text-muted' },
            { header: 'Movement', cell: (t) => (t.type === 'CREDIT' ? 'Earned' : LEDGER_LABEL[t.type] ?? t.type) },
            { header: 'Reason', cell: (t) => t.reason ?? '—', className: 'text-muted' },
            { header: 'Days', align: 'right', cell: (t) => signed(t.amount) },
          ]}
        />
      </Card>

      {claiming && <ClaimModal requireDocument={company.data?.compOff.requireDocument} onClose={() => setClaiming(false)} onDone={() => { setClaiming(false); void reload(); }} />}
    </>
  );
}

function ClaimModal({ onClose, onDone, requireDocument }: { onClose: () => void; onDone: () => void; requireDocument?: boolean }) {
  const toast = useToast();
  const [document, setDocument] = useState<AttachedDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<CompOffForm>({
    resolver: zodResolver(compOffSchema),
    defaultValues: { workedDate: '', dayType: 'FULL', reason: '' },
  });

  const onSubmit = async (values: CompOffForm) => {
    setFormError(null);
    try {
      await api.post('/compoff', { ...values, document: document?.id ?? null });
      toast('Comp-Off claim submitted');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['workedDate', 'dayType', 'reason'] as const));
    }
  };

  return (
    <Modal
      title="Claim Comp-Off"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="claim-form" loading={isSubmitting} disabled={uploading}>Submit claim</Button></>}
    >
      <form id="claim-form" className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <Note>{formError}</Note>}
        <Field label="Date worked" required hint="Must be a weekly off or a company holiday" error={errors.workedDate?.message}><Input type="date" {...register('workedDate')} /></Field>
        <Field label="Duration" required>
          <Select {...register('dayType')}><option value="FULL">Full day</option><option value="HALF">Half day</option></Select>
        </Field>
        <Field label="Reason" required error={errors.reason?.message}><Textarea {...register('reason')} /></Field>
        <DocumentUpload value={document} onChange={setDocument} onUploadingChange={setUploading} required={requireDocument} />
      </form>
    </Modal>
  );
}
