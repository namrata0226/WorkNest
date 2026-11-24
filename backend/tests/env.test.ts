import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async (vars: Record<string, string>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  return (await import('../src/config/env.js')).env;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('app address', () => {
  it('uses the local app when nothing is set', async () => {
    const env = await load({ APP_URL: '', CORS_ORIGINS: '', VERCEL_ENV: '', VERCEL_URL: '', VERCEL_BRANCH_URL: '', VERCEL_PROJECT_PRODUCTION_URL: '' });
    expect(env.APP_URL).toBe('http://localhost:5173');
    expect(env.corsOrigins).toEqual(['http://localhost:5173']);
  });

  it('uses the branch address on a Vercel preview, so links survive new pushes', async () => {
    const env = await load({ APP_URL: '', CORS_ORIGINS: '', VERCEL_ENV: 'preview', VERCEL_URL: 'worknest-abc123.vercel.app', VERCEL_BRANCH_URL: 'worknest-git-branch.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'worknest.vercel.app' });
    expect(env.APP_URL).toBe('https://worknest-git-branch.vercel.app');
    expect(env.corsOrigins).toEqual(expect.arrayContaining(['https://worknest-git-branch.vercel.app', 'https://worknest-abc123.vercel.app']));
  });

  it('uses the production domain in production', async () => {
    const env = await load({ APP_URL: '', CORS_ORIGINS: '', VERCEL_ENV: 'production', VERCEL_URL: 'worknest-abc123.vercel.app', VERCEL_BRANCH_URL: 'worknest-git-main.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'worknest.vercel.app' });
    expect(env.APP_URL).toBe('https://worknest.vercel.app');
  });

  it('lets APP_URL override, for a custom domain', async () => {
    const env = await load({ APP_URL: 'https://hr.example.com/', CORS_ORIGINS: '', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'worknest.vercel.app' });
    expect(env.APP_URL).toBe('https://hr.example.com');
    expect(env.corsOrigins).toContain('https://hr.example.com');
  });
});

describe('Cloudinary settings', () => {
  it('starts even with a display name in place of the cloud name', async () => {
    expect((await load({ CLOUDINARY_CLOUD_NAME: 'LeaveHub' })).CLOUDINARY_CLOUD_NAME).toBe('LeaveHub');
  });

  it('only uses Cloudinary with a real cloud name', async () => {
    const { validCloudName } = await import('../src/services/file.js');
    expect(validCloudName('dq3x9abcd')).toBe(true);
    expect(validCloudName('LeaveHub')).toBe(false);
    expect(validCloudName('')).toBe(false);
  });
});
