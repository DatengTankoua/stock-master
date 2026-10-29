# Reprise des créations SasPay restées `initiating`

Branche : `fix/saspay-initiating-recovery`, créée depuis `origin/dev`
(`dc676a8`, qui contient le lot des retards de confirmation), arbre propre au
départ. Rien n'est commité, poussé ni déployé. Aucun appel réel à SasPay,
aucun paiement, aucun accès à la production, aucune configuration modifiée.

## 1. Cause

`createPayment` procède en trois temps :

1. il insère le paiement en `initiating` (droit d'initier réservé) ;
2. il appelle SasPay (`POST /checkout-sessions/`, 10 s au plus, coupé par
   `AbortSignal`) ;
3. il enregistre l'issue : `pending` avec la référence de session, `uncertain`
   (issue inconnue) ou `failed` (rien n'a été transmis, ou refus).

Si le processus s'arrête entre 1 et 3, le paiement reste `initiating`.
Avant ce lot, plus rien ne le faisait évoluer :

- le rapprochement ne lit que `pending` et `uncertain` ;
- le CLI refuse `initiating` (`status-not-reconcilable`) ;
- seul « Vérifier » pouvait le rattacher, et seulement si la recherche
  retrouvait la session.

Le paiement étant ouvert, il bloque toute nouvelle tentative du commerce.

## 2. Ce que les données persistées permettent de distinguer

Avant l'appel externe, rien n'est écrit en dehors du document `initiating`.
Il n'y a ni horodatage d'appel ni clé d'idempotence.

| Cas | Ce qui s'est passé | Données locales | Distinguable ? |
|---|---|---|---|
| A | arrêt avant l'appel | `initiating`, sans référence | **Non** (identique à B et C) |
| B | appel transmis, résultat inconnu | idem | **Non** |
| C | session créée chez SasPay, réponse non enregistrée | idem | **Non** localement ; seulement si la session est retrouvée chez SasPay |
| D | session enregistrée, état local encore `initiating` | référence présente | **Ne se produit pas par le code** : la référence et `pending` sont écrits dans la même mise à jour (`recordPending`). Un tel document, s'il existait, serait vérifié par sa référence |

Aucun de ces cas n'est déduit d'un délai écoulé, d'une erreur réseau ou
d'une recherche sans résultat. Seule une session retrouvée chez SasPay,
relue et concordante, établit le cas C.

## 3. Limites du prestataire (documentation déjà consultée)

Les sources sont la documentation officielle et l'OpenAPI, consultées le
2026-10-11 et le 2026-10-12 et reprises dans
`saspay-payment-provider.ts`. Aucune nouvelle consultation n'a été faite.

- **Pas d'`Idempotency-Key`** sur `POST /checkout-sessions/`
  (`idempotentInitiation = false`). Réémettre la création peut produire une
  seconde session. **Aucun appel de création n'est donc jamais réémis.**
- **Recherche** : seule la liste paginée des sessions
  (`GET /checkout-sessions/?page=&page_size=`) permet de retrouver une
  session, par `metadata.merchantReference`. Elle est bornée à 5 pages de
  100 sessions et 20 s. Un résultat `not-found` ou une liste incomplète ne
  prouvent jamais l'absence de session.
- Aucune route de recherche par référence marchand n'est documentée, ni
  aucune garantie de délai de visibilité d'une session dans la liste.

## 4. Récupération ajoutée

**Reclassement après délai de sécurité**
(`SubscriptionPaymentsService.recoverStaleInitiations`, appelé en tête de
chaque passe du rapprochement existant) :

- **Sélection** : paiements `initiating` d'un prestataire à recherche par
  référence marchand (SasPay), dont `createdAt` est plus ancien que
  `INITIATING_RECOVERY_DELAY_MS` (10 min). Au plus 5 par passe, les plus
  anciens d'abord.
- **Effet** : passage conditionnel `initiating` → `uncertain` /
  `initiation_uncertain`. C'est l'état existant d'une création à l'issue
  inconnue : il reste ouvert, n'est jamais un échec et n'est jamais réinitié.
  Aucun appel externe à cette étape.
- **Ensuite**, le moteur existant le prend en charge comme tout `uncertain`,
  dans la même passe ou la suivante :
  - réservation persistante par `lastCheckedAt` ;
  - recherche bornée par référence marchand ;
  - relecture de la session, puis concordance stricte (référence marchand,
    montant, devise ; la session porte la référence du paiement, donc de son
    commerce) ;
  - rattachement (`pending`) ou attribution unique (`succeeded`), selon le
    cas.

**Délai de 10 min.** Une création en cours dure au plus le budget de l'appel
(10 s, coupé par `AbortSignal`) plus ses écritures MongoDB (bornées par le
pilote, 60 s au plus). Le délai laisse une large marge à une création lente.
Il correspond aussi à la cadence de relecture existante (10 min).

**Concurrence et écrasement :**

- Le reclassement est une écriture conditionnelle sur `status: initiating`.
  Entre processus, une seule reprise a lieu. Si « Vérifier », un webhook ou la
  création elle-même sont passés avant, rien n'est écrit.
- Une création figée au-delà du délai, dont la réponse arrive après le
  reclassement : son écriture conditionnelle (`from: initiating`) est
  refusée et l'état `uncertain` est conservé. La session est retrouvée par
  la recherche, jamais recréée (testé).
- Toutes les écritures du moteur relisent l'état et ne régressent jamais un
  `succeeded` ni une résolution.

**Sélection indexée sans nouvel index.** Le filtre `{ status: 'initiating' }`
utilise le préfixe de l'index existant `status_1_updatedAt_1` (migration des
notifications de l'administration, déjà dans `migrate:predeploy`). Un
document `initiating` ne vit normalement que quelques secondes : la
sélection porte sur très peu de documents. Aucune migration n'est ajoutée.

**Cadence.** Après reclassement, le paiement suit la cadence de tout
`uncertain` : une relecture au plus toutes les 10 min, au plus 8 appels
SasPay chacune, passe interrompue si le budget des confirmations manque. Le
reclassement ne consomme aucune place de la passe ni aucun appel. Les
`pending` et `uncertain` existants gardent leur ordre (`lastCheckedAt`) et
leurs fréquences (testé). Fréquences inchangées.

## 5. Cas impossible à résoudre automatiquement

Si la recherche ne retrouve pas la session (session jamais créée, liste
incomplète au-delà de 500 sessions, SasPay indisponible) :

- **le paiement reste non résolu** (`uncertain` / `initiation_uncertain`,
  ouvert). Aucun passage en échec, aucune clôture automatique ;
- **aucune nouvelle tentative** : la création renvoie `409
  PAYMENT_ALREADY_PENDING`. C'est la règle existante, un seul paiement ouvert
  par commerce ;
- **client** : texte « Lien de paiement non récupéré ». Il ne promet plus que
  « Vérifier » retrouve la page : « tente de la retrouver chez SasPay, sans
  jamais en créer une nouvelle ; aucun nouveau paiement n'est possible en
  attendant ». Après 24 h depuis la création de la tentative (champ
  `creationUnresolved.delayed`), un bloc d'assistance s'affiche : référence
  copiable, WhatsApp, e-mail, page Assistance. Il précise que la page n'a
  peut-être jamais existé ;
- **administration** : l'alerte existante `payment_confirmation_delayed`
  (24 h) porte désormais `incidentCode: initiation_uncertain` et s'affiche
  « Création de la session SasPay non confirmée (session inconnue,
  peut-être inexistante) », avec la référence Stock Master. Même clé de
  déduplication, donc une seule alerte (testé) ;
- aucune validation forcée, aucune nouvelle règle financière.

## 6. Ce que « Vérifier » et le CLI permettent réellement

| Cas | Rapprochement automatique | « Vérifier » (propriétaire) | CLI `reconcile` |
|---|---|---|---|
| A (aucune session) | reclassé `uncertain` après 10 min ; recherche sans résultat ; **reste non résolu** | recherche sans résultat ; rien ne change | après reclassement : `lookup-not-found`. Clôture seulement avec la preuve écrite de SasPay (`--close-without-session --ticket=…`, 1-22D.3) |
| B (issue inconnue) | idem A tant que la session n'est pas visible ; rattaché si elle apparaît | idem | idem A ; `--reference=<id de session>` si SasPay le fournit |
| C (session créée) | rattaché `pending` (ou attribué si payé) dès que la recherche la trouve | idem, immédiatement | après reclassement : plan `found` puis rattachement audité, ou `--reference` fournie par SasPay |
| D (référence connue) | vérifié par sa référence après reclassement | vérifié par sa référence | après reclassement |

Limites communes :

- au-delà de 500 sessions, la recherche est incomplète, et seule une
  `--reference` fournie par SasPay permet de conclure ;
- tant que le paiement est `initiating` (moins de 10 min, ou rapprochement
  désactivé par `PAYMENT_RECONCILIATION_SWEEP_SECONDS=0`), le CLI répond
  `status-not-reconcilable` ;
- ni « Vérifier » ni le CLI ne sont une solution universelle : sans session
  retrouvée et sans preuve écrite, le cas reste ouvert.

## 7. Démarche opérateur (terminal Railway du service API)

Arguments vérifiés contre le vrai parseur
(`parseReconciliationArguments`, version compilée). Script :
`subscription:reconcile-payment` → `dist/migrations/reconcile-subscription-payment.js`.
L'environnement du service fournit `MONGODB_URI` : ne rien copier, ne saisir
aucun secret.

Préparation (même méthode que [railway-platform-admin.md](../operations/railway-platform-admin.md) ;
le chemin de Node dépend de l'image déployée, voir cette page s'il est
introuvable) :

```sh
export PATH="/mise/installs/node/22.23.3/bin:$PATH"
PAYMENT_ID="REMPLACER_PAR_L_IDENTIFIANT_DU_PAIEMENT"
RECONCILE_CLI="$(find / -path '*/dist/migrations/reconcile-subscription-payment.js' -not -path '*/node_modules/*' 2>/dev/null | head -n 1)"
echo "Node : $(node --version)  |  Commande : $RECONCILE_CLI"
```

Lecture locale, sans appel externe :

```sh
node "$RECONCILE_CLI" inspect --payment-id="$PAYMENT_ID"
```

Prévisualisation (lectures SasPay seulement, aucune écriture) :

```sh
node "$RECONCILE_CLI" reconcile --payment-id="$PAYMENT_ID"
```

Lire `plan.decision` et `plan.lookup.outcome` :

- `found` avec un plan prêt : noter le jeton (`planToken`, 32 caractères
  hexadécimaux), puis appliquer dans une commande séparée :

  ```sh
  node "$RECONCILE_CLI" reconcile --payment-id="$PAYMENT_ID" --apply \
    --plan="REMPLACER_PAR_LE_JETON" \
    --operation-id="$(node -e 'console.log(require("crypto").randomUUID())')" \
    --operator="Emery" --reason=uncertain-initiation
  ```

- `status-not-reconcilable` : le paiement est encore `initiating`.
  Attendre le reclassement automatique (10 min après la création, au plus une
  passe de 5 min ensuite) ;
- `not-found`, `incomplete` ou `unavailable` : demander par écrit à
  l'assistance SasPay si une session existe pour la référence `SM…`
  (montant, date). Si elle fournit l'identifiant de session, prévisualiser
  avec `--reference=<id>` ;
- clôture : uniquement selon la procédure 1-22D.3, avec la preuve écrite.
  Ce lot ne la change pas.

Codes de sortie (inchangés) : 0 prêt ou appliqué, 4 bloqué, 5 plan obsolète,
2 usage, 6 et 7 identifiant d'opération.

## 8. Compatibilité

- **Paiements existants** : aucun champ nouveau n'est lu ni requis. Un ancien
  `initiating`, même sans les champs de 1-21E, est traité exactement de même
  (testé). Il n'est jamais considéré comme sûr à recréer.
- **Anciennes instances** : une ancienne version ignore `initiating` mais
  traite déjà `uncertain`. Plusieurs instances restent sûres : écritures
  conditionnelles et réservation persistante. La configuration testée reste
  une seule instance API.
- **Prestataires sans recherche** (CamPay) : non concernés. Leurs
  `initiating` restent tels quels, comme avant.
- **Vue du propriétaire** : nouveau champ `creationUnresolved`. Un ancien web
  l'ignore ; un nouveau web avec une ancienne API garde le comportement
  actuel.
- **Index, migrations, variables** : aucun. `migrate:predeploy` est inchangé.
- **Ordre** : API puis web.

## 9. Contrôles (29 octobre 2026)

| Contrôle | Résultat |
|---|---|
| `test/saspay-initiating-recovery.e2e-spec.ts` (nouveau, faux SasPay, horloge contrôlée, interruptions simulées) | 10 / 10 |
| Unitaires `src/subscriptions`, `src/platform-admin` (dont `paymentCreationUnresolved`) | 543 / 543 |
| E2E voisins : `saspay-delayed-confirmation`, `saspay-checkout`, `payment-reconciliation`, `payment-unresolved-reconciliation`, `saspay-confirmation-only`, `subscription-payments`, `platform-admin-notifications` | OK. Assertions de forme exacte complétées : rapport `recovered: 0`, champ `creationUnresolved` |
| API : `tsc -p tsconfig.build.json`, `nest build`, ESLint des fichiers touchés | OK |
| Web : `tsc`, ESLint, `test:i18n` | OK |

**Cas e2e :**

1. Arrêt avant l'appel : rien avant 10 min ; ensuite `uncertain`, ouvert,
   0 création ; recherche sans résultat sans effet.
2. Session créée, réponse perdue : retrouvée, `pending`, puis payée :
   1 période, 0 seconde session.
3. Réponse reçue, écriture perdue, sur un ancien document sans champs
   récents : rattaché.
4. Création lente : passe pendant la création sans effet ; processus figé
   au-delà du délai, reprise puis réponse tardive, écriture refusée sans
   écrasement ; session retrouvée, jamais recréée.
5. Deux reprises et « Vérifier » simultanés : une reprise, 1 période.
6. Commerce suspendu : période enregistrée, suspension conservée.
7. Reprise interrompue (SasPay indisponible), puis passe suivante sans état
   en mémoire : terminée.
8. Session introuvable : non résolu, nouvelle tentative 409, assistance
   après 24 h, alerte unique avec `initiation_uncertain`.
9. `pending` existant : rapprochement inchangé.
10. Journaux : identifiants internes seulement, ni URL ni secret.

**Navigateur** : recette isolée (`start --provider=saspay`), création non
confirmée depuis 25 h insérée en base. En FR (390 px, sombre) et en EN
(1280 px, clair) : nouveau texte « lien non récupéré », bloc d'assistance
« création », aucun défilement horizontal, 0 erreur.

## 10. Question à transmettre à SasPay

> Pour une création de session (`POST /api/v1/checkout-sessions/`) dont nous
> n'avons pas reçu la réponse :
>
> 1. existe-t-il une clé d'idempotence acceptée par cette route, et pendant
>    combien de temps garantit-elle qu'une requête identique renvoie la même
>    session ?
> 2. Sinon, existe-t-il une route de recherche d'une session par
>    `metadata.merchantReference` (ou par `description`) qui ne dépende pas
>    de la pagination de toutes les sessions ?
> 3. Une session créée est-elle visible immédiatement dans
>    `GET /checkout-sessions/`, ou après quel délai maximal ?

Les réponses 1 et 2 permettraient de réduire les cas A à C restés non
résolus. Sans elles, le comportement décrit ici reste la limite.

## 11. Fichiers

| Fichier | Nature |
|---|---|
| `api/src/subscriptions/payments/subscription-payments.service.ts` | reclassement, délai, rapport `recovered`, vue `creationUnresolved` |
| `api/src/subscriptions/payments/payment-reconciliation-sweep.ts` | journal de passe |
| `api/src/subscriptions/payments/payment-confirmation-delay.ts` (+ `.spec.ts`) | règle `paymentCreationUnresolved` |
| `api/src/platform-admin/platform-admin-notification-sweep.service.ts` | code d'incident dans l'alerte |
| `api/test/saspay-initiating-recovery.e2e-spec.ts` | nouveau |
| `api/test/{subscription-payments,payment-unresolved-reconciliation,saspay-confirmation-only}.e2e-spec.ts` | formes exactes |
| `web/src/components/subscription/payment-confirmation-assistance.tsx`, `subscription-payment-panel.tsx`, `web/src/lib/subscription-payments.ts` | assistance « création » |
| `web/src/components/admin/admin-notifications.tsx` | résumé « création non confirmée » |
| `web/src/i18n/resources/{fr,en}/{subscription,admin}.ts` | textes |
