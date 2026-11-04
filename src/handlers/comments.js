import { STAFF_ROLES } from '../lib/auth.js';
import { config } from '../lib/config.js';
import {
  buildUpdate,
  deleteItem,
  getItem,
  isConditionalFailure,
  putItem,
  queryPage,
  updateItem,
} from '../lib/dynamo.js';
import { notFound } from '../lib/errors.js';
import { api } from '../lib/handler.js';
import { newId } from '../lib/ids.js';
import { decodeToken, paginated } from '../lib/pagination.js';
import { POST_STATUS } from '../lib/posts.js';
import { created, json, noContent, ok } from '../lib/response.js';
import {
  commentParams,
  commentsQuery,
  createCommentBody,
  moderationBody,
  moderationQuery,
  postIdParams,
} from '../lib/schemas.js';
import { nowIso } from '../lib/time.js';
import { parseBody, parseParams, parseQuery } from '../lib/validation.js';

const COMMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

// L'email du lecteur n'est jamais expose publiquement.
const toPublicComment = (comment) => ({
  commentId: comment.commentId,
  postId: comment.postId,
  authorName: comment.authorName,
  content: comment.content,
  createdAt: comment.createdAt,
});

const assertPublishedPost = async (postId) => {
  const post = await getItem(config.postsTable, { postId });
  if (!post || post.status !== POST_STATUS.PUBLISHED) throw notFound('Post not found');
};

export const createComment = api(async ({ event }) => {
  const { postId } = parseParams(event, postIdParams);
  const body = parseBody(event, createCommentBody);
  await assertPublishedPost(postId);
  const comment = {
    postId,
    commentId: newId(),
    authorName: body.authorName,
    authorEmail: body.authorEmail,
    content: body.content,
    status: COMMENT_STATUS.PENDING,
    createdAt: nowIso(),
  };
  await putItem(config.commentsTable, comment);
  return created({
    commentId: comment.commentId,
    status: comment.status,
    message: 'Your comment has been received and is awaiting moderation.',
  });
});

export const listComments = api(async ({ event }) => {
  const { postId } = parseParams(event, postIdParams);
  const { limit, nextToken } = parseQuery(event, commentsQuery);
  await assertPublishedPost(postId);
  const { items, lastKey } = await queryPage(
    {
      TableName: config.commentsTable,
      KeyConditionExpression: 'postId = :postId',
      FilterExpression: '#status = :approved',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':postId': postId, ':approved': COMMENT_STATUS.APPROVED },
    },
    { limit, startKey: decodeToken(nextToken) },
  );
  return json(200, paginated(items.map(toPublicComment), lastKey), {
    'Cache-Control': 'public, max-age=30',
  });
});

export const listModerationComments = api(
  async ({ event }) => {
    const { limit, nextToken, status } = parseQuery(event, moderationQuery);
    const { items, lastKey } = await queryPage(
      {
        TableName: config.commentsTable,
        IndexName: 'status-index',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ScanIndexForward: false,
      },
      { limit, startKey: decodeToken(nextToken) },
    );
    return ok(paginated(items, lastKey));
  },
  { roles: STAFF_ROLES },
);

export const moderateComment = api(
  async ({ event, user }) => {
    const { postId, commentId } = parseParams(event, commentParams);
    const { status } = parseBody(event, moderationBody);
    try {
      const { Attributes } = await updateItem(
        config.commentsTable,
        { postId, commentId },
        {
          ...buildUpdate({ status, moderatedBy: user.id, moderatedAt: nowIso() }),
          ConditionExpression: 'attribute_exists(commentId)',
        },
      );
      return ok(Attributes);
    } catch (err) {
      if (isConditionalFailure(err)) throw notFound('Comment not found');
      throw err;
    }
  },
  { roles: STAFF_ROLES },
);

export const deleteComment = api(
  async ({ event }) => {
    const { postId, commentId } = parseParams(event, commentParams);
    try {
      await deleteItem(
        config.commentsTable,
        { postId, commentId },
        { ConditionExpression: 'attribute_exists(commentId)' },
      );
    } catch (err) {
      if (isConditionalFailure(err)) throw notFound('Comment not found');
      throw err;
    }
    return noContent();
  },
  { roles: STAFF_ROLES },
);
