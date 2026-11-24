import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { PersonAvatar } from '../components/Avatar';
import { Badge, Button, Card, Column, DataTable, Field, Loading, Modal, Note, PageHeader, Pagination, StatusBadge, Textarea, TypeTag, useToast } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import type { AttendanceCorrection, ExpenseClaim, LeaveRequest, PersonRef, WfhRequest } from '../types';
import { formatDate, formatDateTime, formatRange } from '../utils/date';
import { titleCase } from '../utils/labels';
import { money, ReceiptLink } from './ExpensesPage';
import { ApprovalTrail, LeaveSummary } from './MyLeavesPage';

/** Every request the viewer can decide, decided ones included, so a row stays put (with its outcome) after a decision. */
const VIEW = 'ALL';

export function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const { data, meta, loading, error, reload } = useFetch<LeaveRequest[]>('/approvals/pending', { page, limit: 20, view: VIEW });
  const openId = params.get('request');
  const close = () => setParams({}, { replace: true });

  return (
    <>
      <PageHeader title="Approvals" subtitle="Newest requests first" />
      {error && <Note>{error}</Note>}
      <OtherApprovals />
      <Card flush title="Leave requests">
        <DataTable<LeaveRequest>
          rows={data}
          loading={loading}
          rowKey={(r) => r._id}
          onRowClick={(r) => setParams({ request: r._id })}
          empty="No leave requests yet."
          columns={[
            { header: 'Employee', cell: personCell },
            { header: 'Type', cell: (r) => <TypeTag type={r.leaveType} /> },
            { header: 'Dates', cell: (r) => formatRange(r.startDate, r.endDate), className: 'whitespace-nowrap' },
            { header: 'Days', align: 'right', cell: (r) => r.totalDays },
            { header: 'Status', cell: leaveStatusCell },
            { header: 'Applied', cell: (r) => formatDateTime(r.createdAt), className: 'text-muted whitespace-nowrap' },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
      {openId && <DecisionModal id={openId} onClose={close} onDone={() => { close(); void reload(); }} />}
    </>
  );
}

/** Pending rows show whose step it is, as before; decided rows show their outcome. */
function leaveStatusCell(r: LeaveRequest) {
  if (r.status !== 'PENDING') return <StatusBadge status={r.status} />;
  return <Badge tone="amber">{r.approvalSteps.find((s) => s.approverType === r.currentApproverType && s.status === 'WAITING')?.label ?? 'Approval'}</Badge>;
}

type Person = { employee: PersonRef };

const personCell = (r: Person) => (typeof r.employee === 'string' ? '—' : (
  <div className="flex items-center gap-2.5">
    <PersonAvatar person={r.employee} />
    <div><div className="font-medium">{r.employee.fullName}</div><div className="text-xs text-muted">{r.employee.employeeId} · {r.employee.department?.name ?? 'No department'}</div></div>
  </div>
));

type Decidable = Person & { _id: string; status: string; decidedByName?: string | null; rejectionReason?: string | null };

/** One section for each kind of simple request. Decided requests stay listed with their outcome; hidden only when empty. */
function SimpleApprovals<T extends Decidable>({ title, url, base, noun, columns }: { title: string; url: string; base: string; noun: string; columns: Column<T>[] }) {
  const toast = useToast();
  const { data, reload } = useFetch<T[]>(url, { view: VIEW });
  const [rejecting, setRejecting] = useState<T | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, verb: 'approve' | 'reject', body: object, done: string) => {
    setBusyId(id);
    try {
      await api.patch(`${base}/${id}/${verb}`, body);
      toast(done);
      setRejecting(null);
      setReason('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusyId(null);
      await reload();
    }
  };

  if (!Array.isArray(data) || !data.length) return null;
  return (
    <Card flush className="mb-4" title={title}>
      <DataTable<T>
        rows={data}
        rowKey={(r) => r._id}
        empty=""
        columns={[
          { header: 'Employee', cell: personCell },
          ...columns,
          { header: 'Status', align: 'right', cell: (r) => (r.status === 'PENDING' ? (
            <div className="flex justify-end gap-2">
              <Button small variant="primary" disabled={busyId !== null} loading={busyId === r._id && !rejecting} onClick={() => act(r._id, 'approve', {}, `${noun} approved`)}>Approve</Button>
              <Button small disabled={busyId !== null} onClick={() => setRejecting(r)}>Reject</Button>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-0.5">
              <StatusBadge status={r.status} />
              {r.decidedByName && <span className="text-[11px] text-faint">by {r.decidedByName}</span>}
            </div>
          )) },
        ]}
      />
      {rejecting && (
        <Modal
          title={`Reject ${noun.toLowerCase()}`}
          onClose={() => { setRejecting(null); setReason(''); }}
          footer={<><Button onClick={() => { setRejecting(null); setReason(''); }}>Cancel</Button><Button variant="danger" loading={busyId === rejecting._id} disabled={!reason.trim() || reason.length > REASON_MAX} onClick={() => act(rejecting._id, 'reject', { reason: reason.trim() }, `${noun} rejected`)}>Reject request</Button></>}
        >
          <Field label="Reason" required hint="The employee will see this" error={reason.length > REASON_MAX ? `The reason must be ${REASON_MAX.toLocaleString('en-IN')} characters or fewer` : undefined}>
            <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Modal>
      )}
    </Card>
  );
}

const REASON_MAX = 1000;

function OtherApprovals() {
  return (
    <>
      <SimpleApprovals<WfhRequest>
        title="Work from home requests" url="/wfh/pending" base="/wfh" noun="Work from home"
        columns={[
          { header: 'Dates', cell: (r) => formatRange(r.startDate, r.endDate), className: 'whitespace-nowrap' },
          { header: 'Days', align: 'right', cell: (r) => r.totalDays },
          { header: 'Reason', cell: (r) => r.reason, className: 'text-muted' },
        ]}
      />
      <SimpleApprovals<AttendanceCorrection>
        title="Attendance corrections" url="/attendance/corrections/pending" base="/attendance/corrections" noun="Correction"
        columns={[
          { header: 'Date', cell: (r) => formatDate(r.date), className: 'whitespace-nowrap' },
          { header: 'Punch in', cell: (r) => r.punchIn, className: 'tnum' },
          { header: 'Punch out', cell: (r) => r.punchOut ?? 'Not recorded', className: 'tnum' },
          { header: 'Reason', cell: (r) => r.reason, className: 'text-muted' },
        ]}
      />
      <SimpleApprovals<ExpenseClaim>
        title="Expense claims" url="/expenses/pending" base="/expenses" noun="Claim"
        columns={[
          { header: 'Date', cell: (r) => formatDate(r.expenseDate), className: 'whitespace-nowrap' },
          { header: 'Category', cell: (r) => titleCase(r.category) },
          { header: 'Description', cell: (r) => r.description, className: 'text-muted' },
          { header: 'Amount', align: 'right', cell: (r) => money(r.amount), className: 'tnum' },
          { header: 'Receipt', cell: (r) => <ReceiptLink claim={r} /> },
        ]}
      />
    </>
  );
}

function DecisionModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data: request, loading, error, reload } = useFetch<LeaveRequest>(`/leaves/${id}`);
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setActionError(error), [error]);

  const act = async (url: string, body: object, done: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.patch(url, body);
      toast(done);
      onDone();
    } catch (err) {
      setActionError(errorMessage(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const isCancellation = request?.status === 'CANCELLATION_REQUESTED';
  const decidable = request?.status === 'PENDING' || isCancellation;
  const missingReason = rejecting && !comment.trim();
  const tooLong = comment.length > REASON_MAX;

  return (
    <Modal
      wide
      title={isCancellation ? 'Cancellation request' : 'Leave request'}
      onClose={onClose}
      footer={decidable ? (
        rejecting ? (
          <>
            <Button onClick={() => setRejecting(false)}>Back</Button>
            <Button variant="danger" loading={busy} disabled={missingReason || tooLong} onClick={() => act(isCancellation ? `/approvals/${id}/cancellation/reject` : `/approvals/${id}/reject`, { reason: comment.trim() }, isCancellation ? 'Cancellation declined' : 'Request rejected')}>
              {isCancellation ? 'Decline cancellation' : 'Reject request'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="danger" onClick={() => setRejecting(true)}>{isCancellation ? 'Decline' : 'Reject'}</Button>
            <Button variant="primary" loading={busy} disabled={tooLong} onClick={() => act(isCancellation ? `/approvals/${id}/cancellation/approve` : `/approvals/${id}/approve`, comment.trim() ? { comment: comment.trim() } : {}, isCancellation ? 'Leave cancelled and balance restored' : 'Decision recorded')}>
              {isCancellation ? 'Approve cancellation' : 'Approve'}
            </Button>
          </>
        )
      ) : undefined}
    >
      {loading && !request ? <Loading /> : request && (
        <div className="space-y-4">
          {actionError && <Note>{actionError}</Note>}
          {!decidable && <Note tone="sky">This request has already been decided.</Note>}
          <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
            <LeaveSummary request={request} />
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted">Approval steps</h3>
              <ApprovalTrail request={request} />
            </div>
          </div>
          {decidable && (
            <Field label={rejecting ? 'Reason (required, shared with the employee)' : 'Comment (optional)'} error={comment.length > REASON_MAX ? `Keep this to ${REASON_MAX.toLocaleString('en-IN')} characters or fewer` : missingReason && comment.length > 0 ? 'A reason is required' : undefined}>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}
