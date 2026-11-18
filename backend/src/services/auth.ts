import argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { permissionsFor } from '../constants';
import { JWT_ISSUER } from '../middleware/auth';
import { Employee } from '../models/Employee';
import { PasswordResetToken, Session } from '../models/Session';
import { IUser, User } from '../models/User';
import { AppError, unauthorized, unprocessable } from '../utils/errors';
import { audit, RequestContext } from './audit';
import { sendEmail } from './email';
import { getSettings } from './settings';

const ARGON_OPTIONS = { type: argon2.argon2id as 2, memoryCost: env.isTest ? 2 ** 12 : 2 ** 16, timeCost: env.isTest ? 2 : 3, parallelism: 1 };
const RESET_TTL_MS = 60 * 60 * 1000;
const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000;
/** Parallel tabs legitimately refresh at once, so the just-rotated token is not treated as theft for this long. */
const ROTATION_GRACE_MS = 10_000;
const MAX_USED_TOKENS = 32;

export const hashPassword = (password: string) => argon2.hash(password, ARGON_OPTIONS);
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/** Verified against when the email is unknown, so response timing does not reveal which accounts exist. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

export async function assertPasswordStrength(password: string): Promise<void> {
  const { security } = await getSettings();
  if (password.length < security.minPasswordLength) throw unprocessable(`Password must be at least ${security.minPasswordLength} characters`, 'WEAK_PASSWORD');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw unprocessable('Password must contain letters and numbers', 'WEAK_PASSWORD');
}

export function signAccessToken(userId: Types.ObjectId, sessionId: Types.ObjectId): string {
  return jwt.sign({ sid: String(sessionId) }, env.JWT_ACCESS_SECRET, {
    subject: String(userId),
    issuer: JWT_ISSUER,
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

const INVALID_LOGIN = 'Invalid email or password, or the account is temporarily locked';

export async function login(ctx: RequestContext, email: string, password: string, userAgent?: string): Promise<IssuedTokens & { user: IUser }> {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean<IUser>();
  if (!user) {
    await argon2.verify(await getDummyHash(), password);
    throw unauthorized(INVALID_LOGIN, 'INVALID_CREDENTIALS');
  }

  const settings = await getSettings();
  const valid = await argon2.verify(user.passwordHash, password);
  const locked = user.lockUntil && user.lockUntil > new Date();

  if (locked || !valid || !user.isActive) {
    if (!locked && !valid) {
      const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginAttempts: 1 } }, { returnDocument: 'after' }).lean<IUser>();
      if ((updated?.failedLoginAttempts ?? 0) >= settings.security.maxFailedLogins) {
        await User.updateOne({ _id: user._id }, {
          lockUntil: new Date(Date.now() + settings.security.lockoutMinutes * 60_000),
          failedLoginAttempts: 0,
        });
        await audit(ctx, { action: 'ACCOUNT_LOCKED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Locked after repeated failed logins' });
      }
    }
    await audit(ctx, { action: 'LOGIN_FAILED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email });
    throw unauthorized(INVALID_LOGIN, 'INVALID_CREDENTIALS');
  }

  await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
  const refreshToken = newToken();
  const session = await Session.create({
    user: user._id,
    currentTokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: userAgent?.slice(0, 300) ?? null,
    ip: ctx.ip ?? null,
  });
  await audit(ctx, { action: 'LOGIN_SUCCESS', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email });
  return { accessToken: signAccessToken(user._id, session._id), refreshToken, user };
}

/** Rotates the refresh token. A replay of an already-used token revokes the session. */
export async function refresh(ctx: RequestContext, presented: string): Promise<IssuedTokens | null> {
  const hash = hashToken(presented);
  const next = newToken();
  const rotated = await Session.findOneAndUpdate(
    { currentTokenHash: hash, revokedAt: null, expiresAt: { $gt: new Date() } },
    {
      $set: { currentTokenHash: hashToken(next), previousTokenHash: hash, rotatedAt: new Date() },
      $push: { usedTokenHashes: { $each: [hash], $slice: -MAX_USED_TOKENS } },
    },
    { returnDocument: 'after' },
  ).lean();

  if (rotated) {
    const user = await User.findById(rotated.user).select('isActive').lean<IUser>();
    if (!user?.isActive) {
      await Session.updateOne({ _id: rotated._id }, { revokedAt: new Date(), revokedReason: 'USER_INACTIVE' });
      throw unauthorized('Account is not active');
    }
    return { accessToken: signAccessToken(rotated.user, rotated._id), refreshToken: next };
  }

  const prior = await Session.findOne({ usedTokenHashes: hash }).lean();
  if (!prior) throw unauthorized('Session expired', 'INVALID_REFRESH');
  if (!prior.revokedAt && prior.previousTokenHash === hash && prior.rotatedAt && Date.now() - prior.rotatedAt.getTime() < ROTATION_GRACE_MS) {
    // Another tab won the race. Its response already set the new cookies, so nothing is issued here.
    return null;
  }
  if (!prior.revokedAt) {
    await Session.updateOne({ _id: prior._id }, { revokedAt: new Date(), revokedReason: 'TOKEN_REUSE' });
    await audit(ctx, { action: 'REFRESH_TOKEN_REUSE', category: 'SECURITY', entityType: 'Session', entityId: prior._id, summary: 'Refresh token replayed; session revoked' });
    logger.warn({ session: String(prior._id) }, 'Refresh token reuse detected');
  }
  throw unauthorized('Session expired', 'INVALID_REFRESH');
}

export async function logout(ctx: RequestContext, presentedRefresh?: string): Promise<void> {
  const filter = ctx.auth ? { _id: ctx.auth.sessionId } : presentedRefresh ? { currentTokenHash: hashToken(presentedRefresh) } : null;
  if (filter) await Session.updateOne(filter, { revokedAt: new Date(), revokedReason: 'LOGOUT' });
  if (ctx.auth) await audit(ctx, { action: 'LOGOUT', category: 'SECURITY', entityType: 'User', entityId: ctx.auth.userId });
}

export const revokeAllSessions = (userId: Types.ObjectId, reason: string) =>
  Session.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });

/** A link to set a password. The raw token exists only in this link; MongoDB holds its hash. */
export async function createPasswordLink(userId: Types.ObjectId, purpose: 'RESET' | 'ACTIVATION'): Promise<string> {
  await PasswordResetToken.updateMany({ user: userId, usedAt: null }, { usedAt: new Date() });
  const token = newToken();
  await PasswordResetToken.create({
    user: userId,
    tokenHash: hashToken(token),
    purpose,
    expiresAt: new Date(Date.now() + (purpose === 'ACTIVATION' ? ACTIVATION_TTL_MS : RESET_TTL_MS)),
  });
  return `${env.APP_URL}/reset-password?token=${token}`;
}

/** Answers the same way for known and unknown emails, so accounts cannot be enumerated. */
export async function forgotPassword(ctx: RequestContext, email: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true }).lean<IUser>();
  if (!user) return;
  const link = await createPasswordLink(user._id, 'RESET');
  await sendEmail({
    to: user.email,
    subject: 'Reset your WorkNest password',
    text: `Use this link to reset your password. It works once and expires in one hour:\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
    devLink: link,
  });
  await audit(ctx, { action: 'PASSWORD_RESET_REQUESTED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email });
}

export async function resetPassword(ctx: RequestContext, token: string, password: string): Promise<void> {
  await assertPasswordStrength(password);
  // Claiming the token atomically means it works once even under concurrent submissions.
  const record = await PasswordResetToken.findOneAndUpdate(
    { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
  ).lean();
  if (!record) throw new AppError(400, 'INVALID_RESET_TOKEN', 'This link is invalid or has expired');

  const passwordHash = await hashPassword(password);
  const user = await User.findByIdAndUpdate(record.user, {
    passwordHash, passwordChangedAt: new Date(), mustChangePassword: false, failedLoginAttempts: 0, lockUntil: null,
  }).lean<IUser>();
  await revokeAllSessions(record.user, 'PASSWORD_RESET');
  await audit(ctx, { action: 'PASSWORD_RESET', category: 'SECURITY', entityType: 'User', entityId: record.user, actorEmail: user?.email });
}

export async function changePassword(ctx: RequestContext, current: string, next: string): Promise<void> {
  const userId = ctx.auth!.userId;
  const user = await User.findById(userId).select('+passwordHash').lean<IUser>();
  if (!user || !(await argon2.verify(user.passwordHash, current))) throw unprocessable('The current password is incorrect', 'INVALID_PASSWORD');
  await assertPasswordStrength(next);
  await User.updateOne({ _id: userId }, { passwordHash: await hashPassword(next), passwordChangedAt: new Date(), mustChangePassword: false });
  // Every other device is signed out; this session stays.
  await Session.updateMany({ user: userId, revokedAt: null, _id: { $ne: ctx.auth!.sessionId } }, { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' });
  await audit(ctx, { action: 'PASSWORD_CHANGED', category: 'SECURITY', entityType: 'User', entityId: userId });
}

export async function currentUserProfile(userId: Types.ObjectId) {
  const user = await User.findById(userId).lean<IUser>();
  if (!user) throw unauthorized();
  const employee = user.employee
    ? await Employee.findById(user.employee).populate('department', 'name').populate('location', 'name').populate('reportingManager', 'fullName employeeId').lean()
    : null;
  return {
    id: user._id,
    email: user.email,
    role: user.role,
    permissions: permissionsFor(user.role, user.permissions),
    mustChangePassword: user.mustChangePassword,
    // The file id makes a new photo a new address, so a cached old one is never shown.
    avatarUrl: user.avatarFile ? `/me/avatar?v=${user.avatarFile}` : null,
    isManager: user.employee ? Boolean(await Employee.exists({ reportingManager: user.employee, employmentStatus: { $ne: 'INACTIVE' } })) : false,
    employee,
  };
}
