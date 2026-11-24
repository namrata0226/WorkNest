import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, applyServerErrors, errorMessage } from '../api/client';
import { AttachedDocument, DocumentUpload } from '../components/DocumentUpload';
import { Button, Card, cx, DataTable, Field, InfiniteLoader, Input, Modal, Note, PageHeader, Select, StatusBadge, Textarea, useConfirm, useToast } from '../components/ui';
import { useInfiniteFetch } from '../hooks/useInfiniteFetch';
import { downloadFile } from '../services/download';
import type { ExpenseClaim } from '../types';
import { formatDate, todayString } from '../utils/date';
import { EXPENSE_CATEGORIES, titleCase } from '../utils/labels';
import { EXPENSE_DESCRIPTION_MAX, EXPENSE_MAX_AMOUNT, ExpenseForm, expenseSchema } from '../validations';

export const money = (n: number) => n.toLocaleString('en-IN', { style: 'currency', currency: 'INR' });

export const ReceiptLink = ({ claim }: { claim: ExpenseClaim }) => {
  const toast = useToast();
  if (!claim.receipt) return <span className="text-faint">—</span>;
  const { _id, originalName } = claim.receipt;
  return <button type="button" className="text-brand hover:underline" onClick={(e) => { e.stopPropagation(); downloadFile(`/files/${_id}`, {}, originalName).catch((err) => toast(errorMessage(err), 'error')); }}>Receipt</button>;
};

/** "120 / 1000", turning red once the limit is passed. */
export function CharCount({ length, max }: { length: number; max: number }) {
  return <div aria-hidden className={cx('tnum mt-1 text-right text-[11px]', length > max ? 'font-medium text-rose' : 'text-faint')}>{length.toLocaleString('en-IN')} / {max.toLocaleString('en-IN')}</div>;
}

function NewClaimModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AttachedDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  const { register, handleSubmit, setError, watch, formState: { errors, isSubmitting } } = useForm<ExpenseForm>({
    resolver: zodResolver(expenseSchema),
    // Check as the person types, so hitting a limit shows its message straight away.
    mode: 'onChange',
    defaultValues: { category: 'TRAVEL', expenseDate: todayString(), description: '' },
  });
  const descriptionLength = (watch('description') ?? '').length;
  const onSubmit = async (v: ExpenseForm) => {
    setFormError(null);
    try {
      await api.post('/expenses', { ...v, receipt: receipt?.id ?? null });
      toast('Expense claim submitted');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['category', 'expenseDate', 'amount', 'description'] as const));
    }
  };
  return (
    <Modal title="New expense claim" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="expense-form" disabled={uploading} loading={isSubmitting}>Submit claim</Button></>}>
      <form id="expense-form" className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <div className="sm:col-span-2"><Note>{formError}</Note></div>}
        <Field label="Category" required error={errors.category?.message}><Select {...register('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</Select></Field>
        <Field label="Date of expense" required error={errors.expenseDate?.message}><Input type="date" max={todayString()} {...register('expenseDate')} /></Field>
        <Field label="Amount (₹)" required error={errors.amount?.message} hint={`Up to ₹${EXPENSE_MAX_AMOUNT.toLocaleString('en-IN')}`}>
          <Input type="number" min="0" max={EXPENSE_MAX_AMOUNT} step="0.01" inputMode="decimal" aria-invalid={Boolean(errors.amount)} {...register('amount', { valueAsNumber: true })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" required error={errors.description?.message}>
            <Textarea rows={2} aria-invalid={Boolean(errors.description)} {...register('description')} />
          </Field>
          <CharCount length={descriptionLength} max={EXPENSE_DESCRIPTION_MAX} />
        </div>
        <div className="sm:col-span-2"><DocumentUpload label="Receipt" value={receipt} onChange={setReceipt} onUploadingChange={setUploading} /></div>
      </form>
    </Modal>
  );
}

export function ExpensesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const list = useInfiniteFetch<ExpenseClaim[]>('/expenses/my', {}, { limit: 20 });
  const { data, meta, loading, error, reload } = list;
  const cancel = async (c: ExpenseClaim) => {
    if (!(await confirm({ title: 'Cancel this claim?', message: `Your ${money(c.amount)} claim for ${formatDate(c.expenseDate)} will be withdrawn. You can submit a new one later.`, confirmLabel: 'Cancel claim', cancelLabel: 'Keep claim', tone: 'danger' }))) return;
    try {
      await api.patch(`/expenses/${c._id}/cancel`, {});
      toast('Claim cancelled');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <>
      <PageHeader title="Expense claims" subtitle="Claim back what you spent for work" actions={<Button variant="primary" onClick={() => setCreating(true)}>New claim</Button>} />
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<ExpenseClaim>
          rows={data}
          loading={loading}
          rowKey={(c) => c._id}
          empty="You have no expense claims yet."
          columns={[
            { header: 'Date', cell: (c) => formatDate(c.expenseDate), className: 'whitespace-nowrap' },
            { header: 'Category', cell: (c) => titleCase(c.category) },
            { header: 'Description', cell: (c) => (c.rejectionReason ? `${c.description}. Rejected: ${c.rejectionReason}` : c.description), className: 'text-muted' },
            { header: 'Amount', align: 'right', cell: (c) => money(c.amount), className: 'tnum' },
            { header: 'Receipt', cell: (c) => <ReceiptLink claim={c} /> },
            { header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
            { header: '', align: 'right', cell: (c) => (c.status === 'PENDING' ? <Button small onClick={() => cancel(c)}>Cancel</Button> : null) },
          ]}
        />
        <InfiniteLoader list={list} />
      </Card>
      {creating && <NewClaimModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); void reload(); }} />}
    </>
  );
}
