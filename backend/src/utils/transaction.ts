import mongoose, { ClientSession } from 'mongoose';

/**
 * Runs `fn` in a MongoDB transaction. The driver retries the whole callback on
 * TransientTransactionError (such as a write conflict from a concurrent approval), so
 * `fn` must derive all of its state inside the callback.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

export const isDuplicateKeyError = (err: unknown): boolean => (err as { code?: number })?.code === 11000;
