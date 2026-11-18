import { AxiosAdapter, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, applyServerErrors, AUTH_EXPIRED_EVENT, errorMessage } from '../src/api/client';

const ok = (config: InternalAxiosRequestConfig, data: unknown = {}) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
const fail = (config: InternalAxiosRequestConfig, status: number, data: unknown = {}) =>
  new AxiosError('fail', undefined, config, undefined, { data, status, statusText: String(status), headers: {}, config });

describe('API client', () => {
  const original = api.defaults.adapter;
  let calls: string[];
  let session: 'valid' | 'expired' | 'dead';

  beforeEach(() => {
    calls = [];
    session = 'expired';
    const adapter: AxiosAdapter = async (config) => {
      calls.push(`${config.method} ${config.url}`);
      if (config.url === '/auth/refresh') {
        if (session === 'dead') throw fail(config, 401);
        session = 'valid';
        return ok(config);
      }
      if (session !== 'valid') throw fail(config, 401);
      return ok(config, { url: config.url });
    };
    api.defaults.adapter = adapter;
  });
  afterEach(() => {
    api.defaults.adapter = original;
  });

  it('sends the CSRF header and credentials', () => {
    expect(api.defaults.withCredentials).toBe(true);
    expect(api.defaults.headers['X-Requested-With']).toBe('WorkNest');
  });

  it('refreshes once and retries when the session has expired', async () => {
    const res = await api.get('/leaves/my');
    expect(res.data.url).toBe('/leaves/my');
    expect(calls).toEqual(['get /leaves/my', 'post /auth/refresh', 'get /leaves/my']);
  });

  it('shares one refresh among simultaneous expired calls', async () => {
    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(calls.filter((c) => c === 'post /auth/refresh')).toHaveLength(1);
  });

  it('signals the app when the session cannot be refreshed', async () => {
    session = 'dead';
    const listener = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, listener);
    await expect(api.get('/leaves/my')).rejects.toBeTruthy();
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never tries to refresh a failed login', async () => {
    session = 'dead';
    await expect(api.post('/auth/login', {})).rejects.toBeTruthy();
    expect(calls).toEqual(['post /auth/login']);
  });
});

describe('server errors', () => {
  const err = (details?: { path: string; message: string }[], message = 'Top level') =>
    new AxiosError('x', undefined, undefined, undefined, { data: { error: { message, details } }, status: 422, statusText: 'x', headers: {}, config: {} as InternalAxiosRequestConfig });

  it('reads the message from the consistent error shape', () => {
    expect(errorMessage(err())).toBe('Top level');
    expect(errorMessage(new Error('network'))).toBe('Something went wrong. Please try again.');
  });

  it('puts field errors on known fields and returns the rest', () => {
    const setError = vi.fn();
    const left = applyServerErrors(err([{ path: 'reason', message: 'Too short' }]), setError, ['reason'] as const);
    expect(setError).toHaveBeenCalledWith('reason', { message: 'Too short' });
    expect(left).toBeNull();
    expect(applyServerErrors(err([{ path: 'document', message: 'Needed' }]), setError, ['reason'] as const)).toBe('Needed');
    expect(applyServerErrors(err(), setError, ['reason'] as const)).toBe('Top level');
  });
});
