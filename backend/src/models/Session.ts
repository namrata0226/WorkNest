import { model, Schema, Types } from 'mongoose';

/** One login. Refresh tokens rotate within it, and any replayed token revokes the whole session. */
export interface ISession {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  currentTokenHash: string;
  previousTokenHash: string | null;
  usedTokenHashes: string[];
  rotatedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
}

const schema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    currentTokenHash: { type: String, required: true, unique: true },
    previousTokenHash: { type: String, default: null },
    usedTokenHashes: { type: [String], default: [] },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'refreshTokens' },
);
schema.index({ user: 1, revokedAt: 1 });
schema.index({ usedTokenHashes: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const Session = model<ISession>('Session', schema);

export interface IPasswordResetToken {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  purpose: 'RESET' | 'ACTIVATION';
  expiresAt: Date;
  usedAt: Date | null;
}

const resetSchema = new Schema<IPasswordResetToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['RESET', 'ACTIVATION'], default: 'RESET' },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'passwordResetTokens' },
);
resetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const PasswordResetToken = model<IPasswordResetToken>('PasswordResetToken', resetSchema);
