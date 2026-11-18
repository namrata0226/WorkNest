import { RequestHandler } from 'express';
import { z, ZodType } from 'zod';
import { badRequest, ErrorDetail } from '../utils/errors';
import { isDateOnly } from '../utils/dates';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');
export const dateOnly = z.string().refine(isDateOnly, 'Must be a valid date in YYYY-MM-DD format');
export const idParams = z.object({ id: objectId });
/** Half and quarter days are exact in floating point, so balances never drift. */
export const quarterStep = (schema: z.ZodNumber) =>
  schema.refine((n) => Number.isInteger(n * 4), 'Must be in steps of 0.25');

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export const validate = (schemas: Schemas): RequestHandler => (req, _res, next) => {
  const details: ErrorDetail[] = [];
  const valid: { body: unknown; query: unknown; params: unknown } = { body: undefined, query: undefined, params: undefined };
  for (const part of ['params', 'query', 'body'] as const) {
    const schema = schemas[part];
    if (!schema) continue;
    const result = schema.safeParse(req[part] ?? {});
    if (result.success) valid[part] = result.data;
    else {
      for (const issue of result.error.issues) {
        details.push({ path: issue.path.join('.') || part, message: issue.message });
      }
    }
  }
  if (details.length) throw badRequest('Please correct the highlighted fields', 'VALIDATION_ERROR', details);
  req.valid = valid as Express.Request['valid'];
  next();
};
