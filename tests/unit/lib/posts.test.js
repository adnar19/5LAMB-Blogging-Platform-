import { describe, expect, it } from 'vitest';
import { getUser } from '../../../src/lib/auth.js';
import {
  assertTransition,
  canDelete,
  canEdit,
  canView,
  excerptFrom,
  makeSlug,
  normalizeTags,
  slugify,
  toDetail,
  toSummary,
} from '../../../src/lib/posts.js';
import { makeEvent, post, USERS } from '../helpers.js';

const as = (user) => getUser(makeEvent({ user }));
const admin = as(USERS.admin);
const editor = as(USERS.editor);
const author = as(USERS.author);
const other = as(USERS.other);

describe('slug', () => {
  it('slugify retire accents et caracteres speciaux', () => {
    expect(slugify('  Déployer une API : le guide !  ')).toBe('deployer-une-api-le-guide');
    expect(slugify('???')).toBe('post');
  });

  it("makeSlug ajoute un suffixe issu de l'identifiant", () => {
    expect(makeSlug('Mon titre', '01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe('mon-titre-stvwxyz0');
  });
});

describe('excerptFrom', () => {
  it('nettoie le Markdown et tronque', () => {
    expect(excerptFrom('# Titre\n\n**Gras** et `code`')).toBe('Titre Gras et code');
    const long = excerptFrom('a'.repeat(500), 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('normalizeTags', () => {
  it('dedoublonne', () => {
    expect(normalizeTags(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeTags()).toEqual([]);
  });
});

describe('droits de lecture, edition et suppression', () => {
  const draft = post({ status: 'draft' });
  const published = post({ status: 'published' });

  it('un article publie est visible de tous', () => {
    expect(canView(null, published)).toBe(true);
  });

  it("un brouillon n'est visible que de son auteur et du staff", () => {
    expect(canView(null, draft)).toBe(false);
    expect(canView(other, draft)).toBe(false);
    expect(canView(author, draft)).toBe(true);
    expect(canView(editor, draft)).toBe(true);
  });

  it("l'auteur modifie son article tant qu'il n'est pas publie", () => {
    expect(canEdit(author, draft)).toBe(true);
    expect(canEdit(author, published)).toBe(false);
    expect(canEdit(other, draft)).toBe(false);
    expect(canEdit(editor, published)).toBe(true);
    expect(canDelete(admin, published)).toBe(true);
  });
});

describe('assertTransition', () => {
  it("autorise l'auteur a demander une relecture", () => {
    expect(() =>
      assertTransition(author, post({ status: 'draft' }), 'pending_review'),
    ).not.toThrow();
  });

  it("interdit a l'auteur de publier (403)", () => {
    expect(() => assertTransition(author, post({ status: 'draft' }), 'published')).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it('autorise le staff a publier et archiver', () => {
    expect(() =>
      assertTransition(editor, post({ status: 'pending_review' }), 'published'),
    ).not.toThrow();
    expect(() => assertTransition(editor, post({ status: 'published' }), 'archived')).not.toThrow();
  });

  it('refuse une transition inexistante (400)', () => {
    expect(() => assertTransition(admin, post({ status: 'draft' }), 'archived')).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('est sans effet si le statut ne change pas', () => {
    expect(() => assertTransition(other, post({ status: 'draft' }), 'draft')).not.toThrow();
  });
});

describe('representations', () => {
  it('toDetail masque les attributs techniques', () => {
    expect(toDetail(post({ notifiedAt: '2025-01-01T00:00:00.000Z' }))).not.toHaveProperty(
      'notifiedAt',
    );
  });

  it('toSummary retire le contenu', () => {
    const summary = toSummary(post());
    expect(summary).not.toHaveProperty('content');
    expect(summary.title).toBe('Mon article');
  });
});
