# Documentation et nettoyage ciblé

Branche `chore/documentation-cleanup`, créée depuis `origin/dev` (`a874c31`).
L'arbre était propre : rien à préserver, ni stash ni reset. Aucun commit,
push, déploiement, migration ni changement de configuration. Aucune règle
métier, permission, contrat d'API, clé de stockage ni donnée modifiés.

**Informations du propriétaire (21 octobre 2026)**, sur lesquelles reposent
les textes publics :

- suivi par lots et alertes de péremption activés pour **tous** les
  commerces (`all`) ;
- notifications push activées en production et testées sur de vrais
  téléphones ;
- migrations des lots et des alertes déjà exécutées en production. Elles
  n'ont pas été relancées.

## 1. Documentation actualisée

**Guide d'utilisation FR/EN** (`web/src/i18n/documents/guide/`). Les ancres
existantes sont conservées.

- **Nouvelle section `#lots` « Lots, péremption et pertes »** :
  - activation du suivi et répartition du stock existant ;
  - réceptions ;
  - vente par lots avec proposition FEFO et confirmation des lots remis ;
  - lots sans date et lots périmés ;
  - stock physique et stock vendable ;
  - mise à l'écart, pertes et correction d'une perte ;
  - alertes de péremption et réglage du délai.
- **Autres sections complétées** :
  - connexion et choix du commerce ;
  - droits liés au stock, et « Une option manque ? » ;
  - date sur une fiche sans lots (ne bloque pas les ventes) ;
  - vente avec les vrais libellés (« Vendre », « Confirmer la vente ») ;
  - corbeille : sélection, puis « Restaurer » ou « Supprimer
    définitivement » ;
  - hors ligne : conflits, « Corriger », régularisation ou demande à un
    responsable ;
  - notifications : nouvelles catégories, déconnexion et reconnexion,
    « Relier cet appareil », « Plus tard » (7 jours), « abonnement » de
    l'appareil sans aucun paiement ;
  - assistance : WhatsApp en premier, conversation non synchronisée, e-mail
    en alternative.
- **Retrait** de la mise en garde « push non testé sur de vrais
  téléphones ».

**Article « Gérer le stock d'une boutique » FR/EN** :

- date de péremption et lien vers le suivi par lots ;
- réceptions par lot ;
- pertes sur un lot ;
- bloc « À noter à part » corrigé : seules les pertes des produits **sans
  lots**, les retours et les comptages restent à noter hors de l'outil.

**Accueil FR/EN** (`public.ts`) :

- bénéfice « stock » : seuil, date, lots, pertes séparées des ventes ;
- bloc « aide » : alertes de péremption, WhatsApp, puis Assistance.

L'accueil ne disait nulle part que ces fonctions étaient indisponibles. La
FAQ et la page Contact étaient déjà à jour. Le numéro WhatsApp reste
centralisé (+237 651 563 665), et aucun texte ne promet de réponse
immédiate.

**Textes d'interface devenus faux** (`catalog.ts`, FR/EN) :

- `batches.enableWarning` annonçait que le produit ne pourrait pas être
  vendu « tant que la vente par lots n'est pas disponible » ;
- `product.expiryHelp` disait « les lots ne sont pas gérés ».

**Documentation technique** :

- **README** :
  - fonctionnalités et table des rôles ;
  - clone `stock-master` ;
  - création du premier compte : l'ancien exemple `curl` « admin par
    défaut » était faux ;
  - pré-déploiement complété (1-20E, 1-20F, `install-product-batches.js`,
    `install-expiry-alerts.js`) ;
  - nouvelle section « Fonctionnalités activables par commerce » :
    - différence entre installer et activer ;
    - drapeaux et portées ;
    - état en production ;
    - retour arrière non sûr après des pertes ;
    - limites du hors ligne et du push.
- **Rapports historiques conservés**, avec un simple renvoi daté en tête de
  section :
  - `product-expiry-stock-threshold.md` ;
  - `product-batches-expiry-losses.md` § 11 ;
  - `push-permission-reprompt.md` § 5.

## 2. Éléments supprimés

| Élément | Raison | Vérification |
|---|---|---|
| `web/src/components/objects/*` (3 composants) | Code mort de l'ancien exercice, signalé en 1-9D et 1-10A | Aucun import dans `web/src`, les scripts ou les tests ; aucune dépendance devenue orpheline |
| `web/public/{file,globe,next,vercel,window}.svg` | Gabarit create-next-app | Aucune référence dans le dépôt (code, `sw.js`, scripts, manifeste) |
| Exclusion `components/objects` de `i18n-coverage.mjs` | Dossier supprimé | Couverture inchangée (220 fichiers, 0 texte) |
| Clé `auth.verify.confirmToAccess` (FR/EN) | Usage retiré par `3df300f` | Recherche des clés littérales et dynamiques |
| Fin anglaise du README (« create an object with an image », bloc de code cassé) | Reste de l'exercice Heyama, en doublon des sections françaises | Lecture |

**Conservé volontairement** :

- route `/objects/:id`, qui redirige d'anciens liens et QR imprimés ;
- mentions « RoyalVibe » et « Heyama » dans les commentaires d'historique
  (`auth.ts`, `site-identity.ts`, schémas, cookies) ;
- ces mêmes mentions dans les rapports historiques et les tests, ainsi que
  les noms Docker et domaines fictifs du banc proxy
  (`api/test/proxy`) ;
- tests qui vérifient que l'ancien défaut RoyalVibe n'est pas réintroduit.

Aucune mention n'est visible par les clients. Le dossier local
`heyama-test` n'est qu'un nom de copie de travail.

## 3. Contrôles réalisés

| Contrôle | Résultat |
|---|---|
| `tsc --noEmit` (web) | OK |
| ESLint (documents, ressources, script modifié) | OK |
| `check-i18n` | OK, 0 problème |
| `i18n-coverage --fail` | 0 texte en dur |
| Tests web : WhatsApp, en-têtes de sécurité, marque | 14/14, 7/7, 41/41 |
| `next build` | OK |
| `legal-archive check` | OK : aucun texte juridique archivé modifié |
| HTML servi par `next start` (`/guide`, `/en/guide`, article FR/EN, Contact FR/EN, accueil FR/EN) | Pages rendues ; ancres `#lots`, `#aide`, `#hors-ligne` et `#membres` présentes ; phrases clés présentes dans les deux langues |
| Liens internes de ces pages | 29 liens, tous en 200 |
| Prettier | Seuls les fichiers TS modifiés ont été formatés. Les Markdown, déjà non formatés à `HEAD`, ont été laissés tels quels |

La suite de tests de l'API n'a pas été relancée : aucun fichier de `api/`
n'a été modifié.

## 4. Limites et points à confirmer

- **Pas de vérification visuelle.** Aucun navigateur piloté n'était
  disponible : le rendu sur mobile et sur ordinateur reste à relire à
  l'écran.
- **Textes juridiques (non modifiés, à faire évoluer avec une nouvelle
  version archivée)** :
  - *Confidentialité 0.5*, « Qui peut voir les données » : WhatsApp n'est
    pas mentionné. Écrire au numéro WhatsApp Business fait traiter le
    numéro et les messages par WhatsApp (Meta) et par Stock Master.
  - *Confidentialité 0.5*, liste des données du commerce : les lots (dates,
    numéros fabricant), les pertes (motif, commentaire, auteur) et les
    demandes de régularisation (heure déclarée) n'y figurent pas
    explicitement.
  - *Mentions légales* : le téléphone est toujours « à ajouter »
    (`OPERATOR.phone`).
- **Informations reçues sans vérification.** L'état d'activation en
  production et les tests push reposent sur l'information du propriétaire.
  Ni Railway ni Vercel n'ont été consultés.
- **Pertes des produits sans lots.** Elles ne peuvent toujours pas être
  enregistrées : le guide le dit.

## 5. Deuxième passe : réseaux sociaux et démarrage local

Même branche, modifications précédentes conservées.

### Ajouts

- **Réseaux sociaux officiels.**
  - **Source unique.** `SOCIAL_LINKS` dans `web/src/lib/legal/site-identity.ts`
    (Facebook, Instagram, YouTube, et TikTok sans paramètres de partage).
  - **Composant serveur** `components/contact/social-links.tsx`, sans
    JavaScript, avec des pictogrammes locaux.
  - **Liens.** Nouvel onglet avec `noopener noreferrer`, nom accessible
    « Facebook (nouvel onglet) » / « Facebook (new tab) ».
  - **Placement.** Bloc « Suivez-nous » / « Follow us » dans le pied de page
    public et section du même nom sur la page Contact (FR/EN).
  - **Données structurées.** `sameAs` ajouté à l'unique `Organization` du
    JSON-LD de l'accueil ; les autres valeurs sont conservées.
  - **Test.** Une vérification ajoutée à `test:whatsapp-contact`.
- **README racine.**
  - Carte du dépôt et points d'entrée.
  - Trois usages distingués : développement persistant, recette isolée,
    tests.
  - Parcours en neuf étapes, avec Bash et PowerShell : fichiers
    d'environnement, MongoDB `rs0`, bucket privé, `migrate:predeploy` avec
    l'URI passée dans le shell, premier compte (inscription locale simulée et
    confirmation manuelle d'un compte **local**), arrêt séparé de
    l'effacement.
  - Activation locale des lots et alertes.
  - Résumé des variables, avec le moment où chacune est lue.
  - Tests : ce qui tourne en CI et ce qui reste manuel.
  - Conventions, circuit des branches, contrôles avant PR et dépannage.
- **README de l'API**, réécrit de façon ciblée :
  - section « Tests » : unitaires, ciblés, isolés, e2e ;
  - nettoyage des dossiers `mongo-mem-*` ;
  - retrait de la référence de routes et des modules de l'ancien exercice,
    de la liste WebSocket périmée et du texte standard NestJS.
- **README du web.**
  - Section « Contrôles et tests », avec pour chaque script s'il tourne en
    CI.
  - Moment de lecture des variables.
- **README de la recette.**
  - Usage général et options `--product-batches`, `--expiry-alerts`,
    `--anti-bot=simulated` et `--provider=saspay`.
  - Ordre réel des migrations.
  - Suites Jest isolées.
- **`.env.example` (API et web).**
  - En-tête qui sépare l'obligatoire du facultatif, service par service.
  - Variables lues mais non documentées : `PUBLIC_REGISTRATION_ENABLED`,
    `LEGAL_ACCEPTANCE_PROMPT_ENABLED`, `SOCKET_MEMBERSHIP_RECHECK_SECONDS`,
    `TRUST_PROXY_*`, `PAYMENT_RECONCILIATION_SWEEP_SECONDS`,
    `NEXT_PUBLIC_REGISTRATION_ENABLED`, `S3_HOSTNAME`, `CSP_IMAGE_ORIGINS`
    et `NEXT_PUBLIC_APP_VERSION`.
  - Aucune valeur secrète, aucune valeur de production.
- **Défauts corrigés au passage.**
  - Ligne « le premier utilisateur aura le rôle `admin` » (fausse).
  - Étape « bucket public » : les images sont signées et le bucket est
    privé.
  - Commandes `docker build` de l'API et du web : le contexte doit être la
    racine du dépôt.
  - Exemple web qui pointait vers l'API de production.

### Points d'entrée de la documentation

| Sujet | Source de référence |
|---|---|
| Démarrage local, dépannage, conventions | [README.md](../../README.md) |
| Variables | `api/.env.example`, `web/.env.example` |
| Tests API | [api/README.md](../../api/README.md#tests) |
| Contrôles web | [web/README.md](../../web/README.md#contrôles-et-tests) |
| Recette isolée | [api/test/recipe/README.md](../../api/test/recipe/README.md) |
| Règles métier | Rapports de `docs/architecture/` |

### Commandes réellement vérifiées

| Commande | Résultat |
|---|---|
| `pnpm --filter api build` | OK |
| `node api/test/recipe/recipe.js start --product-batches --expiry-alerts`, puis `status`, `accounts`, `stop` | Démarrage complet, migrations des lots et alertes comprises. Web 200, `/health` OK, `features: { productBatches: true, expiryAlerts: true }` pour `proprietaire.actif`. Arrêt propre : ports libérés, copie isolée supprimée |
| `pnpm --filter api test -- predeploy-migrations` | 7/7 |
| `recipe.js isolated api-unit predeploy-migrations` | 7/7 |
| `recipe.js isolated api-e2e rate-limit-index` | 4/4 |
| `pnpm --filter api migrate:predeploy` sans URI | « MONGODB_URI requis. », code 1 (cas du dépannage) |
| `pnpm --filter web exec next dev --help` | Option `-p, --port` confirmée |
| `test:whatsapp-contact` | 15/15 |
| `tsc`, ESLint, Prettier (fichiers modifiés), `check-i18n`, `i18n-coverage`, `next build`, `legal-archive check` | OK, aucun problème |
| HTML servi (`/`, `/en`, `/contact`, `/en/contact`, `/guide`) | Bloc des réseaux présent ; 4 liens par bloc avec `target="_blank"` et `rel="noopener noreferrer"` ; titres et libellés FR/EN ; aucune iframe ni script tiers ; `sameAs` avec les 4 URL ; une seule `Organization` |
| Liens relatifs et ancres des quatre README | 0 lien cassé |

### Non exécuté

- **Docker.** Le moteur Docker Desktop répondait en erreur 500
  (`dockerDesktopLinuxEngine`) ; il n'a pas été relancé, pour ne pas toucher
  à l'environnement ni aux volumes locaux. Commandes non exécutées :
  - `docker compose up -d`, `ps -a`, `stop`, `down`, `logs mongo-rs-init` ;
  - la commande `docker exec … mongosh` (confirmation d'e-mail et
    `rs.status()`) ;
  - `migrate:predeploy` contre la base de développement ;
  - `pnpm --filter api start:dev` et `pnpm --filter web dev` reliés à
    MongoDB et MinIO ;
  - les deux `docker build`.
- **Rendu visuel.** Mobile, ordinateur, clair et sombre n'ont pas été
  vérifiés : aucun navigateur piloté n'était disponible.

### Limites et points signalés (hors périmètre)

- **Tests hors CI.** `test:whatsapp-contact` et la plupart des scripts
  `web/scripts/test-*.mjs` ne tournent pas en CI, et aucun e2e API non plus.
- **Prestataire de stockage incohérent.** Les variables de production du
  README désignent Cloudflare R2. `PROVIDERS` (`site-identity.ts`) et la
  politique de confidentialité citent Supabase Storage. À confirmer, puis
  aligner le texte juridique par une nouvelle version.
- **Dossiers temporaires.** Dix dossiers `mongo-mem-*` (14 au
  21 octobre 2026) restent dans `%TEMP%`. Ils sont laissés en place ; la
  commande de nettoyage est documentée.
- **Sections non relues.** Les sections « Pages » et « Architecture du code »
  du README web, ainsi que le module `api/src/objects`, n'ont pas été relus
  dans ce lot.

## 6. Troisième passe : stockage R2 et parcours Docker rejoué

Informations du propriétaire (21 octobre 2026) : les photos sont stockées
dans **Cloudflare R2** en production, et Docker Desktop fonctionne. Cette
passe règle deux points de la section 5 : le « prestataire de stockage
incohérent » et les commandes Docker « non exécutées ».

### Stockage : Supabase remplacé par Cloudflare R2

- **Registre.** `PROVIDERS` dans `site-identity.ts` : « Supabase Storage »
  devient « Cloudflare R2 ».
  - Le statut passe à « confirmé par le propriétaire ».
  - `country` reste `null` : aucune région ni durée de conservation
    inventée.
  - Traduction anglaise dans `i18n/documents/providers.ts`.
- **Politique de confidentialité 0.6.**
  - Archivée en FR et en EN
    (`api/src/legal/archive/confidentialite/0.6.{fr,en}.txt`, manifeste
    `current: 0.6`, `publishedAt: 2026-10-21`) avec
    `recipe.js isolated web-build --legal-archive=write --published-at=2026-10-21`.
  - Différence avec la 0.5 : la ligne d'en-tête (version et date) et la
    ligne du prestataire. Les archives 0.3 à 0.5 sont inchangées.
- **Documents non archivés.** Seuls le numéro et la date changent : mentions
  légales 0.3 (elles affichent la même liste de prestataires) et cookies 0.8
  (« service de stockage du site (Cloudflare R2) »).
- **Constantes inutilisées.** `DRAFT` et `DRAFT_COOKIES_0_7` sont
  remplacées par une mention en commentaire, selon la convention du
  fichier.
- **Conservé.** Les mentions de Supabase dans les rapports historiques, les
  archives et les données de test (`*.spec.ts`, anciennes URL). Aucun usage
  actuel de Supabase n'existe dans le code.
- **README.** Stack et tableau de déploiement indiquent Cloudflare R2.
- **Date de publication.** Si la publication de la 0.6 a lieu après le
  21 octobre 2026, la date de `site-identity.ts` doit être corrigée avant
  le déploiement. La version 0.6 n'étant pas encore publiée, l'archive peut
  alors être refaite.
- **Comptes existants.** L'invite d'acceptation pour les comptes existants
  reste régie par `LEGAL_ACCEPTANCE_PROMPT_ENABLED` (inchangé).

### Parcours Docker rejoué dans un environnement isolé

**Isolement.**

- Projet Compose `smdocverify`, avec des noms de conteneur et des volumes
  propres, et des ports distincts :
  - MongoDB 27118, Mongo Express 8181, MinIO 9201/9202 ;
  - API 4100, web 3100.
- Fichier de surcharge temporaire pour MinIO, dont le nom et les ports sont
  fixés dans `docker-compose.yml`.
- L'API a tourné depuis un dossier de vérification contenant un `.env`
  **neuf**, tiré de `api/.env.example` : `RESEND_API_KEY` vide, push
  désactivé, `PAYMENT_PROVIDER_ACTIVE=none`. Le `api/.env` local n'a pas été
  lu.
- Le web a tourné dans une copie isolée sans aucun `.env*` (mécanisme
  `web-copy.js` de la recette).
- Aucun service externe n'a été contacté.

| Étape (README) | Commande exécutée | Résultat |
|---|---|---|
| 3 · MongoDB, replica set, MinIO | `docker compose -p smdocverify -f docker-compose.yml -f <surcharge> up -d`, puis `ps -a` | Tous les services démarrés ; `mongo-rs-init` `Exited (0)` |
| Contrôle du replica set | `docker compose exec mongo mongosh --quiet --eval "rs.status().ok"` | `1` (membre `mongo:27017`) |
| 4 · Bucket privé | `docker compose exec minio mc alias set …`, `mc mb local/stockmaster-objects`, `mc anonymous get …` | Bucket créé, accès `private` |
| 5 · Migrations | `MONGODB_URI=… pnpm --filter api migrate:predeploy` (port 27118) | 13 migrations, « toutes les migrations sont appliquées » ; second passage identique (idempotence) |
| 6 · API | `node api/dist/main.js` (même code que `start:dev`, compilé, pour l'isolement du `.env`) | `/health` OK ; lots et alertes « ACTIVÉS : TOUS les commerces » |
| 6 · Web | `next dev -p 3100` dans la copie isolée | Démarré ; `/auth/register` 200 |
| 8 · Premier compte | `POST /auth/register` (anti-robot simulé) | 202 ; connexion refusée `403 EMAIL_NOT_VERIFIED`, comme documenté |
| 8 · Confirmation manuelle | `docker compose exec mongo mongosh stockmaster --quiet --eval "db.users.updateOne(…)"` | `matchedCount: 1, modifiedCount: 1` ; connexion 201, rôle `owner` |
| Produit avec photo | `POST /sections`, puis `POST /products` (multipart, champ `image`, PNG) | 201 et 201 |
| Affichage de la photo | `GET /products/:id`, lecture de `imageUrl` | URL signée (`X-Amz-Signature`) ; image 200 `image/png` ; sans signature 403 (bucket privé) ; la CSP de la page produit autorise l'origine MinIO |
| 9 · Arrêt et redémarrage | arrêt de l'API ; `docker compose stop`, puis `up -d` | `rs.status().ok = 1`, 1 utilisateur, 1 produit |
| 9 · Retrait des conteneurs | `docker compose down` (volumes gardés), `up -d`, redémarrage de l'API | Fiche, stock 12, photo signée lisible : données MongoDB et MinIO persistantes |
| Build Docker de l'API | `docker build -f api/Dockerfile -t smdocverify-api .` | OK |
| Build Docker du web, tel que documenté | `docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 -t … .` | **Échec** : « TypeError: Expected a non-empty string » |
| Build Docker du web corrigé | même commande avec `--build-arg S3_HOSTNAME=localhost` | OK |

Le contrôle visuel n'a **pas** été fait : aucun navigateur n'a été utilisé.
L'affichage de la photo est vérifié par HTTP (URL signée, contenu, CSP),
pas à l'écran.

### Corrections de documentation issues du rejeu

- **`docker exec stockmaster-mongo …`** devient
  **`docker compose exec mongo …`** : le nom de conteneur varie selon les
  installations (`heyama-mongo` ici).
- **Bucket.** Création en ligne de commande ajoutée (`mc`, vérifiée), en plus
  de la console.
- **Dépannage, seconde installation.** Seuls MongoDB et Mongo Express sont
  paramétrables. MinIO demande une surcharge Compose
  (`container_name`, `ports: !override`). Si MinIO n'est pas sur le port
  9000, déclarer `CSP_IMAGE_ORIGINS` côté web, sinon la CSP bloque les
  photos.
- **Dépannage, Next 16.** Il refuse un second `next dev` dans le même dossier
  `web/`.
- **Build Docker du web.** `--build-arg S3_HOSTNAME=…` est obligatoire, avec
  la raison.
  - Le Dockerfile transmet `S3_HOSTNAME` même vide, et
    `process.env.S3_HOSTNAME ?? "localhost"` garde la chaîne vide.
  - Le code n'a pas été modifié : `docker-compose.prod.yml` exige déjà la
    variable, et l'ajout de l'argument suffit au parcours manuel.
  - Remplacer `??` par `||` dans `next.config.ts` rendrait la variable
    facultative, mais c'est un changement de code à décider à part.

### Contrôles relancés

| Contrôle | Résultat |
|---|---|
| `pnpm --filter api test -- legal` | 21/21 |
| `recipe.js isolated api-e2e legal-acceptance` | 19/19 |
| `recipe.js isolated web-build` (archive en mode `check`) | build OK, `problems: []` |
| `tsc`, ESLint et Prettier des fichiers modifiés, `check-i18n`, `i18n-coverage`, `test:whatsapp-contact` | OK, 15/15 |
| Liens relatifs des README et du rapport | 0 lien cassé |

### Nettoyage

**Supprimé** (uniquement les ressources créées pour cette vérification,
désignées par leur nom) :

- les conteneurs et le réseau `smdocverify` (`down`) ;
- les volumes `smdocverify_mongo_data` et `smdocverify_minio_data` ;
- les images `smdocverify-api` et `smdocverify-web` ;
- la copie `.smdocverify-web/` ;
- les processus API et web des ports 4100 et 3100.

**Non touché** :

- les conteneurs et volumes `heyama-*` / `heyama-test_*` existants ;
- les autres projets Docker de la machine ;
- le serveur `next dev` déjà lancé sur le port 3000 ;
- `api/.env` et `web/.env.local` ;
- le cache de build Docker (couches partagées).

Les fichiers de vérification (surcharge Compose, `.env` neuf, script de
parcours, journaux) sont restés dans le dossier temporaire de session, hors
du dépôt.
