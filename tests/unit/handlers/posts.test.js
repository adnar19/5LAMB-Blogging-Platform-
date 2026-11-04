import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createPost,
  deletePost,
  getPost,
  listMyPosts,
  listPosts,
  listReviewPosts,
  previewPost,
  publishPost,
  updatePost,
} from '../../../src/handlers/posts.js';
import { ddb } from '../../../src/lib/dynamo.js';
import { bodyOf, IDS, makeEvent, post, USERS } from '../helpers.js';

const ddbMock = mockClient(ddb);
const params = { postId: IDS.post };

const conditionalFailure = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  ddbMock.reset();
});

describe('createPost', () => {
  it('401 sans authentification', async () => {
    const res = await createPost(makeEvent({ body: { title: 'T', content: 'C' } }));
    expect(res.statusCode).toBe(401);
  });

  it("cree un brouillon dont l'auteur est l'utilisateur du jeton", async () => {
    ddbMock.on(PutCommand).resolves({});
    const res = await createPost(
      makeEvent({
        user: USERS.author,
        // authorId fourni par le client : refuse (champ inconnu), l'auteur vient toujours du jeton
        body: { title: 'Déployer sur AWS', content: '# Titre\n\nContenu', tags: ['AWS'] },
      }),
    );
    expect(res.statusCode).toBe(201);
    const created = bodyOf(res);
    expect(created).toMatchObject({
      status: 'draft',
      authorId: USERS.author.id,
      authorName: USERS.author.name,
      tags: ['aws'],
    });
    expect(created.slug).toMatch(/^deployer-sur-aws-[a-z0-9]{8}$/);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.TableName).toBe('posts-test');
  });

  it('400 si le client tente de fixer authorId ou le statut publie', async () => {
    for (const extra of [{ authorId: 'autre' }, { status: 'published' }]) {
      const res = await createPost(
        makeEvent({ user: USERS.author, body: { title: 'T', content: 'C', ...extra } }),
      );
      expect(res.statusCode).toBe(400);
    }
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("400 si l'image de couverture est inconnue", async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await createPost(
      makeEvent({
        user: USERS.author,
        body: { title: 'T', content: 'C', coverMediaId: IDS.media },
      }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('listPosts (public)', () => {
  it("interroge l'index des articles publies et pagine", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [post({ status: 'published', publishedAt: '2025-01-02T00:00:00.000Z' })],
      LastEvaluatedKey: { postId: IDS.post, status: 'published', publishedAt: '2025-01-02' },
    });
    const res = await listPosts(makeEvent({ query: { limit: '1', tag: 'serverless' } }));
    expect(res.statusCode).toBe(200);
    const page = bodyOf(res);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('content');
    expect(page.nextToken).toEqual(expect.any(String));
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('status-publishedAt-index');
    expect(input.ExpressionAttributeValues[':status']).toBe('published');
    expect(input.ExpressionAttributeValues[':tag']).toBe('serverless');
    expect(res.headers['Cache-Control']).toContain('max-age');
  });

  it('400 si nextToken est invalide', async () => {
    const res = await listPosts(makeEvent({ query: { nextToken: 'n-importe-quoi' } }));
    expect(res.statusCode).toBe(400);
  });
});

describe('listMyPosts et listReviewPosts', () => {
  it("listMyPosts filtre sur l'auteur du jeton", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [post()] });
    const res = await listMyPosts(makeEvent({ user: USERS.author }));
    expect(res.statusCode).toBe(200);
    expect(
      ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues[':authorId'],
    ).toBe(USERS.author.id);
  });

  it('listReviewPosts est reserve au staff', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect((await listReviewPosts(makeEvent({ user: USERS.author }))).statusCode).toBe(403);
    expect((await listReviewPosts(makeEvent({}))).statusCode).toBe(401);
    expect((await listReviewPosts(makeEvent({ user: USERS.editor }))).statusCode).toBe(200);
  });
});

describe('getPost (public)', () => {
  it('retourne un article publie par identifiant', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published', notifiedAt: 'x' }) });
    const res = await getPost(makeEvent({ params: { postId: IDS.post } }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).not.toHaveProperty('notifiedAt');
  });

  it('retourne un article publie par slug', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [post({ status: 'published' })] });
    const res = await getPost(makeEvent({ params: { postId: 'mon-article-vwxyz0' } }));
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.IndexName).toBe('slug-index');
  });

  it('404 pour un brouillon', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    expect((await getPost(makeEvent({ params }))).statusCode).toBe(404);
  });

  it('404 pour un article inexistant', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await getPost(makeEvent({ params }))).statusCode).toBe(404);
  });
});

describe('previewPost', () => {
  it("l'auteur et le staff voient un brouillon, les autres recoivent 404", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    expect((await previewPost(makeEvent({ user: USERS.author, params }))).statusCode).toBe(200);
    expect((await previewPost(makeEvent({ user: USERS.editor, params }))).statusCode).toBe(200);
    expect((await previewPost(makeEvent({ user: USERS.other, params }))).statusCode).toBe(404);
    expect((await previewPost(makeEvent({ params }))).statusCode).toBe(401);
  });
});

describe('updatePost', () => {
  const update = (user, body) => updatePost(makeEvent({ user, params, body }));

  it("l'auteur modifie son brouillon", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: post({ title: 'Nouveau titre' }) });
    const res = await update(USERS.author, { title: 'Nouveau titre' });
    expect(res.statusCode).toBe(200);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain('attribute_exists(postId)');
    expect(Object.values(input.ExpressionAttributeValues)).toContain('Nouveau titre');
  });

  it("un autre auteur ne peut pas modifier l'article : 404 (brouillon non visible)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    expect((await update(USERS.other, { title: 'X' })).statusCode).toBe(404);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("403 pour l'auteur sur un article publie", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    expect((await update(USERS.author, { title: 'X' })).statusCode).toBe(403);
  });

  it("l'editeur modifie un article publie", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: post({ status: 'published' }) });
    expect((await update(USERS.editor, { title: 'X' })).statusCode).toBe(200);
  });

  it("l'auteur demande une relecture, mais ne peut pas archiver", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: post({ status: 'pending_review' }) });
    expect((await update(USERS.author, { status: 'pending_review' })).statusCode).toBe(200);
    expect((await update(USERS.author, { status: 'archived' })).statusCode).toBe(400);
  });

  it('400 sur un corps vide ou invalide', async () => {
    expect((await update(USERS.author, {})).statusCode).toBe(400);
    expect((await update(USERS.author, { status: 'published' })).statusCode).toBe(400);
  });

  it("409 si l'article a change entre la lecture et l'ecriture", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    expect((await update(USERS.author, { title: 'X' })).statusCode).toBe(409);
  });

  it('401 sans authentification', async () => {
    expect((await update(undefined, { title: 'X' })).statusCode).toBe(401);
  });
});

describe('publishPost', () => {
  const publish = (user) => publishPost(makeEvent({ user, params }));

  it('403 pour un auteur et 401 sans jeton', async () => {
    expect((await publish(USERS.author)).statusCode).toBe(403);
    expect((await publish(undefined)).statusCode).toBe(401);
  });

  it("l'editeur publie un article a relire", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'pending_review' }) });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: post({ status: 'published', publishedAt: '2025-01-02T00:00:00.000Z' }),
    });
    const res = await publish(USERS.editor);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).status).toBe('published');
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':cstatus']).toBe('pending_review');
  });

  it('est idempotent sur un article deja publie', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    expect((await publish(USERS.admin)).statusCode).toBe(200);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("404 si l'article n'existe pas", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await publish(USERS.editor)).statusCode).toBe(404);
  });

  it('409 en cas de modification concurrente', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    expect((await publish(USERS.editor)).statusCode).toBe(409);
  });
});

describe('deletePost', () => {
  const remove = (user) => deletePost(makeEvent({ user, params }));

  it("l'auteur supprime son brouillon et les commentaires associes sont nettoyes", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [{ postId: IDS.post, commentId: IDS.comment }] });
    ddbMock.on(BatchWriteCommand).resolves({});
    const res = await remove(USERS.author);
    expect(res.statusCode).toBe(204);
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ postId: IDS.post });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });

  it("403 pour l'auteur sur un article publie", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    expect((await remove(USERS.author)).statusCode).toBe(403);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("l'admin supprime un article publie", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect((await remove(USERS.admin)).statusCode).toBe(204);
  });

  it('reussit meme si le nettoyage des commentaires echoue', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).rejects(new Error('boom'));
    expect((await remove(USERS.author)).statusCode).toBe(204);
  });

  it('404 pour un article invisible ou inexistant', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    expect((await remove(USERS.other)).statusCode).toBe(404);
  });
});

describe('robustesse', () => {
  it('retourne 500 sans fuite de detail sur une erreur inattendue', async () => {
    ddbMock.on(GetCommand).rejects(new Error('detail interne secret'));
    const res = await previewPost(makeEvent({ user: USERS.author, params }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
  });

  it('400 pour un identifiant mal forme', async () => {
    const res = await previewPost(
      makeEvent({ user: USERS.author, params: { postId: 'pas-un-ulid' } }),
    );
    expect(res.statusCode).toBe(400);
  });
});
