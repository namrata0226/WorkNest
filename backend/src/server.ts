import { createApp } from './app';
import { connectDb, disconnectDb } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { startJobs } from './jobs';

async function main() {
  await connectDb();
  const server = createApp().listen(env.PORT, () => logger.info(`API listening on port ${env.PORT}`));
  if (env.JOBS_ENABLED) startJobs();

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => void disconnectDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Server failed to start');
  process.exit(1);
});
