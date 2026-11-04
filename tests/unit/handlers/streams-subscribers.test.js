import { PublishCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { BatchWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { subscribe } from '../../../src/handlers/subscribers.js';
import { indexPost, notifyNewPost } from '../../../src/handlers/streams.js';
import { ddb } from '../../../src/lib/dynamo.js';
import { bodyOf, makeEvent, post } from '../helpers.js';

const ddbMock = mockClient(ddb);
const snsMock = mockClient(SNSClient);

const record = ({ eventName = 'MODIFY', oldImage, newImage, sequence = '100' }) => ({
  eventID: `evt-${sequence}`,
  eventName,
  dynamodb: {
    SequenceNumber: sequence,
    OldImage: oldImage ? marshall(oldImage, { removeUndefinedValues: true }) : undefined,
    NewImage: newImage ? marshall(newImage, { removeUndefinedValues: true }) : undefined,
  },
});

const conditionalFailure = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  ddbMock.reset();
  snsMock.reset();
});

describe('indexPost', () => {
  const published = post({
    status: 'published',
    title: 'Serverless Lambda',
    content: 'Guide complet',
    tags: ['aws'],
  });

  const writtenRequests = () =>
    ddbMock
      .commandCalls(BatchWriteCommand)
      .flatMap((call) => call.args[0].input.RequestItems['search-test']);

  it("indexe les termes d'un article qui vient d'etre publie", async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    const result = await indexPost({
      Records: [
        record({
          eventName: 'MODIFY',
          oldImage: { ...published, status: 'draft' },
          newImage: published,
        }),
      ],
    });
    expect(result).toEqual({ batchItemFailures: [] });
    const puts = writtenRequests().map((request) => request.PutRequest?.Item);
    expect(puts).toEqual(
      expect.arrayContaining([
        { term: 'serverless', postId: published.postId },
        { term: 'lambda', postId: published.postId },
        { term: 'aws', postId: published.postId },
        { term: 'guide', postId: published.postId },
      ]),
    );
  });

  it("n'indexe pas un brouillon", async () => {
    const result = await indexPost({
      Records: [record({ eventName: 'INSERT', newImage: post({ status: 'draft' }) })],
    });
    expect(result).toEqual({ batchItemFailures: [] });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('ne reecrit que la difference quand le contenu change', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    await indexPost({
      Records: [
        record({
          oldImage: published,
          newImage: { ...published, title: 'Serverless Fargate' },
        }),
      ],
    });
    const requests = writtenRequests();
    expect(requests.filter((r) => r.PutRequest).map((r) => r.PutRequest.Item.term)).toEqual([
      'fargate',
    ]);
    expect(requests.filter((r) => r.DeleteRequest).map((r) => r.DeleteRequest.Key.term)).toEqual([
      'lambda',
    ]);
  });

  it('desindexe un article supprime ou archive', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    await indexPost({ Records: [record({ eventName: 'REMOVE', oldImage: published })] });
    await indexPost({
      Records: [record({ oldImage: published, newImage: { ...published, status: 'archived' } })],
    });
    const requests = writtenRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.DeleteRequest)).toBe(true);
  });

  it('rapporte le premier enregistrement en echec et arrete le traitement', async () => {
    ddbMock.on(BatchWriteCommand).rejects(new Error('boom'));
    const result = await indexPost({
      Records: [
        record({ eventName: 'INSERT', newImage: published, sequence: '1' }),
        record({ eventName: 'INSERT', newImage: published, sequence: '2' }),
      ],
    });
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
  });
});

describe('notifyNewPost', () => {
  const published = post({
    status: 'published',
    title: 'Été à Paris : guide',
    excerpt: 'Un extrait',
  });
  const notify = (newImage = published, eventName = 'MODIFY') =>
    notifyNewPost({
      Records: [record({ eventName, oldImage: { ...published, status: 'draft' }, newImage })],
    });

  it('prend le verrou puis publie une notification', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    snsMock.on(PublishCommand).resolves({});
    expect(await notify()).toEqual({ batchItemFailures: [] });
    const lock = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(lock.ConditionExpression).toContain('attribute_not_exists(notifiedAt)');
    const message = snsMock.commandCalls(PublishCommand)[0].args[0].input;
    expect(message.TopicArn).toBe('arn:aws:sns:eu-west-1:123456789012:new-post-test');
    expect(message.Subject).toMatch(/^[\x20-\x7E]+$/);
    expect(message.Subject.length).toBeLessThanOrEqual(99);
    expect(message.Message).toContain(`https://blog.example.test/posts/${published.slug}`);
  });

  it('ignore les brouillons, les suppressions et les articles deja notifies', async () => {
    await notify(post({ status: 'draft' }));
    await notify(undefined, 'REMOVE');
    await notify({ ...published, notifiedAt: '2025-01-01T00:00:00.000Z' });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it('ne notifie pas deux fois si le verrou est deja pris', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    expect(await notify()).toEqual({ batchItemFailures: [] });
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it("libere le verrou et signale l'echec si SNS refuse la publication", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    snsMock.on(PublishCommand).rejects(new Error('sns down'));
    const result = await notify();
    expect(result.batchItemFailures).toHaveLength(1);
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.UpdateExpression).toMatch(/^REMOVE /);
  });
});

describe('subscribe (public)', () => {
  it("declenche l'email de confirmation SNS", async () => {
    snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: 'pending confirmation' });
    const res = await subscribe(makeEvent({ body: { email: 'lecteur@example.test' } }));
    expect(res.statusCode).toBe(202);
    expect(bodyOf(res).message).toBeTruthy();
    expect(snsMock.commandCalls(SubscribeCommand)[0].args[0].input).toMatchObject({
      Protocol: 'email',
      Endpoint: 'lecteur@example.test',
    });
  });

  it('400 pour un email invalide', async () => {
    const res = await subscribe(makeEvent({ body: { email: 'pas-un-email' } }));
    expect(res.statusCode).toBe(400);
    expect(snsMock.commandCalls(SubscribeCommand)).toHaveLength(0);
  });

  it("400 si SNS rejette l'adresse", async () => {
    snsMock
      .on(SubscribeCommand)
      .rejects(Object.assign(new Error('bad'), { name: 'InvalidParameterException' }));
    expect(
      (await subscribe(makeEvent({ body: { email: 'lecteur@example.test' } }))).statusCode,
    ).toBe(400);
  });
});
