import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Button, Field, Loading, Note, Textarea } from '../components/ui';
import { AuthLayout } from '../layouts/AppLayout';

interface Preview { title: string; employee: string; lines: { label: string; value: string }[]; decidable: boolean }

/** Nothing happens until the button here is pressed, so a mail scanner opening the link cannot decide anything. */
export function EmailActionPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [decision, setDecision] = useState(params.get('decision') === 'reject' ? 'reject' : 'approve');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.post('/email-actions/preview', { token }).then((res) => setPreview(res.data.data)).catch((err) => setError(errorMessage(err)));
  }, [token]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/email-actions/decide', { token, decision, ...(decision === 'reject' ? { reason } : {}) });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const signIn = <Link className="text-brand hover:underline" to="/approvals">Open WorkNest</Link>;
  return (
    <AuthLayout title={preview?.title ?? 'Review request'} subtitle={preview ? `From ${preview.employee}` : undefined}>
      {!preview && !error && <Loading />}
      {error && <div className="mb-3"><Note>{error}</Note></div>}
      {!preview && error && <p className="text-[13px]">{signIn}</p>}
      {preview && done && <><Note tone="green">{decision === 'approve' ? 'Approved. The employee has been told.' : 'Rejected. The employee has been told.'}</Note><p className="mt-3 text-[13px]">{signIn}</p></>}
      {preview && !done && (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {preview.lines.map((l) => <div key={l.label} className="contents"><dt className="text-muted">{l.label}</dt><dd>{l.value}</dd></div>)}
          </dl>
          {!preview.decidable ? <><Note tone="amber">This request has already been decided or withdrawn.</Note><p className="text-[13px]">{signIn}</p></> : (
            <>
              {decision === 'reject' && <Field label="Reason" required hint="The employee will see this"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
              <div className="flex gap-2">
                {decision === 'approve'
                  ? <><Button variant="primary" loading={busy} onClick={() => submit()}>Confirm approval</Button><Button onClick={() => setDecision('reject')}>Reject instead</Button></>
                  : <><Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => submit()}>Confirm rejection</Button><Button onClick={() => setDecision('approve')}>Approve instead</Button></>}
              </div>
            </>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
