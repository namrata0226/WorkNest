/**
 * Local MongoDB replica set for machines without mongod or Docker. Data persists in
 * backend/.data between runs. This is for development only; see docs/DEPLOYMENT.md.
 */
import { mkdirSync } from 'fs';
import path from 'path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

async function main() {
  const dbPath = path.resolve(__dirname, '../.data');
  mkdirSync(dbPath, { recursive: true });
  const replSet = await MongoMemoryReplSet.create({
    binary: { version: '7.0.14' },
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: 27017, dbPath, storageEngine: 'wiredTiger' }],
  });
  console.log(`MongoDB replica set ready: ${replSet.getUri('leave_hub')}`);
  console.log('Press Ctrl+C to stop. Data is kept in backend/.data');

  const stop = async () => {
    await replSet.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
