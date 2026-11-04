import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUploadUrl, deleteMedia, getMedia, listMedia } from '../../../src/handlers/media.js';
import { ddb } from '../../../src/lib/dynamo.js';
import { s3 } from '../../../src/lib/s3.js';
import { bodyOf, IDS, makeEvent, USERS } from '../helpers.js';

const ddbMock = mockClient(ddb);
const s3Mock = mockClient(s3);
const params = { mediaId: IDS.media };

const mediaItem = (overrides = {}) => ({
  mediaId: IDS.media,
  ownerId: USERS.author.id,
  s3Key: `media/${USERS.author.id}/${IDS.media}/photo.png`,
  filename: 'photo.png',
  contentType: 'image/png',
  declaredSize: 2048,
  status: 'pending',
  createdAt: '2025-01-01T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
});

describe('createUploadUrl', () => {
  const request = (user, body) => createUploadUrl(makeEvent({ user, body }));
  const valid = { filename: 'Ma photo été.png', contentType: 'image/png', size: 2048 };

  it('401 sans authentification', async () => {
    expect((await request(undefined, valid)).statusCode).toBe(401);
  });

  it("retourne un formulaire d'upload S3 et enregistre le media en attente", async () => {
    ddbMock.on(PutCommand).resolves({});
    const res = await request(USERS.author, valid);
    expect(res.statusCode).toBe(201);
    const { mediaId, upload } = bodyOf(res);
    expect(upload.url).toContain('media-bucket-test');
    expect(upload.fields.key).toMatch(new RegExp(`^media/${USERS.author.id}/${mediaId}/`));
    expect(upload.fields.key).not.toMatch(/[ é]/);
    expect(upload.fields['Content-Type']).toBe('image/png');
    expect(upload.fields.Policy).toBeTruthy();
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item).toMatchObject({ ownerId: USERS.author.id, status: 'pending' });
  });

  it('400 pour un type ou une taille non autorises', async () => {
    expect(
      (await request(USERS.author, { ...valid, contentType: 'application/x-msdownload' }))
        .statusCode,
    ).toBe(400);
    expect((await request(USERS.author, { ...valid, size: 50 * 1024 * 1024 })).statusCode).toBe(
      400,
    );
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('getMedia (public)', () => {
  it('404 si le media est inconnu', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await getMedia(makeEvent({ params }))).statusCode).toBe(404);
  });

  it("404 tant que le fichier n'a pas ete envoye dans S3", async () => {
    ddbMock.on(GetCommand).resolves({ Item: mediaItem() });
    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
    expect((await getMedia(makeEvent({ params }))).statusCode).toBe(404);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('marque le media comme envoye et retourne une URL presignee', async () => {
    ddbMock.on(GetCommand).resolves({ Item: mediaItem() });
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1999 });
    const res = await getMedia(makeEvent({ params }));
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.url).toContain('X-Amz-Signature');
    expect(body.size).toBe(1999);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(Object.values(input.ExpressionAttributeValues)).toEqual(
      expect.arrayContaining(['uploaded', 1999]),
    );
  });

  it('redirige vers le fichier avec ?redirect=true', async () => {
    ddbMock.on(GetCommand).resolves({ Item: mediaItem({ status: 'uploaded', size: 1999 }) });
    const res = await getMedia(makeEvent({ params, query: { redirect: 'true' } }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain('X-Amz-Signature');
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });
});

describe('listMedia', () => {
  it("liste les medias de l'utilisateur", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [mediaItem()] });
    const res = await listMedia(makeEvent({ user: USERS.author }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).items[0]).not.toHaveProperty('s3Key');
    expect(
      ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues[':ownerId'],
    ).toBe(USERS.author.id);
  });

  it("refuse a un auteur de lister les medias d'un autre, accepte le staff", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const query = { ownerId: USERS.author.id };
    expect((await listMedia(makeEvent({ user: USERS.other, query }))).statusCode).toBe(403);
    expect((await listMedia(makeEvent({ user: USERS.editor, query }))).statusCode).toBe(200);
  });
});

describe('deleteMedia', () => {
  const remove = (user) => deleteMedia(makeEvent({ user, params }));

  it('le proprietaire supprime le fichier et la fiche', async () => {
    ddbMock.on(GetCommand).resolves({ Item: mediaItem() });
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    expect((await remove(USERS.author)).statusCode).toBe(204);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'media-bucket-test',
    });
  });

  it('403 pour un autre auteur, 404 pour un media inconnu', async () => {
    ddbMock.on(GetCommand).resolves({ Item: mediaItem() });
    expect((await remove(USERS.other)).statusCode).toBe(403);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    ddbMock.on(GetCommand).resolves({});
    expect((await remove(USERS.author)).statusCode).toBe(404);
  });

  it('401 sans authentification', async () => {
    expect((await remove(undefined)).statusCode).toBe(401);
  });
});
