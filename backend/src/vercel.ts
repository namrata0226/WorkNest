import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'crypto';
import express, { Request, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { createApp } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { remindMissingPunches, runDailyJobs } from './jobs';
import { errorHandler } from './middleware/error';
import { flushEmailOutbox } from './services/email';
import { syncOutlookCalendars } from './services/outlookCalendar';

/**
 * Entry point on Vercel, where the API runs as a function instead of a long-running server.
 * There is no node-cron here: emails go out straight after the request that caused them,
 * and daily work runs from Vercel Cron Jobs (see vercel.json).
 */

let ready: Promise<void> | null = null;
const ensureDb = (): Promise<void> => {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  ready ??= connectDb()
    .then(() => attachDatabasePool(mongoose.connection.getClient()))
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
};

const quietly = (name: string, fn: () => Promise<unknown>) =>
  fn().then(
    () => undefined,
    (err) => logger.error({ err: (err as Error).message, job: name }, 'Background job failed'),
  );

const deliverQueued = () => Promise.all([quietly('email-outbox', () => flushEmailOutbox()), quietly('outlook-calendar', () => syncOutlookCalendars())]);

/** A change may have queued emails, so they are sent once its response has gone. */
const afterChanges: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    waitUntil(new Promise((resolve) => res.once('close', resolve)).then(deliverQueued));
  }
  next();
};

function fromVercelCron(req: Request): boolean {
  if (!env.CRON_SECRET) return false;
  const given = Buffer.from(req.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Without the secret the request falls through to the API, which answers as for any unknown address. */
const cronJob = (name: string, fn: () => Promise<unknown>): RequestHandler => async (req, res, next) => {
  if (!fromVercelCron(req)) return next();
  await quietly(name, fn);
  await deliverQueued();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
};

const app = express();
app.disable('x-powered-by');
app.use(async (_req, _res, next) => {
  await ensureDb();
  next();
});
app.use(afterChanges);
app.get('/api/cron/daily', cronJob('daily', () => runDailyJobs()));
app.get('/api/cron/punch-reminder', cronJob('punch-reminder', () => remindMissingPunches()));
app.use(createApp());
app.use(errorHandler);

export default app;
