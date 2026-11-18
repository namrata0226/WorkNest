import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password', '*.passwordHash', '*.token'],
    censor: '[redacted]',
  },
  transport: env.isProd || env.isTest ? undefined : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } },
});
