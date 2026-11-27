import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { createApp } from '../src/app';
import { REFRESH_COOKIE } from '../src/middleware/auth';
import { AuditLog, Employee, LoginChallenge, PasswordResetToken, Session, User } from '../src/models';
import * as email from '../src/services/email';
import { agentFor, app, completeLogin, makePerson, PASSWORD, sendCode, useDatabase } from './helpers';

useDatabase('auth');
const client = () => supertest.agent(app).set('X-Requested-With', 'WorkNest');
const cookieValue = (res: supertest.Response, name: string) => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? { value: raw.split(';')[0].slice(name.length + 1), raw } : null;
};

describe('login', () => {
  it('sets HttpOnly SameSite cookies only after the code, and never returns tokens in the body', async () => {
    const p = await makePerson();
    const agent = client();
    const step = await agent.post('/api/auth/login').send({ email: p.email, password: PASSWORD });
    expect(step.status).toBe(200);
    expect(step.headers['set-cookie']).toBeUndefined();
    expect((await agent.get('/api/auth/me')).status).toBe(401);

    const res = await completeLogin(client(), p.email);
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

  it('locks the account for 15 minutes on the third wrong password, even for the right one, and says when it unlocks', async () => {
    const p = await makePerson();
    const wrong = () => client().post('/api/auth/login').send({ email: p.email, password: 'wrong-password' });
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    const third = await wrong();
    expect(third.status).toBe(423);
    expect(third.body.error.code).toBe('ACCOUNT_LOCKED');
    const unlockAt = new Date(third.body.error.meta.lockedUntil).getTime();
    expect(unlockAt - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(unlockAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(third.body.error.meta.retryAfterSeconds).toBeGreaterThan(14 * 60);

    const right = await client().post('/api/auth/login').send({ email: p.email, password: PASSWORD });
    expect(right.status).toBe(423);
    // Trying again while locked does not push the unlock time back.
    expect(new Date(right.body.error.meta.lockedUntil).getTime()).toBe(unlockAt);
    expect(await AuditLog.exists({ action: 'ACCOUNT_LOCKED' })).toBeTruthy();
  });

  it('unlocks by itself once the lock time has passed', async () => {
    const p = await makePerson();
    await User.updateOne({ _id: p.userId }, { lockUntil: new Date(Date.now() - 1000) });
    expect((await completeLogin(client(), p.email)).status).toBe(200);
  });

  it('refuses an inactive account', async () => {
    const p = await makePerson();
    await User.updateOne({ _id: p.userId }, { isActive: false });
    expect((await client().post('/api/auth/login').send({ email: p.email, password: PASSWORD })).status).toBe(401);
  });
});

describe('one-time sign-in code', () => {
  const start = async (email: string) => {
    const agent = client();
    const step = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
    expect(step.status).toBe(200);
    return { agent, token: step.body.data.challengeToken as string, destination: step.body.data.destination as string };
  };

  it('sends the code to the account email only, and offers no mobile option', async () => {
    const p = await makePerson();
    await Employee.updateOne({ _id: p.employee._id }, { phone: '98765 43210' });
    const { agent, token, destination } = await start(p.email);
    expect(destination).toMatch(/^pe\*+@test\.local$/);
    const sent = await sendCode(agent, token);
    expect(sent.res.status).toBe(200);
    expect(sent.res.body.data.destination).toBe(destination);
    expect(JSON.stringify(sent.res.body)).not.toMatch(/SMS|3210/);
    const sms = await agent.post('/api/auth/otp/send').send({ challengeToken: token, channel: 'SMS' });
    expect(sms.status).toBe(400);
  });

  it('makes resending wait 30 seconds, and a new code replaces the old one', async () => {
    const p = await makePerson();
    const { agent, token } = await start(p.email);
    const first = await sendCode(agent, token);
    expect(first.res.status).toBe(200);
    const resendAt = new Date(first.res.body.data.resendAt).getTime();
    expect(resendAt - Date.now()).toBeGreaterThan(28_000);
    expect(resendAt - Date.now()).toBeLessThanOrEqual(30_000);

    const tooSoon = await sendCode(agent, token);
    expect(tooSoon.res.status).toBe(429);
    expect(tooSoon.res.body.error.code).toBe('OTP_RESEND_WAIT');
    expect(tooSoon.res.body.error.meta.resendAt).toBeTruthy();

    await LoginChallenge.updateOne({}, { lastSentAt: new Date(Date.now() - 31_000) });
    const second = await sendCode(agent, token);
    expect(second.res.status).toBe(200);
    if (first.code !== second.code) {
      expect((await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code: first.code })).body.error.code).toBe('INVALID_OTP');
    }
    expect((await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code: second.code })).status).toBe(200);
  });

  it('allows five wrong codes, then makes the person enter their password again', async () => {
    const p = await makePerson();
    const { agent, token } = await start(p.email);
    const { code } = await sendCode(agent, token);
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left--) {
      const res = await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code: wrongCode });
      expect(res.status).toBe(401);
      expect(res.body.error.meta.attemptsLeft).toBe(left);
    }
    const last = await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code: wrongCode });
    expect(last.body.error.code).toBe('LOGIN_CHALLENGE_EXPIRED');
    expect((await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code })).body.error.code).toBe('LOGIN_CHALLENGE_EXPIRED');
  });

  it('works once, refuses an expired code and needs a code to have been sent', async () => {
    const p = await makePerson();
    const { agent, token } = await start(p.email);
    expect((await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code: '123456' })).body.error.code).toBe('OTP_NOT_SENT');
    const { code } = await sendCode(agent, token);
    await LoginChallenge.updateOne({}, { codeExpiresAt: new Date(Date.now() - 1000) });
    expect((await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code })).body.error.code).toBe('OTP_CODE_EXPIRED');
    await LoginChallenge.updateOne({}, { codeExpiresAt: new Date(Date.now() + 60_000) });
    expect((await agent.post('/api/auth/otp/verify').send({ challengeToken: token, code })).status).toBe(200);
    expect((await client().post('/api/auth/otp/verify').send({ challengeToken: token, code })).body.error.code).toBe('LOGIN_CHALLENGE_EXPIRED');
  });

  it('stores only a keyed hash of the code and of the challenge token', async () => {
    const p = await makePerson();
    const { agent, token } = await start(p.email);
    const { code } = await sendCode(agent, token);
    const stored = JSON.stringify(await LoginChallenge.findOne({}).lean());
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(`"${code}"`);
  });

  it("one person's challenge cannot sign in anyone else", async () => {
    const a = await makePerson();
    const b = await makePerson();
    const { agent, token } = await start(a.email);
    const { code } = await sendCode(agent, token);
    const res = await client().post('/api/auth/otp/verify').send({ challengeToken: token, code });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(a.email);
    expect(res.body.data.email).not.toBe(b.email);
  });
});

describe('sessions', () => {
  it('requires authentication', async () => {
    expect((await client().get('/api/auth/me')).status).toBe(401);
  });

  it('rotates the refresh token and revokes the session when an old one is replayed', async () => {
    const p = await makePerson();
    const agent = client();
    const login = await completeLogin(agent, p.email);
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
    const login = await completeLogin(agent, p.email);
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
    const other = await makePerson();
    for (let i = 0; i < 6; i++) expect((await send(PASSWORD)).status).toBe(200);
    // Two failures stay under the account lock; the third comes from another account on the same address.
    for (let i = 0; i < 2; i++) expect((await send('wrong-password')).status).toBe(401);
    expect((await supertest(limited).post('/api/auth/login').set('X-Requested-With', 'WorkNest').send({ email: other.email, password: 'wrong-password' })).status).toBe(401);
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
