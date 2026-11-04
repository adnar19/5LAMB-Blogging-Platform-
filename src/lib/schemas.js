import { z } from 'zod';
import { ALL_ROLES } from './auth.js';
import { MEDIA_TYPES } from './media.js';
import { ULID_REGEX } from './ids.js';

export const POST_STATUSES = ['draft', 'pending_review', 'published', 'archived'];

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const ulid = z.string().regex(ULID_REGEX, 'Invalid identifier');

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(30)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u, 'Invalid tag');

const limit = (max, defaultValue) => z.coerce.number().int().min(1).max(max).default(defaultValue);

const nextToken = z.string().max(2048).optional();

const email = z.email().max(254);

// --- Parametres de chemin ---------------------------------------------------

export const postIdParams = z.object({ postId: ulid });
export const postRefParams = z.object({
  postId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[0-9A-Za-z-]+$/, 'Invalid identifier'),
});
export const mediaIdParams = z.object({ mediaId: ulid });
export const commentParams = z.object({ postId: ulid, commentId: ulid });
export const usernameParams = z.object({
  username: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\p{L}\p{N}_=,.@+-]+$/u, 'Invalid username'),
});

// --- Authentification ---------------------------------------------------------

export const registerBody = z.strictObject({
  email,
  password: z.string().min(10).max(128),
  name: trimmed(1, 80),
});
export const confirmBody = z.strictObject({
  email,
  code: z.string().regex(/^\d{6}$/, 'The code must contain 6 digits'),
});
export const loginBody = z.strictObject({ email, password: z.string().min(1).max(128) });
export const refreshBody = z.strictObject({ refreshToken: z.string().min(10).max(4096) });

export const roleBody = z.strictObject({ role: z.enum(ALL_ROLES) });
export const usersQuery = z.object({ limit: limit(60, 20), nextToken });

// --- Articles ------------------------------------------------------------------

const postFields = {
  title: trimmed(1, 150),
  content: z.string().min(1).max(100_000),
  excerpt: z.string().trim().max(300),
  tags: z.array(tag).max(10),
};

export const createPostBody = z.strictObject({
  title: postFields.title,
  content: postFields.content,
  excerpt: postFields.excerpt.optional(),
  tags: postFields.tags.optional(),
  coverMediaId: ulid.optional(),
  status: z.enum(['draft', 'pending_review']).optional(),
});

export const updatePostBody = z
  .strictObject({
    title: postFields.title.optional(),
    content: postFields.content.optional(),
    excerpt: postFields.excerpt.optional(),
    tags: postFields.tags.optional(),
    coverMediaId: ulid.nullable().optional(),
    status: z.enum(['draft', 'pending_review', 'archived']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one field is required');

export const listPostsQuery = z.object({
  limit: limit(50, 10),
  nextToken,
  tag: tag.optional(),
  authorId: z.string().min(1).max(64).optional(),
});

export const myPostsQuery = z.object({
  limit: limit(50, 10),
  nextToken,
  status: z.enum(POST_STATUSES).optional(),
});

export const reviewPostsQuery = z.object({
  limit: limit(50, 10),
  nextToken,
  status: z.enum(['pending_review', 'draft', 'archived']).default('pending_review'),
});

// --- Medias --------------------------------------------------------------------

export const uploadUrlBody = z
  .strictObject({
    filename: trimmed(1, 200),
    contentType: z.enum(Object.keys(MEDIA_TYPES)),
    size: z.number().int().positive(),
  })
  .superRefine((body, ctx) => {
    const rule = MEDIA_TYPES[body.contentType];
    if (rule && body.size > rule.maxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: `File too large for ${body.contentType} (maximum ${rule.maxBytes} bytes)`,
      });
    }
  });

export const mediaQuery = z.object({
  limit: limit(50, 20),
  nextToken,
  ownerId: z.string().min(1).max(64).optional(),
});

export const mediaGetQuery = z.object({ redirect: z.enum(['true', 'false']).optional() });

// --- Commentaires ------------------------------------------------------------

export const createCommentBody = z.strictObject({
  authorName: trimmed(1, 80),
  authorEmail: email,
  content: trimmed(1, 2000),
});

export const commentsQuery = z.object({ limit: limit(100, 20), nextToken });

export const moderationQuery = z.object({
  limit: limit(100, 20),
  nextToken,
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
});

export const moderationBody = z.strictObject({ status: z.enum(['approved', 'rejected']) });

// --- Recherche et abonnements -------------------------------------------------

export const searchQuery = z.object({ q: trimmed(1, 100), limit: limit(50, 10) });

export const subscribeBody = z.strictObject({ email });
