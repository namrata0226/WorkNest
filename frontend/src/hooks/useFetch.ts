import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { PageMeta } from '../types';

export interface FetchState<T> {
  data: T | null;
  meta: PageMeta | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** GETs on mount and whenever the url or params change, discarding responses that arrive out of order. */
export function useFetch<T>(url: string | null, params?: Record<string, unknown>): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const key = JSON.stringify(params ?? {});

  const load = useCallback(async () => {
    if (!url) {
      setLoading(false);
      return;
    }
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const clean = Object.fromEntries(Object.entries(JSON.parse(key)).filter(([, v]) => v !== '' && v !== null && v !== undefined));
      const res = await api.get(url, { params: clean });
      if (ticket !== latest.current) return;
      setData(res.data.data);
      setMeta(res.data.meta ?? null);
      setError(null);
    } catch (err) {
      if (ticket === latest.current) setError(errorMessage(err));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [url, key]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, meta, loading, error, reload: load };
}
