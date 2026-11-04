import { STAFF_ROLES } from '../lib/auth.js';
import { config } from '../lib/config.js';
import {
  batchWrite,
  deleteItem,
  getItem,
  isConditionalFailure,
  putItem,
  queryAll,
  queryPage,
  updateItem,
  buildUpdate,
} from '../lib/dynamo.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { AUTHENTICATED, api } from '../lib/handler.js';
import { isUlid, newId } from '../lib/ids.js';
import { logger, serializeError } from '../lib/logger.js';
import { decodeToken, paginated } from '../lib/pagination.js';
import {
  POST_STATUS,
  assertTransition,
  canDelete,
  canEdit,
  canView,
  excerptFrom,
  isOwner,
  makeSlug,
  normalizeTags,
  toDetail,
  toSummary,
} from '../lib/posts.js';
import { created, json, noContent, ok } from '../lib/response.js';
import {
  createPostBody,
  listPostsQuery,
  myPostsQuery,
  postIdParams,
  postRefParams,
  reviewPostsQuery,
  updatePostBody,
} from '../lib/schemas.js';
import { nowIso } from '../lib/time.js';
import { parseBody, parseParams, parseQuery } from '../lib/validation.js';

const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=30' };

const assertMediaExists = async (mediaId) => {
  if (!mediaId) return;
  const media = await getItem(config.mediaTable, { mediaId });
  if (!media) throw badRequest('Unknown coverMediaId');
};

/** Charge un article visible par l'utilisateur ; sinon 404 (on ne revele pas l'existence d'un brouillon). */
const loadVisiblePost = async (postId, user) => {
  const post = await getItem(config.postsTable, { postId });
  if (!post || !canView(user, post)) throw notFound('Post not found');
  return post;
};

/** Met a jour un article en verifiant que son statut n'a pas change depuis la lecture (verrou optimiste). */
const updateGuarded = async (post, fields) => {
  const update = buildUpdate(fields);
  try {
    const { Attributes } = await updateItem(
      config.postsTable,
      { postId: post.postId },
      {
        ...update,
        ConditionExpression: 'attribute_exists(postId) AND #cstatus = :cstatus',
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames, '#cstatus': 'status' },
        ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ':cstatus': post.status },
      },
    );
    return Attributes;
  } catch (err) {
    if (isConditionalFailure(err)) {
      throw conflict('The post was modified concurrently, reload it and retry');
    }
    throw err;
  }
};

const queryPostIndex = async (
  { indexName, keyCondition, names, values, filters = [] },
  options,
) => {
  const { items, lastKey } = await queryPage(
    {
      TableName: config.postsTable,
      IndexName: indexName,
      KeyConditionExpression: keyCondition,
      FilterExpression: filters.length > 0 ? filters.join(' AND ') : undefined,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
    },
    options,
  );
  return paginated(items.map(toSummary), lastKey);
};

export const createPost = api(
  async ({ event, user }) => {
    const body = parseBody(event, createPostBody);
    await assertMediaExists(body.coverMediaId);
    const postId = newId();
    const now = nowIso();
    const post = {
      postId,
      slug: makeSlug(body.title, postId),
      title: body.title,
      content: body.content,
      excerpt: body.excerpt ?? excerptFrom(body.content),
      tags: normalizeTags(body.tags),
      status: body.status ?? POST_STATUS.DRAFT,
      authorId: user.id,
      authorName: user.name,
      coverMediaId: body.coverMediaId,
      createdAt: now,
      updatedAt: now,
    };
    await putItem(config.postsTable, post, { ConditionExpression: 'attribute_not_exists(postId)' });
    return created(toDetail(post));
  },
  { roles: AUTHENTICATED },
);

export const listPosts = api(async ({ event }) => {
  const { limit, nextToken, tag, authorId } = parseQuery(event, listPostsQuery);
  const filters = [];
  const names = { '#status': 'status' };
  const values = { ':status': POST_STATUS.PUBLISHED };
  if (tag) {
    filters.push('contains(tags, :tag)');
    values[':tag'] = tag;
  }
  if (authorId) {
    filters.push('authorId = :authorId');
    values[':authorId'] = authorId;
  }
  const page = await queryPostIndex(
    {
      indexName: 'status-publishedAt-index',
      keyCondition: '#status = :status',
      names,
      values,
      filters,
    },
    { limit, startKey: decodeToken(nextToken) },
  );
  return json(200, page, PUBLIC_CACHE);
});

export const listMyPosts = api(
  async ({ event, user }) => {
    const { limit, nextToken, status } = parseQuery(event, myPostsQuery);
    const names = {};
    const values = { ':authorId': user.id };
    const filters = [];
    if (status) {
      names['#status'] = 'status';
      values[':status'] = status;
      filters.push('#status = :status');
    }
    const page = await queryPostIndex(
      {
        indexName: 'author-index',
        keyCondition: 'authorId = :authorId',
        names: Object.keys(names).length > 0 ? names : undefined,
        values,
        filters,
      },
      { limit, startKey: decodeToken(nextToken) },
    );
    return ok(page);
  },
  { roles: AUTHENTICATED },
);

export const listReviewPosts = api(
  async ({ event }) => {
    const { limit, nextToken, status } = parseQuery(event, reviewPostsQuery);
    const page = await queryPostIndex(
      {
        indexName: 'status-updatedAt-index',
        keyCondition: '#status = :status',
        names: { '#status': 'status' },
        values: { ':status': status },
      },
      { limit, startKey: decodeToken(nextToken) },
    );
    return ok(page);
  },
  { roles: STAFF_ROLES },
);

const findBySlug = async (slug) => {
  const { items } = await queryPage(
    {
      TableName: config.postsTable,
      IndexName: 'slug-index',
      KeyConditionExpression: 'slug = :slug',
      ExpressionAttributeValues: { ':slug': slug },
    },
    { limit: 1 },
  );
  return items[0] ?? null;
};

/** Lecture publique d'un article par identifiant (ULID) ou par slug. */
export const getPost = api(async ({ event }) => {
  const { postId: ref } = parseParams(event, postRefParams);
  const post = isUlid(ref)
    ? await getItem(config.postsTable, { postId: ref })
    : await findBySlug(ref.toLowerCase());
  if (!post || post.status !== POST_STATUS.PUBLISHED) throw notFound('Post not found');
  return json(200, toDetail(post), PUBLIC_CACHE);
});

/** Lecture d'un article quel que soit son statut : auteur, editeurs et administrateurs. */
export const previewPost = api(
  async ({ event, user }) => {
    const { postId } = parseParams(event, postIdParams);
    return ok(toDetail(await loadVisiblePost(postId, user)));
  },
  { roles: AUTHENTICATED },
);

export const updatePost = api(
  async ({ event, user }) => {
    const { postId } = parseParams(event, postIdParams);
    const body = parseBody(event, updatePostBody);
    const post = await loadVisiblePost(postId, user);
    if (!canEdit(user, post)) throw forbidden('You are not allowed to edit this post');
    if (body.status !== undefined) assertTransition(user, post, body.status);
    if (body.coverMediaId) await assertMediaExists(body.coverMediaId);

    // L'extrait suit le contenu tant qu'il n'a pas ete saisi manuellement.
    let excerpt = body.excerpt;
    if (excerpt === undefined && body.content !== undefined) {
      const wasAutomatic = post.excerpt === excerptFrom(post.content);
      if (wasAutomatic) excerpt = excerptFrom(body.content);
    }

    const updated = await updateGuarded(post, {
      title: body.title,
      content: body.content,
      excerpt,
      tags: body.tags ? normalizeTags(body.tags) : undefined,
      coverMediaId: body.coverMediaId,
      status: body.status,
      updatedAt: nowIso(),
    });
    return ok(toDetail(updated));
  },
  { roles: AUTHENTICATED },
);

export const publishPost = api(
  async ({ event, user }) => {
    const { postId } = parseParams(event, postIdParams);
    const post = await loadVisiblePost(postId, user);
    if (post.status === POST_STATUS.PUBLISHED) return ok(toDetail(post));
    assertTransition(user, post, POST_STATUS.PUBLISHED);

    const now = nowIso();
    const updated = await updateGuarded(post, {
      status: POST_STATUS.PUBLISHED,
      publishedAt: now,
      updatedAt: now,
    });
    return ok(toDetail(updated));
  },
  { roles: STAFF_ROLES },
);

export const deletePost = api(
  async ({ event, user, requestId }) => {
    const { postId } = parseParams(event, postIdParams);
    const post = await loadVisiblePost(postId, user);
    if (!canDelete(user, post)) {
      throw forbidden(
        isOwner(user, post)
          ? 'A published post can only be deleted by an editor or an administrator'
          : 'You are not allowed to delete this post',
      );
    }
    await deleteItem(config.postsTable, { postId });

    // Nettoyage des commentaires : le post est deja supprime, un echec n'annule pas l'operation.
    try {
      const comments = await queryAll({
        TableName: config.commentsTable,
        KeyConditionExpression: 'postId = :postId',
        ExpressionAttributeValues: { ':postId': postId },
        ProjectionExpression: 'postId, commentId',
      });
      await batchWrite(
        config.commentsTable,
        comments.map(({ commentId }) => ({ DeleteRequest: { Key: { postId, commentId } } })),
      );
    } catch (err) {
      logger.warn('Could not delete the comments of a deleted post', {
        requestId,
        postId,
        error: serializeError(err),
      });
    }
    return noContent();
  },
  { roles: AUTHENTICATED },
);
