import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { HttpError } from './errors.js';

export const cognito = new CognitoIdentityProviderClient({});

/** Traduit les erreurs Cognito en erreurs HTTP ; les erreurs inconnues sont renvoyees telles quelles. */
export const mapCognitoError = (err) => {
  if (err instanceof HttpError) return err;
  switch (err?.name) {
    case 'UsernameExistsException':
      return new HttpError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account already exists for this email',
      );
    case 'InvalidPasswordException':
      return new HttpError(400, 'INVALID_PASSWORD', err.message);
    case 'InvalidParameterException':
      return new HttpError(400, 'INVALID_PARAMETER', 'Invalid parameter');
    case 'CodeMismatchException':
      return new HttpError(400, 'INVALID_CODE', 'Invalid confirmation code');
    case 'ExpiredCodeException':
      return new HttpError(400, 'EXPIRED_CODE', 'The confirmation code has expired');
    case 'NotAuthorizedException':
      return new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid credentials or expired token');
    case 'UserNotConfirmedException':
      return new HttpError(403, 'USER_NOT_CONFIRMED', 'The account has not been confirmed yet');
    case 'UserNotFoundException':
      return new HttpError(404, 'USER_NOT_FOUND', 'User not found');
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return new HttpError(429, 'TOO_MANY_REQUESTS', 'Too many requests, retry later');
    default:
      return err;
  }
};
