import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env';
import { AppError } from './errors';

const key = () => {
  if (!env.FIELD_ENCRYPTION_KEY) throw new AppError(503, 'ENCRYPTION_NOT_CONFIGURED', 'Bank details cannot be saved until the server has an encryption key.');
  return Buffer.from(env.FIELD_ENCRYPTION_KEY, 'hex');
};

/** AES-256-GCM, stored as iv.tag.ciphertext, so a tampered value fails to decrypt rather than reading as wrong data. */
export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decryptField(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
