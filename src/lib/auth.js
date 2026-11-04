import { forbidden, unauthorized } from './errors.js';

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  EDITOR: 'editor',
  GUEST_AUTHOR: 'guest_author',
});

export const ALL_ROLES = Object.freeze(Object.values(ROLES));

// Roles autorises a relire, publier et moderer
export const STAFF_ROLES = Object.freeze([ROLES.ADMIN, ROLES.EDITOR]);

/**
 * Le claim `cognito:groups` arrive sous forme de tableau ou, avec les HTTP API,
 * de chaine du type "[admin editor]".
 */
export const parseGroups = (claim) => {
  if (claim === undefined || claim === null || claim === '') return [];
  if (Array.isArray(claim)) return claim.map(String);
  const text = String(claim).trim();
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return inner
    .split(/[\s,]+/)
    .map((group) => group.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
};

/**
 * Utilisateur authentifie a partir des claims valides par l'authorizer JWT d'API Gateway.
 * Un utilisateur authentifie sans groupe reconnu est traite comme auteur invite.
 */
export const getUser = (event) => {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  if (!claims?.sub) return null;
  const groups = parseGroups(claims['cognito:groups']).filter((group) => ALL_ROLES.includes(group));
  return {
    id: claims.sub,
    username: claims['cognito:username'] ?? claims.username ?? claims.sub,
    email: claims.email,
    name: claims.name ?? claims.email ?? 'Auteur',
    groups: groups.length > 0 ? groups : [ROLES.GUEST_AUTHOR],
  };
};

export const hasRole = (user, roles) => Boolean(user) && user.groups.some((g) => roles.includes(g));

export const isStaff = (user) => hasRole(user, STAFF_ROLES);

export const requireRole = (user, roles) => {
  if (!user) throw unauthorized();
  if (!hasRole(user, roles)) throw forbidden();
};
