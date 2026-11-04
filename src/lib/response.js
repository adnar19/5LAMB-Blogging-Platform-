import { HttpError } from './errors.js';
import { logger, serializeError } from './logger.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { ...JSON_HEADERS, ...headers },
  body: JSON.stringify(body),
});

export const ok = (body) => json(200, body);
export const created = (body) => json(201, body);
export const accepted = (body) => json(202, body);
export const noContent = () => ({ statusCode: 204, body: '' });

export const redirect = (location, headers = {}) => ({
  statusCode: 302,
  headers: { Location: location, ...headers },
  body: '',
});

export const html = (body, headers = {}) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  body,
});

export const errorResponse = (err, requestId) => {
  if (err instanceof HttpError) {
    const error = { code: err.code, message: err.message, requestId };
    if (err.details !== undefined) error.details = err.details;
    return json(err.statusCode, { error });
  }
  logger.error('Unhandled error', { requestId, error: serializeError(err) });
  return json(500, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
  });
};
