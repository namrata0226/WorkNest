import { timingSafeEqual } from 'crypto';
import { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { AppError, badRequest, forbidden } from '../utils/errors';

function hasUnsafeKey(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((v) => hasUnsafeKey(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (key.includes('$') || key.includes('.') || key === '__proto__' || key === 'constructor') return true;
      if (hasUnsafeKey(nested, depth + 1)) return true;
    }
  }
  return false;
}

/** Rejects operator injection such as {"email": {"$ne": null}} or ?status[$ne]=x before routing. */
export const rejectNoSqlOperators: RequestHandler = (req, _res, next) => {
  if (hasUnsafeKey(req.body) || hasUnsafeKey(req.query)) {
    throw badRequest('Request contains disallowed keys', 'UNSAFE_INPUT');
  }
  next();
};

/**
 * CSRF defence in depth on top of SameSite=Strict cookies. Browsers cannot attach this
 * header cross-origin without a CORS preflight, and the preflight is blocked by the
 * explicit CORS allowlist.
 */
/** Turns away requests that did not come through the front-end proxy, which adds this header. */
export const requireOriginSecret: RequestHandler = (req, _res, next) => {
  if (!env.ORIGIN_SECRET) return next();
  const given = Buffer.from(req.get('X-Origin-Secret') ?? '');
  const expected = Buffer.from(env.ORIGIN_SECRET);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('Requests must come through the WorkNest website', 'DIRECT_ACCESS');
  next();
};

/** API answers are private, so no proxy or CDN may keep a copy. File routes set their own, still private, rule. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'WorkNest') throw forbidden('Missing request header', 'CSRF_REJECTED');
  next();
};

const limiter = (max: number, message: string, skipSuccessfulRequests = false) =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: max,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', message)),
  });

export interface RateLimits {
  auth: number;
  sensitive: number;
  global: number;
}

export const defaultRateLimits: RateLimits = {
  auth: env.RATE_LIMIT_AUTH_MAX,
  sensitive: env.RATE_LIMIT_SENSITIVE_MAX,
  global: env.RATE_LIMIT_GLOBAL_MAX,
};

export const createLimiters = (limits: RateLimits) => ({
  // Only failures count, so a whole office signing in from one IP address is not locked out.
  login: limiter(limits.auth, 'Too many failed sign-in attempts. Please try again later.', true),
  auth: limiter(limits.auth, 'Too many attempts. Please try again later.'),
  sensitive: limiter(limits.sensitive, 'Too many requests. Please slow down.'),
  global: limiter(limits.global, 'Too many requests. Please slow down.'),
});
