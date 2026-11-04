import { describe, expect, it } from 'vitest';
import { openapi, ui } from '../../../src/handlers/docs.js';
import { bodyOf, makeEvent } from '../helpers.js';

describe('docs', () => {
  it('GET /docs retourne la page Swagger UI avec une politique de securite de contenu', async () => {
    const res = await ui(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(res.body).toContain('/openapi.json');
  });

  it('GET /openapi.json retourne la specification', async () => {
    const res = await openapi(makeEvent());
    expect(res.statusCode).toBe(200);
    const spec = bodyOf(res);
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(10);
  });
});
