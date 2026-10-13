# Lot 1-21E — Parcours de renouvellement SasPay et reçus

État : **implémenté et vérifié localement**. Trois défauts constatés en
production sont corrigés : choix de forfait figé, « Résultat à vérifier »
sans paiement, lien expiré toujours proposé. La sécurité du renouvellement
est complétée : remplacement d'une tentative, encaissements tardifs,
attribution unique par renouvellement et rapprochement sans webhook. Un reçu
de paiement est ajouté. La clôture du lot a corrigé deux défauts démontrés
(seconde période après une attribution manuelle, remboursement impossible à
consigner) et ouvert le rapprochement opérateur au-delà de 72 h (§ 5.4,
§ 5.5, § 6.1).

Branche `feature/phase-1-21b-saspay-checkout` (`cbf8bd5`). Son contenu est
identique à `origin/main` (`b68c676`), c'est-à-dire à la production au
démarrage du lot. Les modifications ne sont pas commitées (§ 11) et
`stash@{0}` est conservé. Les modifications personnelles (`web/public/sw.js`,
icône, `generate-pwa-icons.ps1`) n'ont pas été touchées. Aucun commit, push,
déploiement, paiement réel, remboursement ni accès en écriture à la
production.

## 1. Défauts constatés et causes

| # | Symptôme en production | Cause |
|---|---|---|
| D1 | Après création de la session, impossible de changer de forfait | Aucune action prévue. Un seul paiement ouvert par commerce (index). Un paiement `pending` ne sortait de cet état que par un succès ou par l'opérateur. |
| D2 | Après rechargement, seulement « Vérifier le paiement » sous « Résultat à vérifier », sans paiement | Toute session `EXPIRED` ou `CANCELLED`, même sans aucune transaction, devenait `uncertain` (`checkout_unresolved`), avec le texte prévu pour une réponse perdue (« La transmission n'a pas pu être confirmée »). Cela arrive dès qu'une vérification a lieu après les 30 min : rechargement avec retour SasPay, bouton, etc. Le déclencheur exact en production n'a pas pu être observé (aucun accès). |
| D3 | Après expiration, « Continuer vers le paiement » ouvre « Paiement indisponible » chez SasPay | L'expiration n'était ni enregistrée ni connue du navigateur. Le lien était renvoyé tant que le statut restait `pending`. |

## 2. Contrat SasPay vérifié

Documentation officielle et OpenAPI consultées le 2026-10-12 :
[checkout-cancel](https://docs.saspay.me/api-reference/payments/checkout-cancel),
[checkout-status](https://docs.saspay.me/api-reference/payments/checkout-status),
[retry](https://docs.saspay.me/api-reference/payments/retry),
[OpenAPI](https://docs.saspay.me/api-reference/openapi.json).

| Point | Documenté | Usage dans Stock Master |
|---|---|---|
| `POST /checkout-sessions/{id}/cancel/` | `PENDING` → `CANCELLED` ; `409 not_pending` si payée, expirée ou déjà annulée | Fermeture d'une page, puis **relecture** obligatoire. Un 200 ne prouve rien à lui seul. |
| `GET /checkout-sessions/{id}/status/` | Revérifie l'état réel côté gateway | Statut de session et transaction désignée |
| `POST /payments/{id}/retry/` | Rejoue une transaction `FAILED` **avec le même identifiant** | `FAILED` **n'est pas définitif** : une tentative échouée bloque la fermeture automatique |
| `expires_at` | Champ de la session (création et détail) | Expiration réelle lue et enregistrée |
| Création | Sans `Idempotency-Key` ; « une session ne débite rien tant qu'elle n'est pas payée » | Jamais de seconde création ; recherche bornée par `metadata` après une réponse perdue (inchangé) |

**Non documenté, à faire confirmer par écrit par SasPay :**
1. Une transaction peut-elle être créée sur une session au moment exact de
   sa fermeture, ou sur une session expirée ou annulée ?
2. Une transaction `FAILED` sur une session close peut-elle encore aboutir
   (rejeu, correction côté opérateur) ?
3. Une session peut-elle porter plusieurs transactions (« Réessayer » sur la
   page) ?
4. Que devient une transaction `PENDING` lors d'une annulation ?

En l'absence de ces confirmations, Stock Master **ne promet pas l'absence de
double débit chez SasPay**. Ce qu'il garantit réellement :
- aucune seconde page payable tant que la fermeture de la précédente n'est
  pas prouvée (§ 3) ;
- au plus **une attribution automatique** par renouvellement, et aucune
  attribution du forfait initial retenu à côté d'une autre (§ 5) ;
- tout encaissement **qui lui est confirmé** est enregistré (`collectedAt`),
  jamais marqué `failed` ni supprimé, et un conflit est signalé.

**Portée de cette détection** (un encaissement qu'aucun chemin ne vérifie
reste inconnu de Stock Master) :

| Chemin | Paiements couverts | Durée |
|---|---|---|
| Webhook SasPay (5 envois jusqu'à environ 2 h 40, documenté) | Ouverts, et tentatives closes `checkout_closed` | 24 h après l'initiation pour une tentative close (`unattachedCandidates`) |
| Rapprochement périodique (§ 6) | Ouverts, et tentatives closes `checkout_closed` | 72 h après la clôture |
| « Vérifier le paiement », retour du payeur | Paiement affiché (ouvert) | tant qu'il est ouvert |
| CLI de rapprochement (opérateur, § 6.1) | Ouverts, `review`, tentatives closes `checkout_closed` | **sans limite**, sur relevé SasPay |

## 3. États d'un paiement par page hébergée

L'API expose désormais une **situation** (`situation`) et le **statut
financier** (`collected`), distincts du statut d'attribution (`status`).

| Situation | Signification | Lien proposé | Nouveau paiement |
|---|---|---|---|
| `checkout-open` | Page valide, aucun paiement confirmé | oui, jusqu'à l'échéance | non |
| `checkout-expired` | Échéance passée, clôture non encore confirmée par SasPay | **non** | non |
| `checkout-link-missing` | Session peut-être créée, lien non reçu (réponse perdue) | non ; « Vérifier » la retrouve sans en créer | non |
| `attempt-unresolved` | Page close **après** une transaction non réussie | non | non (rapprochement) |
| `closure-unconfirmed` | Page close, mais absence de transaction **non affirmée** par SasPay | non | non (rapprochement) |
| `checkout-closed` | Page close, absence de transaction **affirmée** par les deux routes | non | **oui** |
| `renewal-suspended` | Une tentative remplacée du même renouvellement a été encaissée | non | non |
| `collected-in-resolution` | Paiement **reçu**, sans période (conflit de renouvellement) | non | oui (aucun paiement ouvert) |
| `refunded` | Encaissement remboursé hors de Stock Master, consigné (§ 5.5) | non | oui |

### Preuve exigée pour clore une page

Une page n'est close (`failed` + incident `checkout_closed`) que si :
- la session est `EXPIRED` ou `CANCELLED` selon la route de statut ;
- `transaction` est **présent et nul** dans le détail ;
- `transaction_id` est **présent et nul** sur la route de statut ;
- aucune transaction n'est déjà rattachée en base.

| Réponse SasPay | Issue |
|---|---|
| Champ de transaction absent (réponse incomplète) | `closure-unconfirmed`, jamais libéré |
| Transaction désignée, même `FAILED` | `attempt-unresolved` |
| Statut indisponible | 503, état conservé |
| 200 d'annulation mais page relue encore ouverte | `cancel-unconfirmed`, rien n'est libéré |

Le délai local, un retour arrière, la fermeture d'un onglet ou une
déclaration du client ne sont jamais des preuves.

## 4. Parcours client

### 4.1 Session créée au dernier moment

- Le choix d'une formule ne fait **aucun** appel à SasPay.
- Le bouton du formulaire devient « Continuer vers le paiement de X ». Le
  clic réserve le paiement en base (inchangé), crée la session, puis
  **conduit directement** à la page SasPay.
- Garanties conservées : UUID d'opération écrit avant l'envoi, verrou contre
  le double clic, index « un paiement ouvert », rejeu de la même opération
  après une réponse perdue, aucune création au chargement de la page.
- Si le prix a changé depuis l'ouverture de la page, la confirmation 1-21D
  passe avant toute redirection.

### 4.2 Reprise, expiration

- **Expiration :** celle renvoyée par SasPay (`expires_at`), sinon celle
  demandée à la création (contrat vérifié en LIVE, 1-21C). Elle est
  enregistrée une fois (`providerCheckoutExpiresAt`) et jamais repoussée.
  Paiements antérieurs : création + 30 min.
- **Côté API :** aucun lien renvoyé après l'échéance.
- **Côté web :** l'échéance est calculée comme « réception + validité
  restante donnée par le serveur », donc indépendante de l'horloge de
  l'appareil. Un minuteur unique retire le lien 30 s avant l'échéance, puis
  déclenche **une** vérification serveur.
- **Message après expiration** (selon le statut observé) : « Le lien a expiré.
  Nous attendons la confirmation de clôture du prestataire avant de
  permettre une nouvelle tentative. »

### 4.3 « Changer de forfait » et « Annuler cette tentative »

Ces deux actions sont visibles avant l'ouverture de SasPay, après un retour
arrière et après un rechargement, tant que le paiement n'est pas confirmé.
Une confirmation décrit leur effet réel (« Fermer la page SasPay et… »).
Elles appellent `POST …/payments/:id/abandon` (corps vide, propriétaire
seulement), qui suit ces étapes :

1. Vérification complète chez SasPay. Un paiement réussi est confirmé et la
   période attribuée : **ce n'est plus une annulation**.
2. Transaction en cours ou tentative échouée : rien n'est fermé, explication
   affichée.
3. Absence de transaction affirmée : fermeture officielle, puis relecture.
   Seule une page relue close, toujours sans transaction, libère un nouveau
   choix.

| Issue (`outcome`) | Affichage |
|---|---|
| `released` | « Tentative annulée : SasPay confirme la fermeture… » ou formules ouvertes |
| `succeeded` | « Paiement confirmé » ; rien n'est annulé |
| `in-progress`, `attempt-recorded`, `awaiting-resolution`, `not-found-at-provider`, `provider-incomplete`, `cancel-unconfirmed` | Explication dédiée ; formules **consultables**, validation désactivée |

Le texte « Renouvellement annulé » n'est jamais affiché.

## 5. Renouvellement : tentatives liées et attribution unique

### 5.1 Modèle (champs ajoutés à `subscription_payments`)

| Champ | Rôle |
|---|---|
| `renewalId` | Renouvellement de la tentative. Son propre `_id` pour une première tentative, celui de la tentative remplacée sinon. Absent (anciens paiements) = `_id`. Immuable. |
| `replacesPaymentId` | Tentative remplacée, écrite **à l'insertion** : la relation survit à tout redémarrage. Immuable. |
| `autoGrantRenewalId` | Renouvellement dont ce paiement porte l'attribution **automatique** |
| `collectedAt` | **Statut financier** : encaissement confirmé par SasPay. Jamais remis à `null`. |
| `paidAmountMinor` | Montant débité au payeur (centimes), lu sur la transaction réussie |
| `renewalConflictAt` | Poursuite suspendue (lien retiré) |
| `providerCheckoutExpiresAt` | Fin de validité de la page |

**Rattachement d'une nouvelle tentative.** Elle rejoint le renouvellement de
la dernière tentative de l'organisation si celle-ci est close (`failed`)
sans encaissement, et que ce renouvellement n'a reçu aucune attribution.
Sinon, c'est un **nouveau renouvellement** : premier paiement, ou achat
supplémentaire volontaire après un renouvellement terminé. Ce rattachement
est dérivé de la base seule, sans état mémoire.

### 5.2 Garanties en base

| Index (nouveaux, uniques partiels) | Garantie |
|---|---|
| `autoGrantRenewalId_1` | **Un seul règlement par renouvellement** : attribution automatique, ou manuelle « forfait initial retenu » (§ 5.4), entre webhook, vérification, rapprochement périodique, CLI et plusieurs processus. L'achat supplémentaire accepté (`additional`) ne règle pas le renouvellement. |
| `replacesPaymentId_1` | Une tentative n'est remplacée qu'une fois |

S'y ajoutent l'unicité de transaction (`provider_1_providerTransactionId_1`,
1-21B) et l'attribution par paiement (`payment:<id>`, socle 1-14D.2A).

### 5.3 Encaissements tardifs

Dans la transaction de confirmation, avant toute attribution :
- **tentative remplacée** → aucune attribution de l'ancien forfait ;
- **renouvellement déjà attribué** par une autre tentative → aucune seconde
  période ;
- course entre deux tentatives : l'index unique rejette la seconde (E11000)
  et la transaction est annulée.

L'encaissement est alors enregistré **en résolution** : `status: review`,
`open: false`, `collectedAt`, transaction et montant débité, incident
`replaced_payment_collected` ou `renewal_already_granted`. Le paiement n'est
jamais `failed`, jamais supprimé, et aucune période n'est attribuée.

| Cas | Résultat |
|---|---|
| B réussit, puis A (remplacée) réussit tardivement | 1 période (B) ; A reçue, en résolution |
| A remplacée réussit **avant** B | A reçue, en résolution ; B **suspendue** (lien retiré), puis fermée chez SasPay si elle n'a aucune transaction |
| B a déjà une transaction en cours | B suspendue mais non fermée ; son succès éventuel est attribué normalement (1 période) |
| A et B réussissent simultanément | 1 période (B, choix actuel) |
| Deux tentatives non remplacées d'un même renouvellement réussissent en concurrence | 1 attribution (index) ; l'autre `renewal_already_granted` |
| Notifications rejouées ou désordonnées | Aucune nouvelle attribution |

L'accès déjà acquis est conservé.

**Client.** Un bandeau en tête du panneau et l'historique indiquent
« Paiement reçu, en résolution », qu'il n'est ni perdu ni refusé, et que
l'abonnement n'est pas encore prolongé par ce paiement.

**Opérateur.** L'incident est signalé de façon durable par les mécanismes
existants : statut `review` et code d'incident ; journal
`SubscriptionPayments` (identifiants seuls) ; `inspect` du CLI (champs
`collectedAt`, `renewalId`, `replacesPaymentId`, `renewalAutoGranted`).

### 5.4 Rapprochement opérateur (CLI) : résolution d'un conflit

Le CLI 1-14D.2G attribuait une période à tout `review` dont le succès était
vérifié. Il **refuse désormais** un encaissement en conflit
(`renewal-conflict`). Deux résolutions explicites existent, toutes deux
**avec l'accord du client**, liées au jeton de plan et à l'empreinte
d'audit, et refusées sur tout autre paiement
(`grant-renewal-conflict-not-applicable`).

| Option | Sens | Effet sur le renouvellement |
|---|---|---|
| `--grant-renewal-conflict=renewal` | Le client **retient le forfait de ce paiement** pour son renouvellement | **Règle** le renouvellement : même index unique que l'attribution automatique (`autoGrantRenewalId`). Les autres tentatives ouvertes sont suspendues, puis fermées si c'est sûr. Un succès ultérieur d'une autre tentative est enregistré en résolution (`renewal_already_granted`), sans seconde période. Refusé si le renouvellement est déjà réglé (`renewal-already-settled`). |
| `--grant-renewal-conflict=additional` | **Achat supplémentaire** explicitement accepté | Période en plus, renouvellement non réglé par ce paiement |

```
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> --grant-renewal-conflict=renewal
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> --grant-renewal-conflict=renewal \
  --apply --plan=<jeton> --operation-id=<uuid v4> --operator=<identifiant> --reason=customer-evidence --ticket=<référence>
```

**Concurrence** entre l'attribution manuelle `renewal` et la confirmation
d'une autre tentative : les deux revendiquent le renouvellement dans leur
transaction, et l'index unique n'en accepte qu'une. Si le CLI perd, toute
l'opération est annulée (ni période, ni audit) et le résultat est
`renewal-already-settled`. Si c'est la confirmation qui perd, l'autre
paiement est enregistré en résolution.

**Défaut corrigé pendant la clôture du lot.** La première version
attribuait manuellement sans régler le renouvellement : un succès ultérieur
de B donnait **une seconde période**. Le test V1 l'a démontré (2 périodes
attribuées) avant la correction.

### 5.5 Remboursement externe consigné

Un remboursement se fait **hors de Stock Master** (tableau de bord SasPay) :
aucun remboursement automatique, aucun appel de retrait.

Avant ce lot, **rien ne permettait de le consigner**. Un paiement remboursé
restait `review`, et le CLI pouvait encore lui attribuer une période.

Correction minimale, dans le rapprochement existant (plan, jeton, audit
transactionnel) :

```
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> --record-refund
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> --record-refund \
  --apply --plan=<jeton> --operation-id=<uuid v4> --operator=<identifiant> --reason=refunded-outside --ticket=<référence>
```

- Accepté seulement pour un encaissement **en résolution** : `review`,
  `collectedAt`, aucune période, et succès relu chez SasPay. Le motif
  `refunded-outside` et le ticket sont obligatoires, et ce motif est réservé
  à cette option.
- Effet : `refundedAt`, incident `refunded_outside`, `open: false`, plus une
  ligne d'audit (action `record-refund`). Définitif.
- Ensuite, **aucune attribution possible** :
  - le webhook, « Vérifier » et la confirmation s'arrêtent sur `review` ;
  - le rapprochement périodique ignore `review` ;
  - le CLI refuse toute action (`refunded`) ;
  - l'écriture d'attribution exige `refundedAt: null` (défense en
    profondeur).
- Le client voit « Paiement remboursé » ; le reçu reste disponible et
  indique la date du remboursement, sans période.
- Non couvert : un paiement **déjà attribué** (`succeeded`) puis remboursé.
  Il faudrait retirer une période, ce qui est hors du périmètre de ce lot.

## 6. Rapprochement sans webhook

| Mécanisme | Portée |
|---|---|
| Webhook (`transaction.*`) | Candidats bornés : paiements ouverts **et** tentatives closes `checkout_closed` récentes (24 h), afin de retrouver une transaction tardive |
| **Rapprochement périodique** (nouveau, `payment-reconciliation-sweep.ts`) | Processus HTTP seulement (jamais les CLI), toutes les `PAYMENT_RECONCILIATION_SWEEP_SECONDS` (défaut 300 ; `0` désactive). Par passe : au plus 10 paiements non vérifiés depuis 10 min, ouverts ou clos `checkout_closed` depuis moins de 72 h. Chaque paiement est **réservé** par une écriture conditionnelle de `lastCheckedAt`, puis vérifié par le moteur unique. ≤ 30 appels SasPay par passe (limite locale : 120 / min). |
| « Vérifier le paiement », retour du payeur, CLI | Inchangés |

### 6.1 Au-delà des fenêtres automatiques

Un succès tardif sur une tentative close **plus de 72 h** après sa clôture,
sans webhook reçu dans les 24 h, n'est vu par **aucun** traitement
automatique. Avant cette clôture de lot, le CLI refusait aussi ces
paiements (`failed` hors des statuts rapprochables) : il n'y avait **aucune**
voie de rapprochement.

**Correction :** le CLI accepte une tentative close `checkout_closed`, pour
un **succès** relu chez SasPay seulement. Toute autre issue est refusée. Les
règles de renouvellement (§ 5) s'appliquent : une tentative remplacée exige
une résolution explicite.

**Procédure opérateur** (périodique, par exemple hebdomadaire, et sur
réclamation d'un client) :
1. Dans le tableau de bord ou l'export CSV SasPay (`/transactions/export/`),
   relever les transactions `SUCCESS` de type `PAIEMENT`.
2. Chaque libellé contient la référence marchand `SM<24 hexadécimaux>`.
   L'identifiant du paiement est cette valeur sans le `SM`, en minuscules.
3. Lancer `inspect --payment-id=<id>`. Si le paiement n'est pas `succeeded`
   ni en résolution, lancer `reconcile` (simulation, puis `--apply` avec le
   motif `provider-statement`).

Le test V5 couvre ce cas : tentative close il y a 5 jours, ignorée par le
rapprochement périodique, retrouvée depuis la référence `SM…`, une période
attribuée.

## 7. Reçus de paiement

### 7.1 Audit (avant ce lot)

| Question | Constat |
|---|---|
| Reçu Stock Master après paiement | **Inexistant** (ni API, ni web). Le texte affiché disait « les factures seront disponibles ultérieurement ». |
| E-mail | **Aucun** envoi lié au paiement. Seule une notification push « paiement confirmé » existe (1-16A). |
| Facture SasPay | `GET /transactions/{id}/invoice/` : réservée au **marchand** (clé secrète), sans accès client |

### 7.2 Ajouté

- **API :** `GET …/payments/:paymentId/receipt`. Propriétaire réel seulement
  (owner-only), lecture locale, `no-store`. 404 uniforme pour une autre
  organisation ; 409 `PAYMENT_RECEIPT_UNAVAILABLE` si le paiement n'est pas
  encaissé.
- **Web :** bouton « Reçu » dans l'**historique des paiements**, pour tout
  paiement encaissé. Il est retrouvé après rechargement ou reconnexion, y
  compris en **session limitée** (`/access`, abonnement expiré : vérifié en
  navigateur, § 9.2, A2 et A3). Le bouton « Imprimer » n'imprime que le reçu
  (règle `@media print`, vérifiée en PDF, en session normale et limitée).
- **E-mail :** non ajouté. Le reçu est disponible **dans l'application**
  seulement.

| Exigence | Réalisation |
|---|---|
| Fondé sur un encaissement confirmé côté serveur | `collectedAt`, ou `succeeded` pour un ancien paiement |
| Montants enregistrés, jamais le tarif courant | `paidAmountMinor`, sinon `amount` figé (vérifié sur un ancien paiement à 3 000 XAF) |
| Référence stable, date de paiement | Référence marchand `SM…` ; date d'encaissement |
| Émetteur, commerce, formule | « Stock Master », nom de l'organisation, durée |
| Payé par le client ≠ net marchand | Seul le **montant payé** est affiché ; le net marchand ne l'est jamais. Les frais absorbés (`DEDUCTED`) ne sont pas déduits. |
| Période | Affichée seulement si elle a réellement été attribuée |
| Encaissement en résolution | « Paiement reçu, prise en compte en cours de vérification : aucune période attribuée » |
| Données | Ni secret, ni lien de paiement, ni téléphone, ni e-mail |
| Nature | « Ce reçu atteste un paiement encaissé. **Ce n'est pas une facture.** » Aucune conformité fiscale revendiquée. |

Une annulation ou l'expiration d'une page ne fait jamais disparaître le reçu
d'un paiement encaissé.

## 8. Fichiers modifiés

| Zone | Fichiers |
|---|---|
| Contrat prestataire | `payment-provider.ts` : expiration, `checkoutClosed`, `transactionState`, `transactionAbsenceConfirmed`, `paidAmountMinor`, `cancelCheckout`, `checkoutTtlMs` |
| Adaptateur SasPay | `saspay/saspay-payment-provider.ts` : `expires_at`, absence explicite de transaction, montant débité, `POST …/cancel/` |
| Modèle et index | `schemas/subscription-payment.schema.ts`, `subscription-payment-indexes.ts` (2 index) |
| Moteur | `subscription-payments.service.ts` : situations, clôture, `abandonPayment`, renouvellement, conflits, suspension, `sweepOnce`, reçu |
| Routes et erreurs | `subscription-payments.controller.ts` (`abandon`, `receipt`), `payment-errors.ts`, `common/i18n/error-messages.ts` (traductions EN) |
| Rapprochement | `reconciliation/payment-reconciliation.service.ts`, `payment-reconciliation-cli.ts` (`--grant-renewal-conflict=renewal\|additional`, `--record-refund`, `inspect`, tentative close rapprochable), `subscription-payment-reconciliation.schema.ts` (motif `refunded-outside`, action `record-refund`) ; nouveau `payment-reconciliation-sweep.ts` ; `main.ts` |
| Web | `subscription-payment-panel.tsx`, `lib/subscription-payments.ts`, `lib/payment-guards.ts`, `i18n/resources/{fr,en}/subscription.ts`, `app/globals.css` |
| Recette locale | `test/recipe/saspay-sim.js`, `launcher.js` : fermeture, page refusant une session close, expiration, succès tardif |

## 9. Vérifications

### 9.1 Automatiques

| Contrôle | Résultat |
|---|---|
| Unitaires **complets** de l'API (isolés des `.env`), après la clôture | **1 798 / 1 798** (98 fichiers) |
| E2E ciblés après la clôture : `saspay-checkout`, `payment-reconciliation*` | **87 / 87** (3 fichiers) |
| E2E paiements complets, **avant** la clôture : `saspay-checkout`, `saspay-confirmation-only`, `subscription-payments`, `subscription-payment-foundation`, `payment-reconciliation*`, `realtime-subscription-payments` | 162 / 162 (8 fichiers) ; non relancés depuis, conformément à la consigne de tests ciblés |
| Migration compilée des index exécutée deux fois sur base éphémère | créés, puis « déjà présents » |
| Typage (code de production), ESLint (API et web), contrôle i18n FR/EN | propres |

Le catalogue des messages d'erreur de l'API (`common/i18n/error-messages.ts`)
n'avait pas reçu les deux nouveaux messages (`PAYMENT_CHANGE_UNAVAILABLE`,
`PAYMENT_RECEIPT_UNAVAILABLE`). Les exécutions limitées à
`src/subscriptions` ne l'ont pas vu ; la suite complète l'a signalé
(`i18n.spec.ts`). Les deux entrées FR/EN ont été ajoutées.

**Tests de clôture (V1 à V5) :**

| # | Scénario | Résultat |
|---|---|---|
| V1 | A remplacée, encaissée, attribuée par le CLI `renewal` ; B réussit ensuite (webhook, refresh, rapprochement périodique) | **avant correction : 2 périodes** ; après : 1 période, B en résolution, second `renewal` refusé |
| V2 | CLI `renewal` concurrent de la confirmation de B (webhook, refresh, moteur) | 1 période ; issue cohérente quel que soit le gagnant |
| V3 | B réglée, puis CLI `additional` sur A | `renewal` refusé (`renewal-already-settled`) ; `additional` → 2 périodes explicites ; rejeux sans effet |
| V4 | Remboursement consigné (`--record-refund`) | Aucune attribution par webhook, refresh, rapprochement périodique ni CLI (4 options) ; reçu « remboursé » ; option refusée sur un paiement non encaissé |
| V5 | Succès tardif sur une tentative close depuis 5 jours, sans webhook | Ignoré par le rapprochement périodique ; rapproché par le CLI depuis la référence `SM…` |

**Nouveaux e2e :**
- reprise et rechargement : même session, même lien, échéance fixe ;
- changement de forfait ; expiration page ouverte et après rechargement ;
- succès avant expiration confirmé après ; succès **pendant** l'annulation ;
- concurrence avec webhook et vérification ; SasPay indisponible ou ambigu ;
- champ transaction absent (détail, statut) ;
- ancien lien refusé ; notification tardive après annulation ;
- remplacement A → B ; succès tardifs dans les deux ordres et simultanés ;
- garantie de l'index en base ; reprise après redémarrage entre fermeture et
  remplacement ; ancien format de paiement ;
- reçu : isolation, ancien prix, aucun reçu sans encaissement, cas « en
  résolution » ;
- rapprochement périodique sans webhook, avec passes concurrentes.

**Tests existants adaptés au nouveau contrat :**

| Test | Adaptation |
|---|---|
| E12 / 1-21B n° 17 | Un succès tardif d'une tentative **remplacée** n'est plus attribué ; une page close sans transaction est désormais close automatiquement |
| Projection | Champs `checkoutExpiresAt`, `checkoutExpiresInMs`, `situation`, `collected` |
| Index | 8, dont 7 uniques |
| Matrice des routes | `abandon` et `receipt` (owner-only, 403 pour admin et vendeur) |
| CLI | Nouvelle option |
| Création SasPay | Expiration attendue |

### 9.2 Recette navigateur

Méthode :
- `recipe.js start --provider=saspay --anti-bot=simulated` : vrai adaptateur,
  faux SasPay local, webhook signé fictif ;
- Playwright 1.57 et Chromium existants, hors dépôt ;
- `pay.saspay.me` intercepté, **aucune requête externe**.

| # | Contrôle | Résultat |
|---|---|---|
| C1 | FR bureau : choix sans session, clic → SasPay, retour, même lien, rechargement, changer de forfait → fermée chez SasPay → nouveau forfait (10 000) | ✔ |
| C2 | FR : expiration page ouverte (horloge simulée), SasPay encore `PENDING` → lien retiré, message d'attente de clôture, plus de message contradictoire | ✔ |
| C3 | FR mobile 390 px : A remplacée payée tardivement → bandeau et historique « Paiement reçu, en résolution », B fermée, reçu « aucune période », aucun défilement horizontal | ✔ |
| C4 | FR bureau : paiement confirmé, **reconnexion**, reçu (3 500 FCFA, période réelle, « pas une facture »), impression limitée au reçu, PDF | ✔ |
| C5 | EN mobile : choix sans session, SasPay puis retour, annulation, nouveau paiement, reçu EN | ✔ |
| C6 | EN bureau : rechargement après expiration → message d'attente de clôture, aucun lien | ✔ |

Premier passage du lot (même méthode) : 10 / 10. Il couvrait l'ancien lien
dans un autre onglet (retiré par le temps réel, refusé par SasPay), la
tentative échouée puis « Changer de forfait », et le paiement réussi puis
« Annuler cette tentative ».

**Clôture : reçu en session limitée** (même méthode, 3 / 3, aucune requête
externe) :

| # | Contrôle | Résultat |
|---|---|---|
| A1 | API sur la recette : reçu du propriétaire 200 ; autre commerce **404** ; admin et vendeur invités **403** `PERMISSION_DENIED` | ✔ |
| A2 | FR bureau : propriétaire à abonnement **expiré**, connexion redirigée vers `/access` ; historique, reçu (référence, **3 500 FCFA** enregistrés, « pas une facture ») ; impression limitée au reçu, PDF | ✔ |
| A3 | EN mobile 390 px, `/access` : reçu ouvert (« Payment receipt », 3,500), aucun défilement horizontal | ✔ |

Les dates de période visibles sur le reçu en A2 sont **artificielles** :
l'outil de recette `expireOrganization` réécrit les périodes pour simuler
l'expiration. Le reçu affiche fidèlement la période enregistrée.

## 10. Migration et ordre de déploiement

**Données :** aucune reprise. Les anciens paiements sont lus tels quels
(`renewalId` absent = `_id` ; expiration = création + 30 min ; encaissement =
`succeeded`).

**Index :** les deux nouveaux index sont créés par la migration idempotente
existante `create-subscription-payment-indexes.js` (3ᵉ étape de
`predeploy-migrations.js`). En production, l'API **refuse de démarrer** s'ils
manquent (vérification 1-14D.2B inchangée).

| Étape | Action | Contrôle |
|---|---|---|
| 1 | Railway : Pre-deploy (migrations) | « index créés et vérifiés » |
| 2 | API | Démarrage ; journal du rapprochement périodique |
| 3 | Web (Vercel) | Formulaire « Continuer vers le paiement de X » ; reçu dans l'historique |
| 4 | Lecture seule en production | `db.subscription_payments.find({ provider: "saspay", open: true })` : paiements bloqués par l'ancienne règle (`uncertain`, `checkout_unresolved`) |

Compatibilité dans les deux sens :
- **Ancien web + nouvelle API :** fonctionne, sans les nouvelles actions ni le
  reçu.
- **Nouveau web + ancienne API :** situation absente, donc comportement
  antérieur, sans les nouvelles actions.

**Paiements déjà bloqués en production :** une vérification (bouton,
webhook ou rapprochement périodique) clôt automatiquement ceux dont SasPay
affirme l'absence de transaction. Les autres restent sur la procédure
`--close-unresolved` (1-21D § 5).

**Variable facultative :** `PAYMENT_RECONCILIATION_SWEEP_SECONDS` (défaut
300 ; `0` désactive).

### 10.1 Retour arrière : risque d'attribution indue

Une API ou un CLI **antérieurs à ce lot** ignorent `renewalId`,
`replacesPaymentId`, `autoGrantRenewalId` et `refundedAt` :

| Composant ancien | Risque |
|---|---|
| Moteur de confirmation (webhook, « Vérifier ») | Un succès tardif d'une tentative **remplacée** est attribué : **seconde période** à côté de celle de B |
| CLI de rapprochement | Un paiement `review` en conflit, ou **remboursé**, dont SasPay confirme le succès, reçoit une période (aucune option exigée) |
| Index | Les deux nouveaux index restent (inoffensifs : jamais renseignés par l'ancien code) ; l'ancienne vérification au démarrage ne les refuse pas |
| Web | Les nouveaux champs sont ignorés ; plus d'actions de changement, plus de reçu |

**Procédure avant tout retour arrière :**
1. Désactiver les nouveaux paiements (`PAYMENT_PROVIDER_ACTIVE=none`,
   1-21D § 5).
2. Lister, en lecture seule, les paiements exposés :
   ```
   db.subscription_payments.find({ $or: [
     { incidentCode: { $in: ["replaced_payment_collected", "renewal_already_granted", "refunded_outside"] } },
     { replacesPaymentId: { $type: "objectId" } },
     { status: "failed", incidentCode: "checkout_closed" }
   ] }, { status: 1, incidentCode: 1, renewalId: 1, replacesPaymentId: 1, refundedAt: 1 })
   ```
3. Résoudre les conflits avec la version actuelle **avant** le retour
   arrière (§ 5.4, § 5.5). Sinon, accepter le risque explicitement.
4. Après le retour arrière : ne jamais lancer l'ancien CLI sur ces
   paiements. Retirer `SASPAY_WEBHOOK_SECRET` (webhook en 503, renvoyé par
   SasPay jusqu'à environ 2 h 40) réduit l'exposition, sans couvrir
   « Vérifier ».

**Recommandation :** préférer une correction en avant à un retour arrière
du code de paiement.

## 11. Limites et suite

- Confirmations SasPay attendues : § 2 (1 à 4).
- L'issue d'un encaissement en conflit (forfait initial retenu, achat
  supplémentaire ou remboursement) reste une décision opérateur, avec
  l'accord du client (§ 5.4, § 5.5).
- Au-delà de 24 h (webhook) et de 72 h (rapprochement périodique), un succès
  tardif n'est retrouvé que par la procédure opérateur du § 6.1.
- Un paiement déjà attribué (`succeeded`) puis remboursé n'est pas géré
  (retrait de période hors périmètre).
- Retour arrière : risque d'attribution indue décrit au § 10.1.
- Le reçu n'est ni une facture ni un document fiscal. Une facture conforme
  demandera une validation juridique et fiscale.
- Aucun envoi d'e-mail de reçu.
- Rien n'est commité. À faire : revue, puis commit sur la branche, en
  excluant les modifications personnelles (`sw.js`, icône, script
  PowerShell).
