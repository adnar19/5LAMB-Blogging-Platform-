import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { searchPosts } from '../../../src/handlers/search.js';
import { ddb } from '../../../src/lib/dynamo.js';
import { bodyOf, IDS, makeEvent, post } from '../helpers.js';

const ddbMock = mockClient(ddb);

beforeEach(() => {
  ddbMock.reset();
});

describe('searchPosts (public)', () => {
  it('400 sans terme de recherche', async () => {
    expect((await searchPosts(makeEvent({ query: {} }))).statusCode).toBe(400);
  });

  it('retourne une liste vide si la requete ne contient aucun terme indexable', async () => {
    const res = await searchPosts(makeEvent({ query: { q: 'le de' } }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).items).toEqual([]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('intersecte les resultats de chaque terme et ne garde que les articles publies', async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':term': 'serverless' } })
      .resolves({ Items: [{ postId: IDS.post }, { postId: IDS.post2 }] });
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':term': 'lambda' } })
      .resolves({ Items: [{ postId: IDS.post }, { postId: IDS.post2 }, { postId: IDS.media }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        'posts-test': [
          post({ postId: IDS.post, status: 'published', publishedAt: '2025-01-01T00:00:00.000Z' }),
          post({ postId: IDS.post2, status: 'published', publishedAt: '2025-02-01T00:00:00.000Z' }),
        ],
      },
    });
    const res = await searchPosts(makeEvent({ query: { q: 'Serverless Lambda' } }));
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.terms).toEqual(['serverless', 'lambda']);
    // plus recent en premier, sans contenu
    expect(body.items.map((item) => item.postId)).toEqual([IDS.post2, IDS.post]);
    expect(body.items[0]).not.toHaveProperty('content');
    const keys =
      ddbMock.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems['posts-test'].Keys;
    expect(keys.map((key) => key.postId).sort()).toEqual([IDS.post, IDS.post2].sort());
  });

  it('exclut les articles depublies depuis leur indexation', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ postId: IDS.post }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'posts-test': [post({ status: 'archived' })] },
    });
    const res = await searchPosts(makeEvent({ query: { q: 'serverless' } }));
    expect(bodyOf(res).items).toEqual([]);
  });

  it("ne lit aucun article si l'intersection est vide", async () => {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':term': 'serverless' } })
      .resolves({ Items: [{ postId: IDS.post }] });
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':term': 'lambda' } })
      .resolves({ Items: [{ postId: IDS.post2 }] });
    const res = await searchPosts(makeEvent({ query: { q: 'serverless lambda' } }));
    expect(bodyOf(res).items).toEqual([]);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });
});
