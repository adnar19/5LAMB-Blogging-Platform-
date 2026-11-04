import { LIMITS, config } from '../lib/config.js';
import { batchGet, queryPage } from '../lib/dynamo.js';
import { api } from '../lib/handler.js';
import { POST_STATUS, toSummary } from '../lib/posts.js';
import { json } from '../lib/response.js';
import { searchQuery } from '../lib/schemas.js';
import { tokenize } from '../lib/text.js';
import { parseQuery } from '../lib/validation.js';

const MAX_POSTINGS_PER_TERM = 500;
const MAX_CANDIDATES = 100;

const postIdsForTerm = async (term) => {
  const { items } = await queryPage(
    {
      TableName: config.searchTable,
      KeyConditionExpression: 'term = :term',
      ExpressionAttributeValues: { ':term': term },
      ProjectionExpression: 'postId',
    },
    { limit: MAX_POSTINGS_PER_TERM },
  );
  return items.map((item) => item.postId);
};

/**
 * Recherche par mots-cles (tous les termes doivent etre presents) dans l'index inverse.
 * Les identifiants ULID sont ordonnes par date de creation : en cas de nombreux resultats, on
 * garde les plus recents avant de les trier par date de publication.
 */
export const searchPosts = api(async ({ event }) => {
  const { q, limit } = parseQuery(event, searchQuery);
  const terms = tokenize(q, LIMITS.maxSearchTerms);
  if (terms.length === 0) {
    return json(200, { query: q, terms, items: [] });
  }

  const postings = await Promise.all(terms.map(postIdsForTerm));
  const [smallest, ...others] = [...postings].sort((a, b) => a.length - b.length);
  const otherSets = others.map((ids) => new Set(ids));
  const candidates = smallest
    .filter((postId) => otherSets.every((set) => set.has(postId)))
    .sort()
    .reverse()
    .slice(0, MAX_CANDIDATES);

  const posts =
    candidates.length > 0
      ? await batchGet(
          config.postsTable,
          candidates.map((postId) => ({ postId })),
        )
      : [];
  const items = posts
    .filter((post) => post.status === POST_STATUS.PUBLISHED)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, limit)
    .map(toSummary);

  return json(200, { query: q, terms, items }, { 'Cache-Control': 'public, max-age=30' });
});
