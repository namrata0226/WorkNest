import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { Badge, Button, Card, DataTable, Field, Input, Modal, Note, PageHeader, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';

interface OrgItem { _id: string; name: string; code?: string | null; city?: string | null; isActive: boolean }

function OrgSection({ title, path, extraField, extraLabel }: { title: string; path: string; extraField: 'code' | 'city'; extraLabel: string }) {
  const toast = useToast();
  const { data, loading, error, reload } = useFetch<OrgItem[]>(path);
  const [editing, setEditing] = useState<OrgItem | 'new' | null>(null);
  const [name, setName] = useState('');
  const [extra, setExtra] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const open = (item: OrgItem | 'new') => {
    setEditing(item);
    setName(item === 'new' ? '' : item.name);
    setExtra(item === 'new' ? '' : item[extraField] ?? '');
    setIsActive(item === 'new' ? true : item.isActive);
    setFormError(null);
  };

  const save = async () => {
    setBusy(true);
    setFormError(null);
    const body = { name, [extraField]: extra || null, isActive };
    try {
      if (editing === 'new') await api.post(path, body);
      else if (editing) await api.put(`${path}/${editing._id}`, body);
      toast(`${title.slice(0, -1)} saved`);
      setEditing(null);
      await reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={title} flush actions={<Button small onClick={() => open('new')}>Add</Button>}>
      {error && <Note>{error}</Note>}
      <DataTable<OrgItem>
        rows={data}
        loading={loading}
        rowKey={(i) => i._id}
        onRowClick={open}
        columns={[
          { header: 'Name', cell: (i) => i.name, className: 'font-medium' },
          { header: extraLabel, cell: (i) => i[extraField] ?? '—', className: 'text-muted' },
          { header: 'Status', cell: (i) => <Badge tone={i.isActive ? 'green' : 'gray'}>{i.isActive ? 'Active' : 'Inactive'}</Badge> },
        ]}
      />
      {editing && (
        <Modal
          title={editing === 'new' ? `Add to ${title.toLowerCase()}` : `Edit ${editing.name}`}
          onClose={() => setEditing(null)}
          footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => save()}>Save</Button></>}
        >
          <div className="space-y-3">
            {formError && <Note>{formError}</Note>}
            <Field label="Name" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label={extraLabel}><Input value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
            </label>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export function OrgPage() {
  return (
    <>
      <PageHeader title="Teams and locations" subtitle="Used for filters, holiday applicability and leave policies" />
      <div className="grid gap-4 lg:grid-cols-2">
        <OrgSection title="Teams" path="/departments" extraField="code" extraLabel="Code" />
        <OrgSection title="Locations" path="/locations" extraField="city" extraLabel="City" />
      </div>
    </>
  );
}
