import { describe, expect, it } from 'vitest';
import { buildUpdate } from '../../../src/lib/dynamo.js';
import { decodeToken, encodeToken, paginated } from '../../../src/lib/pagination.js';
import {
  createPostBody,
  moderationQuery,
  registerBody,
  searchQuery,
  updatePostBody,
  uploadUrlBody,
} from '../../../src/lib/schemas.js';
import { parseBody, parseQuery } from '../../../src/lib/validation.js';
import { makeEvent } from '../helpers.js';

describe('buildUpdate', () => {
  it('construit SET et REMOVE, ignore undefined', () => {
    const update = buildUpdate({ title: 'Nouveau', coverMediaId: null, tags: undefined });
    expect(update.UpdateExpression).toBe('SET #u0 = :u0 REMOVE #u1');
    expect(update.ExpressionAttributeNames).toEqual({ '#u0': 'title', '#u1': 'coverMediaId' });
    expect(update.ExpressionAttributeValues).toEqual({ ':u0': 'Nouveau' });
  });

  it("n'expose pas de valeurs quand il n'y a que des suppressions", () => {
    expect(buildUpdate({ notifiedAt: null }).ExpressionAttributeValues).toBeUndefined();
  });
});

describe('pagination', () => {
  it('encode et decode un jeton', () => {
    const key = { postId: 'abc', createdAt: '2025-01-01' };
    expect(decodeToken(encodeToken(key))).toEqual(key);
    expect(encodeToken(undefined)).toBeNull();
    expect(decodeToken(undefined)).toBeUndefined();
  });

  it('refuse un jeton invalide (400)', () => {
    expect(() => decodeToken('pas-un-jeton')).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
    const nested = Buffer.from(JSON.stringify({ a: { b: 1 } })).toString('base64url');
    expect(() => decodeToken(nested)).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it('paginated expose nextToken', () => {
    expect(paginated([1], undefined)).toEqual({ items: [1], nextToken: null });
  });
});

describe('schemas', () => {
  it('createPostBody applique les contraintes et refuse les champs inconnus', () => {
    expect(createPostBody.safeParse({ title: 'Titre', content: 'Texte' }).success).toBe(true);
    expect(createPostBody.safeParse({ title: '', content: 'Texte' }).success).toBe(false);
    expect(
      createPostBody.safeParse({ title: 'T', content: 'C', status: 'published' }).success,
    ).toBe(false);
    expect(createPostBody.safeParse({ title: 'T', content: 'C', authorId: 'x' }).success).toBe(
      false,
    );
  });

  it('createPostBody normalise les tags', () => {
    const result = createPostBody.parse({ title: 'T', content: 'C', tags: [' Cloud '] });
    expect(result.tags).toEqual(['cloud']);
  });

  it('updatePostBody exige au moins un champ', () => {
    expect(updatePostBody.safeParse({}).success).toBe(false);
    expect(updatePostBody.safeParse({ coverMediaId: null }).success).toBe(true);
  });

  it('uploadUrlBody limite types et tailles', () => {
    const valid = { filename: 'a.png', contentType: 'image/png', size: 1024 };
    expect(uploadUrlBody.safeParse(valid).success).toBe(true);
    expect(uploadUrlBody.safeParse({ ...valid, contentType: 'application/pdf' }).success).toBe(
      false,
    );
    expect(uploadUrlBody.safeParse({ ...valid, size: 11 * 1024 * 1024 }).success).toBe(false);
    expect(
      uploadUrlBody.safeParse({ ...valid, contentType: 'video/mp4', size: 50 * 1024 * 1024 })
        .success,
    ).toBe(true);
  });

  it('registerBody exige un mot de passe de 10 caracteres minimum', () => {
    const valid = { email: 'a@example.test', password: 'MotDePasse1!', name: 'Ada' };
    expect(registerBody.safeParse(valid).success).toBe(true);
    expect(registerBody.safeParse({ ...valid, password: 'court' }).success).toBe(false);
    expect(registerBody.safeParse({ ...valid, email: 'pas-un-email' }).success).toBe(false);
  });

  it('applique les valeurs par defaut des requetes', () => {
    expect(moderationQuery.parse({})).toMatchObject({ status: 'pending', limit: 20 });
    expect(searchQuery.parse({ q: 'lambda' })).toEqual({ q: 'lambda', limit: 10 });
    expect(searchQuery.safeParse({ limit: '5' }).success).toBe(false);
  });
});

describe('parseBody et parseQuery', () => {
  it('refuse un JSON invalide (400)', () => {
    expect(() => parseBody(makeEvent({ rawBody: '{pas du json' }), createPostBody)).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('detaille les erreurs de validation', () => {
    try {
      parseBody(makeEvent({ body: { title: '' } }), createPostBody);
      expect.unreachable();
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.details.map((d) => d.path)).toEqual(expect.arrayContaining(['title', 'content']));
    }
  });

  it('refuse un corps trop volumineux (413)', () => {
    const rawBody = JSON.stringify({ title: 'T', content: 'x'.repeat(1_100_000) });
    expect(() => parseBody(makeEvent({ rawBody }), createPostBody)).toThrowError(
      expect.objectContaining({ statusCode: 413 }),
    );
  });

  it('decode un corps base64', () => {
    const body = Buffer.from(JSON.stringify({ title: 'T', content: 'C' })).toString('base64');
    const event = { ...makeEvent({ rawBody: body }), isBase64Encoded: true };
    expect(parseBody(event, createPostBody)).toMatchObject({ title: 'T' });
  });

  it('convertit les parametres de requete', () => {
    expect(parseQuery(makeEvent({ query: { q: 'abc', limit: '3' } }), searchQuery)).toEqual({
      q: 'abc',
      limit: 3,
    });
  });
});
