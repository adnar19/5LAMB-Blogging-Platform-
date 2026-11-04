import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { api } from '../lib/handler.js';
import { html, json } from '../lib/response.js';

const SPEC_PATH = join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), 'docs', 'openapi.yaml');

const SWAGGER_UI_VERSION = '5.17.14';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blogify API</title>
    <link rel="stylesheet" href="${CDN}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${CDN}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        persistAuthorization: true,
      });
    </script>
  </body>
</html>
`;

const PAGE_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    `script-src 'unsafe-inline' https://cdn.jsdelivr.net`,
    `style-src 'unsafe-inline' https://cdn.jsdelivr.net`,
    `img-src 'self' data: https://cdn.jsdelivr.net`,
    `connect-src 'self'`,
    `font-src https://cdn.jsdelivr.net`,
    `worker-src blob:`,
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=300',
};

let specPromise;
const loadSpec = () => {
  specPromise ??= readFile(SPEC_PATH, 'utf8')
    .then((source) => parse(source))
    .catch((err) => {
      specPromise = undefined;
      throw err;
    });
  return specPromise;
};

/** Interface Swagger UI (GET /docs). */
export const ui = api(async () => html(PAGE, PAGE_HEADERS));

/** Specification OpenAPI au format JSON (GET /openapi.json). */
export const openapi = api(async () =>
  json(200, await loadSpec(), { 'Cache-Control': 'public, max-age=300' }),
);
