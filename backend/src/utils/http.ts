import { Response } from 'express';
import { z } from 'zod';

export const ok = (res: Response, data: unknown, meta?: Record<string, unknown>, status = 200) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = (res: Response, data: unknown) => ok(res, data, undefined, 201);

export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*$/).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
};

export interface PageParams {
  page: number;
  limit: number;
  sort?: string;
  order: 'asc' | 'desc';
}

/** Only fields on the caller's allowlist can be sorted on. */
export function pageOptions(q: PageParams, allowedSort: string[], fallback: string) {
  const field = q.sort && allowedSort.includes(q.sort) ? q.sort : fallback;
  return {
    skip: (q.page - 1) * q.limit,
    limit: q.limit,
    sort: { [field]: q.order === 'asc' ? 1 : -1, _id: 1 } as Record<string, 1 | -1>,
  };
}

export const pageMeta = (q: PageParams, total: number) => ({
  page: q.page,
  limit: q.limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / q.limit)),
});

/** Which slice of an approval queue to list. Pending is the default so the queue keeps its original meaning. */
export const APPROVAL_VIEWS = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

/** The status filter for a view. `approved` lists the statuses that count as approved for this kind of request. */
export function approvalStatusFilter(view: ApprovalView | undefined, approved: string[] = ['APPROVED']): Record<string, unknown> {
  switch (view ?? 'PENDING') {
    case 'PENDING': return { status: 'PENDING' };
    case 'APPROVED': return { status: { $in: approved } };
    case 'REJECTED': return { status: 'REJECTED' };
    default: return {};
  }
}

/** Pending work oldest first; decided history newest first. */
export const queueSort = (view: ApprovalView | undefined): Record<string, 1 | -1> => ((view ?? 'PENDING') === 'PENDING' ? { createdAt: 1 } : { createdAt: -1 });

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
