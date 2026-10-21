# Stock Master — Application de gestion

Application collaborative de gestion des ventes et du stock pour **Stock Master**.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Stack technique](#stack-technique)
3. [Carte du dépôt](#carte-du-dépôt)
4. [Démarrage local](#démarrage-local)
5. [Variables et services externes](#variables-et-services-externes)
6. [Tests et recette](#tests-et-recette)
7. [Rôles utilisateurs](#rôles-utilisateurs)
8. [Conventions et circuit de travail](#conventions-et-circuit-de-travail)
9. [Dépannage](#dépannage)
10. [Déploiement production](#déploiement-production)
11. [CI/CD et rollback](#cicd-et-rollback)

---

## Fonctionnalités

- **Catalogue produits** organisé par sections (catégories hiérarchiques)
- **Suivi des ventes** avec historique complet et journal d'audit immuable
- **Corbeille** : suppression douce avec restauration ou suppression définitive
- **Analytique** : KPIs globaux, classements produits/vendeurs, tendance mensuelle, filtre par mois
- **Convertisseur EUR ↔ FCFA** intégré (taux fixe officiel : 1 EUR = 655,957 XOF)
- **Notifications temps réel** via WebSocket (Socket.IO) à chaque création/modification
- **PWA** installable sur Android, iOS et desktop
- **Commerces multi-membres** : rôles Propriétaire, Administrateur et Vendeur,
  droits délégables un par un, invitations par lien
- **Péremption et stock** : date de péremption et seuil de stock faible par
  produit, suivi par lots (vente FEFO, lots remis au client), mise à l'écart,
  pertes et alertes de péremption — lots et alertes activables par commerce
  ([voir plus bas](#fonctionnalités-activables-par-commerce))
- **Ventes hors connexion** avec file locale, conflits visibles et
  régularisation par un responsable
- **Notifications push** sur l'appareil, centre de notifications
- **Contact WhatsApp** prioritaire (lien `wa.me`, sans API), réseaux sociaux
  officiels et assistance par e-mail

## Stack technique

| Couche | Technologie |
|---|---|
| API | NestJS 11 · TypeScript · Mongoose · `@nestjs/jwt` · Socket.IO |
| Web | Next.js 16 (App Router) · React 19 · TypeScript 5 · Tailwind CSS 4 · `@base-ui/react` |
| Base de données | MongoDB 7 (replica set, requis par les transactions) |
| Stockage images | S3 compatible, bucket privé et URL signées : MinIO en dev, Cloudflare R2 en production |
| Reverse proxy | Nginx (pile Docker de production uniquement) |
| Monorepo | pnpm workspaces |
| Qualité | Husky + lint-staged + ESLint + Prettier |

## Carte du dépôt

| Chemin | Contenu | Points d'entrée |
|---|---|---|
| `api/src/` | API NestJS, un dossier par domaine (`auth`, `organizations`, `products`, `sales`, `subscriptions`, `push`, `notifications`, `support`, `legal`, `trash`…) | `main.ts`, `app.module.ts` ; gardes globales dans `guards/` et `common/` |
| `api/src/migrations/` | Migrations idempotentes et outils opérateur | `predeploy-migrations.ts` (liste `PREDEPLOY_MIGRATIONS`) |
| `api/test/` | E2E Jest (MongoDB éphémère) ; `recipe/` = recette isolée | [api/README.md](api/README.md#tests), [api/test/recipe/README.md](api/test/recipe/README.md) |
| `web/src/app/` | Pages Next.js : publiques (FR, et EN sous `/en`), `auth/`, application sous `app/` | `layout.tsx` (racine), `app/layout.tsx` (shell connecté), `proxy.ts` (langue, CSP) |
| `web/src/i18n/` | Textes FR/EN : `resources/` (interface), `documents/` (guides, pages juridiques) | `resources/index.ts` |
| `web/src/lib/` | Client API, hors ligne, push, règles partagées | `api.ts`, `legal/site-identity.ts` (coordonnées, documents publics) |
| `web/scripts/` | Contrôles web (i18n, archive juridique, tests ciblés) | [web/README.md](web/README.md#contrôles-et-tests) |
| `docs/architecture/` | Un rapport par lot : règles métier, migrations, limites | Rapport du lot concerné |
| `docker-compose.yml` | Services de dev : MongoDB (`rs0`), MinIO, Mongo Express | — |
| `scripts/mongo/init-replica-set.js` | Initialisation idempotente du replica set | Lancé par le service `mongo-rs-init` |

---

## Démarrage local

### Trois façons de faire tourner Stock Master

| Usage | Données | Commande de départ | Où |
|---|---|---|---|
| **Développement** | Persistantes, dans les volumes Docker | `docker compose up -d` puis API et web en mode dev | Ci-dessous |
| **Recette isolée** | Fictives, MongoDB en mémoire, supprimées à l'arrêt | `node api/test/recipe/recipe.js start` | [api/test/recipe/README.md](api/test/recipe/README.md) |
| **Tests automatisés** | Éphémères, jamais la base de dev | `pnpm --filter api test`, `pnpm --filter api test:e2e` | [Tests et recette](#tests-et-recette) |

La recette et les tests n'utilisent pas Docker et ne touchent jamais la base
de développement.

### Prérequis

| Outil | Version | Remarque |
|---|---|---|
| Node.js | 22 | Version de la CI |
| pnpm | 11.18.0 | Fixée par `packageManager` : `corepack enable` suffit |
| Docker Desktop | avec Docker Compose | Développement uniquement |
| Git | — | — |

Les commandes se lancent depuis la racine du dépôt. Quand la syntaxe
PowerShell diffère de Bash/WSL, les deux sont données.

### 1 · Installer

```bash
git clone https://github.com/DatengTankoua/stock-master.git
cd stock-master
pnpm install
```

### 2 · Créer les fichiers d'environnement

Sans écraser un fichier existant :

```bash
# Bash / WSL
cp -n api/.env.example api/.env
cp -n web/.env.example web/.env.local
```

```powershell
# PowerShell
if (-not (Test-Path api/.env)) { Copy-Item api/.env.example api/.env }
if (-not (Test-Path web/.env.local)) { Copy-Item web/.env.example web/.env.local }
```

Les valeurs d'exemple pointent vers les services locaux et suffisent pour
démarrer. Leur détail est dans les `.env.example` eux-mêmes (voir
[Variables et services externes](#variables-et-services-externes)).

### 3 · Démarrer MongoDB (replica set) et MinIO

```bash
docker compose up -d
docker compose ps -a
```

- `mongo` démarre avec `--replSet rs0`. Le service ponctuel `mongo-rs-init`
  initialise le replica set une seule fois : il doit être `Exited (0)`.
  Détails : [phase-0b7c-local-mongodb-replica-set.md](docs/infrastructure/phase-0b7c-local-mongodb-replica-set.md).
- L'URI d'exemple (`replicaSet=rs0&directConnection=true`) est celle qui
  convient depuis l'hôte.

### 4 · Créer le bucket MinIO (une seule fois)

En ligne de commande, avec le client `mc` inclus dans l'image MinIO
(identifiants de dev de `docker-compose.yml`) :

```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin123
docker compose exec minio mc mb local/stockmaster-objects
docker compose exec minio mc anonymous get local/stockmaster-objects   # attendu : private
```

Ou depuis la console [http://localhost:9001](http://localhost:9001)
(`minioadmin` / `minioadmin123`) : **Buckets → Create Bucket** →
`stockmaster-objects` (valeur de `S3_BUCKET`).

Le bucket reste **privé** : l'API signe une URL à chaque lecture d'image.
Sans bucket, l'ajout de photo échoue, donc la création de produit aussi.

### 5 · Appliquer les migrations locales

Elles créent les mêmes index qu'en production et installent la garde des lots
et les index des alertes (sans rien activer). Le script ne lit pas `.env` :
l'URI se passe dans le shell.

```bash
# Bash / WSL
pnpm --filter api build
MONGODB_URI='mongodb://localhost:27017/stockmaster?replicaSet=rs0&directConnection=true' \
  pnpm --filter api migrate:predeploy
```

```powershell
# PowerShell
pnpm --filter api build
$env:MONGODB_URI = 'mongodb://localhost:27017/stockmaster?replicaSet=rs0&directConnection=true'
pnpm --filter api migrate:predeploy
Remove-Item Env:MONGODB_URI
```

Idempotentes : à relancer sans risque après chaque `git pull` qui ajoute une
migration.

### 6 · Lancer l'API et le web

Deux terminaux :

```bash
pnpm --filter api start:dev   # API, rechargement automatique
pnpm --filter web dev         # web
```

L'API lit `api/.env` **au démarrage** : redémarrer après une modification.
Le web lit les `NEXT_PUBLIC_*` au lancement de `pnpm dev` (et au build).

### 7 · URL et ports

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API (santé : `/health`) | http://localhost:4000 |
| MongoDB | `mongodb://localhost:27017` (replica set `rs0`) |
| MinIO API / console | http://localhost:9000 · http://localhost:9001 |
| Mongo Express | http://localhost:8081 |

### 8 · Premier compte

**Option A — compte de développement persistant.** L'inscription locale fonctionne
sans réseau grâce à la vérification anti-robot simulée (acceptée seulement
quand toutes les origines configurées sont locales).

1. Dans `api/.env` : `PUBLIC_REGISTRATION_ENABLED=true` et
   `TURNSTILE_SIMULATED=true`. Dans `web/.env.local` :
   `NEXT_PUBLIC_REGISTRATION_ENABLED=true` et
   `NEXT_PUBLIC_TURNSTILE_SIMULATED=true`. Redémarrer l'API et le web.
2. S'inscrire sur http://localhost:3000/auth/register : le commerce est créé,
   vous en êtes propriétaire (essai gratuit).
3. Sans `RESEND_API_KEY`, aucun e-mail ne part et la connexion refuse une
   adresse non confirmée. Confirmer **votre** compte local à la main :

   ```bash
   docker compose exec mongo mongosh stockmaster --quiet --eval 'db.users.updateOne({ email: "vous@exemple.test" }, { $set: { emailVerifiedAt: new Date() } })'
   ```

   Résultat attendu : `matchedCount: 1, modifiedCount: 1`. La commande est la
   même en PowerShell 7.3 ou plus récent. Ou via Mongo Express : base
   `stockmaster`, collection `users`, champ `emailVerifiedAt`.

**Option B — comptes fictifs prêts** (propriétaire, administrateur, vendeur,
commerces expirés…) : la [recette isolée](api/test/recipe/README.md). Rien
n'est conservé après l'arrêt.

### 9 · Arrêter, redémarrer, effacer

| Action | Commande | Données |
|---|---|---|
| Arrêter API et web | `Ctrl+C` dans chaque terminal | Conservées |
| Arrêter les conteneurs | `docker compose stop` | Conservées |
| Arrêter et retirer les conteneurs | `docker compose down` | **Conservées** (volumes gardés) |
| Redémarrer | `docker compose up -d`, puis l'étape 6 | Retrouvées ; `mongo-rs-init` ne réinitialise rien |

Les données de dev vivent dans les volumes Docker `mongo_data` et
`minio_data`, préfixés par le nom du projet Compose (le nom du dossier) :
`docker volume ls`.

> **Effacer toutes les données locales** (irréversible, hors parcours
> normal) : `docker compose down -v` supprime ces volumes. Ne jamais
> l'utiliser pour « réparer » un démarrage : voir [Dépannage](#dépannage).

### Activer les lots et les alertes en local

Après l'étape 5, dans `api/.env`, puis redémarrer l'API :

```env
PRODUCT_BATCHES_ENABLED=true
PRODUCT_BATCHES_ORGANIZATIONS=all
EXPIRY_ALERTS_ENABLED=true
EXPIRY_ALERTS_ORGANIZATIONS=all
```

`all` vaut pour tous les commerces **de votre base locale**. Pour un seul
commerce, mettre son identifiant d'organisation. Règles complètes :
[Fonctionnalités activables par commerce](#fonctionnalités-activables-par-commerce).

---

## Variables et services externes

Source de référence : les commentaires de
[api/.env.example](api/.env.example) et [web/.env.example](web/.env.example)
(obligatoire ou facultatif, bornes, défauts). Résumé :

| Besoin | Variables | Sans configuration |
|---|---|---|
| **Démarrer** | API : `MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGIN`, `PUBLIC_APP_URL` · web : `NEXT_PUBLIC_API_URL` | Les exemples suffisent en local |
| Photos et logos | `S3_*` (MinIO local) | Ajout de photo, donc de produit, impossible |
| Inscription | `PUBLIC_REGISTRATION_ENABLED`, Turnstile (`TURNSTILE_*`, `NEXT_PUBLIC_TURNSTILE_*`) | Inscription refusée (403 ou 503). Simulation locale : `TURNSTILE_SIMULATED=true` |
| E-mails | `RESEND_API_KEY`, `EMAIL_FROM` | Comptes créés non confirmés ; réinitialisation du mot de passe indisponible |
| Push | `WEB_PUSH_ENABLED`, `WEB_PUSH_VAPID_*` | Push désactivé ; le centre de notifications fonctionne |
| Lots, alertes | `PRODUCT_BATCHES_*`, `EXPIRY_ALERTS_*` | Désactivés (aucun commerce) |
| Paiements | `PAYMENT_PROVIDER_ACTIVE`, `SASPAY_*` | `none` : 503. Fournisseurs simulés : recette isolée seulement |
| Proxy | `TRUST_PROXY_*` | Aucun proxy approuvé (correct en local) |

- **Moment de lecture.** L'API lit ses variables au démarrage. Côté web,
  `NEXT_PUBLIC_*` et `S3_HOSTNAME` sont figées au build (et au lancement de
  `pnpm dev`) ; `CSP_IMAGE_ORIGINS` est lue à l'exécution.
- **Aucune valeur de production** ne figure dans les exemples ni ne doit y
  être copiée.

---

## Tests et recette

| Quoi | Commande | Référence |
|---|---|---|
| Tests unitaires API (tous / ciblés) | `pnpm --filter api test` · `pnpm --filter api test -- <motif>` | [api/README.md](api/README.md#tests) |
| E2E API (MongoDB éphémère, sans Docker) | `node api/test/recipe/recipe.js isolated api-e2e <motif>` | [api/README.md](api/README.md#tests) |
| Contrôles web (i18n, WhatsApp, push…) | `pnpm --filter web test:i18n`, `test:whatsapp-contact`… | [web/README.md](web/README.md#contrôles-et-tests) |
| Recette manuelle (comptes fictifs, lots, alertes, paiements simulés) | `node api/test/recipe/recipe.js start --product-batches --expiry-alerts` | [api/test/recipe/README.md](api/test/recipe/README.md) |

**En CI** (`.github/workflows/ci.yml`, sur push et PR vers `main` et `dev`) :

- API : `pnpm lint`, `pnpm test` (unitaires), `pnpm build` ;
- web : `pnpm lint`, `test:i18n`, `i18n:coverage`, `test:push-reconnect`,
  `pnpm build`, puis `legal-archive.mjs check`.

**Hors CI, à lancer à la main** : les e2e API, les autres scripts
`web/scripts/test-*.mjs` (dont `test:whatsapp-contact`), la recette et ses
campagnes navigateur (Playwright non installé par le dépôt), et les
vérifications sur vrais téléphones.

---

## Rôles utilisateurs

| Rôle | Droits |
|---|---|
| **Propriétaire** | Tous les droits, abonnement et transfert de propriété |
| **Administrateur** | Tous les droits délégables |
| **Vendeur** | Enregistrer des ventes et voir les siennes ; autres droits ajoutés un par un |

Les droits effectifs sont recalculés par l'API à chaque requête
(`effectivePermissions`) ; détails :
[phase-1-7a-permission-infrastructure.md](docs/architecture/phase-1-7a-permission-infrastructure.md).

---

## Conventions et circuit de travail

- **FR/EN.**
  - Aucun texte visible en dur : interface dans
    `web/src/i18n/resources/{fr,en}`, guides et pages juridiques dans
    `web/src/i18n/documents/`.
  - Les pages publiques ont une URL par langue (anglais sous `/en`).
  - `test:i18n` et `i18n:coverage` doivent passer.
- **Textes juridiques archivés.** Toute modification d'un texte soumis à
  acceptation exige une nouvelle version et son archivage
  ([Documents juridiques versionnés](#documents-juridiques-versionnés-1-16c2)).
- **Permissions.**
  - L'API est seule juge : gardes et `effectivePermissions` à chaque requête.
    Le web ne fait que masquer.
  - Une nouvelle permission passe par les catalogues de permissions
    ([phase-1-7b](docs/architecture/phase-1-7b-permission-application.md)).
- **Isolation des commerces.**
  - L'organisation vient toujours du contexte authentifié, jamais du corps de
    la requête.
  - Un objet d'un autre commerce répond 404
    ([phase-1-4e](docs/architecture/phase-1-4e-multitenant-isolation-gate.md)).
- **Migrations.**
  - Idempotentes, sans activation de fonctionnalité.
  - Celles qu'exige le démarrage entrent dans `PREDEPLOY_MIGRATIONS`.
- **Tests.**
  - Unitaires `*.spec.ts` à côté du code ; e2e `api/test/*.e2e-spec.ts` ;
    scripts web `web/scripts/test-*.mjs`.
  - Chaque lot documente ses règles et ses contrôles dans
    `docs/architecture/`.

**Circuit des branches.**

1. Créer une branche de travail (`feature/…`, `fix/…`, `chore/…`) depuis
   `origin/dev`.
2. Ouvrir une PR vers `dev`.
3. Ouvrir ensuite une PR de `dev` vers `main`. Un push sur `main` déploie
   (Railway, Vercel) : voir [CI/CD et rollback](#cicd-et-rollback).

**Avant une PR :**

```bash
pnpm lint
pnpm --filter api test && pnpm --filter api build
pnpm --filter web test:i18n && pnpm --filter web i18n:coverage && pnpm --filter web build
node web/scripts/legal-archive.mjs check --next-dir web/.next   # si une page publique a changé
```

Ajouter les e2e et les scripts web du domaine touché, ainsi qu'un rapport
dans `docs/architecture/` pour tout changement de règle.

---

## Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `EADDRINUSE`, ou Compose « port is already allocated » | Port 3000, 4000, 27017, 9000/9001 ou 8081 déjà pris | Trouver le processus : `netstat -ano \| findstr :4000` (Windows) ou `lsof -i :4000`. Autres ports : `PORT` (API), `pnpm --filter web exec next dev -p 3001` (web, puis ajuster `CORS_ORIGIN`, `PUBLIC_APP_URL` et `NEXT_PUBLIC_API_URL`), `MONGO_SERVICE_HOST_PORT` (MongoDB, puis `MONGODB_URI`) |
| « Cannot connect to the Docker daemon », erreur 500 de `dockerDesktopLinuxEngine` | Docker Desktop arrêté ou en cours de démarrage | Démarrer Docker Desktop, attendre « Engine running », relancer `docker compose up -d` |
| API bloquée à la connexion MongoDB, ou « Transaction numbers are only allowed on a replica set member » | Replica set non initialisé, ou URI sans `replicaSet=rs0` | `docker compose ps -a` (`mongo-rs-init` doit être `Exited (0)`), `docker compose logs mongo-rs-init`, puis `docker compose up -d mongo-rs-init`. Contrôle : `docker compose exec mongo mongosh --quiet --eval "rs.status().ok"` → `1`. **Ne pas** supprimer le volume |
| Index absent, activation des lots refusée, ou démarrage refusé en production | Migrations non appliquées | Étape 5 (`migrate:predeploy`) ; contrôles `--check` dans [Migrations](#migrations-à-exécuter-avant-lactivation-dune-version) |
| `MONGODB_URI requis.` | Migration lancée sans l'URI dans le shell | Le script ne lit pas `.env` : étape 5 |
| Inscription 403 ou 503, invitation 503 `INVITATION_LINK_UNAVAILABLE`, connexion « adresse non confirmée » | Variable absente | Étape 8 et [Variables et services externes](#variables-et-services-externes) |
| Photo refusée, image absente | Bucket MinIO manquant ou MinIO arrêté | Étape 4 ; `docker compose ps` |
| Seconde installation sur la même machine (ports ou noms de conteneur déjà pris) | MongoDB et Mongo Express sont paramétrables (`MONGO_SERVICE_CONTAINER_NAME`, `MONGO_SERVICE_HOST_PORT`, `MONGO_EXPRESS_CONTAINER_NAME`, `MONGO_EXPRESS_HOST_PORT`) ; MinIO ne l'est pas (nom `stockmaster-minio`, ports 9000/9001 fixes) | Nom de projet distinct (`docker compose -p <nom>`) et fichier de surcharge pour MinIO (`container_name`, `ports: !override`). Reporter les ports dans `MONGODB_URI` et `S3_ENDPOINT`. Côté web, si MinIO n'est pas sur 9000 : `CSP_IMAGE_ORIGINS=http://localhost:<port>`, sinon les photos sont bloquées par la CSP |
| « Another next dev server is already running » | Next 16 refuse un second `next dev` dans le même dossier `web/` | Utiliser le serveur déjà lancé, ou l'arrêter d'abord |
| Changement de `.env` sans effet | Lecture au démarrage ou au build | Redémarrer l'API ; relancer `pnpm dev`, ou reconstruire le web |

Règles métier détaillées : rapports de `docs/architecture/` (un par lot,
par exemple
[product-batches-expiry-losses.md](docs/architecture/product-batches-expiry-losses.md)).

---

## Déploiement production

Les services sont déployés séparément sur des plateformes managées :

| Service | Plateforme | Déclencheur |
|---|---|---|
| `web/` (Next.js) | Vercel | Push sur `main` (intégration GitHub native) |
| `api/` (NestJS) | Railway | Push sur `main` (intégration GitHub native) |
| Base de données | MongoDB Atlas | Managé |
| Stockage images | Cloudflare R2 (bucket privé, URL signées) | Managé |

### Variables d'environnement production

À configurer dans les dashboards Railway et Vercel :

**Railway (API)** :
```env
PORT=4000
MONGODB_URI=<uri-atlas>
JWT_SECRET=<au-moins-32-octets-aleatoires>   # openssl rand -base64 48
CORS_ORIGIN=https://<votre-domaine-vercel>.vercel.app
S3_ENDPOINT=https://<ACCOUNT_ID>.<jurisdiction>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY=<r2-access-key-id>
S3_SECRET_KEY=<r2-secret-access-key>
S3_BUCKET=stockmaster-prod
S3_FORCE_PATH_STYLE=false
TZ=Africa/Douala
```

`TZ` (1-16D) fixe le calendrier des mois : bornes de l'Analyse, de
l'historique mensuel exportable et du bilan mensuel. Au lancement au
Cameroun : `Africa/Douala` (UTC+1, sans heure d'été). Sans `TZ`, le fuseau du
conteneur s'applique (UTC sur `node:22-alpine`). Un nom inconnu bloque le
démarrage de l'API (sinon Node basculerait silencieusement en UTC) ; le
fuseau effectif est journalisé au démarrage (« Fuseau des bornes
mensuelles »). Changer `TZ` ne modifie aucune date enregistrée (toutes en
UTC) : seul le rattachement d'une vente proche de minuit à un mois change.
À définir dans Railway **avant** l'ouverture (configuration Railway actuelle
non consultée par le lot 1-16D).

**Vercel (Web)** :
```env
NEXT_PUBLIC_API_URL=https://<votre-service>.railway.app
```

#### Anti-abus de l'authentification (1-18C)

| Variable | Où | Défaut | Rôle |
|---|---|---|---|
| `TURNSTILE_SECRET_KEY` | API (secret) | vide | Clé secrète du widget Turnstile. Vide → toute inscription refusée (503) |
| `TURNSTILE_ALLOWED_HOSTNAMES` | API | vide | Noms d'hôte exacts acceptés dans la réponse `siteverify` (ex. `www.stock-master.app`). Requis avec la clé |
| `TURNSTILE_TIMEOUT_MS` | API | 5000 | Délai de `siteverify` (500–10000 ms) ; dépassé → 503 réessayable |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Web (public, build) | vide | Clé de site du même widget. Vide → formulaire d'inscription inactif |
| `AUTH_ACCOUNT_FAILURE_LIMIT` / `AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS` | API | 10 / 900 | Échecs de mot de passe par identifiant normalisé (login et routes par identifiants), fenêtre fixe. Au-delà : défi Turnstile (action `login`) exigé pour chaque essai |
| `AUTH_CHALLENGED_FAILURE_LIMIT` | API | 5 | Échecs APRÈS défi, par compte ET IP (/64 en IPv6), même fenêtre (1–20) |
| `INVITATION_EMAIL_RECIPIENT_LIMIT` / `INVITATION_EMAIL_RECIPIENT_WINDOW_SECONDS` | API | 5 / 86400 | E-mails de création de compte par adresse invitée, toutes invitations confondues |

Activation de Turnstile (aucun compte Cloudflare n'est configuré par le
dépôt) :

1. Dans Cloudflare, créer UN widget Turnstile pour le domaine du web
   (`www.stock-master.app`, et le domaine Vercel s'il sert aussi les
   formulaires). Mode conseillé : *Managed*. Il sert à l'inscription
   (action `register`), au défi de récupération d'accès de la connexion
   (action `login`) et, depuis 1-18D, aux demandes de lien de
   réinitialisation (`password-reset`) et de vérification d'e-mail
   (`email-verification`) ; aucune action n'est à déclarer dans Cloudflare.
   **Sans clé, ces deux demandes de lien sont refusées (503)** : configurer
   Turnstile AVANT de déployer l'API 1-18D.
2. Railway (API) : `TURNSTILE_SECRET_KEY` (secret) et
   `TURNSTILE_ALLOWED_HOSTNAMES` (mêmes noms d'hôte). Redémarrer : le mode
   effectif est journalisé (« Anti-robot de l'inscription : cloudflare »).
3. Vercel (web) : `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, puis redéployer (valeur
   inlinée au build).
4. Seulement ensuite, si l'inscription doit être ouverte :
   `PUBLIC_REGISTRATION_ENABLED=true` (API) et
   `NEXT_PUBLIC_REGISTRATION_ENABLED=true` (web).

Les clés de test publiques de Cloudflare et le mode simulé
(`TURNSTILE_SIMULATED`) sont refusés au démarrage dès que
`NODE_ENV=production`, quelles que soient les origines configurées. Recette
locale : `start --anti-bot=simulated` (API en `development`). Le web n'a pas de CSP : s'il en
reçoit une, autoriser `https://challenges.cloudflare.com` en `script-src` et
`frame-src`.

### Migrations à exécuter avant l'activation d'une version

**Règle : une migration requise par une version s'exécute AVANT que cette
version de l'API ne reçoive du trafic.** Railway et Vercel déploient
automatiquement à chaque push sur `main` : sans précaution, la nouvelle API
peut démarrer avant ses index. Deux façons de garantir l'ordre :

1. **Recommandé : la « Pre-deploy Command » de Railway** (service API,
   Settings → Deploy). Elle s'exécute après la construction de l'image et
   **avant** le démarrage du nouveau déploiement, avec les variables du
   service (donc `MONGODB_URI`). Si elle sort avec un code non nul, elle
   n'est pas relancée et **le déploiement ne se poursuit pas** : la version
   en service reste active. Elle s'exécute à chaque déploiement ; toutes les
   migrations sont idempotentes (sans effet si l'index exact existe).
   Source : documentation Railway « Pre-deploy Command » et « Config as
   code » (`deploy.preDeployCommand`), consultée le 7 octobre 2026.
2. À défaut, depuis un poste ou un job contrôlé, **avant la fusion sur
   `main`**, avec l'URI de la base de production (jamais commitée).

#### Commande exacte depuis l'image de production

L'image `api/Dockerfile` ne contient **pas** pnpm (étape `runtime`) : les
scripts `pnpm --filter api migrate:*` n'y fonctionnent pas. Les programmes
compilés sont dans `/app/api/dist/migrations/` (dossier de travail de
l'image : `/app/api`), avec les seules dépendances de production. Les chemins
absolus ci-dessous fonctionnent quel que soit le dossier de lancement.

Pre-deploy Command (une seule commande, sans shell) :

```
node /app/api/dist/migrations/predeploy-migrations.js
```

Elle lance dans l'ordre, et s'arrête au premier échec :

| Migration | Depuis | Pourquoi elle est requise |
|---|---|---|
| `create-sale-operations-index.js` | 1-11C.1 | Vérifiée au démarrage en production : sans elle, l'API ne démarre pas |
| `create-subscription-period-indexes.js` | 1-14B | Idem |
| `create-subscription-payment-indexes.js` | 1-14D.2B | Idem |
| `create-subscription-payment-reconciliation-indexes.js` | 1-14D.2G | Requise par le CLI de rapprochement (`--apply`) |
| `create-push-notification-indexes.js` | 1-16A | Vérifiée au démarrage en production, même avec `WEB_PUSH_ENABLED=false` |
| `create-support-request-indexes.js` | 1-16C.1 | Index TTL `createdAt_1_ttl` (`expireAfterSeconds = 2592000`, 30 jours) du registre `support_requests`. Non bloquante au démarrage : sans elle, l'assistance fonctionne mais le registre n'expire jamais |
| `create-legal-acceptance-indexes.js` | 1-16C.2 | Collections `legal_acceptances` et `legal_document_versions`, index `{ userId, acceptedAt }`. Non bloquante au démarrage |
| `create-rate-limit-indexes.js` | 1-18C | Index TTL `expiresAt_1_ttl` de `rate_limit_buckets` (plafonds persistants par compte et par destinataire d'invitation). Migration d'index uniquement. Nettoyage : non bloquante au démarrage, l'exactitude des plafonds n'en dépend pas. Lecture seule : `--check` |
| `create-invitation-account-token-index.js` | 1-18B | Index partiel `accountTokenHash_1` de `organizationinvitations` (lien de création de compte d'un invité). Migration d'index uniquement, aucune donnée. Index de performance, non bloquant au démarrage ; aussi déclaré dans le schéma (mêmes nom et options), donc compatible avec `autoIndex`. Lecture seule : `--check` |
| `create-sale-history-indexes.js` | 1-20E | Historique paginé des ventes. Performance, non bloquant |
| `create-product-page-indexes.js` | 1-20F | Liste paginée des produits. Performance, non bloquant |
| `install-product-batches.js` | Lots A à C | Garde du suivi par lots (validateur, index des lots, des pertes et des régularisations). Équivaut à `migrate:product-batches -- --install --apply`. **N'active rien** |
| `install-expiry-alerts.js` | Lot C | Index des alertes de péremption et première date de contrôle des cibles datées. Équivaut à `migrate:expiry-alerts -- --apply`. **N'active rien** |

L'ordre réel est celui de `PREDEPLOY_MIGRATIONS`
(`api/src/migrations/predeploy-migrations.ts`). Ces migrations sont
idempotentes : Railway les rejoue à chaque déploiement sans effet si tout est
en place. Les migrations des lots et des alertes ont été exécutées avec succès
en production (information du propriétaire, 21 octobre 2026) : aucune
exécution manuelle n'est nécessaire.

**Échec partiel :** chaque migration s'exécute à part et s'arrête au premier
échec. Les index déjà créés par les étapes précédentes **restent en place**
(rien n'est annulé, aucun index ni aucune donnée n'est supprimé
automatiquement). Ces index sont compatibles avec la version en service ; il
suffit de corriger la cause puis de relancer, les étapes déjà faites étant
sans effet.

Pour la seule migration de l'assistance :
`node /app/api/dist/migrations/create-support-request-indexes.js`.
Chaque migration échoue sans rien écraser si un index homonyme a une autre
configuration, ou si des doublons empêchent un index unique : le
déploiement est alors interrompu, à analyser avant de recommencer. Les outils
opérateur (`subscription:grant`, rapprochement, rattrapage d'historique) ne
sont **jamais** lancés par le pré-déploiement.

Réglages conseillés dans Railway :

- **Pre-deploy Timeout** : une valeur explicite (par exemple 300 secondes ;
  sans réglage, aucune limite) pour qu'une connexion bloquée fasse échouer
  le déploiement au lieu de le suspendre ;
- si l'accès réseau d'Atlas est limité par adresse IP, vérifier que le
  pré-déploiement y a accès comme l'API.

**Limites, à vérifier dans le tableau de bord Railway** (configuration non
présente dans le dépôt : ni `railway.json` ni `railway.toml`). La commande
dépend du constructeur et des chemins réels de l'image ; elle a été testée
avec les seules dépendances de production installées depuis le lockfile, mais
**ni l'image Docker ni Railway n'ont été vérifiés** (rapport 1-16C.2). Ces
chemins supposent que le service est construit avec `api/Dockerfile` et la racine du
dépôt comme contexte (`RAILWAY_DOCKERFILE_PATH=api/Dockerfile`, ou
équivalent). Avec un autre constructeur (Railpack), le dossier de l'image
diffère : depuis le dossier `api` du service, utiliser
`node dist/migrations/predeploy-migrations.js`.

#### Vérification en lecture seule

Sans aucune création ni lecture de données (liste des index uniquement ;
sortie 1 si l'index est absent ou différent) :

```
node /app/api/dist/migrations/create-support-request-indexes.js --check
# Attendu : « support_requests : index createdAt_1_ttl présent, createdAt,
#            expireAfterSeconds=2592000 (lecture seule). »
node /app/api/dist/migrations/create-legal-acceptance-indexes.js --check
```

Équivalent `mongosh`, en lecture seule :
`db.support_requests.getIndexes()` doit contenir
`{ key: { createdAt: 1 }, name: "createdAt_1_ttl", expireAfterSeconds: 2592000 }`.

#### Depuis un poste (dépôt cloné)

```bash
pnpm --filter api build
MONGODB_URI=<uri-atlas> pnpm --filter api migrate:predeploy
MONGODB_URI=<uri-atlas> node api/dist/migrations/create-support-request-indexes.js --check
```

Les autres migrations du dépôt (`migrate:*` dans `api/package.json`) sont
décrites dans les rapports de leurs lots (`docs/architecture/`).

### Fonctionnalités activables par commerce

**Installer n'est pas activer.** Le pré-déploiement installe les structures
(validateurs, index) ; il n'ouvre aucune fonctionnalité. L'activation passe par
des variables du service API, lues à chaque requête :

| Drapeau | Portée | Couvre |
|---|---|---|
| `PRODUCT_BATCHES_ENABLED` | `PRODUCT_BATCHES_ORGANIZATIONS` | Suivi par lots, vente par lots, mise à l'écart, pertes, régularisations |
| `EXPIRY_ALERTS_ENABLED` | `EXPIRY_ALERTS_ORGANIZATIONS` | Alertes de péremption (lots et produits sans lots), réglage du délai |

- Drapeau à `true` **et** portée explicite : liste d'identifiants
  d'organisation (pilotes) ou `all`. Portée absente, vide ou invalide :
  **aucun** commerce. Changer la portée demande un redémarrage de l'API.
- Le web n'a pas de règle propre : il suit `features` de `/auth/context`.
- État en production (information du propriétaire, 21 octobre 2026) : lots
  et alertes activés pour **tous** les commerces ; push activé et testé sur
  de vrais téléphones.
- Détails :
  [product-batches-expiry-losses.md § 6](docs/architecture/product-batches-expiry-losses.md).

**Retour arrière après des pertes.** Désactiver un drapeau ou retirer un
commerce de la portée est sûr et se fait sans changer de version (un commerce
qui a déjà des produits suivis ne peut alors plus les vendre). En revanche,
**dès qu'une perte est enregistrée, redéployer une API antérieure aux pertes
n'est pas sûr** : sa purge écrirait un ajustement de stock faux et définitif.
Corriger en avançant (nouvelle version compatible). Procédure et conditions :
[product-batches-expiry-losses.md § 8](docs/architecture/product-batches-expiry-losses.md).

**Limites connues.**

- Hors ligne : seules les ventes ; pertes, mise à l'écart et réceptions
  exigent une connexion. Les quantités par lot ne sont pas vérifiées hors
  ligne ; un refus à la synchronisation devient un conflit visible
  ([product-batches-sales.md § 4](docs/architecture/product-batches-sales.md)).
- Push : messages génériques ; à la déconnexion, l'appareil est détaché
  (préférences conservées) et rattaché sans nouvelle demande à la
  reconnexion du même utilisateur
  ([push-permission-reprompt.md](docs/architecture/push-permission-reprompt.md)).
  Le centre de notifications reste la référence.

### Documents juridiques versionnés (1-16C.2)

Les conditions d'utilisation, les conditions d'abonnement et la politique de
confidentialité sont acceptées (ou présentées) à l'inscription et à la
création d'un compte par invitation. Leur texte affiché est archivé dans
`api/src/legal/archive/` avec son empreinte. **Toute modification du texte
affiché** (y compris un prix ou une coordonnée rendus dans ces pages) exige
une nouvelle version dans `web/src/lib/legal/site-identity.ts`, puis :

```bash
node api/test/recipe/recipe.js isolated web-build --legal-archive=write --published-at=AAAA-MM-JJ
```

Le build vérifié (`isolated web-build`, et l'étape de la CI web) échoue tant
que le texte affiché diffère de l'archive de sa version. Une version archivée
n'est jamais réécrite. L'invite des comptes existants dans l'application
reste désactivée tant que `LEGAL_ACCEPTANCE_PROMPT_ENABLED` n'est pas
exactement `true` (variable du service API).

## CI/CD et rollback

Le dossier `.github/workflows/` contient trois workflows GitHub Actions
(durcis en 1-22G : [rapport](docs/architecture/phase-1-22g-ci-cd-hardening.md)) :

| Fichier | Déclencheur | Description |
|---|---|---|
| `ci.yml` | Push et pull requests vers `main` et `dev` | Lint, tests, build ; aucun secret |
| `deploy.yml` | Fin de déploiement Railway/Vercel (`deployment_status`) | Health check API + Web ; un échec rend le run rouge. **Aucun rollback automatique** |
| `rollback.yml` | Manuel (`workflow_dispatch`) | Rollback à **cible explicite** : déploiement Vercel nommé ; commit de `main` pour l'API, après la procédure des paiements SasPay (1-21B § 11, 1-21E § 10.1) |

Le déploiement lui-même est fait par les intégrations Git de Railway et de
Vercel, hors GitHub Actions.

### Secrets GitHub requis

Les secrets de déploiement (`RAILWAY_TOKEN`, `VERCEL_*`) sont destinés à
l'environnement GitHub **`production-operations`** (Settings → Environments),
réservé à la branche `main`. **À configurer** : tant que l'environnement n'est
pas créé avec cette règle et que ces secrets restent des secrets du dépôt, ils
ne sont pas protégés. Si un propriétaire est seul relecteur, ne pas activer
*Prevent self-review*, qui rendrait le retour arrière inaccessible. Détails,
protection de `main` et attente de la CI (Railway, Vercel) : rapport 1-22G § 4.
Les URL de santé restent des secrets du dépôt (**Settings → Secrets and
variables → Actions**) :

| Secret | Description |
|---|---|
| `RAILWAY_TOKEN` | Railway → votre projet → Settings → Tokens |
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_ORG_ID` | Champ `orgId` dans `web/.vercel/project.json` |
| `VERCEL_PROJECT_ID` | Champ `projectId` dans `web/.vercel/project.json` |
| `API_HEALTH_URL` | URL du endpoint `/health` de l'API Railway |
| `WEB_HEALTH_URL` | URL de production du frontend Vercel |

