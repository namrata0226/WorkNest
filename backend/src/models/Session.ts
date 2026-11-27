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

export type OtpChannel = 'EMAIL';

/**
 * The step between a correct password and a session. The password alone signs nobody in:
 * the person must also prove they hold the email inbox with a one-time code.
 */
export interface ILoginChallenge {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  channel: OtpChannel | null;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  lastSentAt: Date | null;
  sendCount: number;
  attempts: number;
  consumedAt: Date | null;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

const challengeSchema = new Schema<ILoginChallenge>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    channel: { type: String, enum: ['EMAIL'], default: null },
    codeHash: { type: String, default: null },
    codeExpiresAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: null },
    sendCount: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true, collection: 'loginChallenges' },
);
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

export const LoginChallenge = model<ILoginChallenge>('LoginChallenge', challengeSchema);
