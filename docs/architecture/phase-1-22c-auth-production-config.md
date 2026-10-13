# Lot 1-22C — Configuration d'authentification de production

État : **`JWT_SECRET` validé au pré-déploiement et au démarrage ; `TRUST_PROXY_HOPS=2` conservé
(validation antérieure confirmée par le propriétaire).** Rien n'est commité, poussé ni
déployé. Aucune variable de production n'a été lue ni modifiée.

Pistes 1 et 2 de l'audit 1-22A.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `81b110d` : corrections 1-22B et document 1-22A, commités par le propriétaire sur `security/phase-1-22b-internal-authorization` |
| Branche | `security/phase-1-22c-auth-production-config` |
| Séparation des lots | 1-22B = `4bb369e..81b110d` (commité) ; 1-22C = modifications non commitées de cette branche |

Le stash et les fichiers personnels sont conservés.

## 2. `JWT_SECRET`

### Usages

| Usage | Emplacement | Effet d'une rotation |
|---|---|---|
| Signature et vérification des JWT : session de 7 jours et session limitée de 15 min | `auth/auth.module.ts`, `auth/strategies/jwt.strategy.ts` | Tous les jetons sont refusés : chaque utilisateur doit se reconnecter |
| Poignée de main Socket.IO (même `JwtService`) | `events/socket-auth.middleware.ts` | Reconnexion refusée avec un ancien jeton. Le redémarrage de l'API qui accompagne la rotation ferme les sockets ouverts. |
| Clé HMAC des compteurs anti-abus persistants | `common/rate-limit/persistent-rate-limiter.service.ts` | Compteurs remis à zéro ; les anciens expirent (TTL) |
| Dérivation de la clé des empreintes de demande de paiement | `subscriptions/payments/payment-request.ts`, `subscription-payments.service.ts` | Le rejeu d'une création de paiement antérieure à la rotation (même `clientOperationId`) est refusé comme conflit au lieu d'être rejoué. Les paiements, confirmations et périodes ne sont pas affectés. |
| Comparaison avec les secrets de webhook | `saspay/saspay-config.ts`, `campay/campay-webhook.service.ts`, `payment-providers.wiring.ts` | Le nouveau secret doit rester différent de `SASPAY_WEBHOOK_SECRET`, sinon l'API refuse de démarrer |
| CLI d'exploitation (`AppModule`) | `migrations/reconcile-subscription-payment.ts`, `migrations/storage-quota.ts` | Ils doivent recevoir la même valeur que l'API |

Aucune nouvelle clé HMAC n'est introduite dans ce lot. Le secret n'est
jamais changé automatiquement.

### Décision

Une validation centralisée a été ajoutée : `common/config/jwt-secret-policy.ts`.
Elle passe par `ConfigModule.forRoot({ validate })` et s'exécute au
chargement de `AppModule`. L'API HTTP, la poignée de main Socket.IO et les
CLI sont donc couverts, que la valeur vienne de l'environnement ou d'un
fichier `.env`.

En `NODE_ENV=production`, le secret est refusé dans ces cas :
- absent ou vide ;
- entouré d'espaces ;
- moins de 32 octets UTF-8 ;
- moins de 10 caractères distincts ;
- valeur d'exemple publiée dans le dépôt ;
- marqueur de modèle (`change-me`, `CHANGE_MOI`, `replace-me`, `placeholder`, `your-secret`, `<…>`).

L'erreur est fatale (`JwtSecretPolicyError`) et n'affiche ni la valeur ni sa
longueur. Hors production, rien n'est refusé : développement et tests.

### Points d'application

Une seule politique (`jwtSecretRejection`) est appliquée à trois endroits :

| Point | Quand la règle s'applique | Valeur lue | Effet d'un refus |
|---|---|---|---|
| Démarrage de l'API et des CLI chargeant `AppModule` (`validateEnvironment`) | `NODE_ENV=production` | Environnement du processus, complété par un `.env` éventuel | Arrêt au chargement, code 1 |
| Pré-déploiement : `predeploy-migrations.js`, **première** étape (`validateEnvironment`) | `NODE_ENV=production` | Environnement du processus seulement | Code 1 avant la lecture de `MONGODB_URI`, avant toute connexion et sans aucune migration. Sur Railway, la version en service reste active. |
| CLI autonome `check-jwt-secret.js` | Toujours, quel que soit `NODE_ENV` | `JWT_SECRET` seulement | Code 1, raison affichée |

Les migrations locales et les tests, lancés sans `NODE_ENV=production`,
gardent leurs configurations explicites et ne sont pas concernés.

**Ces contrôles ne prouvent pas l'entropie.** Ils écartent les erreurs
courantes. Seul un secret tiré d'un générateur cryptographique convient :

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
openssl rand -base64 48
```

Les secrets factices des fixtures de test (recette, charge, CLI) ne sont pas
listés : ce ne sont pas des exemples de configuration. Ils restent publics
et ne doivent jamais servir en production.

### Exemples d'environnement

| Fichier | Valeur |
|---|---|
| `.env.prod.example` | `JWT_SECRET=` (vide), avec une consigne de génération. Le démarrage échoue tant que le secret n'est pas renseigné. |
| `api/.env.example` | Valeur de développement explicitement refusée en production |
| `README.md`, `api/README.md` | Consigne « au moins 32 octets aléatoires » |

## 3. Proxy et limites anti-abus

### Sources consultées le 2026-10-13

- **[Railway — Specs & Limits](https://docs.railway.com/networking/public-networking/specs-and-limits).**
  - Documente seulement `X-Real-IP`, ainsi que `X-Forwarded-Proto` et `X-Forwarded-Host`.
  - **Ne documente pas `X-Forwarded-For`** : ni ajout en fin de liste ou remplacement, ni nombre de sauts, ni adresses de l'edge.
  - La page précise que ces informations peuvent changer à tout moment.
- **Forum officiel Railway (Central Station).** Les réponses du personnel se contredisent. Selon les fils :
  - `X-Forwarded-For` est remplacé, ou au contraire complété en fin de liste ;
  - une modification de comportement de l'edge en juin est signalée ;
  - `X-Real-IP` vaut parfois une adresse de CDN.

  Rien de cela ne constitue un contrat.
- **[Express — Behind proxies](https://expressjs.com/en/guide/behind-proxies.html)** (`@nestjs/platform-express` 11, Express 5).
  - Avec un **nombre** de sauts, `X-Forwarded-For` est lu de droite à gauche à partir de la socket.
  - **Aucun chemin** vers l'application ne doit compter moins de sauts.
  - Avec des **adresses**, seuls les sauts venant d'adresses approuvées sont pris en compte.

### Conditions nécessaires

| Objectif | Condition |
|---|---|
| Reconnaître l'IP du client derrière l'ingress | Le dernier proxy approuvé ajoute ou réécrit `X-Forwarded-For` avec l'adresse du client, **et** `TRUST_PROXY_HOPS` vaut exactement le nombre de proxys de la chaîne publique (CDN compris) |
| Empêcher la falsification par `X-Forwarded-For` | Le client ne contrôle que les entrées à **gauche** de celle ajoutée par le proxy. C'est vrai si l'ingress ajoute ou remplace l'en-tête, faux s'il le transmet tel quel. |
| Garder ces protections si un autre chemin existe | En mode sauts, **aucun** autre chemin : pas de réseau privé Railway depuis un autre service, pas de proxy TCP, pas de domaine sans le même CDN. Sinon, seul `TRUST_PROXY_ADDRESSES` protège, mais les adresses de l'edge Railway ne sont pas documentées comme fixes. |

Le code applique déjà ces règles :
- trois modes stricts (aucun, adresses exactes, sauts) ;
- jamais `true`, jamais de plage d'adresses ;
- aucune lecture manuelle de `X-Real-IP`.

### Décision

- **Réglage de production conservé : `TRUST_PROXY_HOPS=2`.** Ce lot ne change ni le code par défaut (aucun proxy approuvé sans variable) ni ce réglage.
- Le démarrage journalise désormais le mode retenu, sans les adresses ; avec `HOPS=2`, la ligne est « 2 saut(s) approuvé(s) ».
- En production **sans** proxy approuvé, l'API avertit que les clients partagent les limites par IP. Cet avertissement ne s'affiche pas avec `HOPS=2`.
- Conséquence pour la piste 1 de l'audit 1-22A (« sans proxy de confiance configuré ») : elle **ne s'applique pas** à la production tant que `HOPS=2` est en place et que ses conditions de validité tiennent (ci-dessous).

### Validation antérieure de `TRUST_PROXY_HOPS=2`

**Validation antérieure confirmée par le propriétaire.** Le dépôt ne contient aucun résultat de mesure brut. La seule trace est le rapport 1-18A (`phase-1-18a-auth-abuse-audit.md`, § « req.ip ») : « `HOPS=2` validé **seulement** sur le chemin public Railway en IPv4 (information fournie) ». Le même rapport (§ questions, point 4) précise que toute modification du chemin réseau impose de revalider. Ces tests n'ont pas été relancés.

Conditions de validité et état au 2026-10-14 :

| Condition | État |
|---|---|
| Aucun proxy TCP sur le service `api` | **Confirmé** par le propriétaire (2026-10-14) |
| Seul le chemin public Railway atteint l'API : aucun autre service de l'environnement ne joint `api.railway.internal` | Non confirmé ici ; à vérifier dans la liste des services |
| Même chaîne d'entrée qu'à la validation : même domaine, aucun CDN ou proxy ajouté (ex. Cloudflare « orange ») | Non confirmé ici ; à vérifier dans Networking et chez le fournisseur DNS |
| Comportement de l'edge Railway inchangé depuis la validation | Non vérifiable sans mesure. Le forum Railway signale des changements de l'edge ; la date de la validation n'est pas documentée. |
| Clients IPv6 | **Non couverts** par la validation (IPv4 seulement) |

Si toutes les conditions vérifiables sont inchangées, `HOPS=2` est conservé sans nouveau test. Si l'une d'elles change (domaine, CDN, autre service, proxy TCP), il faut refaire la mesure (`phase-1-14d2e1-railway-proxy-validation.md` § 7, outillage `api/test/proxy/`, projet de test séparé, deux réseaux de sortie) avant de garder ou modifier le réglage.

### Contrôles restants avant déploiement

Ils n'ont **pas été exécutés** ici : la CLI Railway n'est pas installée dans cet environnement, et aucun accès au tableau de bord n'existe. `.env.prod` (auto-hébergement) n'est pas la configuration Railway et n'a pas été lu.

À lancer par le propriétaire, depuis une copie locale de cette branche construite avec `pnpm --filter api build`. Seule la commande `railway run` documentée injecte les variables du service dans un processus local, et aucune des deux n'affiche de secret :

1. **`NODE_ENV` effectif** (n'affiche que cette variable) :
   ```sh
   railway run --service api --environment production node -e "console.log('NODE_ENV=' + process.env.NODE_ENV)"
   ```
   Attendu : `NODE_ENV=production`. Sinon, ni le pré-déploiement ni le démarrage ne contrôlent le secret (§ 2).
2. **`JWT_SECRET`** (même validateur que le démarrage, affiche seulement le verdict) :
   ```sh
   railway run --service api --environment production node api/dist/migrations/check-jwt-secret.js
   ```
   Attendu : « JWT_SECRET conforme à la politique de production (1-22C). » (code 0).

Ne pas utiliser `railway variables` : cette commande affiche toutes les valeurs, secrets compris.

## 4. Tests

Exécutés en local : MongoDB éphémère, Turnstile simulé, expéditeur simulé,
garde anti-`.env` préchargée. Aucun service réel.

| Contrôle | Résultat |
|---|---|
| Nouveau `test/auth-production-config.e2e-spec.ts` | 14 / 14 |
| … `AppModule` neuf en production : secret absent, court, d'exemple, de modèle ou peu varié → `JwtSecretPolicyError`, valeur absente du message ; secret aléatoire non bloqué | ✔ |
| … sans réglage derrière un proxy : deux clients **partagent** le compteur (limite connue) | ✔ |
| … `HOPS=1`, proxy qui ajoute l'adresse : compteurs distincts par client | ✔ |
| … même client avec `X-Forwarded-For` forgé et changeant : compteur jamais contourné | ✔ |
| … `HOPS=1` et chemin qui contourne le proxy : l'adresse déclarée est imposée. C'est la limite du mode par sauts, démontrée. | ✔ |
| … `TRUST_PROXY_ADDRESSES` avec un pair non approuvé : adresse déclarée ignorée | ✔ |
| … plafond par compte actif malgré des adresses toutes distinctes ; Turnstile toujours exigé derrière le proxy | ✔ |
| Unitaires `common`, `auth`, `anti-bot`, `events`, dont la politique du secret et la description du proxy | 550 / 550 |
| E2E concernés (13 fichiers) : connexion, anti-abus, réinitialisation, vérification d'e-mail, invitations par identifiants, inscription, contexte, socket, proxy, CLI de rapprochement en production, empreintes de paiement | 225 / 225 |
| Démarrages réels compilés, `NODE_ENV=production` : API et CLI avec un secret d'exemple ou trop court | Refus, code de sortie 1, message explicite sans la valeur. Le journal de l'API affiche le mode proxy et l'avertissement. |
| CLI `check-jwt-secret` : même verdict que le démarrage pour chaque cas (unitaires) ; script compilé lancé avec un environnement vide | 32 / 32 ; refus (code 1) pour un secret absent, d'exemple, de développement ou peu varié, « conforme » (code 0) pour un secret aléatoire, valeur jamais affichée |
| Typage, ESLint, Prettier | propres |

Note d'exécution : `payment-reconciliation-cli-process` crée ses propres
`.env` factices dans `%TEMP%`. Avec la garde anti-`.env` préchargée, il doit
recevoir `RECIPE_ENV_GUARD_ALLOW_PREFIXES` pour ce préfixe, sinon son
nettoyage échoue (`ENOTEMPTY`). Ses 15 tests passent dans les deux cas.

## 5. Déploiement

Le refus de démarrer est voulu, mais il ne doit pas surprendre.

1. **Avant de fusionner**, contrôler le secret en place avec **le même validateur** que le démarrage.

   Le CLI `dist/migrations/check-jwt-secret.js` appelle `jwtSecretRejection`, la fonction que `validateEnvironment` applique au démarrage :
   - il n'importe pas `AppModule` : aucune connexion, aucun démarrage, aucun `.env` lu ;
   - il ne lit que `JWT_SECRET` et applique la règle quel que soit `NODE_ENV` ;
   - il affiche seulement « conforme » (code 0) ou la raison du refus (code 1), jamais la valeur ni sa longueur.

   L'image en service ne contient pas encore ce fichier. Deux façons de l'exécuter :
   - **Avant la fusion,** depuis une copie locale de cette branche, construite avec `pnpm --filter api build` et la CLI Railway connectée. Railway injecte les variables du service dans ce seul processus local :
     ```sh
     railway run --service api --environment production node api/dist/migrations/check-jwt-secret.js
     ```
     Le secret transite alors dans la mémoire d'un processus local ; il n'est ni affiché ni écrit.
   - **Après la fusion,** depuis l'image (shell du service, ou en tête de la procédure de déploiement) :
     ```sh
     node /app/api/dist/migrations/check-jwt-secret.js
     ```
     Le script `pnpm --filter api config:check-jwt-secret` fait la même chose dans un poste de développement.

   La commande `node -e …` de la première version de ce document n'était qu'un **contrôle préliminaire**. Elle ne couvrait ni la liste des valeurs d'exemple ni tous les marqueurs, et elle est remplacée par ce CLI.
2. **Si le contrôle échoue :**
   - générer un nouveau secret (§ 2) ;
   - le renseigner dans Railway **et** pour les CLI (et `.env.prod` en auto-hébergement) ;
   - vérifier qu'il diffère de `SASPAY_WEBHOOK_SECRET` ;
   - prévenir que tous les utilisateurs devront se reconnecter.

   Il n'y a ni migration, ni perte de données.
3. Déployer l'API. Ce lot ne modifie pas le web.

   La Pre-deploy Command existante (`node /app/api/dist/migrations/predeploy-migrations.js`) vérifie désormais le secret **avant** toute migration. En cas de refus :
   - le déploiement s'arrête avec un message sans la valeur ;
   - la version en service reste active, comme pour un échec de migration ;
   - aucune connexion à MongoDB n'est ouverte.

   Ce garde-fou suppose deux conditions sur le service Railway, à vérifier :
   - `NODE_ENV=production` dans ses variables ;
   - la Pre-deploy Command réellement configurée.

   Sans la première, ni ce contrôle ni celui du démarrage ne s'appliquent.
4. Vérifier le journal de démarrage :
   - la ligne « Confiance proxy : … » ;
   - en production sans réglage, l'avertissement de limites partagées ;
   - en cas de refus, `JwtSecretPolicyError` et sa raison.
5. Conserver `TRUST_PROXY_HOPS=2`. Revalider seulement si une condition du § 3 change.

## 6. Limites

- La force réelle du secret déployé n'est pas vérifiable d'ici : seules la forme et les valeurs connues le sont.
- `TRUST_PROXY_HOPS=2` repose sur une validation antérieure confirmée par le propriétaire, sans résultats bruts dans le dépôt. Elle couvre l'IPv4 seulement ; l'absence d'autre chemin vers l'API reste à confirmer.
- `NODE_ENV` effectif et conformité du `JWT_SECRET` de Railway : non contrôlés ici (§ 3, contrôles restants).
- Les tests simulent le proxy par l'en-tête sur une connexion locale. Ils prouvent la plomberie Express et le throttler, pas le comportement de l'edge Railway.
- Le secret reste partagé entre sessions, compteurs et empreintes. Une séparation des clés est possible plus tard, avec sa propre migration.
