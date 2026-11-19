import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { ApiFieldError } from '../types';

export const AUTH_EXPIRED_EVENT = 'leavehub:auth-expired';

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'X-Requested-With': 'WorkNest' },
});

let refreshing: Promise<void> | null = null;

/** Several calls can expire together, so they all wait on one refresh. */
function refreshSession(): Promise<void> {
  refreshing ??= api.post('/auth/refresh').then(() => undefined).finally(() => { refreshing = null; });
  return refreshing;
}

const NO_RETRY = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/forgot-password', '/auth/reset-password'];

api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
  const skip = !config || config._retried || NO_RETRY.some((u) => config.url?.startsWith(u));
  if (error.response?.status !== 401 || skip) throw error;
  config._retried = true;
  try {
    await refreshSession();
  } catch (refreshError) {
    // Only a refused refresh means the session is over. A network drop, rate limit or server error keeps the user signed in.
    const status = (refreshError as AxiosError).response?.status;
    if (status === 401 || status === 403) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    throw error;
  }
  return api.request(config);
});

interface ApiErrorBody { error?: { code?: string; message?: string; details?: ApiFieldError[] } }

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const axiosErr = err as AxiosError<ApiErrorBody> | undefined;
  const body = axiosErr?.response?.data;
  if (body?.error?.message) return body.error.message;
  // No response at all: offline, DNS failure, CORS, or the request timed out.
  if (axiosErr?.isAxiosError && !axiosErr.response) return 'Could not reach the server. Check your connection and try again.';
  // `||`, not `??`: over HTTP/2 the status text is an empty string, which would show a blank error.
  return axiosErr?.response?.statusText || fallback;
}

export function errorCode(err: unknown): string | undefined {
  return (err as AxiosError<ApiErrorBody>)?.response?.data?.error?.code;
}

export function fieldErrors(err: unknown): ApiFieldError[] {
  return (err as AxiosError<ApiErrorBody>)?.response?.data?.error?.details ?? [];
}

/** Puts server field errors on the matching form fields. Returns the text for anything left over. */
export function applyServerErrors<T extends string>(err: unknown, setError: (field: T, e: { message: string }) => void, known: readonly T[]): string | null {
  const details = fieldErrors(err);
  const unmatched = details.filter((d) => {
    if (!known.includes(d.path as T)) return true;
    setError(d.path as T, { message: d.message });
    return false;
  });
  if (details.length && !unmatched.length) return null;
  return unmatched[0]?.message ?? errorMessage(err);
}
