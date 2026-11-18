import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Button, Card, DataTable, Field, Loading, Modal, Note, PageHeader, Pagination, Select, StatusBadge, Textarea, TypeTag, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';
import type { LeaveRequest } from '../types';
import { days, formatDateTime, formatDay, formatRange } from '../utils/date';
import { STATUS_LABEL } from '../utils/labels';

export function MyLeavesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, meta, loading, error } = useFetch<LeaveRequest[]>('/leaves/my', { status, page, limit: 15, sort: 'createdAt', order: 'desc' });

  return (
    <>
      <PageHeader title="My requests" subtitle="Everything you have applied for" actions={<Link to="/apply"><Button variant="primary">Apply for leave</Button></Link>} />
      <div className="mb-3 max-w-52">
        <Select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).filter(([k]) => !['ACTIVE', 'ON_NOTICE', 'INACTIVE', 'WAITING'].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<LeaveRequest>
          rows={data}
          loading={loading}
          rowKey={(r) => r._id}
          onRowClick={(r) => navigate(`/leaves/${r._id}`)}
          empty="No requests match."
          columns={[
            { header: 'Type', cell: (r) => <TypeTag type={r.leaveType} /> },
            { header: 'Dates', cell: (r) => formatRange(r.startDate, r.endDate), className: 'whitespace-nowrap' },
            { header: 'Days', align: 'right', cell: (r) => r.totalDays },
            { header: 'Applied', cell: (r) => formatDateTime(r.createdAt), className: 'text-muted whitespace-nowrap' },
            { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
    </>
  );
}

/** Shared by the employee's own view and the approver's: the server decides who may open it. */
export function LeaveSummary({ request }: { request: LeaveRequest }) {
  const rows: [string, React.ReactNode][] = [
    ['Employee', `${request.employee.fullName} (${request.employee.employeeId})`],
    ['Department', request.employee.department?.name ?? '—'],
    ['Leave type', <TypeTag key="t" type={request.leaveType} />],
    ['Dates', formatRange(request.startDate, request.endDate)],
    ['Duration', `${days(request.totalDays)}${request.dayType === 'HALF' ? ` (${request.halfSession === 'FIRST' ? 'first' : 'second'} half)` : ''}`],
    ['Status', <StatusBadge key="s" status={request.status} />],
    ['Reason', request.reason ?? '—'],
  ];
  if (request.handoverNotes) rows.push(['Handover', request.handoverNotes]);
  if (request.rejectionReason) rows.push(['Rejection reason', request.rejectionReason]);
  if (request.cancellationReason) rows.push(['Cancellation reason', request.cancellationReason]);
  if (request.outlookEventId) rows.push(['Outlook and Teams', 'Shown as Out of office']);
  if (request.outlookSyncError) rows.push(['Outlook and Teams', request.outlookSyncError === 'MAILBOX_NOT_FOUND' ? 'Not updated: no Microsoft mailbox matches this email' : 'Not updated: Microsoft rejected the change']);
  if (request.document) rows.push(['Document', <a key="d" className="text-brand hover:underline" href={`/api/files/${request.document._id}`}>{request.document.originalName}</a>]);
  if (request.balance) {
    rows.push(['Balance', `${days(request.balance.available)} available, ${days(request.balance.reserved)} held, ${days(request.balance.used)} used`]);
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[13px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="whitespace-nowrap text-muted">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalTrail({ request }: { request: LeaveRequest }) {
  if (!request.approvalSteps.length) return <p className="text-[13px] text-muted">Approved automatically under the leave policy.</p>;
  return (
    <ol className="space-y-2 text-[13px]">
      {request.approvalSteps.map((s) => (
        <li key={s.order} className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span>{s.label}{s.actedByName ? ` · ${s.actedByName}` : ''}</span>
          <StatusBadge status={s.status} />
          {s.comment && <p className="w-full text-xs text-muted">“{s.comment}”</p>}
          {s.actedAt && <p className="w-full text-xs text-faint">{formatDateTime(s.actedAt)}</p>}
        </li>
      ))}
    </ol>
  );
}

export function LeaveDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { data: request, loading, error, reload } = useFetch<LeaveRequest>(`/leaves/${id}`);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !request) return <Loading />;
  if (error) return <Note>{error}</Note>;
  if (!request) return null;
  const mine = request.employee._id === user?.employee?._id;

  const act = async (call: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await call();
      toast(done);
      setAsking(false);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={request.leaveType.name}
        subtitle={formatRange(request.startDate, request.endDate)}
        actions={mine && (
          <>
            {request.status === 'PENDING' && (
              <Button variant="danger" loading={busy} onClick={() => void act(() => api.patch(`/leaves/${id}/cancel`, {}), 'Request withdrawn')}>Withdraw request</Button>
            )}
            {request.status === 'APPROVED' && <Button onClick={() => setAsking(true)}>Request cancellation</Button>}
          </>
        )}
      />
      {actionError && !asking && <div className="mb-3"><Note>{actionError}</Note></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Details"><LeaveSummary request={request} /></Card>
        <div className="space-y-4">
          <Card title="Approval"><ApprovalTrail request={request} /></Card>
          <Card title="Days charged">
            <ul className="space-y-1 text-[13px]">
              {request.dayBreakdown.map((d) => (
                <li key={d.date} className="tnum flex justify-between"><span>{formatDay(d.date)}</span><span className="text-muted">{d.value}</span></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {asking && (
        <Modal
          title="Request cancellation"
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button onClick={() => setAsking(false)}>Keep leave</Button>
              <Button variant="primary" loading={busy} disabled={!reason.trim()} onClick={() => void act(() => api.post(`/leaves/${id}/cancellation-request`, { reason }), 'Cancellation requested')}>Send request</Button>
            </>
          }
        >
          <div className="space-y-3">
            {actionError && <Note>{actionError}</Note>}
            <p className="text-[13px] text-muted">HR will review this. The leave stays in place, and the balance stays deducted, until they decide.</p>
            <Field label="Reason" required><Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
