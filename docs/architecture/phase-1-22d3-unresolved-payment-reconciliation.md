# Lot 1-22D.3 — Résolution des créations SasPay sans référence fournisseur

État : **une tentative `uncertain` sans référence SasPay peut désormais être retrouvée,
rattachée ou, sur preuve externe, close par l'opérateur.** Rien n'est commité, poussé ni
déployé. Aucun appel réel à SasPay, aucune base réelle, aucun paiement ni remboursement.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `fix/phase-1-22d2-saspay-ambiguous-create`, avec les modifications **non commitées** de 1-22D, 1-22D.1 et 1-22D.2 (26 fichiers, empreintes relevées avant ce lot) |
| Branche | `fix/phase-1-22d3-unresolved-payment-reconciliation`, sans stash, reset ni nettoyage |
| Variables, migrations, index | Aucune |

Le stash (`stash@{0}`) et les fichiers personnels sont conservés.

## 2. Problème

Une création incertaine (réponse perdue, 5xx, `429` depuis 1-22D.2) sans session retrouvée
restait ouverte sans issue. Le CLI de rapprochement exigeait une référence SasPay
(`reference-required`), et l'organisation ne pouvait plus créer de paiement.

## 3. Correction (CLI existant étendu)

Même CLI, même cycle : simulation → jeton de plan → application auditée et idempotente. Aucun
appel de création ni de débit : seules des lectures SasPay sont émises.

### Recherche par référence marchand

Sans référence persistée ni `--reference`, la simulation recherche la session portant la
référence marchand du paiement. C'est la recherche existante de l'adaptateur : au plus 5 pages
de 100 sessions, 20 s, budget d'appels de 1-22D (voie des confirmations, processus du CLI). Le
plan affiche `lookup` :

| `lookup.outcome` | Signification | Plan |
|---|---|---|
| `found` | une session porte cette référence | rattachement par les contrôles habituels : statut relu, concordance stricte (référence marchand, montant, devise), référence déjà portée par un autre paiement refusée |
| `not-found` | liste lue jusqu'au bout, aucune session | bloqué `lookup-not-found` |
| `incomplete` | borne de 5 pages atteinte | bloqué `lookup-incomplete` |
| `unavailable` | SasPay ou budget indisponible | bloqué `lookup-unavailable` |
| `inconsistent` | plusieurs sessions | bloqué `provider-inconsistent` |

`proofOfAbsence` vaut toujours `false` : une recherche sans résultat n'est jamais une preuve
d'absence.

La référence **fournie par l'opérateur** (`--reference`) suit le chemin existant. Elle n'est
rattachée qu'après relecture serveur, si la session porte la référence marchand du paiement et
le bon montant (sinon `mismatch`).

### Clôture exceptionnelle (`--close-without-session`)

**Conditions, toutes revérifiées à l'application :**
1. Le paiement est `uncertain` / `initiation_uncertain`, ouvert, sans référence ni transaction
   prestataire, sans encaissement, sans période, non remboursé.
2. Aucune `--reference` n'est fournie.
3. Une **preuve externe référencée** est fournie par `--ticket=<source>:<identifiant>`, avec
   au moins un chiffre dans l'identifiant (ex. `saspay-support:TCK-48213`). C'est la
   confirmation écrite du prestataire qu'aucune session payable ni aucun encaissement n'existe
   pour cette référence marchand. Elle est exigée **dès la simulation** et incluse dans le jeton.
   Un mot de décision (`fermer`, `saspay:fermer-quand-meme`) est refusé.
4. La recherche de la simulation est **complète et sans résultat**. C'est un contrôle de
   sécurité, jamais la preuve. Une recherche incomplète, indisponible ou incohérente bloque.
5. À l'application : `--reason=provider-no-session` (motif réservé à cette option, et
   réciproquement), même preuve qu'à la simulation, même jeton. Sinon : `PROOF_REQUIRED` ou
   `PLAN_STALE`, aucune écriture.

**Relecture avant application.** Le plan est recalculé, recherche comprise. Une session
apparue, un rattachement, un succès ou une transaction entre-temps rendent le plan différent
ou inapplicable, et rien n'est clos. Dans la transaction, l'écriture est conditionnelle à
l'état ci-dessus.

**Effet.** `failed` / `checkout_closed`, `open: false`. Sont conservés :
- le paiement ;
- la référence marchand ;
- le `clientOperationId` ;
- le renouvellement (`renewalId`).

L'audit consigne : action `close-without-session`, motif `provider-no-session`, preuve
(`reasonTicket`), `verifiedState: no-session`, référence consultée `null`.

### Encaissement tardif après clôture

La clôture n'empêche **pas** un débit tardif chez SasPay ; elle ne prétend pas l'empêcher. Les
protections de 1-21E s'appliquent sans changement, car `failed / checkout_closed` est l'état
qu'elles surveillent :
- **Rapprochement périodique** pendant 72 h : la tentative close est relue par sa référence
  marchand. Un succès vérifié est attribué une fois.
- **Nouvelle tentative :** elle **remplace** l'ancienne (`replacesPaymentId`, même `renewalId`).
  Un succès tardif de l'ancienne devient `review` / `replaced_payment_collected` (encaissement
  conservé, aucune période). Le CLI le règle ensuite : attribution sur accord du client, ou
  remboursement consigné. Un paiement remboursé n'est plus jamais attribué.

### Webhook avant rattachement

Les champs authentifiés d'une notification ne permettent pas de retrouver la tentative. Ils
contiennent la transaction (`id`, `reference`, statut, montants, réseau), mais ni la session ni
la `metadata` (1-21A § 3).

**Heuristique essayée puis retirée (complément).** Une première version proposait la création
incertaine sans référence *la plus récente* comme candidate pendant 1 h. Le scénario des deux
tentatives concurrentes (§ 5, cas 11) a montré qu'elle ne récupère pas A de façon fiable :
- A (plus ancienne, payée) et B (plus récente, 429 sans session) ;
- **avant correction :** le webhook de A et ses trois rejeux ont tous reçu `503` ;
- chaque livraison relançait une recherche pour **B**, inutile et répétée ;
- une transaction étrangère recevait aussi `503` ;
- A n'a été récupérée que par le rapprochement.

Avec B réellement payée et sans autre tentative récente, le webhook de A ne faisait que
confirmer **B** (par ses propres lectures, légitimement) et répondait `503` pour A. A n'était
récupérée par un rejeu que parce que B avait entre-temps obtenu une référence.

Aucune affectation à la mauvaise organisation n'a été observée : chaque rattachement vient de
la session de la tentative elle-même. Mais la récupération dépendait de l'état d'une autre
organisation. L'heuristique est **retirée** : le code des candidats et du webhook est revenu à
1-22D.2 (un commentaire explicite en plus).

**Comportement retenu.** Une création incertaine **sans référence** n'est jamais examinée par un
webhook. Seuls restent les candidats de 1-21B : au plus 3 paiements ouverts **à session
connue**, sans transaction, initiés depuis 24 h, 3 lectures chacun. Ce mécanisme sert au cas
d'une transaction notifiée juste avant la relecture de sa session.

**Ce que garantit la réponse du webhook :**

| Réponse | Garantie |
|---|---|
| `200` (accusé) | Signature et horodatage valides. Puis, selon le cas : soit la transaction est rattachée à un paiement et ce paiement a été relu chez SasPay (état durable, période seulement après relecture concordante) ; soit aucun candidat à session connue ne l'attendait. Dans ce second cas, **rien n'est rattaché ni attribué** : une tentative incertaine sans référence reste ouverte, et le rapprochement périodique la reprend. Un accusé ne signifie jamais « paiement traité ». |
| `503` | Des candidats ont été relus sans que la transaction leur soit rattachée, ou erreur temporaire. SasPay renvoie (5 livraisons au total), puis abandonne. |

La relecture d'un candidat peut confirmer **son** paiement s'il est réellement payé. Elle ne
vaut pas traitement de l'événement notifié : l'accusé exige que **cette** transaction soit
rattachée.

**Chemin de récupération d'une tentative sans référence :**
1. Rapprochement périodique : toutes les 5 min, au plus 10 paiements non vérifiés depuis
   10 min. Recherche par référence marchand ; si la session est payée, relecture complète et
   attribution unique.
2. « Vérifier » du propriétaire.
3. CLI (§ 4).

Délai typique : une passe, soit 5 à 15 min.

**Limites :**
- recherche bornée à 500 sessions (5 pages de 100) : au-delà, seule une `--reference` fournie
  par SasPay résout ;
- tant qu'une tentative reste incertaine, le rapprochement la recherche de nouveau toutes les
  10 min (8 appels au plus par passe). Cela dure jusqu'à son rattachement ou sa clôture
  opérateur, et chaque passe s'interrompt si le budget des confirmations manque (1-22D).

## 4. Procédure opérateur

Sur l'hôte d'exploitation (`MONGODB_URI` explicite, voir 1-14D.2G) :

```sh
pnpm --filter api subscription:reconcile-payment -- inspect --payment-id=<id>
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id>
```

1. `inspect` (local, aucun appel) : `status: uncertain`, `providerReference: null`,
   `incidentCode: initiation_uncertain`, référence marchand `SM…`.
2. `reconcile` (simulation) : lire `plan.lookup`.
   - `found` + plan `ready` : appliquer avec `--apply --plan=<jeton> --operation-id=<UUID v4>
     --operator=<id> --reason=uncertain-initiation`.
   - `incomplete`, `unavailable` : relancer plus tard. Ou demander à SasPay l'identifiant de
     session, puis `reconcile --reference=<uuid>`.
   - `not-found` : demander à SasPay, **par écrit**, si une session payable ou un encaissement
     existe pour la référence `SM…` (montant, date). Si SasPay fournit un identifiant de
     session : `--reference`.
3. Clôture, seulement avec la confirmation écrite d'absence de session et d'encaissement :

   ```sh
   … reconcile --payment-id=<id> --close-without-session --ticket=saspay-support:<n°>
   … reconcile --payment-id=<id> --close-without-session --ticket=saspay-support:<n°> \
       --apply --plan=<jeton> --operation-id=<UUID v4> --operator=<id> --reason=provider-no-session
   ```

4. Codes de sortie :

   | Code | Signification |
   |---|---|
   | 0 | prêt ou appliqué |
   | 4 | bloqué |
   | 5 | plan obsolète : refaire la simulation |
   | 2 | usage ou preuve |
   | 6 | identifiant d'opération réutilisé autrement |
   | 7 | rejouer la même opération |

   Rejouer la même opération renvoie `replayed`.

## 5. Tests (SasPay simulé, isolation 1-22D.1)

Nouveau `test/payment-unresolved-reconciliation.e2e-spec.ts` (11 cas, 11 / 11). Il utilise le
service réel du CLI, les routes HTTP et le webhook signé.

| Cas | Vérifié |
|---|---|
| Inspection et simulation sans référence | `lookup-not-found`, `proofOfAbsence: false`, aucune écriture ni audit |
| Session retrouvée | plan `mark-pending` avec `lookup.found` ; application auditée, rejeu `replayed` ; 0 création ; payée puis 1 période |
| Référence opérateur | session étrangère → `mismatch` ; bonne session → plan prêt |
| Recherche indisponible / incomplète (501 sessions) | `lookup-unavailable` / `lookup-incomplete` (5 pages), aucune clôture, aucune écriture |
| Clôture sans preuve, ou motif / preuve différents | `proof-required`, `PROOF_REQUIRED`, aucune écriture |
| Clôture | simulation sans écriture ; application `failed / checkout_closed`, liens conservés, audit complet, rejeu idempotent ; plus applicable ensuite ; nouvelle tentative possible |
| Succès concurrent | session réapparue et payée avant application → clôture refusée, `succeeded`, 1 période |
| Preuve démentie | succès tardif après clôture → rapprochement → `succeeded`, 1 période |
| Nouvelle tentative puis succès tardif de l'ancienne | même renouvellement, `replacesPaymentId` ; nouvelle attribuée (1 période), ancienne `review` / encaissement en résolution (0 période) ; remboursement consigné → `refunded`, jamais attribuée |
| Webhook avant rattachement (cas 9) | notification de la tentative payée : aucune lecture de sa session, rien rattaché ni attribué ; puis rapprochement → retrouvée par sa référence marchand, `succeeded`, 1 période ; renvoi sans effet |
| Tentatives concurrentes (cas 11) : A payée, B plus récente sans session ; webhook de A, 3 rejeux, transaction étrangère, rapprochement, sans vieillir les fixtures | aucune livraison ne cherche ni ne lit une tentative sans référence (0 recherche, 0 lecture de A), ≤ 9 appels par livraison (candidats 1-21B) ; `txA` uniquement sur A, transaction étrangère sur aucun paiement ; A `succeeded` par le rapprochement en 1 passe, 1 période ; B jamais attribuée (0 période) |
| État changé entre simulation et application | clôture refusée, aucune mutation |

| Ensemble | Résultat |
|---|---|
| CLI unitaire (+2 cas : preuve, motif, incompatibilités, code de sortie) et unitaires `src/subscriptions/payments` | 263 / 263 |
| `payment-reconciliation`, `payment-reconciliation-cli-process` (binaire compilé), `saspay-confirmation-only` | 47 / 47 |
| `saspay-checkout`, `saspay-quota-isolation` | Version initiale : le cas 13 de `saspay-checkout` échouait (transaction étrangère → `503`), et sa préparation avait été adaptée. Après retrait de l'heuristique, cette adaptation est **annulée** (fichier identique à `HEAD`) : 63 / 63. |
| Nouvelle suite | 11 / 11 avec les tentatives laissées par les cas précédents ; cas 11 aussi seul (accusé immédiat, 0 appel, A récupérée en 1 passe) |
| Build de production (`nest build`), `tsc` complet sur les fichiers touchés | 0 erreur. Une erreur de typage introduite dans `payment-reconciliation-cli.spec.ts` (plan prêt sans faits vérifiés) a été corrigée. |
| ESLint | 0 erreur ; 18 alertes de `saspay-checkout.e2e-spec.ts` identiques à `HEAD`, aucune sur les lignes du lot |

## 6. Compatibilité

- **CLI :** commandes existantes inchangées. Seul changement : une simulation sans référence
  renvoyait `reference-required`. Elle renvoie maintenant le résultat de la recherche, ou un
  plan si la session est retrouvée. CamPay (sans recherche) reste `reference-required`.
- **Audit :** référence consultée, référence après et référence vérifiée sont `null` pour une
  clôture sans session seulement. Elles restent exigées pour les autres actions. Aucun index ni
  validateur concerné, aucune migration.
- **Parcours normal, tarifs, routes :** inchangés.
- **Webhook :** comportement de 1-22D.2 inchangé (§ 3) ; aucune nouvelle candidature.

## 7. Limites

- **Preuve non vérifiable par le code :** le CLI exige une référence de preuve et l'audite, mais
  ne peut pas contrôler son authenticité. La responsabilité reste celle de l'opérateur nommé.
- **Recherche bornée à 500 sessions :** sur un compte très actif, `incomplete` bloque la clôture,
  et seule une `--reference` fournie par SasPay permet de résoudre.
- **Débit tardif chez SasPay :** il n'est pas empêché. Il est seulement détecté et traité
  (§ 3) : rapprochement automatique pendant 72 h, puis CLI.
- **Webhook avant rattachement :** jamais récupéré par la notification elle-même, seulement par
  le rapprochement, « Vérifier » ou le CLI (§ 3).
- **Candidats de 1-21B :** temporels eux aussi (3 paiements à session connue les plus récents),
  mais sans risque d'affectation erronée. Avec d'autres paiements récents, une transaction
  inconnue reçoit `503` et SasPay la renvoie, bornée à ses 5 livraisons. Inchangé dans ce lot.
- **Question toujours ouverte :** la réponse écrite de SasPay sur la portée d'un `429` (1-21E § 2).

## 8. Fichiers de ce lot

| Fichier | Nature |
|---|---|
| `api/src/subscriptions/payments/payment-provider.ts` | contrat : recherche par référence marchand (facultative) |
| `api/src/subscriptions/payments/saspay/saspay-payment-provider.ts` | recherche exposée avec sa complétude ; `fetchStatus` inchangé |
| `api/src/subscriptions/payments/reconciliation/payment-reconciliation.service.ts` | recherche, rattachement, clôture exceptionnelle |
| `api/src/subscriptions/payments/reconciliation/payment-reconciliation-cli.ts` | `--close-without-session`, preuve, motif, codes |
| `api/src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema.ts` | motif, action, champs facultatifs pour la clôture |
| `api/src/subscriptions/payments/saspay/saspay-webhook.service.ts` | commentaire seulement : aucune création sans référence parmi les candidats (heuristique retirée ; `subscription-payments.service.ts` revenu à l'état de 1-22D.2) |
| `api/src/subscriptions/payments/reconciliation/payment-reconciliation-cli.spec.ts` | cas CLI, typage |
| `api/test/payment-unresolved-reconciliation.e2e-spec.ts` | nouveau |
| `docs/architecture/phase-1-22d2-saspay-ambiguous-create.md` | renvois § 6 |
| ce rapport | — |
