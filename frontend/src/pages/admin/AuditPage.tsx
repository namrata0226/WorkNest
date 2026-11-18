import { useState } from 'react';
import { Badge, Card, DataTable, Input, Note, PageHeader, Pagination, Select } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import { formatDateTime } from '../../utils/date';
import { ROLE_LABEL, titleCase } from '../../utils/labels';

interface AuditRow {
  _id: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  category: string;
  entityType: string | null;
  summary: string | null;
  ip: string | null;
  createdAt: string;
}

export function AuditPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const systemWide = can('audit:read_system');
  const { data, meta, loading, error } = useFetch<AuditRow[]>('/audit-logs', { search, category, from, to, page, limit: 30 });

  return (
    <>
      <PageHeader title="Audit log" subtitle={systemWide ? 'All HR, security and system events' : 'HR activity'} />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Search" placeholder="Search action, person or summary" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        {systemWide && (
          <Select aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
            <option value="">All categories</option>
            <option value="HR">HR</option>
            <option value="SECURITY">Security</option>
            <option value="SYSTEM">System</option>
          </Select>
        )}
        <Input aria-label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <Input aria-label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
      </div>
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<AuditRow>
          rows={data}
          loading={loading}
          rowKey={(r) => r._id}
          empty="No events match."
          columns={[
            { header: 'When', cell: (r) => formatDateTime(r.createdAt), className: 'whitespace-nowrap text-muted' },
            { header: 'Who', cell: (r) => <div><div>{r.actorEmail ?? 'System'}</div>{r.actorRole && <div className="text-xs text-muted">{ROLE_LABEL[r.actorRole] ?? r.actorRole}</div>}</div> },
            { header: 'Action', cell: (r) => <span className="whitespace-nowrap">{titleCase(r.action)}</span> },
            { header: 'Detail', cell: (r) => r.summary ?? '—', className: 'text-muted' },
            { header: 'Category', cell: (r) => <Badge tone={r.category === 'SECURITY' ? 'rose' : r.category === 'SYSTEM' ? 'sky' : 'gray'}>{r.category}</Badge> },
          ]}
        />
        <Pagination meta={meta} onPage={setPage} />
      </Card>
    </>
  );
}
