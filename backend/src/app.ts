import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { randomUUID } from 'crypto';
import express, { Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import path from 'path';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { createLimiters, defaultRateLimits, noStore, RateLimits, rejectNoSqlOperators, requireCsrfHeader, requireOriginSecret } from './middleware/security';
import { buildApiRouter } from './routes';

export function createApp(options: { rateLimits?: Partial<RateLimits> } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(pinoHttp({ logger, genReqId: () => randomUUID(), autoLogging: { ignore: (req) => req.url === '/health' } }));
  // Photos are fetched with the session and shown from a blob: address.
  app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'blob:'] } } }));
  app.use(cors({ origin: env.corsOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Requested-With', 'Idempotency-Key'] }));
  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'unavailable' });
  });

  const limits = createLimiters({ ...defaultRateLimits, ...options.rateLimits });
  app.use('/api', requireOriginSecret, noStore, limits.global, requireCsrfHeader, rejectNoSqlOperators, buildApiRouter(limits));
  app.use('/api', notFoundHandler);

  // Set CLIENT_DIST to serve the built React app from this process in production.
  if (process.env.CLIENT_DIST) {
    const dist = path.resolve(process.env.CLIENT_DIST);
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile('index.html', { root: dist }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
