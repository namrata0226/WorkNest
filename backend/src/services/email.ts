import { Types } from 'mongoose';
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { EmailActionKind } from '../constants';
import { Notification } from '../models/System';
import { createHash, randomBytes } from 'crypto';
import { EmailActionToken } from '../models/People';
import { IUser, User } from '../models/User';

const MAX_ATTEMPTS = 5;
let transport: Transporter | null = null;

function getTransport(): Transporter | null {
  // A username with no password can only ever fail, and would use up every queued email's retries.
  if (!env.SMTP_HOST || (env.SMTP_USER && !env.SMTP_PASS)) return null;
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function createEmailActionToken(user: Types.ObjectId, kind: EmailActionKind, target: Types.ObjectId): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await EmailActionToken.create({ tokenHash: createHash('sha256').update(token).digest('hex'), user, kind, target, expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  return token;
}

export const emailConfigured = () => Boolean(getTransport());

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Names, reasons and comments in a message are typed by people, so everything is escaped. */
export function renderNotificationEmail(n: { title: string; message: string; link?: string | null; actionToken?: string | null }): { text: string; html: string } {
  const url = n.link ? new URL(n.link, env.APP_URL).href : null;
  const action = n.link?.startsWith('/approvals') ? 'Review request' : 'View in WorkNest';
  const actionUrl = (decision: string) => new URL(`/email-action?token=${encodeURIComponent(n.actionToken!)}&decision=${decision}`, env.APP_URL).href;
  const buttonStyle = 'display:inline-block;padding:10px 18px;border-radius:6px;font-weight:600;text-decoration:none;margin-right:8px';
  const decisions = n.actionToken
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(actionUrl('approve'))}" style="${buttonStyle};background:#0f5c55;color:#ffffff">Approve</a><a href="${escapeHtml(actionUrl('reject'))}" style="${buttonStyle};background:#ffffff;color:#0f5c55;border:1px solid #0f5c55">Reject</a></p><p style="margin:8px 0 0;font-size:12px;color:#6b7280">Each opens a page to confirm your decision. These buttons work once, for 7 days. Do not forward this email, as anyone with it can use them.</p>`
    : '';
  const button = url
    ? `<p style="margin:24px 0 8px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f5c55;color:#ffffff;padding:10px 18px;border-radius:6px;font-weight:600;text-decoration:none">${action}</a></p>`
    : '';
  return {
    text: [n.message, n.actionToken ? `Approve: ${actionUrl('approve')}\nReject: ${actionUrl('reject')}\nDo not forward this email, as anyone with it can use these links.` : null, url ? `${action}: ${url}` : null].filter(Boolean).join('\n\n'),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2933;max-width:520px"><h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(n.title)}</h2><p style="margin:0">${escapeHtml(n.message)}</p>${decisions}${button}</div>`,
  };
}

export async function sendEmail(mail: { to: string; subject: string; text: string; html?: string; devLink?: string }): Promise<boolean> {
  const t = getTransport();
  if (!t) {
    // Lets password reset be exercised locally without SMTP. Never logged in production.
    if (!env.isProd && mail.devLink) logger.info({ to: mail.to, link: mail.devLink }, 'Email not configured; development link');
    return false;
  }
  // Test mode: one inbox receives everything, and each email says who it was meant for.
  const note = env.EMAIL_REDIRECT_TO ? `Test mode: this email was meant for ${mail.to}.` : null;
  try {
    await t.sendMail({
      from: env.EMAIL_FROM,
      to: env.EMAIL_REDIRECT_TO || mail.to,
      subject: mail.subject,
      text: note ? `${note}\n\n${mail.text}` : mail.text,
      html: mail.html && note ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280">${escapeHtml(note)}</p>${mail.html}` : mail.html,
    });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Email send failed');
    return false;
  }
}

/** Sends notifications committed with EMAIL pending. Delivery failures never touch the HR action that caused them. */
export async function flushEmailOutbox(limit = 50): Promise<number> {
  if (!getTransport()) return 0;
  const pending = await Notification.find({ emailStatus: 'PENDING' }).sort({ createdAt: 1 }).limit(limit).lean();
  let sent = 0;
  for (const n of pending) {
    const user = await User.findById(n.recipient).select('email').lean<IUser>();
    if (!user) {
      await Notification.updateOne({ _id: n._id }, { emailStatus: 'FAILED' });
      continue;
    }
    // Created here, at sending time, so the usable token is never stored anywhere.
    const actionToken = n.action ? await createEmailActionToken(n.recipient, n.action.kind, n.action.id) : null;
    const delivered = await sendEmail({ to: user.email, subject: n.title, ...renderNotificationEmail({ ...n, actionToken }) });
    const attempts = n.emailAttempts + 1;
    await Notification.updateOne(
      { _id: n._id },
      { emailAttempts: attempts, emailStatus: delivered ? 'SENT' : attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING' },
    );
    if (delivered) sent++;
  }
  return sent;
}
