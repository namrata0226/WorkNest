/** Builds every declared index. Production runs with autoIndex off, so run this on each release. */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import '../src/models';

async function main() {
  await connectDb();
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes();
    console.log(`Indexes synced: ${name}`);
  }
  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
