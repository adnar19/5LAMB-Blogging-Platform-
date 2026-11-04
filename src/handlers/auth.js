import {
  AdminAddUserToGroupCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ROLES } from '../lib/auth.js';
import { cognito, mapCognitoError } from '../lib/cognito.js';
import { config } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import { api } from '../lib/handler.js';
import { logger, serializeError } from '../lib/logger.js';
import { created, ok } from '../lib/response.js';
import { confirmBody, loginBody, refreshBody, registerBody } from '../lib/schemas.js';
import { parseBody } from '../lib/validation.js';

const tokensResponse = (result, { withRefresh }) => ({
  tokenType: 'Bearer',
  // L'ID token porte l'email, le nom et les groupes : c'est lui qui s'envoie dans Authorization.
  idToken: result.IdToken,
  accessToken: result.AccessToken,
  ...(withRefresh ? { refreshToken: result.RefreshToken } : {}),
  expiresIn: result.ExpiresIn,
});

export const register = api(async ({ event, requestId }) => {
  const { email, password, name } = parseBody(event, registerBody);

  let signUp;
  try {
    signUp = await cognito.send(
      new SignUpCommand({
        ClientId: config.userPoolClientId,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: name },
        ],
      }),
    );
  } catch (err) {
    throw mapCognitoError(err);
  }

  // Tout nouveau compte est auteur invite. Sans groupe, getUser applique le meme role par defaut.
  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: config.userPoolId,
        Username: signUp.UserSub,
        GroupName: ROLES.GUEST_AUTHOR,
      }),
    );
  } catch (err) {
    logger.warn('Could not add the new user to the default group', {
      requestId,
      error: serializeError(err),
    });
  }

  return created({
    userId: signUp.UserSub,
    confirmationRequired: !signUp.UserConfirmed,
    message: 'Account created. A verification code has been sent by email.',
  });
});

export const confirm = api(async ({ event }) => {
  const { email, code } = parseBody(event, confirmBody);
  try {
    await cognito.send(
      new ConfirmSignUpCommand({
        ClientId: config.userPoolClientId,
        Username: email,
        ConfirmationCode: code,
      }),
    );
  } catch (err) {
    throw mapCognitoError(err);
  }
  return ok({ message: 'Account confirmed. You can now sign in.' });
});

export const login = api(async ({ event }) => {
  const { email, password } = parseBody(event, loginBody);
  let result;
  try {
    result = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: config.userPoolClientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
  } catch (err) {
    throw mapCognitoError(err);
  }
  if (!result.AuthenticationResult) {
    throw new HttpError(401, 'CHALLENGE_NOT_SUPPORTED', 'This sign-in challenge is not supported');
  }
  return ok(tokensResponse(result.AuthenticationResult, { withRefresh: true }));
});

export const refresh = api(async ({ event }) => {
  const { refreshToken } = parseBody(event, refreshBody);
  let result;
  try {
    result = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: config.userPoolClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
  } catch (err) {
    throw mapCognitoError(err);
  }
  if (!result.AuthenticationResult) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid credentials or expired token');
  }
  return ok(tokensResponse(result.AuthenticationResult, { withRefresh: false }));
});
