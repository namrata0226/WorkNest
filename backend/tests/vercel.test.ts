import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import * as email from '../src/services/email';
import vercelApp from '../src/vercel';
import { baseline, useDatabase } from './helpers';

useDatabase('vercel');

const request = () => supertest(vercelApp);

beforeEach(async () => {
  await baseline();
});

afterEach(() => {
  env.CRON_SECRET = undefined;
  vi.restoreAllMocks();
});

describe('Vercel entry point', () => {
  it('serves the API', async () => {
    expect((await request().get('/health')).status).toBe(200);
    expect((await request().get('/api/auth/me')).status).toBe(401);
  });

  it('runs scheduled jobs only for Vercel Cron, which sends the secret', async () => {
    env.CRON_SECRET = 'c'.repeat(40);
    expect((await request().get('/api/cron/daily')).status).toBe(401);
    expect((await request().get('/api/cron/daily').set('Authorization', 'Bearer wrong')).status).toBe(401);
    const res = await request().get('/api/cron/daily').set('Authorization', `Bearer ${env.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('runs no scheduled jobs when no secret is set', async () => {
    expect((await request().get('/api/cron/daily').set('Authorization', 'Bearer undefined')).status).toBe(401);
  });

  it('sends queued emails after a change, not after a read', async () => {
    const flush = vi.spyOn(email, 'flushEmailOutbox').mockResolvedValue(0);
    await request().get('/api/auth/me');
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).not.toHaveBeenCalled();
    await request().post('/api/auth/login').set('X-Requested-With', 'WorkNest').send({ email: 'nobody@test.local', password: 'wrong-password-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).toHaveBeenCalled();
  });
});
