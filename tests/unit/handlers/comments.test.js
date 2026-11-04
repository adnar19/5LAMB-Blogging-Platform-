import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createComment,
  deleteComment,
  listComments,
  listModerationComments,
  moderateComment,
} from '../../../src/handlers/comments.js';
import { ddb } from '../../../src/lib/dynamo.js';
import { bodyOf, IDS, makeEvent, post, USERS } from '../helpers.js';

const ddbMock = mockClient(ddb);
const postParams = { postId: IDS.post };
const commentParams = { postId: IDS.post, commentId: IDS.comment };
const validComment = {
  authorName: 'Lecteur',
  authorEmail: 'lecteur@example.test',
  content: 'Bravo !',
};

const conditionalFailure = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  ddbMock.reset();
});

describe('createComment (public)', () => {
  it('cree un commentaire en attente de moderation', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    ddbMock.on(PutCommand).resolves({});
    const res = await createComment(makeEvent({ params: postParams, body: validComment }));
    expect(res.statusCode).toBe(201);
    expect(bodyOf(res)).toMatchObject({ status: 'pending' });
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item).toMatchObject({
      postId: IDS.post,
      status: 'pending',
      authorEmail: 'lecteur@example.test',
    });
  });

  it('ne laisse pas le client choisir le statut', async () => {
    const res = await createComment(
      makeEvent({ params: postParams, body: { ...validComment, status: 'approved' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("404 si l'article n'est pas publie ou n'existe pas", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    expect(
      (await createComment(makeEvent({ params: postParams, body: validComment }))).statusCode,
    ).toBe(404);
    ddbMock.on(GetCommand).resolves({});
    expect(
      (await createComment(makeEvent({ params: postParams, body: validComment }))).statusCode,
    ).toBe(404);
  });

  it('400 pour un email invalide ou un contenu vide', async () => {
    for (const body of [
      { ...validComment, authorEmail: 'pas-un-email' },
      { ...validComment, content: '   ' },
    ]) {
      expect((await createComment(makeEvent({ params: postParams, body }))).statusCode).toBe(400);
    }
  });
});

describe('listComments (public)', () => {
  it('ne retourne que les commentaires approuves, sans email', async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'published' }) });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          postId: IDS.post,
          commentId: IDS.comment,
          authorName: 'Lecteur',
          authorEmail: 'lecteur@example.test',
          content: 'Bravo !',
          status: 'approved',
          createdAt: '2025-01-02T00:00:00.000Z',
        },
      ],
    });
    const res = await listComments(makeEvent({ params: postParams }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).items[0]).not.toHaveProperty('authorEmail');
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':approved']).toBe('approved');
  });

  it("404 si l'article n'est pas publie", async () => {
    ddbMock.on(GetCommand).resolves({ Item: post({ status: 'draft' }) });
    expect((await listComments(makeEvent({ params: postParams }))).statusCode).toBe(404);
  });
});

describe('moderation', () => {
  it('listModerationComments : staff uniquement, filtre par statut', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [{ ...commentParams, authorEmail: 'a@example.test' }] });
    expect((await listModerationComments(makeEvent({}))).statusCode).toBe(401);
    expect((await listModerationComments(makeEvent({ user: USERS.author }))).statusCode).toBe(403);
    const res = await listModerationComments(makeEvent({ user: USERS.editor }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).items[0].authorEmail).toBe('a@example.test');
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input).toMatchObject({ IndexName: 'status-index' });
    expect(input.ExpressionAttributeValues[':status']).toBe('pending');
  });

  it('listModerationComments : 400 pour un statut inconnu', async () => {
    const res = await listModerationComments(
      makeEvent({ user: USERS.editor, query: { status: 'x' } }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('moderateComment approuve un commentaire existant', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...commentParams, status: 'approved' } });
    const res = await moderateComment(
      makeEvent({ user: USERS.editor, params: commentParams, body: { status: 'approved' } }),
    );
    expect(res.statusCode).toBe(200);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('attribute_exists(commentId)');
    expect(Object.values(input.ExpressionAttributeValues)).toContain(USERS.editor.id);
  });

  it('moderateComment : 403 pour un auteur, 400 pour un statut invalide, 404 si inexistant', async () => {
    const call = (user, body) => moderateComment(makeEvent({ user, params: commentParams, body }));
    expect((await call(USERS.author, { status: 'approved' })).statusCode).toBe(403);
    expect((await call(USERS.editor, { status: 'pending' })).statusCode).toBe(400);
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    expect((await call(USERS.editor, { status: 'rejected' })).statusCode).toBe(404);
  });

  it('deleteComment : staff uniquement, 404 si inexistant', async () => {
    const call = (user) => deleteComment(makeEvent({ user, params: commentParams }));
    ddbMock.on(DeleteCommand).resolves({});
    expect((await call(USERS.author)).statusCode).toBe(403);
    expect((await call(USERS.admin)).statusCode).toBe(204);
    ddbMock.on(DeleteCommand).rejects(conditionalFailure());
    expect((await call(USERS.admin)).statusCode).toBe(404);
  });
});
