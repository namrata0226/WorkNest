import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { createApp } from '../src/app';
import { REFRESH_COOKIE } from '../src/middleware/auth';
import { AuditLog, PasswordResetToken, Session, User } from '../src/models';
import * as email from '../src/services/email';
import { agentFor, app, makePerson, PASSWORD, useDatabase } from './helpers';

useDatabase('auth');
const client = () => supertest.agent(app).set('X-Requested-With', 'WorkNest');
const cookieValue = (res: supertest.Response, name: string) => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? { value: raw.split(';')[0].slice(name.length + 1), raw } : null;
};

describe('login', () => {
  it('sets HttpOnly SameSite cookies and never returns tokens in the body', async () => {
    const p = await makePerson();
    const res = await client().post('/api/auth/login').send({ email: p.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const access = cookieValue(res, 'lh_access')!;
    expect(access.raw).toMatch(/HttpOnly/);
    expect(access.raw).toMatch(/SameSite=Strict/);
    expect(cookieValue(res, REFRESH_COOKIE)!.raw).toMatch(/Path=\/api\/auth/);
    expect(JSON.stringify(res.body)).not.toContain(access.value);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('stores only a hash of the password', async () => {
    const p = await makePerson();
    const user = await User.findById(p.userId).select('+passwordHash').lean();
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const p = await makePerson();
    const wrong = await client().post('/api/auth/login').send({ email: p.email, password: 'wrong-password' });
    const unknown = await client().post('/api/auth/login').send({ email: 'nobody@test.local', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const p = await makePerson();
    for (let i = 0; i < 5; i++) await client().post('/api/auth/login').send({ email: p.email, password: 'wrong-password' });
    expect((await User.findById(p.userId).lean())!.lockUntil).toBeTruthy();
    const res = await client().post('/api/auth/login').send({ email: p.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(await AuditLog.exists({ action: 'ACCOUNT_LOCKED' })).toBeTruthy();
  });

  it('refuses an inactive account', async () => {
    const p = await makePerson();
    await User.updateOne({ _id: p.userId }, { isActive: false });
    expect((await client().post('/api/auth/login').send({ email: p.email, password: PASSWORD })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('requires authentication', async () => {
    expect((await client().get('/api/auth/me')).status).toBe(401);
  });

  it('rotates the refresh token and revokes the session when an old one is replayed', async () => {
    const p = await makePerson();
    const agent = client();
    const login = await agent.post('/api/auth/login').send({ email: p.email, password: PASSWORD });
    const first = cookieValue(login, REFRESH_COOKIE)!.value;

    const refreshed = await agent.post('/api/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(cookieValue(refreshed, REFRESH_COOKIE)!.value).not.toBe(first);

    // Past the grace period that exists for parallel tabs, this is theft.
    await Session.updateOne({ user: p.userId }, { rotatedAt: new Date(Date.now() - 60_000) });
    const replay = await supertest(app).post('/api/auth/refresh').set('X-Requested-With', 'WorkNest').set('Cookie', `${REFRESH_COOKIE}=${first}`);
    expect(replay.status).toBe(401);
    expect((await Session.findOne({ user: p.userId }).lean())!.revokedReason).toBe('TOKEN_REUSE');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('does not treat a parallel tab refreshing at once as theft', async () => {
    const p = await makePerson();
    const agent = client();
    const login = await agent.post('/api/auth/login').send({ email: p.email, password: PASSWORD });
    const first = cookieValue(login, REFRESH_COOKIE)!.value;
    await agent.post('/api/auth/refresh');
    const race = await supertest(app).post('/api/auth/refresh').set('X-Requested-With', 'WorkNest').set('Cookie', `${REFRESH_COOKIE}=${first}`);
    expect(race.status).toBe(200);
    expect(cookieValue(race, REFRESH_COOKIE)).toBeNull();
    expect((await Session.findOne({ user: p.userId }).lean())!.revokedAt).toBeNull();
  });

  it('logout revokes the session on the server', async () => {
    const p = await makePerson();
    const agent = await agentFor(p.email);
    const stolen = (await Session.findOne({ user: p.userId }).lean())!;
    expect((await agent.post('/api/auth/logout')).status).toBe(200);
    expect((await Session.findById(stolen._id).lean())!.revokedReason).toBe('LOGOUT');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('cuts off a deactivated user immediately, before the access token expires', async () => {
    const p = await makePerson();
    const agent = await agentFor(p.email);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await User.updateOne({ _id: p.userId }, { isActive: false });
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('temporary passwords', () => {
  it('blocks everything except the auth routes until the password is changed', async () => {
    const p = await makePerson();
    await User.updateOne({ _id: p.userId }, { mustChangePassword: true });
    const agent = await agentFor(p.email);
    const blocked = await agent.get('/api/leave-balances/my');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await agent.get('/api/auth/me')).body.data.mustChangePassword).toBe(true);
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'Brand-new-pass-123' })).status).toBe(200);
    expect((await agent.get('/api/leave-balances/my')).status).toBe(200);
  });
});

describe('password reset', () => {
  let link = '';
  beforeEach(() => {
    link = '';
    vi.spyOn(email, 'sendEmail').mockImplementation(async (m) => {
      link = m.devLink ?? '';
      return true;
    });
  });
  const tokenOf = () => new URL(link).searchParams.get('token')!;

  it('answers the same whether or not the account exists', async () => {
    const p = await makePerson();
    const known = await client().post('/api/auth/forgot-password').send({ email: p.email });
    const unknown = await client().post('/api/auth/forgot-password').send({ email: 'nobody@test.local' });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
  });

  it('works once, stores only a hash, and signs out every session', async () => {
    const p = await makePerson();
    const session = await agentFor(p.email);
    await client().post('/api/auth/forgot-password').send({ email: p.email });
    const token = tokenOf();
    expect(await PasswordResetToken.exists({ tokenHash: token })).toBeNull();

    const reset = await client().post('/api/auth/reset-password').send({ token, password: 'Brand-new-pass-123' });
    expect(reset.status).toBe(200);
    expect((await session.get('/api/auth/me')).status).toBe(401);
    await agentFor(p.email, 'Brand-new-pass-123');

    const again = await client().post('/api/auth/reset-password').send({ token, password: 'Another-pass-456' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects an expired token', async () => {
    const p = await makePerson();
    await client().post('/api/auth/forgot-password').send({ email: p.email });
    await PasswordResetToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await client().post('/api/auth/reset-password').send({ token: tokenOf(), password: 'Brand-new-pass-123' })).status).toBe(400);
  });

  it('rejects a weak password without burning the token', async () => {
    const p = await makePerson();
    await client().post('/api/auth/forgot-password').send({ email: p.email });
    expect((await client().post('/api/auth/reset-password').send({ token: tokenOf(), password: 'alllettersnodigits' })).status).toBe(422);
    expect((await client().post('/api/auth/reset-password').send({ token: tokenOf(), password: 'Brand-new-pass-123' })).status).toBe(200);
  });
});

describe('API hardening', () => {
  it('rate limits login attempts', async () => {
    const limited = createApp({ rateLimits: { auth: 3 } });
    const send = () => supertest(limited).post('/api/auth/login').set('X-Requested-With', 'WorkNest').send({ email: 'a@test.local', password: 'x' });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(401);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('counts only failed sign-ins, so people sharing one IP address are not locked out', async () => {
    const p = await makePerson();
    const limited = createApp({ rateLimits: { auth: 3 } });
    const send = (password: string) => supertest(limited).post('/api/auth/login').set('X-Requested-With', 'WorkNest').send({ email: p.email, password });
    for (let i = 0; i < 6; i++) expect((await send(PASSWORD)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await send('wrong-password')).status).toBe(401);
    expect((await send(PASSWORD)).status).toBe(429);
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await supertest(app).post('/api/auth/login').send({ email: 'a@test.local', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('allows only listed CORS origins', async () => {
    const good = await supertest(app).options('/api/auth/login').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST');
    const evil = await supertest(app).options('/api/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and hides the framework', async () => {
    const res = await supertest(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects NoSQL operators in login', async () => {
    const res = await client().post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSAFE_INPUT');
  });

  it('rejects oversized bodies and malformed JSON without leaking internals', async () => {
    const big = await client().post('/api/auth/login').send({ email: 'a@test.local', password: 'x'.repeat(300 * 1024) });
    expect(big.status).toBe(413);
    const bad = await supertest(app).post('/api/auth/login').set('X-Requested-With', 'WorkNest').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/stack|at .*\.js/i);
  });

  it('never exposes stack traces on unexpected errors', async () => {
    const p = await makePerson();
    const agent = await agentFor(p.email);
    vi.spyOn(User, 'findById').mockImplementationOnce(() => {
      throw new Error('secret internal detail from the database');
    });
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    vi.restoreAllMocks();
  });
});

describe('deployment safeguards', () => {
  afterEach(() => { env.ORIGIN_SECRET = undefined; });

  it('refuses API requests without the proxy secret once one is set, but keeps the health check open', async () => {
    env.ORIGIN_SECRET = 's'.repeat(40);
    const direct = await supertest(app).get('/api/auth/me');
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('DIRECT_ACCESS');
    expect((await supertest(app).get('/api/auth/me').set('X-Origin-Secret', 'wrong')).body.error.code).toBe('DIRECT_ACCESS');
    expect((await supertest(app).get('/api/auth/me').set('X-Origin-Secret', 's'.repeat(40))).status).toBe(401);
    expect((await supertest(app).get('/health')).status).not.toBe(403);
  });

  it('tells proxies and CDNs not to keep API answers', async () => {
    const res = await supertest(app).get('/api/auth/me');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
