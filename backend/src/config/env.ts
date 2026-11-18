import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.string().optional(),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  CLAMAV_REQUIRED: bool(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('WorkNest <no-reply@example.com>'),
  EMAIL_REDIRECT_TO: z.union([z.literal(''), z.string().email('EMAIL_REDIRECT_TO must be an email address')]).optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  FIELD_ENCRYPTION_KEY: z.union([z.literal(''), z.string().regex(/^[0-9a-f]{64}$/, 'FIELD_ENCRYPTION_KEY must be 64 hexadecimal characters')]).optional(),
  /** When set, API requests must carry it in X-Origin-Secret, so only the Vercel proxy can reach the API. */
  ORIGIN_SECRET: z.string().optional(),
  MS_TENANT_ID: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_SENSITIVE_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(3000),
  JOBS_ENABLED: bool(true),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${lines}`);
}

const data = parsed.data;
const isProd = data.NODE_ENV === 'production';

if (isProd && /change[-_]?me|dev[-_]only/i.test(data.JWT_ACCESS_SECRET)) {
  throw new Error('JWT_ACCESS_SECRET still holds a placeholder value; set a random secret in production');
}

if (isProd && data.EMAIL_REDIRECT_TO) {
  throw new Error('EMAIL_REDIRECT_TO sends every employee\'s email to one inbox and is for testing only; remove it in production');
}

export const env = {
  ...data,
  isProd,
  isTest: data.NODE_ENV === 'test',
  corsOrigins: data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  cookieSecure: data.COOKIE_SECURE === undefined || data.COOKIE_SECURE === '' ? isProd : data.COOKIE_SECURE === 'true',
};
