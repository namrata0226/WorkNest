import multer from 'multer';
import { env } from '../config/env';

/** Held in memory only until its bytes are verified. Nothing reaches disk before that. */
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 0 },
}).single('file');

export const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
}).single('file');
