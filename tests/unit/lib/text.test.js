import { describe, expect, it } from 'vitest';
import { normalize, postTerms, tokenize } from '../../../src/lib/text.js';

describe('normalize', () => {
  it('retire les accents et passe en minuscules', () => {
    expect(normalize('Élève Été Çà')).toBe('eleve ete ca');
  });
});

describe('tokenize', () => {
  it('retourne des termes uniques, sans mots vides ni mots trop courts', () => {
    expect(tokenize('Le Serverless, le serverless et AWS: les fonctions Lambda !')).toEqual([
      'serverless',
      'aws',
      'fonctions',
      'lambda',
    ]);
  });

  it('respecte la limite de termes', () => {
    expect(tokenize('alpha bravo charlie delta', 2)).toEqual(['alpha', 'bravo']);
  });

  it('ignore les valeurs vides', () => {
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('a b')).toEqual([]);
  });
});

describe('postTerms', () => {
  it('indexe le titre, les tags et le contenu', () => {
    const terms = postTerms({
      title: 'Déployer Lambda',
      tags: ['aws-cloud'],
      content: 'Bonjour monde',
    });
    expect(terms).toEqual(
      expect.arrayContaining(['deployer', 'lambda', 'aws', 'cloud', 'bonjour', 'monde']),
    );
  });

  it('limite le nombre de termes', () => {
    const content = Array.from({ length: 500 }, (_, i) => `mot${i}`).join(' ');
    expect(postTerms({ title: 'Titre', tags: [], content }).length).toBeLessThanOrEqual(200);
  });
});
