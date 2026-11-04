import { LIMITS } from './config.js';

const STOP_WORDS = new Set(
  [
    // francais
    'les',
    'des',
    'une',
    'est',
    'que',
    'qui',
    'pas',
    'pour',
    'dans',
    'sur',
    'avec',
    'par',
    'plus',
    'son',
    'ses',
    'ces',
    'aux',
    'ont',
    'sont',
    'mais',
    'ou',
    'donc',
    'car',
    'nous',
    'vous',
    'ils',
    'elle',
    'elles',
    'cette',
    'leur',
    'leurs',
    'comme',
    'etre',
    'avoir',
    'fait',
    'tout',
    'tous',
    // anglais
    'the',
    'and',
    'for',
    'are',
    'but',
    'not',
    'you',
    'all',
    'can',
    'has',
    'her',
    'was',
    'one',
    'our',
    'out',
    'who',
    'its',
    'with',
    'this',
    'that',
    'from',
    'have',
    'they',
    'will',
    'been',
  ].map((word) => word.toLowerCase()),
);

/** Minuscules sans accents. */
export const normalize = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Termes uniques, normalises, de 3 a 40 caracteres, hors mots vides. */
export const tokenize = (text, max = Infinity) => {
  const terms = normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3 && term.length <= 40 && !STOP_WORDS.has(term));
  return [...new Set(terms)].slice(0, max);
};

/** Termes indexes pour un article : titre et tags en priorite, puis contenu. */
export const postTerms = (post) => {
  const terms = new Set([
    ...tokenize(post.title),
    ...(post.tags ?? []).flatMap((tag) => tokenize(tag)),
    ...tokenize(post.content, LIMITS.maxIndexedTermsPerPost),
  ]);
  return [...terms].slice(0, LIMITS.maxIndexedTermsPerPost);
};
