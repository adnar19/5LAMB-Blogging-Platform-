import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
// Les tags CloudFormation (!Ref, !GetAtt...) n'ont pas besoin d'etre resolus ici.
const yaml = (path) => parse(read(path), { logLevel: 'error' });

const serverless = yaml('serverless.yml');
const handlerModules = import.meta.glob('../../src/handlers/*.js');

const functionFiles = [
  ...read('serverless.yml').matchAll(/\$\{file\(\.\/(functions\/[\w-]+\.yml)\)\}/g),
].map((match) => match[1]);

const functions = Object.fromEntries(functionFiles.flatMap((file) => Object.entries(yaml(file))));

const httpRoutes = Object.entries(functions).flatMap(([name, definition]) =>
  (definition.events ?? [])
    .filter((event) => event.httpApi)
    .map((event) => ({
      name,
      method: event.httpApi.method.toLowerCase(),
      path: event.httpApi.path,
      secured: Boolean(event.httpApi.authorizer),
    })),
);

const openapi = yaml('docs/openapi.yaml');
const documented = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => ['get', 'post', 'put', 'delete', 'patch'].includes(method))
    .map(([method, operation]) => ({ path, method, operation })),
);

describe('serverless.yml', () => {
  it('reference au moins un fichier de fonctions et des fonctions', () => {
    expect(functionFiles.length).toBeGreaterThan(0);
    expect(Object.keys(functions).length).toBeGreaterThan(20);
  });

  it('cible Node.js sur eu-west-1', () => {
    expect(serverless.provider.runtime).toMatch(/^nodejs\d+\.x$/);
    expect(serverless.provider.region).toBe('eu-west-1');
  });

  it('definit des parametres pour les stages dev et prod', () => {
    expect(serverless.params).toHaveProperty('prod');
    expect(serverless.params.prod.deletionPolicy).toBe('Retain');
  });

  it.each(Object.entries(functions))(
    '%s : le handler existe et est une fonction exportee',
    async (_name, definition) => {
      const match = /^(src\/handlers\/[\w-]+)\.(\w+)$/.exec(definition.handler);
      expect(match, `handler invalide : ${definition.handler}`).not.toBeNull();
      const [, modulePath, exportName] = match;
      const load = handlerModules[`../../${modulePath}.js`];
      expect(load, `module introuvable : ${modulePath}.js`).toBeDefined();
      const module = await load();
      expect(typeof module[exportName]).toBe('function');
    },
  );

  it("les routes d'ecriture et d'administration sont protegees par l'authorizer", () => {
    for (const route of httpRoutes) {
      const isPublicWrite = ['/auth/', '/subscribers', '/posts/{postId}/comments'].some(
        (prefix) => route.path.startsWith(prefix) || route.path === prefix,
      );
      if (route.path.startsWith('/admin') || (route.method !== 'get' && !isPublicWrite)) {
        expect(route.secured, `${route.method} ${route.path} doit etre protegee`).toBe(true);
      }
    }
  });
});

describe('docs/openapi.yaml', () => {
  const apiRoutes = httpRoutes.filter((route) => !['/docs', '/openapi.json'].includes(route.path));

  it.each(apiRoutes.map((route) => [`${route.method.toUpperCase()} ${route.path}`, route]))(
    '%s est documentee avec le bon operationId et la bonne securite',
    (_label, route) => {
      const operation = openapi.paths[route.path]?.[route.method];
      expect(operation, 'operation absente de la specification').toBeDefined();
      expect(operation.operationId).toBe(route.name);
      // `security: []` marque une route publique ; sinon la securite globale (bearerAuth) s'applique.
      expect(operation.security?.length === 0).toBe(!route.secured);
    },
  );

  it('ne documente aucune route inexistante', () => {
    const served = new Set(apiRoutes.map((route) => `${route.method} ${route.path}`));
    for (const { path, method } of documented) {
      expect(
        served.has(`${method} ${path}`),
        `${method} ${path} n'existe pas dans serverless`,
      ).toBe(true);
    }
  });
});
