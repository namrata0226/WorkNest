import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { Button, Card, Input, Note, Select, useToast } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import { downloadFile } from '../../services/download';
import type { Checklist, EmployeeDetails, PersonalDocument } from '../../types';
import { ChecklistCard, DetailRows } from '../SelfServicePage';

/** Bank details, contacts and documents. Each view is written to the audit log. */
export function PrivateDetailsCard({ employeeId }: { employeeId: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { data, error } = useFetch<EmployeeDetails & { documents: PersonalDocument[] }>(open ? `/employees/${employeeId}/details` : null);
  const [account, setAccount] = useState<string | null>(null);
  const reveal = async () => {
    try {
      setAccount((await api.post(`/employees/${employeeId}/details/reveal-bank`, {})).data.data.accountNumber);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Card className="mt-4" title="Private details" actions={!open && <Button small onClick={() => setOpen(true)}>Show details</Button>}>
      {!open && <p className="text-[13px] text-muted">Bank details, emergency contacts and personal documents. Opening these is recorded in the audit log.</p>}
      {error && <Note>{error}</Note>}
      {open && data && (
        <div className="space-y-3">
          <DetailRows details={data} />
          {data.bank && (account ? <p className="tnum text-[13px]">Account number: <strong>{account}</strong></p> : <Button small onClick={() => void reveal()}>Show full account number</Button>)}
          {data.documents?.length > 0 && (
            <ul className="text-[13px]">
              {data.documents.map((d) => <li key={d._id}><button type="button" className="text-brand hover:underline" onClick={() => downloadFile(`/files/${d._id}`, {}, d.originalName).catch((err) => toast(errorMessage(err), 'error'))}>{d.originalName}</button></li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

export function EmployeeChecklists({ employeeId }: { employeeId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const canWrite = can('employees:write');
  const { data, error, reload } = useFetch<Checklist[]>(`/employees/${employeeId}/checklists`);
  const [label, setLabel] = useState('');
  const [owner, setOwner] = useState<'HR' | 'EMPLOYEE'>('HR');

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const missing = (['ONBOARDING', 'EXIT'] as const).filter((k) => !data?.some((c) => c.kind === k));

  return (
    <div className="mt-4 space-y-4">
      {error && <Note>{error}</Note>}
      {data?.map((c) => (
        <ChecklistCard
          key={c._id}
          checklist={c}
          canTick={() => canWrite}
          onToggle={(itemId, done) => void run(() => api.patch(`/employees/${employeeId}/checklists/${c._id}/items/${itemId}`, { done }))}
          footer={canWrite && (
            <form className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); if (label.trim()) void run(() => api.post(`/employees/${employeeId}/checklists/${c._id}/items`, { label, owner })).then(() => setLabel('')); }}>
              <Input aria-label="New item" placeholder="Add an item" className="min-w-40 flex-1" value={label} onChange={(e) => setLabel(e.target.value)} />
              <Select aria-label="Who does it" className="w-32" value={owner} onChange={(e) => setOwner(e.target.value as 'HR' | 'EMPLOYEE')}><option value="HR">HR</option><option value="EMPLOYEE">Employee</option></Select>
              <Button small type="submit">Add</Button>
            </form>
          )}
        />
      ))}
      {canWrite && data && missing.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {missing.map((k) => <Button key={k} onClick={() => void run(() => api.post(`/employees/${employeeId}/checklists`, { kind: k }))}>{k === 'ONBOARDING' ? 'Start onboarding checklist' : 'Start exit checklist'}</Button>)}
        </div>
      )}
    </div>
  );
}
