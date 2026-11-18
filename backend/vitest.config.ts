import { defineConfig } from 'vitest/config';
import os from 'os';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://placeholder/test',
      JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      UPLOAD_DIR: path.join(os.tmpdir(), 'leave-hub-test-uploads'),
      RATE_LIMIT_AUTH_MAX: '100000',
      RATE_LIMIT_SENSITIVE_MAX: '100000',
      RATE_LIMIT_GLOBAL_MAX: '100000',
      JOBS_ENABLED: 'false',
      FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
    },
  },
});
