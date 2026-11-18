import { CookieOptions, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { ACCESS_COOKIE, authenticate, REFRESH_COOKIE } from '../middleware/auth';
import { ctxOf } from '../services/audit';
import * as auth from '../services/auth';
import { unauthorized } from '../utils/errors';
import { ok } from '../utils/http';

const base: CookieOptions = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: 'strict',
  domain: env.COOKIE_DOMAIN || undefined,
};
const accessOptions: CookieOptions = { ...base, path: '/', maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000 };
/** Scoped to the auth routes, so the long-lived token is not sent with ordinary API calls. */
const refreshOptions: CookieOptions = { ...base, path: '/api/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 };

function setCookies(res: Response, tokens: auth.IssuedTokens) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, accessOptions);
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshOptions);
}

function clearCookies(res: Response) {
  const { maxAge: _a, ...access } = accessOptions;
  const { maxAge: _r, ...refreshCookie } = refreshOptions;
  res.clearCookie(ACCESS_COOKIE, access);
  res.clearCookie(REFRESH_COOKIE, refreshCookie);
}

export const login: RequestHandler = async (req, res) => {
  const { email, password } = req.valid.body;
  const result = await auth.login(ctxOf(req), email, password, req.get('user-agent'));
  setCookies(res, result);
  ok(res, await auth.currentUserProfile(result.user._id));
};

export const refresh: RequestHandler = async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (typeof presented !== 'string' || !presented) throw unauthorized('Session expired', 'INVALID_REFRESH');
  try {
    const tokens = await auth.refresh(ctxOf(req), presented);
    if (tokens) setCookies(res, tokens);
    ok(res, { refreshed: true });
  } catch (err) {
    clearCookies(res);
    throw err;
  }
};

/** Works with an expired access token too, since the point is to end the session regardless. */
export const logout: RequestHandler = async (req: Request, res) => {
  await new Promise<void>((resolve) => {
    Promise.resolve(authenticate(req, res, () => resolve())).catch(() => resolve());
  });
  await auth.logout(ctxOf(req), req.cookies?.[REFRESH_COOKIE]);
  clearCookies(res);
  ok(res, { loggedOut: true });
};

export const forgotPassword: RequestHandler = async (req, res) => {
  await auth.forgotPassword(ctxOf(req), req.valid.body.email);
  ok(res, { message: 'If that email belongs to an account, a reset link has been sent.' });
};

export const resetPassword: RequestHandler = async (req, res) => {
  await auth.resetPassword(ctxOf(req), req.valid.body.token, req.valid.body.password);
  clearCookies(res);
  ok(res, { message: 'Your password has been updated. Please sign in.' });
};

export const changePassword: RequestHandler = async (req, res) => {
  await auth.changePassword(ctxOf(req), req.valid.body.currentPassword, req.valid.body.newPassword);
  ok(res, { message: 'Your password has been changed.' });
};

export const me: RequestHandler = async (req, res) => {
  ok(res, await auth.currentUserProfile(req.auth!.userId));
};
