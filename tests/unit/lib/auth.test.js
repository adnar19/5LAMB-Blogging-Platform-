import { describe, expect, it } from 'vitest';
import { getUser, hasRole, isStaff, parseGroups, requireRole } from '../../../src/lib/auth.js';
import { makeEvent, USERS } from '../helpers.js';

describe('parseGroups', () => {
  it.each([
    [undefined, []],
    ['', []],
    [
      ['admin', 'editor'],
      ['admin', 'editor'],
    ],
    ['[admin editor]', ['admin', 'editor']],
    ['[guest_author]', ['guest_author']],
    ['admin,editor', ['admin', 'editor']],
  ])('%j -> %j', (claim, expected) => {
    expect(parseGroups(claim)).toEqual(expected);
  });
});

describe('getUser', () => {
  it('retourne null sans authentification', () => {
    expect(getUser(makeEvent())).toBeNull();
  });

  it('lit les claims du jeton', () => {
    expect(getUser(makeEvent({ user: USERS.editor }))).toMatchObject({
      id: 'user-editor',
      email: 'editor@example.test',
      name: 'Eli Editor',
      groups: ['editor'],
    });
  });

  it('traite un utilisateur sans groupe reconnu comme auteur invite', () => {
    const user = { ...USERS.author, groups: ['inconnu'] };
    expect(getUser(makeEvent({ user })).groups).toEqual(['guest_author']);
  });
});

describe('roles', () => {
  const editor = getUser(makeEvent({ user: USERS.editor }));
  const author = getUser(makeEvent({ user: USERS.author }));

  it('hasRole et isStaff', () => {
    expect(hasRole(editor, ['admin'])).toBe(false);
    expect(hasRole(editor, ['admin', 'editor'])).toBe(true);
    expect(isStaff(editor)).toBe(true);
    expect(isStaff(author)).toBe(false);
    expect(isStaff(null)).toBe(false);
  });

  it('requireRole leve 401 sans utilisateur et 403 sans le bon role', () => {
    expect(() => requireRole(null, ['admin'])).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(() => requireRole(author, ['admin'])).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => requireRole(editor, ['editor'])).not.toThrow();
  });
});
