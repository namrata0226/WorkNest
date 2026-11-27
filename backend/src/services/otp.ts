import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { sendEmail } from './email';

export const OTP_LENGTH = 6;

export const newOtp = () => String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

/** Keyed with a server secret and bound to one challenge, so a leaked database row cannot be brute-forced offline or replayed elsewhere. */
export const hashOtp = (challengeId: Types.ObjectId, code: string) =>
  createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${challengeId}:${code}`).digest('hex');

export function otpMatches(challengeId: Types.ObjectId, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashOtp(challengeId, code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const shown = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${shown}${'*'.repeat(Math.max(3, local.length - shown.length))}@${domain}`;
}

/**
 * An object, so tests can stand in for the real delivery and read the code.
 * Outside production, a code that cannot be emailed is written to the server log instead.
 */
export const otpDelivery = {
  async deliver(to: string, code: string, minutes: number): Promise<boolean> {
    const text = `Your WorkNest sign-in code is ${code}. It expires in ${minutes} minutes. Never share it with anyone.`;
    // The code is digits only, so it is safe to place in the HTML as it is.
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;max-width:440px"><h2 style="font-size:18px;margin:0 0 8px">Your sign-in code</h2><p style="margin:0 0 16px;font-size:14px;color:#52606d">Enter this code in WorkNest to finish signing in.</p><div style="font-size:32px;font-weight:700;letter-spacing:10px;background:#eef6f4;color:#0f5c55;border-radius:10px;padding:16px 0;text-align:center">${code}</div><p style="margin:16px 0 0;font-size:12px;color:#6b7280">It expires in ${minutes} minutes and works once. Never share it with anyone. If you did not try to sign in, change your password.</p></div>`;
    const sent = await sendEmail({ to, subject: `${code} is your WorkNest sign-in code`, text: `${text}\n\nIf you did not try to sign in, change your password.`, html });
    if (!sent && !env.isProd) {
      logger.info({ to, code }, 'Sign-in code not emailed; development code');
      return true;
    }
    return sent;
  },
};
