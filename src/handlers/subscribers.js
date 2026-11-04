import { SubscribeCommand } from '@aws-sdk/client-sns';
import { config } from '../lib/config.js';
import { badRequest } from '../lib/errors.js';
import { api } from '../lib/handler.js';
import { accepted } from '../lib/response.js';
import { subscribeBody } from '../lib/schemas.js';
import { sns } from '../lib/sns.js';
import { parseBody } from '../lib/validation.js';

/**
 * Abonnement aux nouveaux articles. SNS envoie un email de confirmation (double opt-in) et
 * ajoute un lien de desinscription a chaque notification.
 */
export const subscribe = api(async ({ event }) => {
  const { email } = parseBody(event, subscribeBody);
  try {
    await sns.send(
      new SubscribeCommand({
        TopicArn: config.newPostTopicArn,
        Protocol: 'email',
        Endpoint: email,
        ReturnSubscriptionArn: false,
      }),
    );
  } catch (err) {
    if (err?.name === 'InvalidParameterException' || err?.name === 'InvalidParameter') {
      throw badRequest('Invalid email address');
    }
    throw err;
  }
  return accepted({
    message:
      'A confirmation email has been sent. Click the link in it to confirm your subscription.',
  });
});
