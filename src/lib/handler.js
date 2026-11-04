import { ALL_ROLES, getUser, requireRole } from './auth.js';
import { errorResponse } from './response.js';

/** Routes qui exigent un utilisateur authentifie, quel que soit son role. */
export const AUTHENTICATED = ALL_ROLES;

/**
 * Enveloppe un handler HTTP : authentification, controle de role, gestion centralisee des erreurs.
 * Le handler recoit { event, user, params, query, requestId } et retourne une reponse API Gateway.
 */
export const api =
  (fn, { roles } = {}) =>
  async (event) => {
    const requestId = event?.requestContext?.requestId;
    try {
      const user = getUser(event);
      if (roles) requireRole(user, roles);
      return await fn({
        event,
        user,
        params: event.pathParameters ?? {},
        query: event.queryStringParameters ?? {},
        requestId,
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
