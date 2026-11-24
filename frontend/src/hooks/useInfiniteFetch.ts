import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { PageMeta } from '../types';

export interface InfiniteState<T> {
  /** Every page loaded so far, joined. For responses that wrap their rows, the first page's other fields stay. */
  data: T | null;
  meta: PageMeta | null;
  /** The first page is loading (or reloading after a filter change). */
  loading: boolean;
  /** A further page is loading. */
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Refetches every page loaded so far, so the list keeps its length and scroll position. */
  reload: () => Promise<void>;
}

const clean = (params: Record<string, unknown>) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));

/**
 * Pages through a list endpoint as the person scrolls. Starts again from the first page whenever the url or
 * params change, and ignores responses that arrive after a newer request.
 *
 * `rowsKey` names the array inside an object response (e.g. `rows` in `{ summary, rows }`); without it the
 * response itself is the array.
 */
export function useInfiniteFetch<T>(url: string | null, params: Record<string, unknown> = {}, { limit = 25, rowsKey }: { limit?: number; rowsKey?: string } = {}): InfiniteState<T> {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [pages, setPages] = useState(0);
  const [loading, setLoading] = useState(Boolean(url));
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const busy = useRef(false);
  const key = JSON.stringify(clean(params));

  const rowsOf = useCallback((body: unknown): unknown[] => {
    const rows = rowsKey ? (body as Record<string, unknown>)?.[rowsKey] : body;
    return Array.isArray(rows) ? rows : [];
  }, [rowsKey]);

  const merge = useCallback((first: unknown, rows: unknown[]): T => (rowsKey ? { ...(first as object), [rowsKey]: rows } : rows) as T, [rowsKey]);

  const fetchPage = useCallback((page: number) => api.get(url!, { params: { ...JSON.parse(key), page, limit } }), [url, key, limit]);

  // First page, again on every change of url or filters.
  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    const mine = ++ticket.current;
    busy.current = true;
    setLoading(true);
    setError(null);
    fetchPage(1)
      .then((res) => {
        if (mine !== ticket.current) return;
        setData(merge(res.data.data, rowsOf(res.data.data)));
        setMeta(res.data.meta ?? null);
        setPages(1);
      })
      .catch((err) => { if (mine === ticket.current) setError(errorMessage(err)); })
      .finally(() => {
        if (mine === ticket.current) {
          busy.current = false;
          setLoading(false);
        }
      });
  }, [url, fetchPage, merge, rowsOf]);

  const hasMore = Boolean(meta && pages < meta.totalPages);

  const loadMore = useCallback(() => {
    if (!url || busy.current || !hasMore) return;
    const mine = ticket.current;
    busy.current = true;
    setLoadingMore(true);
    fetchPage(pages + 1)
      .then((res) => {
        if (mine !== ticket.current) return;
        setData((current) => merge(current, [...rowsOf(current), ...rowsOf(res.data.data)]));
        setMeta(res.data.meta ?? null);
        setPages((p) => p + 1);
      })
      .catch((err) => { if (mine === ticket.current) setError(errorMessage(err)); })
      .finally(() => {
        if (mine === ticket.current) busy.current = false;
        setLoadingMore(false);
      });
  }, [url, hasMore, pages, fetchPage, merge, rowsOf]);

  const reload = useCallback(async () => {
    if (!url) return;
    const mine = ++ticket.current;
    const count = Math.max(1, pages);
    try {
      const results = await Promise.all(Array.from({ length: count }, (_, i) => fetchPage(i + 1)));
      if (mine !== ticket.current) return;
      const last = results[results.length - 1];
      setData(merge(results[0].data.data, results.flatMap((r) => rowsOf(r.data.data))));
      setMeta(last.data.meta ?? null);
      setError(null);
    } catch (err) {
      if (mine === ticket.current) setError(errorMessage(err));
    } finally {
      if (mine === ticket.current) busy.current = false;
    }
  }, [url, pages, fetchPage, merge, rowsOf]);

  return { data, meta, loading, loadingMore, error, hasMore, loadMore, reload };
}
