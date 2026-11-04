import { badRequest } from './errors.js';

/** nextToken opaque : cle de pagination DynamoDB encodee en base64url. */
export const encodeToken = (key) =>
  key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : null;

export const decodeToken = (token) => {
  if (!token) return undefined;
  try {
    const key = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const valid =
      key !== null &&
      typeof key === 'object' &&
      !Array.isArray(key) &&
      Object.values(key).every((value) => typeof value === 'string' || typeof value === 'number');
    if (!valid) throw new Error('invalid');
    return key;
  } catch {
    throw badRequest('Invalid nextToken');
  }
};

export const paginated = (items, lastKey) => ({
  items,
  nextToken: encodeToken(lastKey),
});
