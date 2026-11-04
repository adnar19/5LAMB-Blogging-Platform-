import { badRequest, payloadTooLarge } from './errors.js';
import { LIMITS } from './config.js';

const formatIssues = (issues) =>
  issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

export const parseWith = (schema, data) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Validation failed', formatIssues(result.error.issues));
  }
  return result.data;
};

export const parseBody = (event, schema) => {
  let raw = event.body;
  if (raw === undefined || raw === null || raw === '') {
    raw = '{}';
  } else if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.maxBodyBytes) {
    throw payloadTooLarge();
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return parseWith(schema, data);
};

export const parseQuery = (event, schema) => parseWith(schema, event.queryStringParameters ?? {});

export const parseParams = (event, schema) => parseWith(schema, event.pathParameters ?? {});
