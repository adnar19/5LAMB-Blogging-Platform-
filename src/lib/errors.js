export class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You are not allowed to perform this action') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') =>
  new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message = 'Conflict', code = 'CONFLICT') =>
  new HttpError(409, code, message);
export const payloadTooLarge = (message = 'Payload too large') =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', message);
export const tooManyRequests = (message = 'Too many requests') =>
  new HttpError(429, 'TOO_MANY_REQUESTS', message);
