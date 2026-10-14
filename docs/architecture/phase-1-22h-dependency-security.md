# Lot 1-22H — Audit et correction ciblée des dépendances

État : **audit fait, 68 avis npm corrigés sur 70, runtime Node mis à jour dans les images,
non-régression navigateur vérifiée (§ 7.1).**
Rien n'est commité, poussé ni déployé. Aucun service métier réel, aucune base réelle, aucun paiement.

Ce lot complète l'audit 1-22A, qui n'avait pas couvert les vulnérabilités connues des dépendances
(1-22A, limites : « faute de base CVE hors ligne »).

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `security/phase-1-22g-ci-cd-hardening` à `1f68710`, arbre propre. 1-22G est commité ; le correctif i18n de 1-22E est dans l'historique (`f28c9c8`) |
| Branche | `security/phase-1-22h-dependency-security`, créée depuis `1f68710` |
| Préservé | `stash@{0}`, `.env.prod`, `api/.env`, `api/.env.local`, `web/.env.local`, `web/.env.development.local` : **ni lus, ni modifiés** |
| Isolation | Mises à jour, installations, builds, tests et images exécutés dans une **copie des seuls fichiers suivis** (`git archive` / `git ls-files`) dans un répertoire temporaire : aucun `.env` présent, variable de jeton de session retirée de l'environnement. Seuls `web/package.json` et `pnpm-lock.yaml` ont été recopiés dans le dépôt |
| Sources | `pnpm audit` (avis du registre npm, issus de la GitHub Advisory Database) ; **OSV.dev** (`/v1/querybatch`, recoupement et paquets malveillants `MAL-*`) ; pages GHSA de chaque avis prioritaire ; `nodejs.org/dist/index.json` et calendrier `nodejs/Release` ; Docker Hub (tags et digests). Seuls des noms et versions de paquets publics ont été transmis |
| Variables, migrations | Aucune |

## 2. Inventaire

| Périmètre | Contenu | Lancé où |
|---|---|---|
| **API, production** | NestJS 11 / Express 5.2.1, Mongoose 9.9, socket.io 4.8, Sharp 0.35.5, bcryptjs, web-push, AWS SDK S3 | Image `api/Dockerfile` (Railway), `pnpm install --prod --frozen-lockfile` |
| **Web, serveur** | Next.js 16 (App Router uniquement, `src/proxy.ts`), React 19.2.4, next-i18next | Vercel (build Vercel) ; image `web/Dockerfile` (standalone) pour l'hébergement autonome |
| **Web, navigateur** | axios, socket.io-client, Base UI, recharts, i18next | Navigateur (composants `"use client"`) |
| **Web, build seulement** | `shadcn` (déclaré en `dependencies` ; seul usage : `@import "shadcn/tailwind.css"` dans `globals.css`), Tailwind, PostCSS | Build Vercel / Docker, poste développeur |
| **Build, test, CI** | Nest CLI, webpack, Jest 30, ts-jest, ESLint 9, typescript-eslint, mongodb-memory-server, Husky, lint-staged, Prettier | `ci.yml` (Node 22, `pnpm install --frozen-lockfile`) et postes |
| **Outils CI hors lockfile** | `vercel@61.1.0`, `@railway/cli@5.63.1` via `npx` (`rollback.yml`) ; actions `checkout` 4.4.0, `setup-node` 4.4.0, `pnpm/action-setup` 4.3.0 épinglées par SHA | GitHub Actions |
| **Runtime** | Images `node:22.17.1-alpine3.22` (digest figé) ; CI `node-version: 22` (dernière 22.x) ; pnpm 11.18.0 (corepack) | — |
| **Compose autonome** | `mongo:7`, `minio/minio:latest`, `nginx:alpine` (non épinglés) | `docker-compose.prod.yml` |

Lockfile : 1 222 paquets résolus.

## 3. Avant / après

| Mesure | Avant | Après |
|---|---|---|
| `pnpm audit` (tout le lockfile) | **70** : 3 critiques, 30 élevés, 32 modérés, 5 faibles | **2** : 1 élevé, 1 modéré |
| `pnpm audit --prod` | 58 : 1 critique, 24 élevés, 28 modérés, 5 faibles | 1 élevé (`braces`, via `shadcn`) |
| OSV.dev (1 222 paquets) | 19 paquets touchés, 62 identifiants, aucun `MAL-*` | 2 paquets (`braces`, `sprintf-js`), aucun `MAL-*` |
| Node dans les images | 22.17.1 (4 publications de sécurité manquantes) | 22.23.3 |

Les deux bases concordent paquet par paquet avant et après.

## 4. Qualification

Exposition : **D** démontrée, **P** possible, **NA** non applicable (justifiée), **I** indéterminée.
Aucune exploitation n'a été démontrée dans ce projet.

### 4.1 Production

| Avis | Paquet, version, chemin | Conditions d'exploitation | Exposition | Correctif |
|---|---|---|---|---|
| GHSA-jqcg-44mw-7w3h, CVE-2026-90711 (critique) | `proxy-addr` 2.0.7 ; `api > @nestjs/platform-express > express > proxy-addr` | Confiance accordée à un **sous-réseau IPv6 court** (`::ffff:10.0.0.0/8`, `::/1`) : tout client devient proxy de confiance, `req.ip` est usurpable | **NA** : `trust-proxy.ts` n'accepte que des adresses IP exactes ou un nombre de sauts ; CIDR et mots-clés refusés au démarrage. Vérifié : `::ffff:10.0.0.5` (exacte, /128) n'approuve que cette adresse | 2.0.8, dans la plage d'Express (`~2.0.7`). Garde ajoutée (§ 5) |
| GHSA-cjq9-62q9-8jv4, CVE-2026-94483 (élevé) | `next` 16.3.6 (direct) | SSRF de l'optimiseur d'images ; exige `images.remotePatterns` et un hôte autorisé dont le DNS n'est pas sûr | **P** : `remotePatterns` contient `S3_HOSTNAME` (https) et `http://localhost:9000` | 16.3.8 |
| GHSA-4jqv-mc3x-m676 (modéré) | `next` 16.3.6 | Pages Router + SSG/ISR, auto-hébergé ; Vercel non concerné | **NA** : App Router uniquement (pas de `src/pages`) | 16.3.8 |
| GHSA-mcj8-r9mp-w47p (modéré) | `next` 16.3.6 | Catch-all à la racine + SSG/ISR | **NA** : aucune route `[...x]` / `[[...x]]` | 16.3.8 |
| GHSA-f87g-xv8r-7p7x (modéré) | `next` 16.3.6 | Routes d'image de métadonnées (`opengraph-image`…) avec `dynamicParams` | **NA** : aucune route de ce type | 16.3.8 |
| GHSA-3w37-wq28-93x7 (modéré) | `next` 16.3.6 | `use cache` + Draft Mode | **NA** : ni l'un ni l'autre utilisé | 16.3.8 |
| GHSA-39w2-rjm5-chcv (faible) | `next` 16.3.6 | Endpoint MCP du serveur **de développement** | **NA** en production ; **P** sur un poste qui expose `next dev` | 16.3.8 |
| 12 avis axios (7 élevés, 5 modérés) : GHSA-c29m-xwm3-cm6r, -mghh-pgcx-3jjj, -x97p-jq2g-jp4f, -3pq3-5fj3-cg6v, -542g-h47m-68v8, -m8m8-qj5v-23w3, -r4gj-5m52-g5wh, -vh66-26gq-q6x8, -9fr6-4gfg-395g, -j8rh-479h-cp32, -4hqw-qxg8-jxx2, -44g4-m2mj-wpvx | `axios` 1.19.0 (direct, web) | Adaptateur HTTP/HTTP2 de Node, proxy, `data:` URI ; ou **gadgets** qui exigent une pollution de prototype préalable | **NA** pour les avis propres à Node : axios n'est importé que par des modules `"use client"` (navigateur). **I** pour les gadgets : aucune pollution de prototype connue, mais absence non démontrable | `^1.20.0` (1.20.0) |
| Node.js 22.22.0, 22.22.2, 22.23.0, 22.23.2 (publications de sécurité) | Images `node:22.17.1-alpine3.22` | Serveur HTTP Node exposé (API) | **P** | `node:22.23.3-alpine3.23` (§ 5) |

### 4.2 Chaîne `shadcn` (dépendance web, utilisée au build)

`shadcn` est en `dependencies`, mais son code JavaScript ne s'exécute pas en production : seule sa
feuille CSS est importée, et ni Vercel ni le standalone n'embarquent son serveur MCP ou son client HTTP.

| Avis | Paquet, version | Conditions | Exposition | Correctif |
|---|---|---|---|---|
| GHSA-6qxp-vccf-f47h (élevé) | `@modelcontextprotocol/sdk` 1.30.0 | Client OAuth MCP connecté à un serveur MCP non fiable | **NA** prod ; **P** poste (`shadcn mcp`) | 1.32.1 |
| 8 avis hono (GHSA-8j4g-w8fx-2239, -f23p-vx2j-j53r, -54fx-42gc-7vw4, -gqvv-2mrq-wpjv, -g6gw-c38x-mqfc, -crvj-82cr-hjcx, -hxh3-vqpv-xpqv, -79qm-7rj5-m7r9) | `hono` 4.12.32 (+ `@hono/node-server` 2.0.12) | Serveur Hono exposé | **NA** prod ; **P** poste | 4.13.13 / 2.1.5 |
| 10 avis undici 7 (2 élevés : GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3) | `undici` 7.29.0 | Réponses ou WebSocket malveillants | **NA** prod ; **P** poste (registres shadcn) | 7.30.0 |
| 4 avis ip-address (GHSA-rpw4-54j3-4h4q, -2vr4-cq9g-pvrc, -j6r3-76f7-8jcv, -h3mg-xc3c-68pw) | `ip-address` 10.4.0 via `express-rate-limit` | Contrôle d'accès par sous-réseau | **NA** prod | 10.7.4 (`express-rate-limit` 8.7.1) |
| GHSA-rj75-hqrm-r3gf (modéré) | `postcss-selector-parser` 7.1.4 | CSS hostile analysé | **NA** : CSS du dépôt | 7.1.6 |

### 4.3 Build, tests, CI

Les entrées de ces outils (motifs glob, YAML, cartes de source, modèles) viennent du dépôt. Le
pire cas réaliste est une PR malveillante qui bloque **son propre** job CI : depuis 1-22G, ce job
n'a ni secret ni jeton en écriture. Exposition : **P**, impact limité au déni de service du job.

| Avis | Paquet, versions | Conditions | Correctif |
|---|---|---|---|
| GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f (critiques), GHSA-xw65-4hp5-5hc7 | `handlebars` 4.7.9 (`ts-jest`) | Objet AST non fiable passé à `compile`/`precompile` ; « les applications qui ne passent que des chaînes ne sont pas concernées » | 4.7.10 |
| GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr | `brace-expansion` 1.1.18 / 2.1.4 / 5.0.9 | Motif glob hostile | 1.1.21 / 2.1.7 / 5.0.12 |
| 7 avis fast-uri (GHSA-7p8r-x3mc-p8w7…) | `fast-uri` 3.1.4 (`ajv`) | URI hostile validée par ajv | 3.1.8 |
| GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh | `js-yaml` 3.15.0 / 4.3.0 | YAML hostile | 3.15.2 / 4.3.2 |
| GHSA-2v37-7h3g-55p8 | `nanoid` 3.3.16 (`postcss`) | Générateur personnalisé de taille 0 | 3.3.20 |
| GHSA-68fv-2mgg-jv7q | `source-map-js` 1.2.1 (`postcss`) | Carte de source hostile | 1.2.2 |

## 5. Correctifs appliqués

| Fichier | Changement | Justification |
|---|---|---|
| `web/package.json` | `next` 16.3.6 → **16.3.8** (épinglage exact conservé) ; `axios` ^1.19.0 → **^1.20.0** | Correctifs de patch et mineur, sans changement d'API |
| `pnpm-lock.yaml` | Rafraîchissement **des seules transitives vulnérables, dans les plages de leurs parents** (`pnpm update -r --lockfile-only <paquets>`, puis `--depth Infinity` pour fast-uri, nanoid et source-map-js) | Aucun manifest parent changé, **aucun override** |
| `pnpm-lock.yaml` (js-yaml 3) | `js-yaml` 3.15.0 → 3.15.2 pour `@istanbuljs/load-nyc-config` (plage `^3.13.1`) | `pnpm update` ne re-résolvait pas cette branche. `--fix-lockfile` la résolvait mais effaçait aussi tous les `hasBin`. Seules la version et l'intégrité ont donc été reportées : intégrité identique à celle du registre, dépendances inchangées (`argparse ^1.0.7`, `esprima ^4.0.0`). `pnpm install --lockfile-only` puis `--frozen-lockfile` l'acceptent |
| `api/Dockerfile`, `web/Dockerfile` | `node:22.17.1-alpine3.22@sha256:5539…ea59` → `node:22.23.3-alpine3.23@sha256:baf6…1c5a` (index multi-arch ; amd64 `sha256:4894…2b3a`) | 4 publications de sécurité Node manquantes. Aucune 22.23.x n'est publiée sur Alpine 3.22 (`22-alpine3.22` s'arrête en 22.22.x) : passage à Alpine 3.23. Image publiée le 23/09/2026 |
| `api/src/common/runtime-dependency-advisories.spec.ts` | Garde 1-22H : `proxy-addr` chargé par Express ≥ 2.0.8 ; la charge de l'avis (`::ffff:10.0.0.0/8`, `::/1`) n'approuve pas une IPv4 quelconque ; une adresse exacte reste seule approuvée | Même modèle que 1-12F (copie réellement chargée par Express) |

Ni `latest` général, ni `fix --force`. Aucune alerte supprimée ou ignorée.

## 6. Avis non résolus

Trois catégories distinctes, à ne pas additionner.

### 6.1 Alertes du lockfile (`pnpm audit`, OSV)

| Avis | Chemin | Raison | Exposition | Suite |
|---|---|---|---|---|
| GHSA-vfj7-8cjw-p6xm, CVE-2026-93687 (élevé) | `braces` 3.0.3 via `micromatch` 4.0.8 (`lint-staged`, `shadcn > fast-glob`, `eslint-config-next`) | **Aucune version corrigée publiée** (3.0.3 est la dernière ; l'avis indique « patched: none ») | **NA** prod : motifs issus de la configuration du dépôt. CI : **P**, déni de service du job seulement | Surveiller ; pas d'override possible |
| GHSA-hp3w-g68c-fv3c, CVE-2026-97058 (modéré) | `sprintf-js` 1.0.3 via `jest > … > js-yaml 3 > argparse 1` | Aucune version corrigée (dernière : 1.1.3) | **NA** : l'attaquant doit contrôler la chaîne de format ; celles d'argparse sont constantes | Surveiller |

### 6.2 Alertes des outils CLI hors lockfile

Ces CLI sont installés à la volée par `npx` dans `rollback.yml`. `pnpm audit` ne les voit pas ;
ils ont été contrôlés à part dans OSV.

| Outil | Dépendances vulnérables | Raison | Exposition |
|---|---|---|---|
| `vercel@61.1.0` | Versions exactes `undici` 5.29.0 (13 avis), `sandbox` 4.4.0 (2), `smol-toml` 1.5.2 (3) | Mêmes versions dans la dernière publication (64.0.2) : aucun correctif côté éditeur | **P**, faible : lancé seulement par `rollback.yml` (manuel, environnement protégé), face à l'API Vercel |
| `@railway/cli@5.63.1` | `tar` ^6.1.11 → 6.2.1 (12 avis) | La dernière version (5.68.0) déclare toujours `tar ^6` | **P**, faible : `tar` décompresse en postinstall l'archive du binaire téléchargée depuis les releases Railway ; il faudrait une archive malveillante |

Seuls les éditeurs peuvent corriger ces alertes. Installer ces CLI via un lockfile dédié plutôt
que par `npx` rendrait leurs dépendances **reproductibles et auditables**, mais **ne corrigerait
pas** ces vulnérabilités : les mêmes versions seraient figées. Un override de `undici`, `sandbox`,
`smol-toml` ou `tar` sous ces CLI demanderait une revalidation de `vercel rollback` (1-22G § 3)
et de l'installation de Railway : à traiter dans un lot distinct s'il est retenu.

### 6.3 Images système non scannées

Les paquets Alpine des images `node:22.23.3-alpine3.23` (OpenSSL, musl, BusyBox, etc.) et les
images de `docker-compose.prod.yml` n'ont été scannés par **aucun** outil : ni Trivy ni Grype
n'étaient disponibles. Ce n'est ni un résultat « sans alerte » ni un risque démontré : leur
exposition est **indéterminée** (§ 8).

## 7. Vérifications

Toutes exécutées dans la copie isolée, sauf mention contraire.

| Contrôle | Résultat |
|---|---|
| `pnpm install --lockfile-only` puis `pnpm install --frozen-lockfile` (`CI=true`) | OK, politique de chaîne d'approvisionnement pnpm validée ; versions chargées : next 16.3.8, axios 1.20.0, proxy-addr 2.0.8 (copie d'Express) |
| `pnpm audit` / OSV.dev après correction | 2 avis, ceux du § 6 |
| API : `nest build` ; `jest` (unitaires) | OK ; **102 suites, 1 864 tests** |
| API : ESLint du spec modifié | OK |
| API e2e (isolation 1-22D.1 : `jest-e2e.json` et `e2e-app-config`, MongoDB éphémère) : `trust-proxy`, `auth-anti-abuse`, `invitation-rate-limiting`, `test-config-isolation`, `auth-production-config`, `app` | **6 suites, 147 tests** OK. Choix : proxy-addr détermine `req.ip`, donc la confiance proxy et la limitation de débit. Paiements et MongoDB : aucune dépendance modifiée sur ces chemins (axios est côté navigateur) |
| Web : `lint`, `test:i18n`, `i18n:coverage`, `test:security-headers` (7/7), `build`, `legal-archive check` | OK |
| **CSP** (`next start`) : `/`, `/auth/login`, `/offline`, `/sales` | Nonce présent et renouvelé à chaque requête, `'strict-dynamic'`, pas d'`'unsafe-inline'` pour les scripts. Toutes les balises `<script>` portent le nonce (19/19, 23/23, 20/20, 8/8) |
| **PWA** : requêtes d'installation de `sw.js` rejouées | 7 ressources fixes en 200 ; shell `/app/catalog` en HTML 200, sans redirection, CSP à nonce ; **46/46** chunks `/_next/static` en 200 ; 11 pages publiques × FR/EN sans erreur, avec le bon `lang` ; `sw.js` et `manifest.webmanifest` servis |
| Images Docker (contexte = fichiers suivis seulement) | `api` et `web` construites. API : Node v22.23.3, Alpine 3.23.6, utilisateur `node`, Sharp 0.35.5 / libvips 8.18.7 fonctionnel, proxy-addr 2.0.8 |
| Démarrage de l'image API, réseau Docker `--internal` + `mongo:7` jetable, valeurs factices | Migrations de pré-déploiement OK ; `/health` → 200 ; `/auth/login` (compte inexistant) → 401 |
| Démarrage de l'image web (standalone, Node 22.23.3) | `/`, `/offline`, `/app/catalog` : 200, tous les scripts portent le nonce (19/19, 20/20, 27/27) |

Conteneurs, réseau et serveurs locaux supprimés après usage.

### 7.1 Non-régression navigateur

**Cadre** : recette locale existante (`api/test/recipe`), lancée **depuis la copie isolée**, avec
le nouveau lockfile et un `next build` de production. MongoDB éphémère (`MongoMemoryReplSet`),
SasPay, stockage et anti-robot simulés, aucun `.env`. Playwright 1.57.0 et Chromium 1234 sont
des installations existantes ; rien n'a été installé. Pour bloquer **tout** appel externe, un relais
Playwright hors dépôt ajoute `--host-resolver-rules` à Chromium : seuls `127.0.0.1` et
`localhost` se résolvent. Les routes des simulations restent prioritaires.

| Parcours demandé | Scénario | Résultat |
|---|---|---|
| Navigation interne vers une page dont le JS n'est pas encore chargé, hydratation, CSP | `NAV` (1-22F), préchargements refusés | **5/5** : même document (aucun rechargement), nouveaux chunks chargés au clic (5, 1, 1), formulaire de connexion interactif, retour arrière puis ouverture d'un rayon, **0 violation CSP** |
| Connexion et requête authentifiée via axios | `NAV` | Connexion par l'interface, puis catalogue rendu avec la section créée pour le test : requête axios authentifiée réussie |
| Installation effective du service worker, page publique et catalogue hors ligne | `PWA` (1-22F) **sans sa phase v5 → v6**, déjà vérifiée en 1-22F et non rejouée. Variante dérivée dans la copie isolée seulement (3 modifications : v6 servi d'emblée, enregistrement v5 et mise à jour retirés, titre) | **6/6** : SW v6 actif et contrôlant ; copies `/`, `/guide`, `/offline` et shell avec leur CSP et nonce ; hors ligne, la copie **applique** sa CSP (gestionnaire injecté non exécuté, 1 violation attendue) ; `/guide` hors ligne sans violation ; lancement `/app` → catalogue hors ligne avec le produit ; page non préparée → écran hors ligne ; retour du réseau |
| Vente hors ligne conservée puis synchronisée une seule fois | `RT7` (1-15A) | **PASS** : vente en attente dans l'outbox pendant la coupure, aucune vente serveur avant reprise ; après reprise, **1 vente, 1 événement** ; rejeu du même `clientOperationId` sans nouvelle vente ni événement ; stock 25 → 22 partout |
| 429/503 + Retry-After : message, attente, tentative conservée sans recréation | **Aucun scénario existant** pour le panneau SasPay (1-22D n'avait pas de recette navigateur ; les scénarios 6 et 12 de la recette visent l'interface CamPay de 1-14D). Vérification ciblée **hors dépôt**, sur un seul parcours du compte de recette `proprietaire.actif` | **6/6** (détail ci-dessous) |

Vérification 429/503 (horloge Playwright, réponses de l'API simulées sur `POST …/payments`) :

| Cas | Attendu | Observé |
|---|---|---|
| 429 `PAYMENT_RATE_LIMITED`, `Retry-After: 4`, en-tête **exposé** | Message « Rien n'est perdu… », bouton désactivé 4 s | Désactivé à +3 s, réactivé à +5 s |
| 503 `PAYMENT_SERVICE_UNAVAILABLE`, `Retry-After: 30`, exposé | Message, bouton désactivé 30 s | Désactivé à +25 s, réactivé à +31 s |
| 429 avec les en-têtes CORS **de l'API réelle** | — | Retry-After illisible : repli fixe de **60 s** |
| 503 avec les en-têtes CORS de l'API réelle | — | Retry-After illisible : **aucun blocage**, message seul |
| Tentative conservée | Même UUID et même durée, jamais recréés | 5 envois avec le **même** `clientOperationId` et `monthly` ; intention présente dans `localStorage` ; **0** paiement créé pendant les refus |
| Nouvel essai réel (API de recette, SasPay simulé) | Un seul paiement | **1** paiement, créé avec l'UUID conservé ; **1** session SasPay simulée ; départ vers la page SasPay **simulée** |
| Appels externes | Aucun | Aucun |

**Constat antérieur au lot, non causé par les dépendances** : la configuration CORS de l'API
(`buildHttpCorsOptions`, `api/src/events/origin.helpers.ts`) ne déclare aucun `exposedHeaders`.
Or le web (Vercel) et l'API (Railway) sont sur deux origines distinctes : le navigateur ne peut
donc pas lire `Retry-After`. Effets en production :
- sur 429, attente fixe de 60 s au lieu du délai du serveur (1 à 60 s), sans perte de données ;
- sur 503 de capacité, les boutons restent actifs, contrairement à 1-22D (« les boutons sont
  désactivés jusque-là »). Un nouveau clic renvoie le **même** UUID, donc aucun doublon possible, mais il
  peut retomber sur la limite ;
- la synchronisation de l'outbox (1-11C.3 l'avait déjà signalé) retombe sur son backoff.

Ce comportement CORS ne dépend ni d'axios ni de Next. **Corrigé en 1-22H.1** :
`exposedHeaders: ['Retry-After']`, vérifié sur deux origines réelles
([phase-1-22h1-cors-retry-after.md](phase-1-22h1-cors-retry-after.md)).

Réserve : dans la vérification ciblée, le relevé CSP final a été lu après le départ vers la page
SasPay simulée. Il ne couvre donc pas le panneau ; la CSP des pages de l'application est couverte
par `NAV` et `PWA`.

## 8. Limites de couverture

- **Un audit sans alerte ne prouve pas l'absence de vulnérabilité** : il ne couvre que les avis publiés dans GHSA et OSV à la date du 14/10/2026.
- Paquets Alpine des images (OpenSSL, musl, etc.) : **non scannés** (§ 6.3). Le passage à Alpine 3.23.6 apporte les correctifs publiés, sans inventaire.
- Node côté **Vercel** : défini dans les réglages du projet, pas dans le dépôt (pas de champ `engines`) : **I**. À contrôler (22.x).
- Railway construit-il bien depuis `api/Dockerfile` ? Les documents 1-12E et 1-22G le supposent ; non observé ici.
- `docker-compose.prod.yml` : `mongo:7`, `minio/minio:latest`, `nginx:alpine` ne sont pas épinglés, donc versions effectives **I**. Version et hébergement du MongoDB de production : **I**.
- Arbres complets de `vercel` et `@railway/cli` : seules les dépendances exactes ou résolues au premier niveau ont été contrôlées.
- Navigateur : Chromium 1234 seul (ni Firefox ni Safari), émulation hors ligne de Playwright (cf. 1-11C.3 : un vrai Chrome réellement coupé du réseau n'a pas été testé). Le 429/503 du panneau a été vérifié par une vérification ciblée hors dépôt, faute de scénario existant.
- Les actions GitHub épinglées ne font l'objet d'aucun avis dans OSV. GitHub ne publie pas toutes les compromissions d'actions dans ces bases.

## 9. Recommandations hors lot

1. **Épingler les images de `docker-compose.prod.yml`** par tag et digest, comme 1-12E (lot distinct ; MinIO `latest` en particulier).
2. **Déplacer `shadcn` en `devDependencies`** : il n'est utilisé qu'au build. `pnpm audit --prod` et l'inventaire de production seraient plus justes. Effet nul sur Vercel et le stage de build Docker, qui installent tout.
3. Réserver `http://localhost:9000` de `images.remotePatterns` au développement (réduction de la surface SSRF de l'optimiseur d'images).
4. ~~Exposer `Retry-After` dans le CORS de l'API~~ : fait en 1-22H.1 ([rapport](phase-1-22h1-cors-retry-after.md)).
5. Ajouter un scanner d'images (Trivy ou Grype) et `pnpm audit --audit-level=high` en CI, en **non bloquant** au départ, pour éviter qu'une alerte sans correctif (comme `braces`) bloque les fusions.
6. Outils de retour arrière (§ 6.2) : un lockfile dédié rendrait leurs dépendances reproductibles et auditables, **sans corriger** leurs vulnérabilités ; revalider `vercel rollback` à chaque montée de version.

## 10. Ordre de déploiement

Aucune migration ni variable. API et web sont indépendants.

1. Fusion vers `main` après CI verte (`ci.yml` : install figée, lint, tests, build).
2. **API (Railway)** en premier : nouvelle image Node 22.23.3 / Alpine 3.23. Seules dépendances JS modifiées côté API : `proxy-addr` et des outils de build. Vérifier `/health`, une connexion et la limitation de débit derrière le proxy (`TRUST_PROXY_*` inchangées). Paiements SasPay : aucune procédure particulière, puisque ni le code ni les dépendances de ce chemin ne changent, mais la règle 1-21B § 11 s'applique si un retour arrière devient nécessaire.
3. **Web (Vercel)** : next 16.3.8 et axios 1.20.0. Contrôler sur l'URL de prévisualisation : en-tête CSP à nonce, absence de violations dans la console, installation PWA et page `/offline`.
4. En cas de régression : retour arrière manuel par `rollback.yml` (1-22G), avec une cible explicite.

## 11. Fichiers modifiés

- `web/package.json`
- `pnpm-lock.yaml`
- `api/Dockerfile`, `web/Dockerfile`
- `api/src/common/runtime-dependency-advisories.spec.ts`
- `docs/architecture/phase-1-22h-dependency-security.md` (ce rapport)

## 12. Ressources temporaires

Supprimées après vérification : images Docker `sm-api:1-22h` et `sm-web:1-22h`, copie isolée et
contextes de build, relais Playwright, scripts et résultats de la vérification ciblée. La stack
de recette a été arrêtée par sa propre commande (`recipe.js stop`), qui supprime MongoDB
éphémère, journaux et copie web. Aucun nettoyage Docker global ; Docker Desktop reste ouvert ;
`mongo:7` (utilisée pour le test de démarrage de l'API) et la base
`node:22.23.3-alpine3.23`, tirée par digest pour les builds, restent dans le cache Docker local,
comme les autres images. Les dossiers `%TEMP%/mongo-mem-*` présents sont antérieurs au lot et
n'ont pas été touchés.
