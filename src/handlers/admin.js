import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ALL_ROLES, ROLES } from '../lib/auth.js';
import { cognito, mapCognitoError } from '../lib/cognito.js';
import { config } from '../lib/config.js';
import { forbidden } from '../lib/errors.js';
import { api } from '../lib/handler.js';
import { ok } from '../lib/response.js';
import { roleBody, usernameParams, usersQuery } from '../lib/schemas.js';
import { parseBody, parseParams, parseQuery } from '../lib/validation.js';

// Du plus au moins privilegie
const ROLE_PRIORITY = [ROLES.ADMIN, ROLES.EDITOR, ROLES.GUEST_AUTHOR];

const roleOf = (groups) =>
  ROLE_PRIORITY.find((role) => groups.includes(role)) ?? ROLES.GUEST_AUTHOR;

const attribute = (user, name) => user.Attributes?.find((attr) => attr.Name === name)?.Value;

const listGroups = async (username) => {
  const { Groups } = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: config.userPoolId, Username: username }),
  );
  return (Groups ?? []).map((group) => group.GroupName);
};

// AdminListGroupsForUser est limite en debit : on traite les utilisateurs par lots.
const mapInBatches = async (items, size, fn) => {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
};

export const listUsers = api(
  async ({ event }) => {
    const { limit, nextToken } = parseQuery(event, usersQuery);
    let result;
    try {
      result = await cognito.send(
        new ListUsersCommand({
          UserPoolId: config.userPoolId,
          Limit: limit,
          PaginationToken: nextToken,
        }),
      );
    } catch (err) {
      throw mapCognitoError(err);
    }
    const items = await mapInBatches(result.Users ?? [], 10, async (user) => {
      const groups = await listGroups(user.Username);
      return {
        username: user.Username,
        email: attribute(user, 'email'),
        name: attribute(user, 'name'),
        status: user.UserStatus,
        enabled: user.Enabled,
        role: roleOf(groups),
        createdAt: user.UserCreateDate?.toISOString(),
      };
    });
    return ok({ items, nextToken: result.PaginationToken ?? null });
  },
  { roles: [ROLES.ADMIN] },
);

export const setUserRole = api(
  async ({ event, user }) => {
    const { username } = parseParams(event, usernameParams);
    const { role } = parseBody(event, roleBody);
    if (username === user.id || username === user.username) {
      throw forbidden('You cannot change your own role');
    }
    try {
      const current = await listGroups(username);
      // On ajoute d'abord le nouveau role : l'utilisateur n'est jamais sans role.
      if (!current.includes(role)) {
        await cognito.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: config.userPoolId,
            Username: username,
            GroupName: role,
          }),
        );
      }
      for (const group of current.filter((g) => ALL_ROLES.includes(g) && g !== role)) {
        await cognito.send(
          new AdminRemoveUserFromGroupCommand({
            UserPoolId: config.userPoolId,
            Username: username,
            GroupName: group,
          }),
        );
      }
    } catch (err) {
      throw mapCognitoError(err);
    }
    return ok({
      username,
      role,
      note: 'The new role applies to tokens issued after the change (sign in again or refresh).',
    });
  },
  { roles: [ROLES.ADMIN] },
);
