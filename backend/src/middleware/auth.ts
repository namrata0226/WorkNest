import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { Permission, permissionsFor, Role } from '../constants';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { forbidden, unauthorized } from '../utils/errors';

export interface AuthContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  email: string;
  role: Role;
  permissions: Permission[];
  employeeId: Types.ObjectId | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      valid: { body: any; query: any; params: any };
    }
  }
}

export const ACCESS_COOKIE = 'lh_access';
export const REFRESH_COOKIE = 'lh_refresh';
export const JWT_ISSUER = 'worknest';

/**
 * Role, permissions and status are re-read from MongoDB on every request, so a
 * deactivation, permission change or logout takes effect immediately rather than when
 * the access token expires.
 */
export const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized();

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: JWT_ISSUER }) as jwt.JwtPayload;
  } catch {
    throw unauthorized('Session expired', 'TOKEN_EXPIRED');
  }

  const [user, session] = await Promise.all([
    User.findById(payload.sub).lean(),
    Session.findById(payload.sid).select('revokedAt expiresAt').lean(),
  ]);
  if (!user || !user.isActive) throw unauthorized('Account is not active');
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Session expired', 'TOKEN_EXPIRED');

  // Until the temporary password is replaced, only the auth routes (including change-password) work.
  if (user.mustChangePassword && !req.originalUrl.startsWith('/api/auth/')) {
    throw forbidden('Change your temporary password to continue', 'PASSWORD_CHANGE_REQUIRED');
  }

  req.auth = {
    userId: user._id,
    sessionId: session._id,
    email: user.email,
    role: user.role,
    permissions: permissionsFor(user.role, user.permissions),
    employeeId: user.employee ?? null,
  };
  next();
};

export const can = (auth: AuthContext, permission: Permission) => auth.permissions.includes(permission);

export const requirePermission = (...required: Permission[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (!required.every((p) => can(req.auth!, p))) throw forbidden();
  next();
};

/** Passes when the caller holds at least one of the listed permissions. */
export const requireAnyPermission = (...required: Permission[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (!required.some((p) => can(req.auth!, p))) throw forbidden();
  next();
};

export const requireEmployeeProfile: RequestHandler = (req, _res, next) => {
  if (!req.auth?.employeeId) throw forbidden('This account has no employee profile', 'NO_EMPLOYEE_PROFILE');
  next();
};

/** Nobody grants themselves leave, Comp-Off or HR changes. Another administrator has to do it, and the audit log shows who. */
export function refuseOwnRecord(auth: AuthContext, employeeId: unknown, message: string): void {
  if (auth.employeeId && String(auth.employeeId) === String(employeeId)) throw forbidden(message, 'OWN_RECORD');
}
