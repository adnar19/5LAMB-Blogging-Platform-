import { PublishCommand } from '@aws-sdk/client-sns';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { config } from '../lib/config.js';
import { batchWrite, buildUpdate, isConditionalFailure, updateItem } from '../lib/dynamo.js';
import { logger, serializeError } from '../lib/logger.js';
import { POST_STATUS } from '../lib/posts.js';
import { sns } from '../lib/sns.js';
import { postTerms } from '../lib/text.js';
import { nowIso } from '../lib/time.js';

const image = (raw) => (raw ? unmarshall(raw) : null);

/**
 * Traite les enregistrements dans l'ordre ; au premier echec on rapporte son numero de sequence
 * (ReportBatchItemFailures) : Lambda reessaie a partir de cet enregistrement.
 */
const processRecords = async (event, handleRecord) => {
  for (const record of event.Records ?? []) {
    try {
      await handleRecord(record);
    } catch (err) {
      logger.error('Stream record processing failed', {
        eventID: record.eventID,
        error: serializeError(err),
      });
      return { batchItemFailures: [{ itemIdentifier: record.dynamodb.SequenceNumber }] };
    }
  }
  return { batchItemFailures: [] };
};

// --- Indexation pour la recherche ---------------------------------------------

const indexedTerms = (post) =>
  post && post.status === POST_STATUS.PUBLISHED ? postTerms(post) : [];

const indexRecord = async (record) => {
  const before = image(record.dynamodb.OldImage);
  const after = image(record.dynamodb.NewImage);
  const postId = (after ?? before)?.postId;
  if (!postId) return;

  const previousTerms = new Set(indexedTerms(before));
  const currentTerms = new Set(indexedTerms(after));
  const requests = [
    ...[...currentTerms]
      .filter((term) => !previousTerms.has(term))
      .map((term) => ({ PutRequest: { Item: { term, postId } } })),
    ...[...previousTerms]
      .filter((term) => !currentTerms.has(term))
      .map((term) => ({ DeleteRequest: { Key: { term, postId } } })),
  ];
  if (requests.length > 0) {
    await batchWrite(config.searchTable, requests);
  }
};

export const indexPost = (event) => processRecords(event, indexRecord);

// --- Notification des abonnes -------------------------------------------------

// Les sujets SNS n'acceptent que de l'ASCII imprimable, 100 caracteres maximum.
const toSubject = (title) =>
  `Blogify - ${String(title).normalize('NFD').replace(/\p{M}/gu, '')}`
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, 99);

const notifyRecord = async (record) => {
  if (record.eventName === 'REMOVE') return;
  const post = image(record.dynamodb.NewImage);
  if (!post || post.status !== POST_STATUS.PUBLISHED || post.notifiedAt) return;

  // Verrou : une seule notification par article, meme si le stream rejoue l'evenement.
  try {
    await updateItem(
      config.postsTable,
      { postId: post.postId },
      {
        UpdateExpression: 'SET notifiedAt = :now',
        ConditionExpression:
          'attribute_exists(postId) AND attribute_not_exists(notifiedAt) AND #status = :published',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':now': nowIso(), ':published': POST_STATUS.PUBLISHED },
      },
    );
  } catch (err) {
    if (isConditionalFailure(err)) return;
    throw err;
  }

  try {
    await sns.send(
      new PublishCommand({
        TopicArn: config.newPostTopicArn,
        Subject: toSubject(post.title),
        Message: [
          "Un nouvel article vient d'etre publie sur Blogify.",
          '',
          post.title,
          post.excerpt ?? '',
          '',
          `Lire l'article : ${config.siteUrl}/posts/${post.slug}`,
        ].join('\n'),
      }),
    );
  } catch (err) {
    // Libere le verrou pour que la nouvelle tentative puisse notifier.
    await updateItem(config.postsTable, { postId: post.postId }, buildUpdate({ notifiedAt: null }));
    throw err;
  }
  logger.info('Subscribers notified', { postId: post.postId });
};

export const notifyNewPost = (event) => processRecords(event, notifyRecord);
