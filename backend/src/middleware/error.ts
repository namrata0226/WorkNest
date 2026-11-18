import { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { logger } from '../config/logger';
import { AppError, notFound } from '../utils/errors';
import { isDuplicateKeyError } from '../utils/transaction';

export const notFoundHandler: RequestHandler = () => {
  throw notFound('Route');
};

/** Translates every failure to one response shape; internals only ever reach the logs. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;
  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof multer.MulterError) {
    appError = new AppError(400, 'UPLOAD_ERROR', err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : 'The upload was rejected');
  } else if (err instanceof mongoose.Error.ValidationError) {
    appError = new AppError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields',
      Object.entries(err.errors).map(([path, e]) => ({ path, message: e.kind === 'required' ? `${path} is required` : `${path} is invalid` })));
  } else if (err instanceof mongoose.Error.CastError) {
    appError = new AppError(400, 'VALIDATION_ERROR', 'A value in the request is invalid');
  } else if (isDuplicateKeyError(err)) {
    appError = new AppError(409, 'DUPLICATE', 'A record with these details already exists');
  } else if (err?.type === 'entity.too.large') {
    appError = new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large');
  } else if (err?.type === 'entity.parse.failed') {
    appError = new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON');
  } else {
    logger.error({ err, requestId: req.id, path: req.path, method: req.method }, 'Unhandled error');
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }

  res.status(appError.status).json({
    success: false,
    error: { code: appError.code, message: appError.message, ...(appError.details ? { details: appError.details } : {}) },
    requestId: req.id,
  });
};
