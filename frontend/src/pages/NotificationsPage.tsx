import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Button, Card, Empty, Loading, Note, PageHeader, Pagination, Tabs, useToast } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import type { NotificationItem } from '../types';
import { formatDateTime } from '../utils/date';

export function NotificationsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState(1);
  const { data, meta, loading, error, reload } = useFetch<NotificationItem[]>('/notifications', { page, limit: 20, unread: filter === 'unread' ? 'true' : '' });

  const open = async (n: NotificationItem) => {
    try {
      if (!n.readAt) await api.patch(`/notifications/${n._id}/read`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    if (n.link) navigate(n.link);
    else void reload();
  };

  const markAll = async () => {
    try {
      await api.patch('/notifications/read-all');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <>
            <Tabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} tabs={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
            <Button disabled={!meta?.unread} onClick={() => void markAll()}>Mark all read</Button>
          </>
        }
      />
      {error && <Note>{error}</Note>}
      <Card flush>
        {loading && !data ? <Loading /> : !data?.length ? <Empty>You are all caught up.</Empty> : (
          <ul className="divide-y divide-line">
            {data.map((n) => (
              <li key={n._id}>
                <button type="button" onClick={() => void open(n)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-paper">
                  <span aria-label={n.readAt ? undefined : 'Unread'} className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-brand'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] ${n.readAt ? '' : 'font-semibold'}`}>{n.title}</span>
                    <span className="block text-[13px] text-muted">{n.message}</span>
                    <span className="mt-0.5 block text-xs text-faint">{formatDateTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Pagination meta={meta} onPage={setPage} />
      </Card>
    </>
  );
}
