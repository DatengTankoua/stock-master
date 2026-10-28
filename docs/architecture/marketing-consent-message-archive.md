# Consentement aux e-mails marketing et archivage des messages administratifs

> Aucun envoi de campagne dans ce lot. Les textes juridiques restent au
> statut « projet » ; les nouvelles versions ne valent pas validation
> juridique.

## 0. Base et périmètre

- Branche `feature/marketing-consent-message-archive`, créée depuis
  `origin/dev` à jour (`6213ee8`, « feat: platform admin communicationns »).
  Les communications administratives (`platform-admin-communications.md`)
  y figurent : aucune dépendance externe à documenter.
- Arbre propre au départ : aucune modification locale à préserver, aucun
  reset ni stash.
- Aucun commit, push, déploiement, changement de configuration, envoi réel
  ni écriture en production. MongoDB éphémère et recette isolée seulement.
- Mécanismes réutilisés : transaction d'inscription, preuves immuables et
  archive versionnée des documents juridiques (`forbidMutations`,
  `$setOnInsert`), capacités et commande opérateur de l'administration,
  BFF `/api/admin/*`, pré-déploiement.

## 1. Consentement marketing individuel

### 1.1 Modèle

Module feuille `api/src/marketing-consent/`, importé par `AuthModule` comme
`LegalModule`. Trois collections :

| Collection | Contenu | Écriture |
|---|---|---|
| `marketing_consents` | État COURANT : `_id = email.promotions/<userId>` (un état par utilisateur, unicité par `_id` natif), `granted`, `addressSha256`, `wordingVersion`, `source`, `changedAt`, `lastEventId` | Mise à jour dans la transaction de chaque changement effectif |
| `marketing_consent_events` | PREUVE d'un choix : `userId`, `channel: email`, `purpose: promotions`, `action: granted\|withdrawn`, `at` (horloge serveur), `source: registration\|settings`, `wordingVersion`, `locale`, `wordingId`, `addressSha256` | Insertion seule ; modèle immuable côté application (`forbidMutations`) |
| `marketing_consent_wordings` | Libellé PRÉSENTÉ : `_id = email.promotions@<version>/<langue>`, texte, empreinte, date | `$setOnInsert` à la première utilisation, jamais réécrit ; texte relu et comparé à l'empreinte |

Ni adresse IP, ni agent utilisateur, ni texte libre. L'adresse n'est pas
recopiée : seule son empreinte SHA-256 (adresse normalisée) est gardée,
pour lier l'accord à l'adresse.

**Absence = refus.** Un compte sans état, un champ absent, une case
décochée, une invitation, l'acceptation des conditions, l'autorisation
push et les préférences de notifications (dont `platformMessage`) ne
créent jamais d'accord. Aucune migration ne crée d'état.

### 1.2 Libellé versionné

`marketing-consent-wording.ts` : version `1`, texte FR et EN, empreinte
figée.

| Langue | Texte | SHA-256 |
|---|---|---|
| fr | « Je souhaite recevoir par e-mail les offres et promotions de Stock Master. Je peux me désinscrire à tout moment. » | `30db7e85…19541cae` |
| en | « I would like to receive Stock Master offers and promotions by email. I can unsubscribe at any time. » | `aa78f661…c21dd3c7` |

Le web affiche ce texte depuis l'i18n (`legal`, `marketing.label`) et
envoie la version (`web/src/lib/marketing-consent.ts`). Un test unitaire
de l'API vérifie l'empreinte, la présence du texte exact dans les
ressources FR/EN et la même version côté web. Changer le texte impose une
nouvelle version (ici et dans le web) ; l'ancienne reste pour lire les
preuves.

### 1.3 Parcours

| Parcours | Comportement |
|---|---|
| Inscription (`POST /auth/register`) | Case facultative, non cochée, distincte des conditions. Champ `marketingEmailConsent: { granted, wordingVersion, locale }` facultatif. Contrôle AVANT toute écriture ; si `granted: true`, preuve et état écrits dans la MÊME transaction que le compte et le commerce. Absent ou `false` : rien n'est écrit. Adresse déjà inscrite : réponse neutre inchangée (1-18E), aucun accord pour le compte existant |
| Création de compte par invitation | Aucun accord ; le champ est refusé (400, liste blanche). Le membre choisit ensuite dans ses réglages |
| Réglages (`GET`/`PUT /auth/me/marketing-consent`) | Compte connecté seulement (`sub` du JWT) ; aucun mot de passe ni MFA ; session limitée acceptée (comme la langue du compte) ; aucun autre champ accepté (`userId`, `email`, `source`, date : 400). Web : rubrique « Offres et promotions par e-mail », Organisation → Notifications |
| Organisation, administration | Aucune route : ni le propriétaire ni un administrateur de la plateforme ne peut accorder (ou retirer) l'accord d'un autre utilisateur |

Refus : booléen strict (`"true"`, `1`, `null` → 400), version non
numérique ou langue hors `fr|en` → 400 ; accord avec une version autre que
la version en vigueur → 409 `MARKETING_CONSENT_WORDING_OUTDATED` (page
périmée, aucune écriture). Un **retrait** accepte toute version publiée,
pour rester toujours possible.

**Rejeu et concurrence.** Un choix identique à l'état courant (même
accord, même adresse, même version ; ou retrait sans accord en cours)
n'écrit rien. Chaque changement lit et écrit l'état dans une transaction :
des requêtes identiques simultanées entrent en conflit d'écriture, la
transaction rejouée relit l'état et n'ajoute aucune preuve (testé : 6
requêtes, 1 preuve).

**Retrait immédiat.** L'éligibilité relit l'état à chaque appel, sans
cache.

### 1.3 bis Accès au réglage hors des pages métier

Vérification ciblée : le réglage ne dépend ni d'une permission, ni de
l'état du commerce, ni de l'abonnement.

- **API** : `GET`/`PUT /auth/me/marketing-consent` est une route
  d'identité. Elle ne demande ni contexte d'organisation
  (`@SkipOrganizationContext`), ni abonnement actif
  (`@AllowInactiveSubscription('identity')`), ni permission. Elle
  accepte le jeton applicatif comme le jeton limité.
- **Web, constat** : la page Organisation → Notifications n'est
  accessible à aucun rôle particulier (aucune permission requise), mais
  elle est **inaccessible** dans trois cas :
  - session limitée : redirection vers `/access` ;
  - abonnement expiré pendant la session : écran de blocage commercial à
    la place des pages ;
  - commerce suspendu pendant la session : avis de suspension à la place
    des pages.
- **Correction** : le **même** composant `MarketingConsentSection` est
  affiché dans ces écrans, sans logique dupliquée :
  - écran de blocage commercial (`commercial-block-screen.tsx`), commun à
    `/access` et au blocage en cours de session. Il reçoit le jeton limité
    explicite (paramètre `token` facultatif ajouté au composant et aux
    deux appels de `web/src/lib/marketing-consent.ts`) ;
  - avis de suspension du shell (`app/app/layout.tsx`).
  Le composant est masqué hors ligne dans ces écrans.
- **Limite** : un compte dont **tous** les commerces sont suspendus ne peut
  pas ouvrir de session (règle de connexion existante,
  `ORGANIZATION_SUSPENDED`). Il n'a donc accès à aucun réglage. Ce lot ne
  change pas cette règle ; un retrait sans connexion relèvera du lien de
  désabonnement (§ 6).
- **Contrôle e2e ajouté** (`marketing-consent.e2e-spec.ts`, 3 tests, suite
  18/18). Dans chaque cas, une route métier (`/notifications/preferences`)
  est bien refusée (403), tandis que lecture, accord et retrait
  réussissent :
  - vendeur sans droit particulier ;
  - abonnement expiré, avec le jeton applicatif puis avec la session
    limitée (`SUBSCRIPTION_INACTIVE`) ;
  - commerce suspendu pendant la session.
- **Recette navigateur** : 7/7 contrôles, aucune erreur de page, aucun
  défilement horizontal :
  - session limitée sur `/access`, mobile FR ;
  - commerce suspendu pendant la session, ordinateur EN.

### 1.4 Changement d'adresse e-mail

Constat : l'application ne propose **aucun** changement d'adresse (les CGU
le disent ; demande par e-mail au support). Rien n'est modifié dans le
parcours de vérification existant.

Comportement retenu : l'accord porte l'empreinte de l'adresse au moment
du choix. Si l'adresse du compte change (futur parcours, ou modification
manuelle par l'exploitant), l'ancien accord ne vaut plus :
`emailEligibility` renvoie `address_changed`, les réglages affichent la
case décochée avec une explication, et un nouvel accord explicite (avec
l'empreinte de la nouvelle adresse) est nécessaire. La nouvelle adresse
doit aussi être vérifiée (`email_unverified` sinon).

### 1.5 Éligibilité centralisée (lecture seule)

`MarketingConsentService.emailEligibility(userId)` →
`{ eligible, reasons[] }`, raisons :

- `account_missing` ;
- `no_consent` : aucun accord actuel ;
- `address_changed` : accord donné pour une autre adresse ;
- `email_unverified` ;
- `no_active_membership` : aucune appartenance active à un commerce actif
  (règle de connexion existante).

Aucun expéditeur, campagne, planificateur ni route publique de
désabonnement n'est créé. Le refus n'a aucun effet sur l'accès ni sur les
communications de service : le traitement des messages de service ne lit
pas l'accord marketing (testé : message de service livré sans accord).

## 2. Documents juridiques

Mécanisme existant (`legal-archive.mjs write` dans le build isolé) :

| Document | Version | FR | EN |
|---|---|---|---|
| Conditions d'utilisation | 0.3 → **0.4** | `a36afe42…a5d008f5` | `e94f40d3…8c6ebc89` |
| Confidentialité | 0.6 → **0.7** | `92ea1438…06e9ce2e` | `521357e5…f7d7e8bc3` |

Empreintes complètes : `api/src/legal/archive/manifest.json`. Les
versions 0.3 (CGU) et 0.3 à 0.6 (confidentialité) et leurs acceptations
restent inchangées : seuls des fichiers et des entrées ont été ajoutés.

Contenu ajouté :

- **CGU 0.4**, section « E-mails de Stock Master » : e-mails de service
  (confirmation, réinitialisation, invitations, messages de service) ;
  e-mails promotionnels seulement avec un accord distinct et facultatif,
  personnel ; **accepter les conditions ne vaut pas accord** ; retrait à
  tout moment dans l'application ; sans effet sur l'accès ni sur les
  e-mails de service.
- **Confidentialité 0.7** : données de preuve du choix ; finalité « offres
  et promotions » (consentement spécifique) et preuve des choix ; section
  « E-mails promotionnels et e-mails de service » (facultatif, individuel,
  retrait immédiat, distinction avec le service, adresse confirmée, push
  et préférences sans valeur d'accord) ; ligne de conservation.
- Deux phrases devenues fausses ont été corrigées (et seulement elles) :
  « aucune autorisation facultative n'est demandée à l'inscription » et
  « Stock Master n'envoie pas de prospection commerciale ». Aucune autre
  clause n'est modifiée.
- Aucun lien de désabonnement n'est annoncé dans les e-mails ; aucune
  durée de conservation, identité juridique ni prestataire n'est inventé
  (commentaires « À COMPLÉTER / À VALIDER »).

**Date de publication provisoire : 28 octobre 2026** (`updatedAt` dans
`site-identity.ts`, `--published-at=2026-10-28`, `publishedAt` du libellé).
Elle est rendue dans le texte archivé et **doit correspondre à la
publication effective** : si la mise en ligne a lieu un autre jour,
changer la date et réarchiver AVANT publication (ces versions ne sont pas
encore publiées).

**Conséquence de la CGU 0.4** : pour les comptes existants, les conditions
d'utilisation redeviennent « en attente » (`GET /legal/acceptance`) ;
l'invite reste désactivée par défaut (`LEGAL_ACCEPTANCE_PROMPT_ENABLED`).
Une réacceptation n'écrit jamais d'accord marketing (testé, avec et sans
accord existant).

## 3. Archivage des messages administratifs

### 3.1 Capacité

`platform.communications.archive`, ajoutée à `PLATFORM_CAPABILITIES` :
espace `platform.` distinct des permissions délégables des commerces,
jamais attribuée automatiquement (une autorisation commence toujours en
`platform.read`). `platform.read` permet la consultation des filtres, pas
l'archivage. Les capacités d'envoi (`notify`, `email`) ne suffisent pas.

Attribution (commande opérateur existante, **non exécutée en
production**) — d'abord sans `--apply` pour relire l'effet, puis avec :

```
node /app/api/dist/migrations/platform-admin-cli.js capability-add --user-id=<identifiant 24 hex> --capability=platform.communications.archive --reason="<motif de 10 à 300 caractères>" --operator=<opérateur>
node /app/api/dist/migrations/platform-admin-cli.js capability-add --user-id=<identifiant 24 hex> --capability=platform.communications.archive --reason="<motif de 10 à 300 caractères>" --operator=<opérateur> --apply
```

Depuis un poste : `MONGODB_URI=... pnpm --filter api platform-admin -- capability-add …`.
Retrait : `capability-remove` avec les mêmes options.

### 3.2 API

| Route | Accès | Effet |
|---|---|---|
| `GET organizations/:id/messages?page=&archived=active\|archived\|all` | MFA + `platform.read` | Défaut `active`. `total` et la pagination portent sur le filtre ; `counts: { active, archived }` ; chaque message porte `archivedAt` et `archivedBy` (adresse) |
| `POST organizations/:id/message-archive` | MFA + `platform.communications.archive` (vérifiée par le service, refus audité) | `{ messageIds }` |
| `POST organizations/:id/message-restore` | idem | idem |

Contrôles serveur : 1 à 50 identifiants (`MESSAGE_ARCHIVE_BATCH_MAX`),
24 hex, sans doublon (400, jamais tronqué) ; commerce existant ; tous les
messages doivent appartenir à CE commerce, sinon 404 pour toute la
demande, **sans aucune modification** (vérification et mise à jour dans
une transaction). Réponse `{ archived, requested, changed }`.

Idempotence : seuls les messages qui changent d'état sont écrits
(`archivedAt: null` → date ; date → `null`) ; un rejeu renvoie
`changed: 0` et la date d'archivage d'origine est conservée.

Audit (`organization_message_archive` / `organization_message_restore`),
dans la même transaction, seulement si un message change : auteur, date,
commerce, capacité, `after: { messageIds, changed }`. Jamais le titre ni
le texte. Refus (`capability`, `not_found`) audités en `denied`.

Seuls `archivedAt` et `archivedBy` du message changent. Ne sont jamais
touchés : livraisons (statut, tentatives, clés d'idempotence, dates de
tentative, incertitudes, résultats), notifications des destinataires,
e-mails déjà reçus, traitement de fond, audits. Aucun effacement
physique. Un message en attente archivé continue d'être livré (testé).

### 3.3 Interface

Fiche organisation, « Messages de service » :

- filtre « Actifs / Archivés / Tous » avec compteurs, Actifs par défaut ;
- avec la capacité : case par message, « Sélectionner les messages de cette
  page », « Archiver (n) » et « Restaurer (n) » selon la sélection,
  « Archiver » / « Restaurer » sur chaque message ;
- confirmation simple (liste des titres, rappel que l'envoi n'est pas
  annulé), sans preuve renforcée ; MFA inchangée pour les envois et
  relances ;
- explication : « Archiver masque le message de la liste principale… Cela
  n'annule pas son envoi… » ;
- message archivé : badge et « Archivé le … par … ».

Le BFF relaie les deux nouvelles routes et le paramètre `archived`
(`bff-policy.ts`, testé). Aucune fonction d'annulation.

## 4. Migration, déploiement, compatibilité

- `create-marketing-consent-indexes.js` ajoutée à `migrate:predeploy`
  (après les index de l'administration) : collections et index
  `{ userId, at }` ; `--check` en lecture seule ; aucune donnée lue ni
  écrite, **aucun utilisateur inscrit**.
- `create-platform-admin-indexes.js` (déjà au pré-déploiement) crée
  `organizationId_1_archivedAt_1_createdAt_-1` sur `platform_messages`.
  L'espace d'administration vérifie ses index avant d'ouvrir : sans la
  migration, il répond 503 (les commerces ne sont pas affectés).
- Aucune migration n'attribue de capacité.
- Données existantes : messages sans `archivedAt` = actifs ; comptes sans
  état = aucun accord. Aucune réécriture.
- Ordre : pré-déploiement (index) → API → web. Un web ancien face à la
  nouvelle API : inscription sans le champ (= aucun accord), historique
  sans filtre (= actifs seulement : un message archivé par la nouvelle
  interface disparaît de l'ancienne liste). Un web nouveau face à une
  ancienne API : le champ d'inscription est refusé (400) et les routes
  d'archivage et de consentement répondent 404 ; déployer l'API d'abord.
- **Retour arrière** : une ancienne version de l'API ignore l'accord et
  ses retraits. Elle n'envoie aucune campagne aujourd'hui ; aucune version
  qui enverrait des campagnes ne doit tourner si elle ne lit pas l'état
  courant et les retraits (`emailEligibility`). Les collections et index
  ajoutés peuvent rester en place ; les champs `archivedAt`/`archivedBy`
  sont ignorés par l'ancienne version (messages archivés de nouveau
  visibles).
- Droits Atlas : comme pour `legal_acceptances`, limiter la modification et
  la suppression de `marketing_consent_events` et
  `marketing_consent_wordings` (l'immuabilité applicative ne protège pas
  d'un accès direct).

## 5. Contrôles

| Contrôle | Résultat |
|---|---|
| E2E `marketing-consent` (nouveau) | 18/18 (dont 3 tests d'accès, § 1.3 bis) |
| E2E `platform-admin-communications` (+ 5 archivage) | 24/24 |
| E2E `legal-acceptance` | 19/19 |
| E2E régression : 9 suites (inscription, anti-abus, invitations, vérification, administration ×3, consentement, pré-déploiement) | 203/203 |
| Unitaires API, suite complète (dont `marketing-consent.spec.ts`) | 110 suites, 2028/2028 après correction (§ 5.1) |
| Typage API (`tsc -p tsconfig.build.json`) et web (`tsc --noEmit`) | 0 erreur |
| Lint API (fichiers modifiés) et web | 0 erreur (avertissements antérieurs seulement) |
| i18n : `check-i18n.mjs`, `i18n-coverage.mjs --fail` | 0 problème |
| BFF : `test-admin-bff.mjs` | réussi |
| Build web isolé + archive juridique (`write` puis `check`) | exit 0, aucun `.env` dans la copie |

Couverture e2e du consentement : inscription sans champ, case décochée,
accord (preuve exacte, champs limités, libellé archivé), valeurs
invalides et libellé périmé (aucune écriture), adresse déjà inscrite,
invitation (champ refusé, aucun accord), compte antérieur, accord / rejeu
/ retrait immédiat / rejeu, concurrence, impossibilité de viser un autre
utilisateur (champs refusés, aucune route d'organisation ni
d'administration), version périmée et retrait toujours possible,
changement d'adresse, éligibilité (adresse non vérifiée, commerce
suspendu), réacceptation des conditions sans effet, préférences sans
effet, immuabilité des preuves.

Couverture e2e de l'archivage : capacité dédiée exigée (lecture seule et
capacités d'envoi refusées, refus audités, aucune modification),
individuel idempotent, audit sans contenu, groupé, interorganisations et
inconnu refusés sans modification partielle, formes refusées, filtres,
compteurs et pagination, message en attente archivé puis livré
(livraisons identiques, notification et e-mail uniques, audit d'envoi
conservé).

### 5.1 Résultats complémentaires

- Premier passage unitaire : 1 échec, légitime. `common/i18n/i18n.spec.ts`
  exige une traduction de chaque message d'erreur lancé par l'API. Les
  trois messages du consentement ont été ajoutés au catalogue
  (`error-messages.ts`) ; la suite i18n passe (15/15).
- Recette navigateur isolée (`recipe.js start --platform-admin
  --anti-bot=simulated`, comptes et clés fictifs, base locale) :
  - capacités accordées au compte de recette par la commande opérateur
    (base locale uniquement) ;
  - 19 captures, aucune erreur de page, aucun défilement horizontal ;
  - administration, ordinateur FR et mobile EN : filtre Actifs par
    défaut, archivage individuel confirmé, message masqué, filtre
    Archivés (badge, auteur), sélection de la page, restauration groupée,
    compteurs ;
  - inscription, mobile FR et ordinateur EN : case décochée, distincte des
    conditions, libellé exact ;
  - réglages, mobile FR et ordinateur EN : sans accord, accord (date),
    retrait.
- Remarque d'interface : la case des réglages ne change d'état qu'après la
  réponse du serveur (pas d'affichage anticipé), le temps d'un aller-retour.

## 6. Contrat pour le prochain lot (campagnes et désabonnement)

1. **Contrôle juste avant chaque envoi** : `emailEligibility(userId)` pour
   CHAQUE destinataire, au moment de l'envoi (pas à la planification) ;
   envoi seulement si `eligible`. Adresse d'envoi = adresse actuelle du
   compte (celle dont l'empreinte correspond).
2. **Lien de désabonnement sans connexion** dans chaque e-mail
   promotionnel : jeton propre au destinataire et à la finalité, non
   devinable, stocké haché, sans exposer l'identifiant ni l'adresse.
3. **Retrait idempotent** par ce lien : réutilise le même enregistrement
   (preuve `withdrawn`, source à ajouter, par exemple `unsubscribe_link`),
   effet immédiat, aucune erreur si déjà retiré ; un lien rejoué ou ancien
   ne peut jamais réactiver l'accord.
4. Aucun accord ne s'obtient par ce lien ni par une campagne ; l'accord
   reste une action de l'utilisateur connecté (inscription, réglages).
5. Campagnes distinctes des messages de service (autre catégorie,
   expéditeur et journal), jamais envoyées par la route des messages de
   service.
6. En-têtes de désabonnement (`List-Unsubscribe`) à prévoir avec le
   prestataire d'envoi.

## 7. Décisions manquantes (production et juridique)

1. **Date de publication** des CGU 0.4 et de la confidentialité 0.7
   (provisoire : 28 octobre 2026).
2. **Durée de conservation** des preuves de choix après un retrait et après
   la fin du compte (aucune inventée).
3. **Validation juridique** de la finalité promotionnelle et de son
   fondement (consentement, loi 2024/017), du texte de la case et de la
   preuve conservée.
4. **Réacceptation des CGU 0.4** par les comptes existants : activer ou non
   `LEGAL_ACCEPTANCE_PROMPT_ENABLED` (inchangé, désactivé par défaut).
5. Attribution de `platform.communications.archive` (commande § 3.1, à
   lancer par l'exploitant).
6. Droits Atlas sur les nouvelles collections de preuve (§ 4).

## 8. Fichiers

Nouveaux :

- `api/src/marketing-consent/` (libellé, schémas, DTO, service,
  contrôleur, module, index, tests unitaires) ;
- `api/src/migrations/create-marketing-consent-indexes.ts` ;
- `api/test/marketing-consent.e2e-spec.ts` ;
- `api/src/legal/archive/conditions-utilisation/0.4.{fr,en}.txt`,
  `api/src/legal/archive/confidentialite/0.7.{fr,en}.txt` ;
- `web/src/lib/marketing-consent.ts`,
  `web/src/components/legal/marketing-consent-section.tsx` ;
- ce rapport.

Modifiés :

- API :
  - `auth/{auth.module,auth.service,auth.service.spec}.ts`,
    `auth/dto/register.dto.ts` ;
  - `platform-admin/` : capacités, magasin, index, DTO, contrôleur,
    service des communications, politique ;
  - `migrations/{predeploy-migrations,platform-admin-cli}.ts` ;
  - `package.json`, `legal/archive/manifest.json` ;
  - `test/platform-admin-communications.e2e-spec.ts`.
- Web :
  - `app/auth/register/page.tsx` ;
  - `app/app/organization/notifications/page.tsx` ;
  - `app/app/layout.tsx` et `components/subscription/commercial-block-screen.tsx`
    (réglage affiché dans les écrans de blocage, § 1.3 bis) ;
  - `components/admin/{organization-messages,organization-actions}.tsx` ;
  - `app/admin/(console)/audit/page.tsx` ;
  - `lib/{api,admin/admin-api,admin/bff-policy,legal/site-identity}.ts` ;
  - `scripts/test-admin-bff.mjs` ;
  - i18n `admin` et `legal` (FR/EN) ;
  - documents `conditions-utilisation` et `confidentialite` (FR/EN).
- `README.md` : tableau des migrations, vérification `--check`.
