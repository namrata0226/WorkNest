import { randomBytes } from 'crypto';
import { RequestHandler } from 'express';
import { ALL_PERMISSIONS, HR_ASSIGNABLE_PERMISSIONS, permissionsFor, ROLES } from '../constants';
import { Employee, IEmployee } from '../models/Employee';
import { CompanySettings, Notification } from '../models/System';
import { IUser, User } from '../models/User';
import { audit, ctxOf } from '../services/audit';
import { createPasswordLink, currentUserProfile, hashPassword, revokeAllSessions } from '../services/auth';
import { emailConfigured, sendEmail } from '../services/email';
import { authorizeDownload, deleteUpload, ownAvatar, readBytes, removeAvatar, setAvatar, storeUpload } from '../services/file';
import { getSettings } from '../services/settings';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { created, escapeRegex, ok, pageMeta, pageOptions } from '../utils/http';

/* Notifications: every query is scoped to the caller, so ids of other users simply find nothing. */
export const listNotifications: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = { recipient: req.auth!.userId };
  if (q.unread === 'true') filter.readAt = null;
  const { skip, limit, sort } = pageOptions(q, ['createdAt'], 'createdAt');
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort(sort).skip(skip).limit(limit).select('-emailStatus -emailAttempts -dedupeKey').lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ recipient: req.auth!.userId, readAt: null }),
  ]);
  ok(res, items, { ...pageMeta(q, total), unread });
};

export const unreadCount: RequestHandler = async (req, res) => {
  ok(res, { unread: await Notification.countDocuments({ recipient: req.auth!.userId, readAt: null }) });
};

export const markRead: RequestHandler = async (req, res) => {
  const doc = await Notification.findOneAndUpdate({ _id: req.valid.params.id, recipient: req.auth!.userId }, { readAt: new Date() }, { returnDocument: 'after' }).lean();
  if (!doc) throw notFound('Notification');
  ok(res, doc);
};

export const markAllRead: RequestHandler = async (req, res) => {
  await Notification.updateMany({ recipient: req.auth!.userId, readAt: null }, { readAt: new Date() });
  ok(res, { updated: true });
};

/* Files */
export const uploadFile: RequestHandler = async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  created(res, await storeUpload(req.auth!, req.file));
};

export const downloadFile: RequestHandler = async (req, res) => {
  const file = await authorizeDownload(req.auth!, req.valid.params.id);
  // Read first, so that a storage failure is not sent with these file headers.
  const bytes = await readBytes(file);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
  res.send(bytes);
};

export const deleteFile: RequestHandler = async (req, res) => {
  await deleteUpload(req.auth!, req.valid.params.id);
  ok(res, { deleted: true });
};

export const getOwnAvatar: RequestHandler = async (req, res) => {
  const file = await ownAvatar(req.auth!);
  const bytes = await readBytes(file);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(bytes);
};

export const uploadOwnAvatar: RequestHandler = async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  await setAvatar(ctxOf(req), req.file);
  ok(res, await currentUserProfile(req.auth!.userId));
};

export const deleteOwnAvatar: RequestHandler = async (req, res) => {
  await removeAvatar(ctxOf(req));
  ok(res, await currentUserProfile(req.auth!.userId));
};

/* Settings */
export const getCompanyInfo: RequestHandler = async (_req, res) => {
  const s = await getSettings();
  ok(res, { companyName: s.companyName, timezone: s.timezone, compOff: s.compOff });
};

export const getAllSettings: RequestHandler = async (_req, res) => ok(res, await getSettings());

function flatten(body: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) set[`${key}.${k}`] = v;
    } else set[key] = value;
  }
  return set;
}

export const updateSettings: RequestHandler = async (req, res) => {
  const before = await getSettings();
  const doc = await CompanySettings.findOneAndUpdate({ key: 'global' }, { $set: flatten(req.valid.body) }, { returnDocument: 'after', runValidators: true }).lean();
  await audit(ctxOf(req), { action: 'SETTINGS_UPDATED', category: 'SYSTEM', entityType: 'CompanySettings', before, after: req.valid.body });
  ok(res, doc);
};

export const updateCompOffRules: RequestHandler = async (req, res) => {
  const before = await getSettings();
  const doc = await CompanySettings.findOneAndUpdate({ key: 'global' }, { $set: flatten({ compOff: req.valid.body }) }, { returnDocument: 'after', runValidators: true }).lean();
  await audit(ctxOf(req), { action: 'COMPOFF_RULES_UPDATED', entityType: 'CompanySettings', before: before.compOff, after: req.valid.body });
  ok(res, doc);
};

/* Administrative accounts */
const toAdminView = async (u: IUser) => {
  const employee = u.employee ? await Employee.findById(u.employee).select('employeeId fullName').lean<IEmployee>() : null;
  return {
    _id: u._id,
    email: u.email,
    role: u.role,
    customPermissions: u.permissions,
    effectivePermissions: permissionsFor(u.role, u.permissions),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    employee: employee ? { _id: employee._id, employeeId: employee.employeeId, fullName: employee.fullName } : null,
  };
};

export const permissionCatalog: RequestHandler = async (_req, res) => {
  ok(res, { all: ALL_PERMISSIONS, assignable: HR_ASSIGNABLE_PERMISSIONS });
};

export const listAdmins: RequestHandler = async (req, res) => {
  const q = req.valid.query;
  const filter: Record<string, unknown> = { role: { $in: [ROLES.HR_ADMIN, ROLES.SUPER_ADMIN] } };
  if (q.search) filter.email = new RegExp(escapeRegex(q.search), 'i');
  const { skip, limit, sort } = pageOptions(q, ['email', 'createdAt'], 'email');
  const [users, total] = await Promise.all([User.find(filter).sort(sort).skip(skip).limit(limit).lean<IUser[]>(), User.countDocuments(filter)]);
  ok(res, await Promise.all(users.map(toAdminView)), pageMeta(q, total));
};

export const createAdmin: RequestHandler = async (req, res) => {
  const { email, employee: employeeRef, role, permissions } = req.valid.body;
  const ctx = ctxOf(req);
  const customPermissions = role === ROLES.HR_ADMIN ? permissions ?? null : null;

  if (employeeRef) {
    const employee = await Employee.findById(employeeRef).lean<IEmployee>();
    if (!employee?.user) throw notFound('Employee account');
    if (String(employee.user) === String(ctx.auth?.userId)) throw forbidden('You cannot change your own role', 'SELF_ROLE_CHANGE');
    const user = await User.findByIdAndUpdate(employee.user, { role, permissions: customPermissions }, { returnDocument: 'after' }).lean<IUser>();
    await audit(ctx, { action: 'ADMIN_PROMOTED', category: 'SECURITY', entityType: 'User', entityId: employee.user, summary: `${user!.email} is now ${role}` });
    return created(res, { admin: await toAdminView(user!), activationLink: null });
  }

  if (await User.exists({ email })) throw conflict('An account with this email already exists', 'DUPLICATE_ACCOUNT');
  const user = await User.create({ email, role, permissions: customPermissions, passwordHash: await hashPassword(randomBytes(32).toString('hex')) });
  const link = await createPasswordLink(user._id, 'ACTIVATION');
  const sent = await sendEmail({ to: email, subject: 'Your WorkNest administrator account', text: `Set your password with this link, which works once and expires in 72 hours:\n\n${link}`, devLink: link });
  await audit(ctx, { action: 'ADMIN_CREATED', category: 'SECURITY', entityType: 'User', entityId: user._id, summary: `${email} as ${role}` });
  created(res, { admin: await toAdminView(user.toObject() as IUser), activationLink: sent || emailConfigured() ? null : link });
};

export const updateAdmin: RequestHandler = async (req, res) => {
  const ctx = ctxOf(req);
  const { id } = req.valid.params;
  const body = req.valid.body;
  if (String(ctx.auth?.userId) === id) throw forbidden('You cannot change your own role, permissions or status', 'SELF_ROLE_CHANGE');

  const target = await User.findById(id).lean<IUser>();
  if (!target) throw notFound('Account');
  if (body.role === ROLES.EMPLOYEE && !target.employee) throw unprocessable('This account has no employee profile, so it cannot become an employee', 'NO_EMPLOYEE_PROFILE');

  const losesSuper = target.role === ROLES.SUPER_ADMIN && ((body.role && body.role !== ROLES.SUPER_ADMIN) || body.isActive === false);
  if (losesSuper) {
    const others = await User.countDocuments({ role: ROLES.SUPER_ADMIN, isActive: true, _id: { $ne: target._id } });
    if (!others) throw unprocessable('At least one active Super Admin must remain', 'LAST_SUPER_ADMIN');
  }

  const nextRole = body.role ?? target.role;
  const set: Record<string, unknown> = { ...body };
  if (nextRole !== ROLES.HR_ADMIN) set.permissions = null;
  const user = await User.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean<IUser>();
  if (body.isActive === false) await revokeAllSessions(target._id, 'DEACTIVATED');
  await audit(ctx, {
    action: 'ADMIN_UPDATED', category: 'SECURITY', entityType: 'User', entityId: id, summary: target.email,
    before: { role: target.role, permissions: target.permissions, isActive: target.isActive }, after: body,
  });
  ok(res, await toAdminView(user!));
};
