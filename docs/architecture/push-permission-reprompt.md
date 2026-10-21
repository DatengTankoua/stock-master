# Notifications — demande d'activation répétée à chaque connexion

Branche `fix/push-permission-reprompt`, créée depuis `origin/dev`
(`cba84c9`). La tâche précédente (`feature/product-batches-foundation`,
`50f4e3f`) était déjà commitée, poussée et fusionnée (#58, puis #59 vers
`main`). L'arbre de travail était propre : rien à terminer ni à
préserver, aucun reset ni stash. Aucun commit, push ou déploiement. Clés
VAPID inchangées.

## 1. Constat et cause

Sur le même navigateur, l'utilisateur active les notifications, se
déconnecte, se reconnecte : Stock Master lui propose de nouveau de les
activer.

Trois notions distinctes, vérifiées une par une :

| Notion | Où elle vit | État après déconnexion (avant correctif) |
|---|---|---|
| Autorisation (`Notification.permission`) | navigateur, par origine | **`granted`, conservée** |
| Abonnement `PushManager` | navigateur, par origine et service worker | **supprimé** (`unsubscribe()`) |
| Rattachement au compte + préférences | `push_subscriptions` (API) | **document supprimé** |

**Cause.** `releasePushOnLogout` (`web/src/lib/push-notifications.ts`)
supprimait l'appareil côté serveur (`…/subscription/remove`) **et**
désabonnait le navigateur à chaque déconnexion. À la reconnexion,
`EngagementPrompt` ne regardait que le rattachement serveur
(`fetchPushDeviceState` → `registered: false` puisqu'il n'y a plus
d'abonnement local) et proposait « Activer », alors que la permission
était encore accordée. Les préférences par catégorie de l'appareil
étaient aussi perdues (remises « tout activé » à la réactivation).

Causes aggravantes :

- « Plus tard » n'était mémorisé que pour la session (`sessionStorage`) :
  chaque nouvelle connexion ou onglet relançait la bannière ; le modal
  revenait toutes les 24 h.
- Après une désactivation volontaire dans les réglages, l'invitation
  revenait aussi.
- Le refus du navigateur n'a jamais relancé `requestPermission` (déjà
  correct), mais son aide revenait à chaque session.

Points vérifiés et **hors de cause** :

- Délai de chargement : l'invitation n'est fixée qu'après les appels
  réseau (`invitation = null` pendant la vérification). Conservé.
- `requestPermission` n'était appelé qu'au clic. Conservé.
- `www` / sans `www` / application installée : permission et abonnement
  sont **propres à chaque origine**. En production, `stock-master.app`
  redirige vers `www.stock-master.app` (configuration hébergeur, hors
  dépôt ; `CANONICAL_ORIGIN`), et le manifeste (`start_url: /app`,
  `scope: /`) suit l'origine d'installation. Un utilisateur qui passe de
  l'une à l'autre se verra proposer l'activation une fois par origine :
  c'est un comportement du navigateur, pas une boucle. Non reproductible
  sur une même origine, pas de changement.

## 2. Correction

**API** (`api/src/push/`) — infrastructure existante, aucun index ni
migration :

- Nouvel état `disabledReason: 'signed-out'` (enum du schéma).
- `POST /notifications/push/subscription/release` (déconnexion, autorisé
  en session limitée comme `remove`) : l'appareil actif portant cet
  endpoint passe `disabled / signed-out`, **préférences conservées**.
  Quel que soit son titulaire actif : l'endpoint (jamais renvoyé par
  l'API) désigne ce navigateur. Réponse 204 dans tous les cas. La même
  écriture atomique (mise à jour en pipeline) enregistre
  `releasedSession`, l'empreinte SHA-256 du jeton de la session qui se
  déconnecte (jamais le jeton lui-même), quel que soit l'état de
  l'appareil (voir § 3).
- `POST /notifications/push/subscription/reconcile` (gardes complets :
  JWT, session, membership, abonnement) : rattache l'abonnement existant
  **au même utilisateur uniquement** —
  - actif pour une autre de ses organisations → suit l'organisation
    active ;
  - `signed-out` ou `session-revoked` → réactivé, `authVersion` courante,
    `registeredAt = maintenant` (aucun événement antérieur livré) ;
  - appartenant à un **autre utilisateur** → jamais attribué ; s'il est
    encore actif, il est **détaché** (`signed-out`) ; réponse identique
    à un appareil absent ;
  - `gone`, `replaced` ou supprimé (désactivation volontaire) → absent ;
  - session déjà déconnectée de cet appareil (`releasedSession` = jeton
    de la requête) → absent, et l'écriture de réactivation est
    conditionnée à `releasedSession ≠ session`.
- `register` (clic « Activer ») conserve les préférences si l'appareil
  appartenait déjà au même utilisateur ; nouvel utilisateur → défauts ;
  une activation explicite efface `releasedSession`.
- Le répartiteur n'envoie qu'aux appareils `active` : rien n'est livré
  pendant la déconnexion (inchangé).

**Web** :

- `releasePushOnLogout` appelle `release` ; l'abonnement local n'est
  **gardé que si le serveur confirme (204)**. Hors ligne, erreur, délai
  dépassé ou API plus ancienne : désabonnement local comme avant. Aucune
  nouvelle réconciliation n'est envoyée pendant la déconnexion ; une
  réconciliation déjà partie est neutralisée par le serveur (§ 3).
- `reconcilePushSubscription` : seulement si la permission est **déjà**
  `granted` et qu'un abonnement local existe avec la clé serveur
  courante ; jamais `requestPermission`, jamais `subscribe`.
- `EngagementPrompt` et la page Réglages réconcilient avant de décider ;
  décision pure dans `web/src/lib/push-invitation.ts` :
  - rattaché → rien ;
  - `granted` mais non rattaché (autre compte avant, abonnement retiré
    hors ligne…) → **« Relier cet appareil »**, texte explicite, un clic,
    sans nouvelle fenêtre du navigateur ;
  - `default` → « Activer » (demande native au clic) ;
  - `denied` → aide aux réglages, jamais de nouvelle demande.
- « Plus tard » sur une invitation push : **7 jours** sur l'appareil
  (`stockmaster.engagement.pushDeferredUntil`).
- « Désactiver » dans les réglages : indicateur
  `stockmaster.push.optedOut` ; plus aucune invitation automatique sur
  l'appareil (réactivation possible dans les réglages, qui lève
  l'indicateur).

**Appareils partagés** — aucune donnée personnelle ajoutée en local ;
détachement serveur à la déconnexion ; service worker inchangé (il
n'affiche aucun contenu sans identité locale correspondante) ; aucun
rattachement à un autre compte sans son clic ; préférence coupée jamais
réactivée.

## 3. Course réconciliation / déconnexion

Scénario : la requête `reconcile` est partie, puis l'utilisateur se
déconnecte. Côté navigateur, annuler ou attendre la requête ne garantit
rien : le serveur peut la traiter après `release`, ou entre sa propre
lecture et son écriture.

Avant ce point, la course était réelle : `release` ne touchait que les
appareils `active`. Une réconciliation qui avait lu l'appareil
`signed-out` pouvait donc écrire `active` après la déconnexion. Le premier
correctif côté navigateur (attente bornée, puis désabonnement local)
réduisait le risque sans rien garantir côté serveur ; il est retiré au
profit de la garantie serveur.

Garantie actuelle, côté serveur, quel que soit l'ordre de traitement :

- `release` traité **avant** `reconcile` : la réconciliation voit
  `releasedSession` = sa session et renvoie « absent » ;
- `release` appliqué **entre** la lecture et l'écriture de `reconcile` :
  l'écriture, filtrée sur `releasedSession ≠ session`, ne trouve plus le
  document ;
- `reconcile` écrit **avant** `release` : `release` détache ensuite
  l'appareil actif, dans la même écriture que le marquage.

Couverture : e2e `web-push-notifications`, **test 14** (ordre inverse,
puis entrelacement forcé, puis aucune livraison à l'appareil, puis
réconciliation normale dans une session suivante). Contrôle par mutation :
sans le filtre `releasedSession ≠ session`, le test 14 échoue
(`registered: true` après `release`). Côté web, `test:push-reconnect`
(cas 4) vérifie que le navigateur envoie bien `release` malgré la
réconciliation en vol, puis que la réponse tardive ne réactive rien
(serveur simulé appliquant la même règle).

Limite connue : les jetons sont déterministes (`sub`, `orgId`, `ver`,
portée, `iat` à la seconde). Une reconnexion dans la **même seconde** que
la déconnexion redonne le même jeton, donc la même session : la
réconciliation est alors refusée (issue sûre), et l'invitation « Relier »
s'affiche une fois. L'authentification n'a pas été modifiée (hors
périmètre).

## 4. Contrôles

Tous **simulés** : aucun service push réel, aucune notification
réellement reçue. Le faux transport de l'e2e enregistre les envois, les
doublures web remplacent navigateur et API.

| Contrôle | Résultat |
|---|---|
| `api` e2e `web-push-notifications` (nouveaux tests 13 : déconnexion → événement → reconnexion → changement de compte → session expirée de B → désactivation explicite / `gone` → changement d'organisation ; 14 : course `reconcile` / `release`) | 15/15 |
| `api` e2e `notification-center`, `member-activity-notifications`, `push-dispatcher-throughput` | 38/38 |
| `api` unitaires `src/push` | 52/52 |
| `web` `test:push-reconnect` (nouveau, `node:test`, 7 cas), ajouté au job CI `web` | 7/7 |
| `web` `tsc --noEmit`, ESLint (fichiers modifiés), `test:i18n` | OK |
| `api` ESLint (fichiers modifiés) | OK |
| **Build `api`** (`pnpm build`, `nest build`) | OK |
| **Build `web`** (`pnpm build`, `next build`) | OK |

Les e2e voisins (`notification-center`, `member-activity-notifications`,
`push-dispatcher-throughput`) ont été passés avant ce dernier point ; ils
n'utilisent ni `release` ni `reconcile` et n'ont pas été relancés. Le test
13 ouvre désormais une session distincte après chaque déconnexion
(`freshLogin`), voir la limite du § 3.

Le test 13 vérifie notamment : rien n'est envoyé à l'appareil pendant la
déconnexion ; à la reconnexion, une seule livraison, avec
`aud = {A, organisation}` ; préférences coupées conservées ; B ne récupère
jamais l'appareil de A sans clic ; un compte précédent encore actif est
détaché.

## 5. Validation restante sur appareil réel

> **Mis à jour** : push activé en production et testé sur de vrais téléphones
> (information du propriétaire, 21 octobre 2026 ; parcours exact non
> détaillé). Le guide ne porte plus la mise en garde « non testé » : [documentation-cleanup.md](documentation-cleanup.md).

**Aucun push réel n'a été reçu** : tous les contrôles ci-dessus sont
simulés. À faire en recette, sur un vrai navigateur (Chrome/Android,
Safari iOS avec l'application installée), avec les clés VAPID de recette
inchangées :

1. Activer les notifications, puis **désactiver une catégorie** (par
   exemple « Vente enregistrée ») dans Réglages → Notifications.
2. Se déconnecter.
3. Déclencher un événement de l'organisation : **aucune notification ne
   doit s'afficher**.
4. Se reconnecter avec le même compte, quelques secondes plus tard :
   **aucun bandeau ni modal** ; dans les réglages, l'appareil est
   « activé » et **la catégorie désactivée l'est toujours**.
5. Déclencher un nouvel événement d'une catégorie active : **notification
   reçue**. Un événement de la catégorie désactivée : **rien**.
6. Facultatif, appareil partagé : se déconnecter, se connecter avec un
   autre compte → invitation « Relier », aucune notification destinée au
   premier compte.

## 6. Limites et suites

- Safari / iOS : la réconciliation n'utilise ni `subscribe` ni
  `requestPermission`, donc aucun geste utilisateur n'est requis. Si
  l'abonnement local a disparu, l'invitation « Relier » demande un clic.
- Ordre de déploiement libre : web avant API → `release` / `reconcile`
  en 404 → ancien comportement (désabonnement local, invitation).
- Les anciens appareils supprimés avant ce correctif ne sont pas
  récupérables : un dernier clic « Activer » ou « Relier » sera
  nécessaire après la mise en production.
- `test:push-reconnect` est lancé par la CI (job `web`). Les e2e de
  l'API ne le sont pas (le job `api` lance seulement `pnpm test`).

## Fichiers

- `api/src/push/push-subscriptions.service.ts`, `push.controller.ts`,
  `dto/push-subscription.dto.ts`, `schemas/push-subscription.schema.ts`
- `api/test/web-push-notifications.e2e-spec.ts` (tests 13 et 14)
- `.github/workflows/ci.yml` (étape `pnpm test:push-reconnect`)
- `web/src/lib/push-notifications.ts`, `web/src/lib/push-invitation.ts`
  (nouveau)
- `web/src/components/notifications/engagement-prompt.tsx`
- `web/src/app/app/organization/notifications/page.tsx`
- `web/src/i18n/resources/{fr,en}/notifications.ts`
- `web/scripts/test-push-reconnect.mjs` (nouveau), `web/package.json`
