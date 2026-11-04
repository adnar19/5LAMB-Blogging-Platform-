#!/usr/bin/env node
/**
 * Smoke test de bout en bout sur un stage deploye.
 *
 *   npm run smoke -- --stage dev      (charge le fichier .env s'il existe)
 *
 * Variables : STAGE (defaut dev), AWS_REGION (defaut eu-west-1), SMOKE_EMAIL (adresse de base des
 * comptes de test, defaut smoke@example.com), SMOKE_SUBSCRIBE_EMAIL (optionnel : teste aussi
 * l'abonnement, un email de confirmation SNS est alors envoye a cette adresse).
 *
 * Les credentials AWS (profil, SSO ou variables d'environnement) doivent permettre de lire le stack
 * CloudFormation et d'administrer le User Pool. Les comptes et donnees crees sont supprimes a la fin.
 */
import {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const argStage = process.argv.includes('--stage')
  ? process.argv[process.argv.indexOf('--stage') + 1]
  : undefined;
const stage = argStage ?? process.env.STAGE ?? 'dev';
const region = process.env.AWS_REGION ?? 'eu-west-1';
const emailBase = process.env.SMOKE_EMAIL ?? 'smoke@example.com';

const run = Date.now().toString(36);
const uniqueWord = `smoke${run}`;
const password = `Smoke-${run}-Passw0rd!`;
const [emailLocal, emailDomain] = emailBase.split('@');
const emailFor = (label) => `${emailLocal}+${label}-${run}@${emailDomain}`;

const cognito = new CognitoIdentityProviderClient({ region });
const cloudformation = new CloudFormationClient({ region });

const createdUsers = [];
const cleanup = [];

// --- Utilitaires -------------------------------------------------------------------------------

let apiUrl;

const call = async (method, path, { token, body, headers = {} } = {}) => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
};

const check = async (label, request, expectedStatus) => {
  const response = await request;
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} : statut ${response.status} au lieu de ${expectedStatus} ${JSON.stringify(response.data)}`,
    );
  }
  console.log(`[ok] ${label} (${response.status})`);
  return response;
};

const assert = (label, condition) => {
  if (!condition) throw new Error(`${label} : assertion fausse`);
  console.log(`[ok] ${label}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const poll = async (label, predicate, { attempts = 15, delayMs = 2000 } = {}) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await predicate()) {
      console.log(`[ok] ${label}`);
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`${label} : delai depasse`);
};

const stackOutputs = async () => {
  const { Stacks } = await cloudformation.send(
    new DescribeStacksCommand({ StackName: `blogify-${stage}` }),
  );
  const outputs = Object.fromEntries(
    (Stacks?.[0]?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]),
  );
  for (const key of ['HttpApiUrl', 'UserPoolId', 'UserPoolClientId']) {
    if (!outputs[key]) throw new Error(`Sortie CloudFormation manquante : ${key}`);
  }
  return outputs;
};

// --- Comptes -------------------------------------------------------------------------------------

const createUser = async (label, { userPoolId, group } = {}) => {
  const email = emailFor(label);
  await check(
    `inscription de ${label}`,
    call('POST', '/auth/register', { body: { email, password, name: `Smoke ${label}` } }),
    201,
  );
  createdUsers.push({ email, userPoolId });
  // Confirmation sans passer par l'email de verification
  await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: email }));
  if (group) {
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: group }),
    );
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: 'guest_author',
      }),
    );
  }
  // Le groupe est lu dans le jeton : la connexion se fait apres l'attribution du role.
  const login = await check(
    `connexion de ${label}`,
    call('POST', '/auth/login', { body: { email, password } }),
    200,
  );
  return { email, token: login.data.idToken, refreshToken: login.data.refreshToken };
};

// 1x1 pixel PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// --- Scenario ------------------------------------------------------------------------------------

const main = async () => {
  console.log(`Smoke test du stage "${stage}" (${region})`);
  const outputs = await stackOutputs();
  apiUrl = outputs.HttpApiUrl.replace(/\/$/, '');
  const { UserPoolId: userPoolId } = outputs;
  console.log(`API : ${apiUrl}`);

  // Documentation
  const spec = await check('GET /openapi.json', call('GET', '/openapi.json'), 200);
  assert('la specification contient /posts', Boolean(spec.data.paths?.['/posts']));
  await check('GET /docs', call('GET', '/docs'), 200);

  // Controles negatifs sans jeton
  await check(
    'POST /posts sans jeton',
    call('POST', '/posts', { body: { title: 'T', content: 'C' } }),
    401,
  );
  await check('GET /posts/mine sans jeton', call('GET', '/posts/mine'), 401);
  await check('GET /posts avec nextToken invalide', call('GET', '/posts?nextToken=invalide'), 400);

  // Comptes
  const author = await createUser('author', { userPoolId });
  const editor = await createUser('editor', { userPoolId, group: 'editor' });
  await check(
    'connexion avec un mauvais mot de passe',
    call('POST', '/auth/login', { body: { email: author.email, password: 'MauvaisMotDePasse1!' } }),
    401,
  );
  await check(
    'renouvellement du jeton',
    call('POST', '/auth/refresh', { body: { refreshToken: author.refreshToken } }),
    200,
  );
  await check(
    "GET /admin/users en tant qu'auteur",
    call('GET', '/admin/users', { token: author.token }),
    403,
  );

  // Articles : cycle de vie et droits
  await check(
    'creation avec un statut interdit',
    call('POST', '/posts', {
      token: author.token,
      body: { title: 'Interdit', content: 'Contenu', status: 'published' },
    }),
    400,
  );
  const created = await check(
    "creation d'un brouillon",
    call('POST', '/posts', {
      token: author.token,
      body: {
        title: `Article de test ${uniqueWord}`,
        content: `Contenu de l'article de smoke test ${uniqueWord}.`,
        tags: ['smoke'],
      },
    }),
    201,
  );
  const { postId, slug } = created.data;
  cleanup.push(() => call('DELETE', `/posts/${postId}`, { token: editor.token }));
  assert("le brouillon appartient a l'auteur", created.data.status === 'draft');

  await check("un brouillon n'est pas public", call('GET', `/posts/${postId}`), 404);
  await check(
    "l'auteur ne peut pas publier",
    call('POST', `/posts/${postId}/publish`, { token: author.token }),
    403,
  );
  await check(
    "l'auteur demande une relecture",
    call('PUT', `/posts/${postId}`, { token: author.token, body: { status: 'pending_review' } }),
    200,
  );
  const review = await check(
    'GET /posts/review (editeur)',
    call('GET', '/posts/review', { token: editor.token }),
    200,
  );
  assert(
    "l'article est dans la file de relecture",
    review.data.items.some((item) => item.postId === postId),
  );
  await check(
    'GET /posts/review (auteur)',
    call('GET', '/posts/review', { token: author.token }),
    403,
  );

  await check(
    "publication par l'editeur",
    call('POST', `/posts/${postId}/publish`, { token: editor.token }),
    200,
  );
  await check('lecture publique par identifiant', call('GET', `/posts/${postId}`), 200);
  await check('lecture publique par slug', call('GET', `/posts/${slug}`), 200);
  const list = await check('GET /posts', call('GET', '/posts?limit=50'), 200);
  assert(
    "l'article publie apparait dans la liste",
    list.data.items.some((item) => item.postId === postId),
  );
  await check(
    "l'auteur ne peut plus modifier un article publie",
    call('PUT', `/posts/${postId}`, { token: author.token, body: { title: 'Modifie' } }),
    403,
  );

  // Recherche (indexation asynchrone via DynamoDB Streams)
  await poll("l'article est retrouve par la recherche", async () => {
    const { data } = await call('GET', `/search?q=${uniqueWord}`);
    return data?.items?.some((item) => item.postId === postId);
  });

  // Medias
  await check(
    "upload d'un type interdit",
    call('POST', '/media/upload-url', {
      token: author.token,
      body: { filename: 'virus.exe', contentType: 'application/x-msdownload', size: 100 },
    }),
    400,
  );
  const upload = await check(
    "demande d'URL d'upload",
    call('POST', '/media/upload-url', {
      token: author.token,
      body: { filename: 'pixel.png', contentType: 'image/png', size: PNG.length },
    }),
    201,
  );
  const { mediaId } = upload.data;
  cleanup.push(() => call('DELETE', `/media/${mediaId}`, { token: author.token }));
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.data.upload.fields)) form.append(name, value);
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'pixel.png');
  const s3Response = await fetch(upload.data.upload.url, { method: 'POST', body: form });
  assert(`envoi du fichier vers S3 (${s3Response.status})`, s3Response.status === 204);
  const media = await check('GET /media/{id}', call('GET', `/media/${mediaId}`), 200);
  const file = await fetch(media.data.url);
  assert(`telechargement via l'URL presignee (${file.status})`, file.status === 200);
  await check('GET /media (auteur)', call('GET', '/media', { token: author.token }), 200);

  // Commentaires et moderation
  const comment = await check(
    'commentaire public',
    call('POST', `/posts/${postId}/comments`, {
      body: { authorName: 'Lecteur', authorEmail: emailFor('reader'), content: 'Bel article !' },
    }),
    201,
  );
  assert('le commentaire est en attente', comment.data.status === 'pending');
  const before = await check(
    'commentaires publics (avant moderation)',
    call('GET', `/posts/${postId}/comments`),
    200,
  );
  assert('aucun commentaire visible avant moderation', before.data.items.length === 0);
  await check('moderation par un auteur', call('GET', '/comments', { token: author.token }), 403);
  const pending = await check(
    'commentaires a moderer',
    call('GET', '/comments?limit=100', { token: editor.token }),
    200,
  );
  assert(
    'le commentaire est dans la file de moderation',
    pending.data.items.some((item) => item.commentId === comment.data.commentId),
  );
  await check(
    'approbation du commentaire',
    call('PUT', `/comments/${postId}/${comment.data.commentId}/moderation`, {
      token: editor.token,
      body: { status: 'approved' },
    }),
    200,
  );
  const after = await check(
    'commentaires publics (apres moderation)',
    call('GET', `/posts/${postId}/comments`),
    200,
  );
  assert('le commentaire approuve est visible', after.data.items.length === 1);
  assert("l'email du lecteur n'est pas expose", !('authorEmail' in after.data.items[0]));

  // Abonnement (optionnel : envoie un email de confirmation SNS)
  if (process.env.SMOKE_SUBSCRIBE_EMAIL) {
    await check(
      'abonnement',
      call('POST', '/subscribers', { body: { email: process.env.SMOKE_SUBSCRIBE_EMAIL } }),
      202,
    );
  } else {
    console.log('[skip] abonnement (definir SMOKE_SUBSCRIBE_EMAIL pour le tester)');
  }
  await check(
    'abonnement avec un email invalide',
    call('POST', '/subscribers', { body: { email: 'invalide' } }),
    400,
  );

  // Suppression d'un article publie
  await check(
    "suppression par l'auteur d'un article publie",
    call('DELETE', `/posts/${postId}`, { token: author.token }),
    403,
  );
  await check(
    "suppression par l'editeur",
    call('DELETE', `/posts/${postId}`, { token: editor.token }),
    204,
  );
  cleanup.length = 0;
  cleanup.push(() => call('DELETE', `/media/${mediaId}`, { token: author.token }));
  await check("l'article supprime est introuvable", call('GET', `/posts/${postId}`), 404);
};

const teardown = async () => {
  for (const task of cleanup) {
    try {
      await task();
    } catch (err) {
      console.warn(`Nettoyage : ${err.message}`);
    }
  }
  for (const { email, userPoolId } of createdUsers) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
    } catch (err) {
      console.warn(`Suppression du compte ${email} impossible : ${err.message}`);
    }
  }
};

try {
  await main();
  console.log('\nSmoke test reussi.');
} catch (err) {
  console.error(`\n[FAIL] ${err.message}`);
  process.exitCode = 1;
} finally {
  await teardown();
}
