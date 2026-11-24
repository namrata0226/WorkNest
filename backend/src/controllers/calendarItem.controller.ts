import { RequestHandler } from 'express';
import { ctxOf } from '../services/audit';
import * as items from '../services/calendarItems';
import { diffDays } from '../utils/dates';
import { badRequest } from '../utils/errors';
import { created, ok } from '../utils/http';

export const list: RequestHandler = async (req, res) => {
  const { start, end } = req.valid.query;
  if (end < start || diffDays(end, start) > 62) throw badRequest('Choose a range of at most 62 days', 'RANGE_TOO_LONG');
  ok(res, await items.listItems(req.auth!, start, end));
};
export const create: RequestHandler = async (req, res) => created(res, await items.createItem(ctxOf(req), req.valid.body));
export const update: RequestHandler = async (req, res) => ok(res, await items.updateItem(ctxOf(req), req.valid.params.id, req.valid.body));
export const setDone: RequestHandler = async (req, res) => ok(res, await items.setDone(ctxOf(req), req.valid.params.id, req.valid.body.done));
export const remove: RequestHandler = async (req, res) => {
  await items.deleteItem(ctxOf(req), req.valid.params.id);
  ok(res, { deleted: true });
};
