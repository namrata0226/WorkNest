import { v2 as cloudinary } from 'cloudinary';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Types } from 'mongoose';
import { Socket } from 'net';
import path from 'path';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AuthContext, can } from '../middleware/auth';
import { PERMISSIONS } from '../constants';
import { CompOffRequest } from '../models/CompOff';
import { Employee } from '../models/Employee';
import { LeaveRequest } from '../models/LeaveRequest';
import { Announcement, ExpenseClaim } from '../models/People';
import { IStoredFile, StoredFile } from '../models/System';
import { IUser, User } from '../models/User';
import { AppError, conflict, notFound, unprocessable } from '../utils/errors';
import { audit, RequestContext } from './audit';

export const uploadRoot = () => path.resolve(env.UPLOAD_DIR);

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const STORAGE_TIMEOUT_MS = 30_000;

export const cloudinaryConfigured = () => Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

function cloud() {
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
  return cloudinary;
}

// 'authenticated' files can only be read with a URL signed by the API secret. Those URLs stay on the server,
// which checks permissions on every download, because a signed URL would work for anyone who got hold of it.
const cloudOptions = { resource_type: 'raw', type: 'authenticated' } as const;
const cloudId = (storedName: string) => `leave-hub/${storedName}`;

const storageUnavailable = (err: unknown) => {
  // Cloudinary's errors are plain objects, and only the message is safe to log.
  logger.error({ err: (err as { message?: string; error?: { message?: string } }).error?.message ?? (err as Error).message }, 'File storage failed');
  return new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is unavailable. Try again later.');
};

async function writeBytes(storedName: string, buffer: Buffer, mime: string): Promise<IStoredFile['storage']> {
  if (!cloudinaryConfigured()) {
    await fs.mkdir(uploadRoot(), { recursive: true, mode: 0o750 });
    await fs.writeFile(path.join(uploadRoot(), storedName), buffer, { mode: 0o640 });
    return 'LOCAL';
  }
  try {
    await cloud().uploader.upload(`data:${mime};base64,${buffer.toString('base64')}`, { ...cloudOptions, public_id: cloudId(storedName), overwrite: false, timeout: STORAGE_TIMEOUT_MS });
    return 'CLOUDINARY';
  } catch (err) {
    throw storageUnavailable(err);
  }
}

export async function readBytes(file: Pick<IStoredFile, 'storage' | 'storedName'>): Promise<Buffer> {
  if (file.storage !== 'CLOUDINARY') {
    return fs.readFile(path.join(uploadRoot(), path.basename(file.storedName))).catch(() => { throw notFound('File'); });
  }
  try {
    const res = await fetch(cloud().url(cloudId(file.storedName), { ...cloudOptions, sign_url: true }), { signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Cloudinary returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw storageUnavailable(err);
  }
}

/** The record goes first. A leftover stored file is harmless, as nothing can reach it without a record. */
export async function removeStoredFile(file: IStoredFile): Promise<void> {
  await StoredFile.deleteOne({ _id: file._id });
  try {
    if (file.storage === 'CLOUDINARY') await cloud().uploader.destroy(cloudId(file.storedName), { ...cloudOptions, invalidate: true });
    else await fs.rm(path.join(uploadRoot(), path.basename(file.storedName)), { force: true });
  } catch (err) {
    storageUnavailable(err);
  }
}

const ALLOWED = [
  { mime: 'application/pdf', exts: ['.pdf'], signature: Buffer.from('%PDF-') },
  { mime: 'image/png', exts: ['.png'], signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'], signature: Buffer.from([0xff, 0xd8, 0xff]) },
];

/** The file's bytes decide its type. The extension and declared MIME type must simply agree with them. */
export function detectAllowedType(buffer: Buffer, originalName: string, declaredMime: string) {
  const ext = path.extname(originalName).toLowerCase();
  const match = ALLOWED.find((t) => buffer.subarray(0, t.signature.length).equals(t.signature));
  if (!match || !match.exts.includes(ext) || match.mime !== declaredMime) {
    throw unprocessable('Only genuine PDF, PNG or JPEG files can be uploaded', 'INVALID_FILE_TYPE');
  }
  return match;
}

export const safeDisplayName = (name: string) => path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'document';

/** Scans through clamd's INSTREAM protocol. Returns true when clean. */
function clamScan(buffer: Buffer): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let reply = '';
    socket.setTimeout(20_000);
    socket.on('timeout', () => socket.destroy(new Error('clamd timed out')));
    socket.on('error', reject);
    socket.on('data', (d) => (reply += d.toString()));
    socket.on('close', () => resolve(/OK\s*\0?\s*$/.test(reply)));
    socket.connect(env.CLAMAV_PORT, env.CLAMAV_HOST!, () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(buffer.length);
      socket.write(size);
      socket.write(buffer);
      socket.write(Buffer.alloc(4));
    });
  });
}

async function scan(buffer: Buffer): Promise<IStoredFile['scanStatus']> {
  if (!env.CLAMAV_HOST) return 'NOT_SCANNED';
  try {
    if (!(await clamScan(buffer))) throw unprocessable('This file was rejected by the malware scanner', 'MALWARE_DETECTED');
    return 'CLEAN';
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err: (err as Error).message }, 'Malware scan unavailable');
    if (env.CLAMAV_REQUIRED) throw new AppError(503, 'SCAN_UNAVAILABLE', 'File scanning is unavailable. Try again later.');
    return 'NOT_SCANNED';
  }
}

type Upload = { buffer: Buffer; originalname: string; mimetype: string; size: number };

export async function storeUpload(auth: AuthContext, file: Upload, purpose: IStoredFile['purpose'] = 'DOCUMENT') {
  const type = detectAllowedType(file.buffer, file.originalname, file.mimetype);
  const scanStatus = await scan(file.buffer);
  const storedName = `${randomUUID()}${type.exts[0]}`;
  const storage = await writeBytes(storedName, file.buffer, type.mime);
  const doc = await StoredFile.create({
    owner: auth.userId,
    ownerEmployee: auth.employeeId,
    originalName: safeDisplayName(file.originalname),
    storedName,
    storage,
    purpose,
    mimeType: type.mime,
    size: file.size,
    sha256: createHash('sha256').update(file.buffer).digest('hex'),
    scanStatus,
  });
  return { id: doc._id, originalName: doc.originalName, mimeType: doc.mimeType, size: doc.size };
}

/** Only the owner may delete an upload, and only before it is attached: a submitted request keeps its evidence. */
export async function deleteUpload(auth: AuthContext, id: string): Promise<void> {
  const file = await StoredFile.findOne({ _id: id, owner: auth.userId, purpose: { $nin: ['AVATAR', 'PERSONAL'] } }).lean<IStoredFile>();
  if (!file) throw notFound('File');
  const [leave, compOff, expense, announcement] = await Promise.all([LeaveRequest.exists({ document: file._id }), CompOffRequest.exists({ document: file._id }), ExpenseClaim.exists({ receipt: file._id }), Announcement.exists({ document: file._id })]);
  if (leave || compOff || expense || announcement) throw conflict('This document is attached to a submitted request', 'FILE_IN_USE');
  await removeStoredFile(file);
}

async function discardAvatar(fileId: Types.ObjectId | null | undefined): Promise<void> {
  const file = fileId ? await StoredFile.findById(fileId).lean<IStoredFile>() : null;
  if (file) await removeStoredFile(file);
}

export async function setAvatar(ctx: RequestContext, upload: Upload): Promise<void> {
  const auth = ctx.auth!;
  if (!detectAllowedType(upload.buffer, upload.originalname, upload.mimetype).mime.startsWith('image/')) {
    throw unprocessable('A profile photo must be a PNG or JPEG image', 'INVALID_FILE_TYPE');
  }
  if (upload.size > MAX_AVATAR_BYTES) throw unprocessable('A profile photo must be 2 MB or smaller', 'FILE_TOO_LARGE');
  const stored = await storeUpload(auth, upload, 'AVATAR');
  const previous = await User.findByIdAndUpdate(auth.userId, { avatarFile: stored.id }).lean<IUser>();
  if (auth.employeeId) await Employee.updateOne({ _id: auth.employeeId }, { avatarFile: stored.id });
  await discardAvatar(previous?.avatarFile);
  await audit(ctx, { action: 'PROFILE_PHOTO_CHANGED', entityType: 'User', entityId: auth.userId, summary: 'Profile photo changed' });
}

export async function removeAvatar(ctx: RequestContext): Promise<void> {
  const auth = ctx.auth!;
  const previous = await User.findByIdAndUpdate(auth.userId, { avatarFile: null }).lean<IUser>();
  if (auth.employeeId) await Employee.updateOne({ _id: auth.employeeId }, { avatarFile: null });
  if (!previous?.avatarFile) return;
  await discardAvatar(previous.avatarFile);
  await audit(ctx, { action: 'PROFILE_PHOTO_REMOVED', entityType: 'User', entityId: auth.userId, summary: 'Profile photo removed' });
}

export async function ownAvatar(auth: AuthContext): Promise<IStoredFile> {
  const user = await User.findById(auth.userId).lean<IUser>();
  const file = user?.avatarFile ? await StoredFile.findById(user.avatarFile).lean<IStoredFile>() : null;
  if (!file) throw notFound('Profile photo');
  return file;
}

/** Owners, admins handling the linked request, and that employee's manager may read a file. Others see a 404. */
export async function authorizeDownload(auth: AuthContext, id: string): Promise<IStoredFile> {
  const file = await StoredFile.findById(id).lean<IStoredFile>();
  if (!file) throw notFound('File');
  if (String(file.owner) === String(auth.userId)) return file;
  if (file.purpose === 'PERSONAL') {
    if (can(auth, PERMISSIONS.EMPLOYEE_PRIVATE_READ)) return file;
    throw notFound('File');
  }
  // Published company documents are for everyone. Receipts follow the claim.
  if (await Announcement.exists({ document: file._id })) return file;
  const expense = await ExpenseClaim.findOne({ receipt: file._id }).select('employee').lean();
  if (expense) {
    if (can(auth, PERMISSIONS.EXPENSES_MANAGE)) return file;
    if (auth.employeeId && await Employee.exists({ _id: expense.employee, reportingManager: auth.employeeId })) return file;
    throw notFound('File');
  }

  const [leave, compOff] = await Promise.all([
    LeaveRequest.findOne({ document: file._id }).select('employee').lean(),
    CompOffRequest.findOne({ document: file._id }).select('employee').lean(),
  ]);
  if (leave && can(auth, PERMISSIONS.LEAVE_READ_ALL)) return file;
  if (compOff && can(auth, PERMISSIONS.COMPOFF_MANAGE)) return file;
  if (leave && auth.employeeId) {
    const manages = await Employee.exists({ _id: leave.employee, reportingManager: auth.employeeId });
    if (manages) return file;
  }
  throw notFound('File');
}
