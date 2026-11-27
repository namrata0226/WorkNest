import argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { permissionsFor } from '../constants';
import { JWT_ISSUER } from '../middleware/auth';
import { Employee } from '../models/Employee';
import { ILoginChallenge, LoginChallenge, PasswordResetToken, Session } from '../models/Session';
import { IUser, User } from '../models/User';
import { AppError, unauthorized, unprocessable } from '../utils/errors';
import { audit, RequestContext } from './audit';
import { sendEmail } from './email';
import { hashOtp, maskEmail, newOtp, otpDelivery, otpMatches } from './otp';
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

const INVALID_LOGIN = 'Invalid email or password';
const CHALLENGE_EXPIRED = 'Your sign-in has expired. Enter your email and password again.';

/** How long the person has, after the password, to get and enter a code. */
const CHALLENGE_TTL_MS = 10 * 60_000;
export const OTP_TTL_MINUTES = 5;
export const OTP_RESEND_SECONDS = 30;
const MAX_OTP_SENDS = 5;
export const MAX_OTP_ATTEMPTS = 5;

function lockedError(lockUntil: Date): AppError {
  const seconds = Math.max(1, Math.ceil((lockUntil.getTime() - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, undefined, {
    lockedUntil: lockUntil.toISOString(),
    retryAfterSeconds: seconds,
  });
}

const challengeExpired = () => unauthorized(CHALLENGE_EXPIRED, 'LOGIN_CHALLENGE_EXPIRED');

export interface LoginChallengeResult {
  challengeToken: string;
  expiresAt: string;
  /** Where the code will go: the account's email, partly hidden. */
  destination: string;
}

/**
 * Step one of signing in. A correct password does not sign anyone in: it opens a short-lived
 * challenge that a one-time code, sent to the account's email, must complete.
 */
export async function login(ctx: RequestContext, email: string, password: string, userAgent?: string): Promise<LoginChallengeResult> {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean<IUser>();
  if (!user) {
    await argon2.verify(await getDummyHash(), password);
    throw unauthorized(INVALID_LOGIN, 'INVALID_CREDENTIALS');
  }

  const settings = await getSettings();
  const valid = await argon2.verify(user.passwordHash, password);

  if (!user.isActive) {
    await audit(ctx, { action: 'LOGIN_FAILED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Inactive account' });
    throw unauthorized(INVALID_LOGIN, 'INVALID_CREDENTIALS');
  }
  // While locked, even the right password is refused, and the attempt does not extend the lock.
  if (user.lockUntil && user.lockUntil > new Date()) {
    await audit(ctx, { action: 'LOGIN_FAILED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Account locked' });
    throw lockedError(user.lockUntil);
  }

  if (!valid) {
    const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginAttempts: 1 } }, { returnDocument: 'after' }).lean<IUser>();
    await audit(ctx, { action: 'LOGIN_FAILED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email });
    const failures = updated?.failedLoginAttempts ?? 0;
    if (failures >= settings.security.maxFailedLogins) {
      const lockUntil = new Date(Date.now() + settings.security.lockoutMinutes * 60_000);
      await User.updateOne({ _id: user._id }, { lockUntil, failedLoginAttempts: 0 });
      await LoginChallenge.updateMany({ user: user._id, consumedAt: null }, { consumedAt: new Date() });
      await audit(ctx, { action: 'ACCOUNT_LOCKED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Locked after repeated failed logins' });
      throw lockedError(lockUntil);
    }
    // Same answer as an unknown email, so the response does not reveal which accounts exist.
    throw unauthorized(INVALID_LOGIN, 'INVALID_CREDENTIALS');
  }

  await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, lockUntil: null });
  const challengeToken = newToken();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await LoginChallenge.create({
    user: user._id,
    tokenHash: hashToken(challengeToken),
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
    ip: ctx.ip ?? null,
  });
  await audit(ctx, { action: 'LOGIN_PASSWORD_OK', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Password accepted; waiting for one-time code' });

  return { challengeToken, expiresAt: expiresAt.toISOString(), destination: maskEmail(user.email) };
}

async function openChallenge(challengeToken: string) {
  const challenge = await LoginChallenge.findOne({ tokenHash: hashToken(challengeToken), consumedAt: null, expiresAt: { $gt: new Date() } }).lean<ILoginChallenge>();
  if (!challenge) throw challengeExpired();
  const user = await User.findById(challenge.user).lean<IUser>();
  if (!user?.isActive) throw challengeExpired();
  if (user.lockUntil && user.lockUntil > new Date()) throw lockedError(user.lockUntil);
  return { challenge, user };
}

export interface OtpSent {
  destination: string;
  resendAt: string;
  codeExpiresAt: string;
}

/** Step two: email a code. A new code replaces the last one, and resending waits 30 seconds. */
export async function sendLoginOtp(ctx: RequestContext, challengeToken: string): Promise<OtpSent> {
  const { challenge, user } = await openChallenge(challengeToken);

  const destination = maskEmail(user.email);

  if (challenge.sendCount >= MAX_OTP_SENDS) {
    await LoginChallenge.updateOne({ _id: challenge._id }, { consumedAt: new Date() });
    throw new AppError(429, 'OTP_SEND_LIMIT', 'Too many codes requested. Enter your email and password again.');
  }

  const now = new Date();
  const code = newOtp();
  const codeExpiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000);
  // Claimed atomically, so two quick clicks cannot both send.
  const claimed = await LoginChallenge.findOneAndUpdate(
    {
      _id: challenge._id,
      consumedAt: null,
      sendCount: { $lt: MAX_OTP_SENDS },
      $or: [{ lastSentAt: null }, { lastSentAt: { $lte: new Date(now.getTime() - OTP_RESEND_SECONDS * 1000) } }],
    },
    { $set: { channel: 'EMAIL', codeHash: hashOtp(challenge._id, code), codeExpiresAt, lastSentAt: now }, $inc: { sendCount: 1 } },
    { returnDocument: 'after' },
  ).lean<ILoginChallenge>();
  if (!claimed) {
    const latest = await LoginChallenge.findById(challenge._id).select('lastSentAt').lean<ILoginChallenge>();
    const resendAt = new Date((latest?.lastSentAt ?? now).getTime() + OTP_RESEND_SECONDS * 1000);
    const wait = Math.max(1, Math.ceil((resendAt.getTime() - Date.now()) / 1000));
    throw new AppError(429, 'OTP_RESEND_WAIT', `Wait ${wait} seconds before asking for another code.`, undefined, { resendAt: resendAt.toISOString() });
  }

  if (!(await otpDelivery.deliver(user.email, code, OTP_TTL_MINUTES))) {
    // Nothing reached the person, so they may try again straight away.
    await LoginChallenge.updateOne({ _id: challenge._id }, { codeHash: null, codeExpiresAt: null, lastSentAt: null });
    throw new AppError(503, 'OTP_DELIVERY_FAILED', 'We could not send the email. Please try again in a moment.');
  }
  await audit(ctx, { action: 'LOGIN_OTP_SENT', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Code sent by email' });
  return { destination, resendAt: new Date(now.getTime() + OTP_RESEND_SECONDS * 1000).toISOString(), codeExpiresAt: codeExpiresAt.toISOString() };
}

async function startSession(ctx: RequestContext, user: IUser, userAgent?: string | null): Promise<IssuedTokens> {
  const refreshToken = newToken();
  const session = await Session.create({
    user: user._id,
    currentTokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: userAgent?.slice(0, 300) ?? null,
    ip: ctx.ip ?? null,
  });
  return { accessToken: signAccessToken(user._id, session._id), refreshToken };
}

/** Step three: the right code, in time, completes the sign-in. Five wrong codes end the challenge. */
export async function verifyLoginOtp(ctx: RequestContext, challengeToken: string, code: string, userAgent?: string): Promise<IssuedTokens & { user: IUser }> {
  const now = new Date();
  const tokenHash = hashToken(challengeToken);
  // Counting the attempt before checking it means parallel guesses cannot exceed the limit.
  const challenge = await LoginChallenge.findOneAndUpdate(
    { tokenHash, consumedAt: null, expiresAt: { $gt: now }, codeHash: { $ne: null }, attempts: { $lt: MAX_OTP_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean<ILoginChallenge>();
  if (!challenge) {
    const waiting = await LoginChallenge.exists({ tokenHash, consumedAt: null, expiresAt: { $gt: now }, codeHash: null });
    if (waiting) throw unprocessable('Ask for a code first.', 'OTP_NOT_SENT');
    throw challengeExpired();
  }

  const user = await User.findById(challenge.user).lean<IUser>();
  if (!user?.isActive) throw challengeExpired();
  if (user.lockUntil && user.lockUntil > now) throw lockedError(user.lockUntil);

  if (!otpMatches(challenge._id, code, challenge.codeHash!)) {
    const left = MAX_OTP_ATTEMPTS - challenge.attempts;
    await audit(ctx, { action: 'LOGIN_OTP_FAILED', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email });
    if (left <= 0) {
      await LoginChallenge.updateOne({ _id: challenge._id }, { consumedAt: now });
      throw unauthorized('Too many wrong codes. Enter your email and password again.', 'LOGIN_CHALLENGE_EXPIRED');
    }
    throw new AppError(401, 'INVALID_OTP', `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`, undefined, { attemptsLeft: left });
  }
  if (!challenge.codeExpiresAt || challenge.codeExpiresAt <= now) {
    throw new AppError(401, 'OTP_CODE_EXPIRED', 'This code has expired. Ask for a new one.');
  }

  // A code works once, even if it is submitted twice at the same moment.
  const won = await LoginChallenge.findOneAndUpdate({ _id: challenge._id, consumedAt: null }, { consumedAt: now }).lean();
  if (!won) throw challengeExpired();

  await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: now });
  const tokens = await startSession(ctx, user, userAgent ?? challenge.userAgent);
  await audit(ctx, { action: 'LOGIN_SUCCESS', category: 'SECURITY', entityType: 'User', entityId: user._id, actorEmail: user.email, summary: 'Verified by email code' });
  return { ...tokens, user };
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
