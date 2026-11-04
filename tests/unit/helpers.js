// Identifiants ULID valides (26 caracteres Crockford)
export const IDS = {
  post: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  post2: '01JABCDEFGHJKMNPQRSTVWXYZ1',
  comment: '01JBBCDEFGHJKMNPQRSTVWXYZ0',
  media: '01JCBCDEFGHJKMNPQRSTVWXYZ0',
};

export const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', email: 'admin@example.test', groups: ['admin'] },
  editor: {
    id: 'user-editor',
    name: 'Eli Editor',
    email: 'editor@example.test',
    groups: ['editor'],
  },
  author: {
    id: 'user-author',
    name: 'Gaia Guest',
    email: 'author@example.test',
    groups: ['guest_author'],
  },
  other: {
    id: 'user-other',
    name: 'Otto Other',
    email: 'other@example.test',
    groups: ['guest_author'],
  },
};

/** Construit un evenement API Gateway HTTP API (payload v2) tel que recu par les handlers. */
export const makeEvent = ({ user, body, query, params, rawBody } = {}) => ({
  requestContext: {
    requestId: 'req-test',
    authorizer: user
      ? {
          jwt: {
            claims: {
              sub: user.id,
              'cognito:username': user.id,
              email: user.email,
              name: user.name,
              'cognito:groups': `[${user.groups.join(' ')}]`,
            },
          },
        }
      : undefined,
  },
  body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  queryStringParameters: query,
  pathParameters: params,
});

export const bodyOf = (response) => (response.body ? JSON.parse(response.body) : undefined);

export const post = (overrides = {}) => ({
  postId: IDS.post,
  slug: 'mon-article-vwxyz0',
  title: 'Mon article',
  content: 'Contenu de mon article',
  excerpt: 'Contenu de mon article',
  tags: ['serverless'],
  status: 'draft',
  authorId: USERS.author.id,
  authorName: USERS.author.name,
  createdAt: '2025-01-01T10:00:00.000Z',
  updatedAt: '2025-01-01T10:00:00.000Z',
  ...overrides,
});
