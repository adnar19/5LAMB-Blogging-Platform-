# Plan : Blogify, plateforme de blog headless (Serverless Framework + AWS Lambda)

Service Serverless Framework v4 unique, en Node.js JavaScript (ESM), déployé en `eu-west-1` avec les stages `dev` et `prod`.
L'API est en HTTP API avec authorizer JWT Cognito, les rôles sont portés par les groupes Cognito, DynamoDB est en multi-tables, S3 sert aux médias et les trois fonctionnalités optionnelles sont incluses.

## Architecture

- **API** : API Gateway HTTP API, routes publiques (lecture, commentaires, abonnement) et routes protégées par JWT Cognito.
- **Rôles** : groupes `admin`, `editor` et `guest_author`, vérifiés dans un middleware de handler. Le claim `cognito:groups` peut arriver sous forme de chaîne `"[admin editor]"`, le parseur accepte chaîne et tableau.
- **Cycle de vie d'un article** : `draft`, puis `pending_review`, `published`, `archived`. Un `guest_author` ne peut pas publier.
- **Tables DynamoDB** (pay-per-request, pas de table users car Cognito fait foi) :
  - `posts` : clé `postId`, index slug, `authorId` + `createdAt` et `status` + `publishedAt`.
  - `comments` : clé `postId` + `commentId` (ULID), index `status` + `createdAt` pour la file de modération.
  - `media` : clé `mediaId`, index propriétaire.
  - `search-index` : clé `term` + `postId`.
- **Médias** : bucket S3 privé avec chiffrement et blocage de l'accès public. Upload par presigned POST (liste blanche de content-types, taille limitée), lecture par URL présignée.
- **Recherche** : une Lambda branchée sur le DynamoDB Stream de `posts` tokenise titre, tags et contenu pour alimenter l'index inversé. `GET /search` interroge chaque terme et fait l'intersection.
- **Notifications** : un topic SNS. `POST /subscribers` appelle `sns:Subscribe` en email (confirmation et désinscription natives). Une seconde Lambda sur le Stream publie sur le topic quand un article passe à `published`.

## Endpoints prévus

- **Auth** : `POST /auth/register`, `/auth/confirm`, `/auth/login`, `/auth/refresh`. L'inscription ajoute l'utilisateur au groupe `guest_author`.
- **Admin** : `GET /admin/users`, `PUT /admin/users/{username}/role`.
- **Articles** :
  - Lecture publique : `GET /posts` (pagination `limit` et `nextToken`, filtres tag et auteur) et `GET /posts/{postId}`.
  - Écriture : `POST`, `PUT` et `DELETE /posts/{postId}`.
  - Publication : `POST /posts/{postId}/publish`.
  - Listes privées : `GET /posts/mine` (brouillons de l'auteur) et `GET /posts/review` (file de relecture des editors et admins).
- **Médias** : `POST /media/upload-url`, `GET /media/{mediaId}`, `GET /media`, `DELETE /media/{mediaId}`.
- **Commentaires** :
  - `GET` et `POST /posts/{postId}/comments`, publics. Un commentaire créé est en `pending` et la route est limitée par throttling.
  - `GET /comments?status=pending` pour la modération.
  - `PUT /comments/{postId}/{commentId}/moderation` pour approuver ou rejeter.
  - `DELETE /comments/{postId}/{commentId}`.
- **Divers** : `GET /search?q=`, `POST /subscribers`, `GET /docs`, `GET /openapi.json`.

## Étapes

### Phase 0 : prérequis et squelette

1. Installer Node 22 et Serverless v4 (`npm i -g serverless`, puis `serverless login`), configurer les credentials AWS (SSO ou profil).
2. Initialiser `package.json` (`"type": "module"`), `.gitignore`, `.env.example`, ESLint et Prettier, et créer `serverless.yml` (service `blogify`, `frameworkVersion: '4'`, runtime `nodejs22.x`, région `eu-west-1`, stage `${opt:stage, 'dev'}`, build esbuild).
3. Ajouter des `params` par stage : rétention des logs, throttling, `DeletionPolicy` Retain et PITR en prod, origines CORS. _Dépend de 2._

### Phase 1 : infrastructure (ressources CloudFormation)

4. Définir les 4 tables avec leurs index, le bucket S3 (CORS, chiffrement, blocage public), le User Pool Cognito (politique de mot de passe, vérification email, client sans secret avec les flows `USER_PASSWORD_AUTH` et `REFRESH_TOKEN`, 3 groupes), le topic SNS et les Outputs.
5. Déclarer l'authorizer JWT sur la HTTP API et les statements IAM limités par ARN. Le throttling par défaut passe par une surcharge du stage HTTP API.

### Phase 2 : bibliothèque partagée

6. Dans `src/lib/` : client DynamoDB (DocumentClient), réponses JSON et erreurs normalisées, validation zod, middleware de rôles, config via variables d'environnement, pagination (`nextToken` encodé et validé), logger JSON.

### Phase 3 : authentification et rôles

7. Implémenter register, confirm, login, refresh, et l'administration des rôles (`AdminAddUserToGroup` et `AdminRemoveUserFromGroup`, réservé aux admins).

### Phase 4 : articles

8. Implémenter le CRUD avec un slug généré (`slugify(titre)` plus un suffixe court, ce qui évite le problème d'unicité sur un index secondaire).
9. Appliquer les règles : un auteur modifie uniquement ses articles, un editor ou admin modifie tout, et seuls eux publient. Gérer les transitions de statut avec des conditional writes.

### Phase 5 : médias

10. Implémenter la génération d'URL présignée avec enregistrement des métadonnées, la lecture, la liste et la suppression.

### Phase 6 : fonctionnalités optionnelles

11. Commentaires et modération.
12. Stream `posts` vers l'indexeur de recherche (ajout, mise à jour et suppression des termes), puis endpoint `GET /search`.
13. Stream `posts` vers la Lambda de notification (publication SNS uniquement à la transition vers `published`) et endpoint `POST /subscribers`.

### Phase 7 : documentation OpenAPI

14. Rédiger `docs/openapi.yaml` (schémas, `securitySchemes` bearer JWT, codes d'erreur), avec `GET /docs` (Swagger UI) et `GET /openapi.json` servis par Lambda.

### Phase 8 : tests

15. Tests unitaires avec Vitest et `aws-sdk-client-mock` : middleware de rôles, parseur de groupes, validation, machine d'états des articles, tokenizer, handlers principaux (cas passants et refus 401/403/404/409).
16. Script de smoke test Node.js (`scripts/smoke.mjs`, `fetch` et SDK AWS) pour le scénario de bout en bout.

### Phase 9 : CI/CD et stages

17. `ci.yml` sur pull request : `npm ci`, lint, tests, lint OpenAPI, `serverless package`.
18. `deploy.yml` : push sur `develop` déploie `dev`, push sur `main` déploie `prod` via un GitHub Environment avec approbation. L'authentification AWS passe par OIDC (`configure-aws-credentials`) et `SERVERLESS_ACCESS_KEY` vient d'un secret. Un smoke test suit chaque déploiement.

### Phase 10 : livrable

19. Réécrire `README.md` : schéma d'architecture (Mermaid), prérequis, déploiement par stage, tableau des rôles et permissions, exemples d'appels, coûts, et nettoyage avec `serverless remove`.

## Fichiers concernés

- `serverless.yml`, `resources/*.yml` et `functions/*.yml` : configuration, ressources et déclaration des fonctions.
- `src/handlers/{auth,admin,posts,media,comments,search,subscribers,streams,docs}.js` : handlers.
- `src/lib/*.js` : utilitaires partagés.
- `tests/unit/**` et `scripts/smoke.mjs`.
- `docs/openapi.yaml`.
- `.github/workflows/ci.yml` et `.github/workflows/deploy.yml`.
- `package.json`, `.gitignore`, `.env.example`, `eslint.config.js`, `README.md`.

## Vérification

1. `npm test` et `npm run lint` passent sans erreur.
2. Le lint OpenAPI (`@redocly/cli lint docs/openapi.yaml`) passe.
3. `serverless package --stage dev` réussit.
4. `serverless deploy --stage dev` réussit, puis le smoke test enchaîne : inscription, confirmation par `aws cognito-idp admin-confirm-sign-up`, login, création d'un article, publication par un editor, listing public, recherche, upload média, commentaire en `pending` puis approuvé, abonnement.
5. Contrôles négatifs : un `guest_author` qui publie reçoit 403, un appel sans token reçoit 401, un upload `.exe` ou trop gros est refusé.
6. Le pipeline GitHub Actions est vert sur une PR, et `develop` vers `dev` puis `main` vers `prod` déploient.
7. `serverless remove --stage dev` nettoie les ressources.

## Décisions

- **Inclus** : tout le cœur plus commentaires, recherche et notifications, tests, CI/CD, OpenAPI et deux stages.
- **Exclus** : frontend, domaine personnalisé, WAF, CloudFront devant S3, SES, OpenSearch.
- **Serverless v4** (esbuild intégré, login requis, `SERVERLESS_ACCESS_KEY` en CI).
- **Table users** : pas de table, les infos auteur (`sub` et nom) viennent des claims Cognito et sont dénormalisées dans l'article.
- **Commentaires** : ouverts aux lecteurs anonymes (nom et email), toujours en `pending` avant modération.
- **Notifications** : SNS email (pas de sandbox SES).
- **Recherche** : index inversé alimenté par DynamoDB Stream.
