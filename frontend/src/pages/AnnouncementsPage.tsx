import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, applyServerErrors, errorMessage } from '../api/client';
import { AttachedDocument, DocumentUpload } from '../components/DocumentUpload';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Loading, Modal, Note, PageHeader, Select, Textarea, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';
import { downloadFile } from '../services/download';
import type { Announcement } from '../types';
import { formatDateTime } from '../utils/date';
import { AnnouncementForm, announcementSchema } from '../validations';

function PublishModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const [document, setDocument] = useState<AttachedDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<AnnouncementForm>({ resolver: zodResolver(announcementSchema), defaultValues: { kind: 'ANNOUNCEMENT', title: '', body: '', requiresAck: false } });
  const onSubmit = async (v: AnnouncementForm) => {
    setFormError(null);
    try {
      await api.post('/announcements', { ...v, document: document?.id ?? null });
      toast('Published. Everyone has been notified.');
      onDone();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['kind', 'title', 'body'] as const));
    }
  };
  return (
    <Modal wide title="Publish to everyone" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="announcement-form" disabled={uploading} loading={isSubmitting}>Publish</Button></>}>
      <form id="announcement-form" className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <Note>{formError}</Note>}
        <Field label="Type" required><Select {...register('kind')}><option value="ANNOUNCEMENT">Announcement</option><option value="POLICY">Policy</option></Select></Field>
        <Field label="Title" required error={errors.title?.message}><Input {...register('title')} /></Field>
        <Field label="Message" required error={errors.body?.message}><Textarea rows={5} {...register('body')} /></Field>
        <DocumentUpload label="Document" value={document} onChange={setDocument} onUploadingChange={setUploading} />
        <Checkbox label="Ask everyone to confirm they have read this" {...register('requiresAck')} />
      </form>
    </Modal>
  );
}

function ReadersModal({ item, onClose }: { item: Announcement; onClose: () => void }) {
  const { data, loading, error } = useFetch<{ confirmed: { name: string; at: string }[]; waiting: { name: string }[] }>(`/announcements/${item._id}/readers`);
  return (
    <Modal title={`Who has read: ${item.title}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {loading && <Loading />}
      {error && <Note>{error}</Note>}
      {data && (
        <div className="space-y-4 text-[13px]">
          <section><h3 className="mb-1 font-semibold">Waiting ({data.waiting.length})</h3><ul>{data.waiting.map((w) => <li key={w.name}>{w.name}</li>)}</ul></section>
          <section><h3 className="mb-1 font-semibold">Confirmed ({data.confirmed.length})</h3><ul>{data.confirmed.map((c) => <li key={c.name} className="flex justify-between gap-3"><span>{c.name}</span><span className="text-muted">{formatDateTime(c.at)}</span></li>)}</ul></section>
        </div>
      )}
    </Modal>
  );
}

export function AnnouncementsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('announcements:manage');
  const { data, loading, error, reload } = useFetch<Announcement[]>('/announcements');
  const [publishing, setPublishing] = useState(false);
  const [readers, setReaders] = useState<Announcement | null>(null);

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast(done);
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <PageHeader title="Announcements and policies" subtitle="Company news and documents" actions={manage && <Button variant="primary" onClick={() => setPublishing(true)}>Publish</Button>} />
      {error && <Note>{error}</Note>}
      {loading && !data && <Loading />}
      {data && !data.length && <Card><Empty>Nothing has been published yet.</Empty></Card>}
      <div className="space-y-3">
        {data?.map((a) => (
          <Card key={a._id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-semibold">{a.title}</h2>{a.kind === 'POLICY' && <Badge tone="sky">Policy</Badge>}</div>
                <p className="mt-0.5 text-xs text-muted">{a.publishedByName}, {formatDateTime(a.createdAt)}</p>
              </div>
              {manage && <div className="flex gap-2">
                {a.requiresAck && <Button small onClick={() => setReaders(a)}>Who has read</Button>}
                <Button small onClick={() => { if (window.confirm(`Delete "${a.title}"?`)) void run(() => api.delete(`/announcements/${a._id}`), 'Deleted'); }}>Delete</Button>
              </div>}
            </div>
            <p className="mt-3 whitespace-pre-wrap text-[13px]">{a.body}</p>
            {a.document && <button type="button" className="mt-2 text-[13px] text-brand hover:underline" onClick={() => downloadFile(`/files/${a.document!._id}`, {}, a.document!.originalName).catch((err) => toast(errorMessage(err), 'error'))}>{a.document.originalName}</button>}
            {a.requiresAck && (
              <div className="mt-3 border-t border-line pt-3">
                {a.acknowledged ? <Badge tone="green">You confirmed this</Badge> : <Button small variant="primary" onClick={() => void run(() => api.post(`/announcements/${a._id}/acknowledge`, {}), 'Thanks for confirming')}>I have read this</Button>}
              </div>
            )}
          </Card>
        ))}
      </div>
      {publishing && <PublishModal onClose={() => setPublishing(false)} onDone={() => { setPublishing(false); void reload(); }} />}
      {readers && <ReadersModal item={readers} onClose={() => setReaders(null)} />}
    </>
  );
}
