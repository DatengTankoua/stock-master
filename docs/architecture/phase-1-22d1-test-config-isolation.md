# Lot 1-22D.1 — Isolation fiable des tests et de leur configuration

État : **régression de 1-22C reproduite sans risque, puis corrigée dans le dispositif e2e.**
Rien n'est commité, poussé ni déployé. Aucune base réelle jointe, aucun appel à SasPay.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `security/phase-1-22d-saspay-quota-isolation` (sur `origin/main` `38ce06a`), avec les modifications **non commitées** de 1-22D |
| Branche | `fix/phase-1-22d1-test-config-isolation`, créée depuis cet état sans stash ni reset |
| Héritage 1-22D | 15 fichiers non commités (paiements, web, tests SasPay, rapport). Empreintes relevées avant ce lot : aucun n'a été modifié ici, sauf le rapport 1-22D (corrections demandées, § 7). |
| Variables, migrations | Aucune |

Le stash (`stash@{0}`) et les fichiers personnels (`api/.env`, `api/.env.local`, `.env.prod`) sont
conservés et n'ont pas été lus.

## 2. Cause

Ordre réel d'une suite e2e :

1. Jest charge le fichier de test ; les `import` statiques passent en premier, dont `AppModule`.
2. À l'import d'`app.module.ts`, `ConfigModule.forRoot({ validate })` s'exécute aussitôt :
   - lecture de `<répertoire courant>/.env` ;
   - fusion `{ ...fichier, ...process.env }` ;
   - validation de `JWT_SECRET` (1-22C) ;
   - copie des clés du fichier dans `process.env` ;
   - **conservation de la configuration validée**.
3. `beforeAll` démarre le MongoDB éphémère et pose `process.env.MONGODB_URI`. La garde
   `validatedEphemeralUri` valide cette URI.
4. `Test.createTestingModule().compile()` : la fabrique Mongoose lit
   `ConfigService.get('MONGODB_URI')`, qui **préfère la configuration conservée** à
   `process.env`.

La garde validait donc une URI que l'application n'utilisait pas. L'URI réellement transmise au
connecteur venait de `.env` ou de l'environnement hérité, figés à l'étape 2. Avant 1-22C, sans
`validate`, rien n'était conservé et l'étape 4 lisait `process.env`.

`ignoreEnvFile` seul ne suffit pas : une URI héritée du shell reste figée à l'étape 2. Lancer
depuis `api/test` non plus : cela évite le fichier, mais pas l'URI héritée ni la copie figée.

## 3. Reproduction (avant correction)

`api/test/test-config-isolation.e2e-spec.ts` :
- `AppModule` neuf importé depuis un répertoire temporaire contenant un **`.env` factice** ; les
  vrais `.env` ne sont ni lus ni chargés ;
- `mongoose.createConnection` intercepté sur l'instance qu'utilise `@nestjs/mongoose` : il
  enregistre l'URI reçue et **refuse lui-même** tout hôte non local. La sécurité ne repose donc
  pas sur l'absence d'un serveur.

| Cas | URI reçue par le connecteur, avant |
|---|---|
| `.env` factice (`dev-from-env-file.invalid:27017`) | celle du `.env`, et le `.env` est copié dans `process.env` |
| URI interdite héritée de l'environnement | celle-ci |
| URI temporaire posée après l'import, comme le font les suites | **toujours l'URI héritée**, retentée ; jamais la temporaire |
| Production, secret d'exemple | refus (contrôle 1-22C intact) |

## 4. Correction

Le dispositif de test injecte explicitement sa configuration ; le comportement de production ne
change pas.

- **`src/common/config/app-config.ts`** (production) : options de `ConfigModule` et fabrique
  Mongoose extraites d'`AppModule`, à l'identique. On y trouve `validateEnvironment`, la lecture de
  `.env` puis de l'environnement, la copie validée et `uri: MONGODB_URI`.
- **`test/jest-e2e.json`** : `moduleNameMapper` remplace ce module par
  `test/e2e/e2e-app-config.ts`, pour toutes les suites e2e, quel que soit le répertoire courant.
  Cette configuration est la seule qui exécute les `*.e2e-spec.ts` : la configuration unitaire a
  `rootDir: src`.
- **`test/e2e/e2e-app-config.ts`** :
  - `ignoreEnvFile: true` : aucun `.env` lu ;
  - `validate` appelle `validateEnvironment`, puis ne conserve **aucune copie** :
    `ConfigService` lit `process.env` à la création de chaque application, donc après le
    `beforeAll` de la suite ;
  - la fabrique Mongoose passe l'URI **effectivement transmise** à `assertEphemeralUri` avant
    toute connexion. Une URI absente, distante, sur le port 27017, avec identifiants ou hors base
    e2e entraîne un échec sans connexion ni écriture.
- **`test/e2e/ephemeral-mongodb.ts`** : `startEphemeralMongo` échoue d'emblée si la
  configuration substituée n'est pas active (suite lancée hors de `jest-e2e.json`). Aucune base
  n'est alors démarrée.

### Processus enfants et recette

| Chemin | Constat |
|---|---|
| `payment-reconciliation-cli-process` (CLI compilé, `AppModule` de production) | Déjà sûr. Environnement minimal et explicite, répertoire temporaire vide (aucun `.env`), URI validée par la garde avant le lancement. Inchangé. |
| Migrations lancées par `subscription-payments` et `subscriptions` | Lisent `process.env.MONGODB_URI` directement, sans `.env` ni `AppModule`. Le cas « sans URI » la retire explicitement. Elles héritaient des valeurs du `.env` copiées dans le processus Jest : ce n'est plus le cas. |
| Scripts de recette | Aucun dans le dépôt n'importe `AppModule` en test (`scripts/` ne contient que `mongo/`). |

### Production

Inchangés :
- validation centralisée de `JWT_SECRET` au chargement (API, Socket.IO, CLI) ;
- contrôle de pré-déploiement ;
- ordre et priorité des sources de configuration.

`dist/app.module.js` est recompilé à l'identique, hormis l'import du module extrait.

## 5. Vérifications

Toutes en local. Base éphémère sur 127.0.0.1, `.env` factices, interception du connecteur.

| Preuve | Résultat |
|---|---|
| `.env` factice avec URI interdite | Refus avant connexion (« MONGODB_URI not set ») ; 0 appel au connecteur ; `.env` non chargé |
| URI interdite héritée de l'environnement | Refus par la garde (« not a local address ») ; 0 appel au connecteur |
| URI temporaire posée après l'import | Le connecteur reçoit exactement cette URI ; hôte et port de la connexion identiques |
| Deux applications successives, deux `mongod` distincts | Chacune reçoit sa propre URI (ports différents) |
| Production, secret d'exemple | `JWT_SECRET refusé`, aucune connexion |
| Suite lancée **sans** `jest-e2e.json` (configuration temporaire hors dépôt) | `E2E refused: AppModule configuration is not the e2e one`, aucune base démarrée |
| `pnpm test:e2e` depuis `api/` (où se trouve le vrai `api/.env`, désormais ignoré) : isolation, 1-22D (quota, confirmation seule), 1-22C (`auth-production-config`), CLI de rapprochement | 52 / 52 (5 suites) |
| `pnpm --filter api test:e2e` depuis la racine : isolation, quota 1-22D, `subscription-payments`, `subscriptions` (migrations compilées) | 94 / 94 (4 suites) |
| `jest --config api/test/jest-e2e.json`, répertoire courant = racine | 5 / 5 |
| Unitaires `src/common/config`, `src/migrations` (`check-jwt-secret`, `predeploy-migrations`) | 38 / 38 |
| Suites d'index sans `AppModule` (utilisent `startEphemeralMongo`) : `invitation-account-index`, `rate-limit-index`, `support-request-indexes` | 1ʳᵉ exécution : 12 / 13. Échec isolé de `invitation-account-index` (« un second passage ne modifie rien »), détail non capturé. Ensuite 13 / 13 sur les trois suites, et 6 / 6 trois fois seule. Intermittent, non reproduit, cause non établie. |
| `tsc` (build), ESLint (fichiers du lot) | 0 erreur. Une alerte ESLint et une erreur `tsc` (configuration complète) préexistantes sur l'import `MongoMemoryReplSetOpts` de `ephemeral-mongodb.ts`, ligne non modifiée. |

## 6. `429` SasPay à la création : garantie non établie

Ce qui est consigné, et seulement cela :
- 1-21A § 3 (sources officielles) : `429` figure parmi les erreurs ; limite de 300 requêtes / min
  par compte ;
- 1-21B classe `401/403/404/429` comme « requête non transmise » → `failed`, sans session. Ce
  classement est une **déduction**. Aucune source citée ne dit qu'un `429` exclut la création
  d'une session.

La garantie « aucune session créée » n'est donc **pas établie**. Le rapport 1-22D § 9 est
corrigé dans ce sens. Le commentaire « Refus avant création, documentés… » de
`saspay-payment-provider.ts` (1-21B) l'affirme aussi. Il est laissé en l'état : ce lot ne touche
pas aux paiements.

**Correction proposée** (lot séparé). *Point 2 réalisé en 1-22D.2 ; le point 1 reste ouvert.*
1. Obtenir de SasPay une réponse écrite : un `429` sur `POST /checkout-sessions/` garantit-il
   l'absence de session ? L'ajouter aux questions ouvertes de 1-21E § 2.
2. En attendant, classer ce `429` comme **incertain** (`PaymentProviderUncertainError`) au lieu
   d'indisponible. Le paiement reste ouvert, avec sa référence marchand, jamais déclaré échoué.
   La vérification suivante le retrouve par recherche bornée sur la `metadata`, ou le laisse au
   rapprochement opérateur. Coût : l'organisation reste bloquée (un paiement ouvert) jusqu'à
   cette résolution. La pause locale de 15 s rend le cas rare.

## 7. Corrections du rapport 1-22D

- Rapprochement : une passe toutes les 5 min, au plus 10 paiements, soit 20 à 30 appels, ou
  jusqu'à 80 sans référence SasPay. L'ancienne estimation « 5 passes complètes / min » est
  remplacée. Une passe au pire cas s'interrompt sous 8 appels disponibles et reprend à la
  suivante.
- `429` à la création : garantie marquée non établie (§ 6), puis corrigée en 1-22D.2.
- Lancement depuis `api/test` : retiré comme solution ; renvoi à ce lot.

## 8. Commandes normales

- Depuis `api/` : `pnpm test:e2e -- <fichiers>`.
- Depuis la racine : `pnpm --filter api test:e2e -- <fichiers>`.

Pour les suites qui lancent des scripts compilés, exécuter d'abord `pnpm --filter api build`.
Aucune précaution sur le répertoire courant ni sur le `.env` n'est nécessaire.

## 9. Limites

- La protection suppose `test/jest-e2e.json`. Une suite lancée autrement échoue fermée au
  démarrage du MongoDB éphémère. Une suite qui n'en démarrerait pas recevrait encore la
  configuration de production ; aucune n'existe aujourd'hui sans base : 4 suites sans
  `AppModule`, toutes les autres via la garde.
- Les processus enfants qui chargent `AppModule` restent soumis à la configuration de
  production. Ils doivent être lancés comme `payment-reconciliation-cli-process` : environnement
  explicite et répertoire temporaire vide.

## 10. Fichiers de ce lot

| Fichier | Nature |
|---|---|
| `api/src/common/config/app-config.ts` | nouveau (extraction, comportement identique) |
| `api/src/app.module.ts` | utilise le module extrait |
| `api/test/jest-e2e.json` | `moduleNameMapper` |
| `api/test/e2e/e2e-app-config.ts` | nouveau : configuration e2e et garde au connecteur |
| `api/test/e2e/ephemeral-mongodb.ts` | échec fermé hors dispositif e2e |
| `api/test/test-config-isolation.e2e-spec.ts` | nouveau : reproduction et preuves |
| `docs/architecture/phase-1-22d-saspay-quota-isolation.md` | corrections (§ 7) |
| `docs/architecture/phase-1-22d1-test-config-isolation.md` | ce document |

Déploiement : aucun effet sur l'exécution en production, hormis l'extraction. À fusionner avec,
ou avant, toute suite e2e ajoutée. Aucune variable ni migration.
