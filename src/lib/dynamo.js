import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const isConditionalFailure = (err) => err?.name === 'ConditionalCheckFailedException';

export const getItem = async (table, key) => {
  const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  return Item ?? null;
};

export const putItem = (table, item, options = {}) =>
  ddb.send(new PutCommand({ TableName: table, Item: item, ...options }));

export const updateItem = (table, key, options) =>
  ddb.send(new UpdateCommand({ TableName: table, Key: key, ReturnValues: 'ALL_NEW', ...options }));

export const deleteItem = (table, key, options = {}) =>
  ddb.send(new DeleteCommand({ TableName: table, Key: key, ...options }));

/**
 * Execute une Query en completant la page lorsqu'un FilterExpression retire des elements.
 * `limit` est le nombre maximal d'elements retournes ; `lastKey` sert a construire le nextToken.
 */
export const queryPage = async (params, { limit, startKey, maxPages = 5 }) => {
  const items = [];
  let lastKey = startKey;
  let pages = 0;
  do {
    const result = await ddb.send(
      new QueryCommand({
        ...params,
        Limit: limit - items.length,
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
    pages += 1;
  } while (lastKey && items.length < limit && pages < maxPages);
  return { items, lastKey };
};

/** Requete exhaustive (a reserver aux partitions de taille bornee). */
export const queryAll = async (params) => {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
};

const chunk = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const batchGet = async (table, keys) => {
  const results = [];
  for (const group of chunk(keys, 100)) {
    let request = { [table]: { Keys: group } };
    for (let attempt = 0; attempt < 4 && request; attempt += 1) {
      const result = await ddb.send(new BatchGetCommand({ RequestItems: request }));
      results.push(...(result.Responses?.[table] ?? []));
      const unprocessed = result.UnprocessedKeys;
      request = unprocessed && Object.keys(unprocessed).length > 0 ? unprocessed : null;
      if (request) await sleep(50 * 2 ** attempt);
    }
  }
  return results;
};

/** requests : [{ PutRequest: { Item } } | { DeleteRequest: { Key } }] */
export const batchWrite = async (table, requests) => {
  for (const group of chunk(requests, 25)) {
    let request = { [table]: group };
    for (let attempt = 0; attempt < 4 && request; attempt += 1) {
      const result = await ddb.send(new BatchWriteCommand({ RequestItems: request }));
      const unprocessed = result.UnprocessedItems;
      request = unprocessed && Object.keys(unprocessed).length > 0 ? unprocessed : null;
      if (request) await sleep(50 * 2 ** attempt);
    }
    if (request) throw new Error(`BatchWrite left unprocessed items on ${table}`);
  }
};

/**
 * Construit une UpdateExpression a partir d'un objet. Les valeurs `undefined` sont ignorees,
 * les valeurs `null` suppriment l'attribut. Les alias utilisent le prefixe #u / :u afin de ne
 * pas entrer en collision avec ceux de la ConditionExpression (#c / :c).
 */
export const buildUpdate = (fields) => {
  const names = {};
  const values = {};
  const sets = [];
  const removes = [];
  Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .forEach(([key, value], index) => {
      names[`#u${index}`] = key;
      if (value === null) {
        removes.push(`#u${index}`);
      } else {
        values[`:u${index}`] = value;
        sets.push(`#u${index} = :u${index}`);
      }
    });
  const parts = [];
  if (sets.length > 0) parts.push(`SET ${sets.join(', ')}`);
  if (removes.length > 0) parts.push(`REMOVE ${removes.join(', ')}`);
  return {
    UpdateExpression: parts.join(' '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
  };
};
