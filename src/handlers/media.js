import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isStaff } from '../lib/auth.js';
import { LIMITS, config } from '../lib/config.js';
import { deleteItem, getItem, putItem, queryPage, updateItem, buildUpdate } from '../lib/dynamo.js';
import { forbidden, notFound } from '../lib/errors.js';
import { AUTHENTICATED, api } from '../lib/handler.js';
import { newId } from '../lib/ids.js';
import { MEDIA_TYPES, mediaKey } from '../lib/media.js';
import { decodeToken, paginated } from '../lib/pagination.js';
import { created, json, noContent, ok, redirect } from '../lib/response.js';
import { mediaGetQuery, mediaIdParams, mediaQuery, uploadUrlBody } from '../lib/schemas.js';
import { s3 } from '../lib/s3.js';
import { nowIso } from '../lib/time.js';
import { parseBody, parseParams, parseQuery } from '../lib/validation.js';

const MEDIA_STATUS = Object.freeze({ PENDING: 'pending', UPLOADED: 'uploaded' });

const toMedia = (item) => ({
  mediaId: item.mediaId,
  ownerId: item.ownerId,
  filename: item.filename,
  contentType: item.contentType,
  size: item.size ?? item.declaredSize,
  status: item.status,
  createdAt: item.createdAt,
});

const isMissingObject = (err) => err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;

/**
 * Demande une URL d'upload : le client envoie ensuite le fichier directement a S3 (POST multipart)
 * avec les champs retournes. La politique signee impose le type et la taille maximale.
 */
export const createUploadUrl = api(
  async ({ event, user }) => {
    const body = parseBody(event, uploadUrlBody);
    const mediaId = newId();
    const key = mediaKey({ ownerId: user.id, mediaId, filename: body.filename });
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: config.mediaBucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, MEDIA_TYPES[body.contentType].maxBytes],
        ['eq', '$Content-Type', body.contentType],
      ],
      Fields: { 'Content-Type': body.contentType },
      Expires: LIMITS.presignedUrlTtlSeconds,
    });
    await putItem(config.mediaTable, {
      mediaId,
      ownerId: user.id,
      s3Key: key,
      filename: body.filename,
      contentType: body.contentType,
      declaredSize: body.size,
      status: MEDIA_STATUS.PENDING,
      createdAt: nowIso(),
    });
    return created({
      mediaId,
      upload: { method: 'POST', url, fields, expiresIn: LIMITS.presignedUrlTtlSeconds },
    });
  },
  { roles: AUTHENTICATED },
);

/**
 * Lecture publique (les medias illustrent des articles publies) : retourne une URL presignee
 * temporaire, ou une redirection 302 avec `?redirect=true` pour l'utiliser dans une balise <img>.
 * Le premier appel verifie la presence de l'objet dans S3 et passe le media a `uploaded`.
 */
export const getMedia = api(async ({ event }) => {
  const { mediaId } = parseParams(event, mediaIdParams);
  const { redirect: wantsRedirect } = parseQuery(event, mediaGetQuery);
  const media = await getItem(config.mediaTable, { mediaId });
  if (!media) throw notFound('Media not found');

  let size = media.size ?? media.declaredSize;
  if (media.status !== MEDIA_STATUS.UPLOADED) {
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: config.mediaBucket, Key: media.s3Key }),
      );
      size = head.ContentLength;
    } catch (err) {
      if (isMissingObject(err)) throw notFound('Media has not been uploaded yet');
      throw err;
    }
    await updateItem(
      config.mediaTable,
      { mediaId },
      buildUpdate({ status: MEDIA_STATUS.UPLOADED, size }),
    );
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.mediaBucket, Key: media.s3Key }),
    { expiresIn: LIMITS.mediaUrlTtlSeconds },
  );

  if (wantsRedirect === 'true') {
    return redirect(url, { 'Cache-Control': 'private, max-age=300' });
  }
  return json(
    200,
    {
      mediaId,
      filename: media.filename,
      contentType: media.contentType,
      size,
      createdAt: media.createdAt,
      url,
      expiresIn: LIMITS.mediaUrlTtlSeconds,
    },
    { 'Cache-Control': 'private, max-age=300' },
  );
});

export const listMedia = api(
  async ({ event, user }) => {
    const { limit, nextToken, ownerId } = parseQuery(event, mediaQuery);
    if (ownerId && ownerId !== user.id && !isStaff(user)) {
      throw forbidden('You can only list your own media');
    }
    const { items, lastKey } = await queryPage(
      {
        TableName: config.mediaTable,
        IndexName: 'owner-index',
        KeyConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': ownerId ?? user.id },
        ScanIndexForward: false,
      },
      { limit, startKey: decodeToken(nextToken) },
    );
    return ok(paginated(items.map(toMedia), lastKey));
  },
  { roles: AUTHENTICATED },
);

export const deleteMedia = api(
  async ({ event, user }) => {
    const { mediaId } = parseParams(event, mediaIdParams);
    const media = await getItem(config.mediaTable, { mediaId });
    if (!media) throw notFound('Media not found');
    if (media.ownerId !== user.id && !isStaff(user)) {
      throw forbidden('You are not allowed to delete this media');
    }
    await s3.send(new DeleteObjectCommand({ Bucket: config.mediaBucket, Key: media.s3Key }));
    await deleteItem(config.mediaTable, { mediaId });
    return noContent();
  },
  { roles: AUTHENTICATED },
);
