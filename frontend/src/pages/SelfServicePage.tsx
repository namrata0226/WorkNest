import { useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { Badge, Button, Card, Empty, Field, Input, Modal, Note, Textarea, useConfirm, useToast } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import { downloadFile } from '../services/download';
import type { Checklist, EmployeeDetails, PersonalDocument } from '../types';

const blankContact = { name: '', relationship: '', phone: '' };

function DetailsModal({ details, onClose, onDone }: { details: EmployeeDetails; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [bank, setBank] = useState({ holderName: details.bank?.holderName ?? '', bankName: details.bank?.bankName ?? '', ifsc: details.bank?.ifsc ?? '', accountNumber: '' });
  const [contacts, setContacts] = useState(details.emergencyContacts?.length ? details.emergencyContacts : [blankContact]);
  const [address, setAddress] = useState(details.address ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasBank = bank.holderName || bank.bankName || bank.ifsc || bank.accountNumber || details.bank;

  const setContact = (i: number, key: keyof typeof blankContact, value: string) => setContacts(contacts.map((c, n) => (n === i ? { ...c, [key]: value } : c)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { accountNumber, ...rest } = bank;
      await api.put('/me/details', {
        emergencyContacts: contacts.filter((c) => c.name || c.phone),
        address: address || null,
        ...(hasBank ? { bank: { ...rest, ...(accountNumber ? { accountNumber } : {}) } } : {}),
      });
      toast('Details saved');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title="Update my details" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => save()}>Save details</Button></>}>
      <div className="space-y-4">
        {error && <Note>{error}</Note>}
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">Bank details</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account holder name"><Input value={bank.holderName} onChange={(e) => setBank({ ...bank, holderName: e.target.value })} /></Field>
            <Field label="Bank name"><Input value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} /></Field>
            <Field label="IFSC code"><Input value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} /></Field>
            <Field label="Account number" hint={details.bank ? `Ending ${details.bank.accountLast4}. Leave blank to keep it.` : undefined}><Input inputMode="numeric" autoComplete="off" value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} /></Field>
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">Emergency contacts</h3>
          <div className="space-y-2">
            {contacts.map((c, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-3">
                <Field label="Name"><Input value={c.name} onChange={(e) => setContact(i, 'name', e.target.value)} /></Field>
                <Field label="Relationship"><Input value={c.relationship} onChange={(e) => setContact(i, 'relationship', e.target.value)} /></Field>
                <Field label="Phone"><Input value={c.phone} onChange={(e) => setContact(i, 'phone', e.target.value)} /></Field>
              </div>
            ))}
          </div>
          {contacts.length < 5 && <div className="mt-2"><Button small onClick={() => setContacts([...contacts, blankContact])}>Add another contact</Button></div>}
        </section>
        <Field label="Home address"><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function DetailRows({ details }: { details: Partial<EmployeeDetails> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
      <dt className="text-muted">Bank</dt>
      <dd>{details.bank ? `${details.bank.bankName}, ${details.bank.holderName}, account ending ${details.bank.accountLast4}, IFSC ${details.bank.ifsc}` : 'Not added'}</dd>
      <dt className="text-muted">Emergency contacts</dt>
      <dd>{details.emergencyContacts?.length ? details.emergencyContacts.map((c) => <div key={c.name + c.phone}>{c.name} ({c.relationship}), {c.phone}</div>) : 'Not added'}</dd>
      <dt className="text-muted">Address</dt>
      <dd className="whitespace-pre-wrap">{details.address ?? 'Not added'}</dd>
    </dl>
  );
}

function DocumentsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, reload } = useFetch<PersonalDocument[]>('/me/documents');
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post('/me/documents', form);
      toast('Document added');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const remove = async (d: PersonalDocument) => {
    if (!(await confirm({ title: 'Delete this document?', message: `${d.originalName} will be permanently deleted. HR will no longer be able to open it.`, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api.delete(`/me/documents/${d._id}`);
      toast('Document deleted');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Card title="My documents" actions={<><input ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg" aria-label="Choose a document" onChange={(e) => void upload(e.target.files?.[0])} /><Button small loading={busy} onClick={() => fileRef.current?.click()}>Add document</Button></>}>
      {!data?.length ? <Empty>ID proofs and certificates you add appear here. Only you and HR can open them.</Empty> : (
        <ul className="divide-y divide-line text-[13px]">
          {data.map((d) => (
            <li key={d._id} className="flex items-center justify-between gap-3 py-2">
              <button type="button" className="min-w-0 truncate text-left text-brand hover:underline" onClick={() => downloadFile(`/files/${d._id}`, {}, d.originalName).catch((err) => toast(errorMessage(err), 'error'))}>{d.originalName}</button>
              <Button small variant="ghost" className="text-rose" onClick={() => remove(d)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ChecklistCard({ checklist, canTick, onToggle, footer }: { checklist: Checklist; canTick: (owner: 'HR' | 'EMPLOYEE') => boolean; onToggle: (itemId: string, done: boolean) => void; footer?: React.ReactNode }) {
  const done = checklist.items.filter((i) => i.done).length;
  return (
    <Card title={checklist.kind === 'ONBOARDING' ? 'Onboarding checklist' : 'Exit checklist'} actions={<Badge tone={done === checklist.items.length ? 'green' : 'amber'}>{done} of {checklist.items.length} done</Badge>}>
      <ul className="space-y-2 text-[13px]">
        {checklist.items.map((i) => (
          <li key={i._id} className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" aria-label={i.label} checked={i.done} disabled={!canTick(i.owner)} onChange={(e) => onToggle(i._id, e.target.checked)} />
            <span className={i.done ? 'text-muted line-through' : ''}>{i.label}<span className="ml-1.5 text-xs text-faint no-underline">{i.owner === 'HR' ? 'HR' : 'You'}{i.doneByName ? `, done by ${i.doneByName}` : ''}</span></span>
          </li>
        ))}
      </ul>
      {footer}
    </Card>
  );
}

export function SelfService() {
  const toast = useToast();
  const details = useFetch<EmployeeDetails>('/me/details');
  const checklists = useFetch<Checklist[]>('/me/checklists');
  const [editing, setEditing] = useState(false);

  const toggle = async (id: string, itemId: string, done: boolean) => {
    try {
      await api.patch(`/me/checklists/${id}/items/${itemId}`, { done });
      await checklists.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card title="My details" actions={<Button small onClick={() => setEditing(true)}>Update</Button>}>
        <DetailRows details={details.data ?? {}} />
        <p className="mt-3 text-xs text-faint">Only you and authorised HR staff can see these. Your account number is encrypted.</p>
      </Card>
      <DocumentsCard />
      {(Array.isArray(checklists.data) ? checklists.data : []).map((c) => <ChecklistCard key={c._id} checklist={c} canTick={(o) => o === 'EMPLOYEE'} onToggle={(itemId, done) => void toggle(c._id, itemId, done)} />)}
      {editing && details.data && <DetailsModal details={details.data} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void details.reload(); }} />}
    </div>
  );
}
