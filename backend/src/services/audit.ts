import { Request } from 'express';
import { ClientSession } from 'mongoose';
import { AuditCategory } from '../constants';
import { AuthContext } from '../middleware/auth';
import { AuditLog } from '../models/System';

export interface RequestContext {
  auth?: AuthContext;
  ip?: string | null;
  requestId?: string | null;
}

export const ctxOf = (req: Request): RequestContext => ({ auth: req.auth, ip: req.ip, requestId: String(req.id ?? '') });

export const SYSTEM_CTX: RequestContext = {};

interface AuditEntry {
  action: string;
  category?: AuditCategory;
  entityType?: string;
  entityId?: unknown;
  summary?: string;
  before?: unknown;
  after?: unknown;
  actorEmail?: string;
}

/** Inside a transaction the audit row commits or aborts with the change it describes. */
export async function audit(ctx: RequestContext, entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLog.create(
    [{
      actor: ctx.auth?.userId ?? null,
      actorEmail: entry.actorEmail ?? ctx.auth?.email ?? null,
      actorRole: ctx.auth?.role ?? null,
      action: entry.action,
      category: entry.category ?? 'HR',
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ? String(entry.entityId) : null,
      summary: entry.summary ?? null,
      before: entry.before,
      after: entry.after,
      ip: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    }],
    { session },
  );
}
