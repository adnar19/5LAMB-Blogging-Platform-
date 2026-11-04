import { isStaff } from './auth.js';
import { badRequest, forbidden } from './errors.js';

export const POST_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
});

// Un auteur ne peut modifier ou supprimer son article que tant qu'il n'est pas publie.
const AUTHOR_EDITABLE = [POST_STATUS.DRAFT, POST_STATUS.PENDING_REVIEW];

// Transitions autorisees : 'owner' = auteur de l'article, editeur ou admin ; 'staff' = editeur ou admin.
const TRANSITIONS = {
  [POST_STATUS.DRAFT]: {
    [POST_STATUS.PENDING_REVIEW]: 'owner',
    [POST_STATUS.PUBLISHED]: 'staff',
  },
  [POST_STATUS.PENDING_REVIEW]: {
    [POST_STATUS.DRAFT]: 'owner',
    [POST_STATUS.PUBLISHED]: 'staff',
  },
  [POST_STATUS.PUBLISHED]: {
    [POST_STATUS.ARCHIVED]: 'staff',
    [POST_STATUS.DRAFT]: 'staff',
  },
  [POST_STATUS.ARCHIVED]: {
    [POST_STATUS.DRAFT]: 'staff',
    [POST_STATUS.PUBLISHED]: 'staff',
  },
};

export const isOwner = (user, post) => Boolean(user) && post.authorId === user.id;

export const canView = (user, post) =>
  post.status === POST_STATUS.PUBLISHED || isStaff(user) || isOwner(user, post);

export const canEdit = (user, post) =>
  isStaff(user) || (isOwner(user, post) && AUTHOR_EDITABLE.includes(post.status));

export const canDelete = canEdit;

export const canTransition = (user, post, to) => {
  if (post.status === to) return true;
  const rule = TRANSITIONS[post.status]?.[to];
  if (rule === 'staff') return isStaff(user);
  if (rule === 'owner') return isStaff(user) || isOwner(user, post);
  return false;
};

/** Verifie le droit de passer l'article a `to` ; leve 400 si la transition n'existe pas, 403 sinon. */
export const assertTransition = (user, post, to) => {
  if (post.status === to) return;
  if (!TRANSITIONS[post.status]?.[to]) {
    throw badRequest(`Cannot change status from ${post.status} to ${to}`);
  }
  if (!canTransition(user, post, to)) {
    throw forbidden(`You are not allowed to change status to ${to}`);
  }
};

export const slugify = (title) => {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'post';
};

/** Slug stable et unique : titre + 8 derniers caracteres (aleatoires) de l'identifiant ULID. */
export const makeSlug = (title, postId) => `${slugify(title)}-${postId.slice(-8).toLowerCase()}`;

export const excerptFrom = (content, maxLength = 200) => {
  const text = content
    .replace(/[#*_`>[\]()!~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
};

export const normalizeTags = (tags = []) => [...new Set(tags)];

const SUMMARY_FIELDS = [
  'postId',
  'slug',
  'title',
  'excerpt',
  'tags',
  'status',
  'authorId',
  'authorName',
  'coverMediaId',
  'createdAt',
  'updatedAt',
  'publishedAt',
];

/** Article complet sans les attributs techniques internes. */
export const toDetail = (post) => {
  const { notifiedAt: _notifiedAt, ...detail } = post;
  return detail;
};

/** Representation sans contenu, utilisee dans les listes. */
export const toSummary = (post) =>
  Object.fromEntries(
    SUMMARY_FIELDS.filter((field) => post[field] !== undefined).map((field) => [
      field,
      post[field],
    ]),
  );
