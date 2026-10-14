# Lot 1-22D.2 — Création SasPay : réponse 429 ambiguë

État : **un `429` reçu après l'envoi d'une création SasPay n'est plus traité comme la preuve
qu'aucune session n'existe.** Rien n'est commité, poussé ni déployé. Aucun appel réel à SasPay,
aucune base réelle.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `fix/phase-1-22d1-test-config-isolation`, avec les modifications **non commitées** de 1-22D et 1-22D.1 (22 fichiers, empreintes relevées avant ce lot) |
| Branche | `fix/phase-1-22d2-saspay-ambiguous-create`, sans stash, reset ni nettoyage |
| Variables, migrations | Aucune |

Le stash (`stash@{0}`) et les fichiers personnels sont conservés.

## 2. Défaut

`SasPayPaymentProvider.initiate` classait un `429` comme les refus 401/403/404 : « rien n'a été
créé » → `PaymentProviderUnavailableError`. Le service fermait alors la tentative
(`failed / provider_unavailable`, `open: false`) et libérait une nouvelle création.

- **Aucune source** ne dit qu'un `429` sur `POST /checkout-sessions/` exclut la création. 1-21A
  § 3 le liste seulement parmi les erreurs (constat 1-22D.1 § 6).
- Si une session avait été créée, elle pouvait être payée alors que sa tentative était déjà close
  et qu'une autre session était proposée. Le paiement pouvait encore être rattrapé (tentative
  `failed` relue), mais cela ouvrait un risque de double page de paiement.

## 3. Correction

Une seule ligne de classement change dans l'adaptateur :

| Cas | Avant | Après |
|---|---|---|
| Budget local refusé avant tout envoi (quota de l'organisation, capacité, pause) | aucune tentative (admission 1-22D, avant insertion) | inchangé |
| Transport `not-sent` (rien envoyé) | indisponible | inchangé |
| 401 / 403 / 404 | indisponible | inchangé |
| **429 après envoi** | indisponible → `failed` | **incertain** (`PaymentProviderUncertainError`) |
| 409, 5xx, réponse perdue | incertain | inchangé |

Le reste est le **parcours « incertain » existant**, sans nouveau mécanisme :
- tentative conservée **ouverte** (`uncertain`, `initiation_uncertain`), avec sa référence
  marchand et son `clientOperationId` ;
- un rejeu de la même opération renvoie la même tentative ; aucune session n'est jamais recréée ;
- une nouvelle opération reçoit `409 PAYMENT_ALREADY_PENDING` ;
- la vérification (« Vérifier », rapprochement périodique) recherche la session par la
  `metadata` (au plus 5 pages), dans les limites d'appels de 1-22D (8 appels réservés). Le CLI
  ne fait pas cette recherche : il consulte seulement par référence SasPay ;
- trouvée : session adoptée (`pending`), puis confirmée normalement ;
- introuvable : **aucune conclusion**, la tentative reste incertaine. Les règles existantes
  s'appliquent : nouvelles vérifications et rapprochements périodiques. Aucune clôture n'est
  outillée, voir § 6 ;
- la pause de 15 s après un `429` (1-22D) reste active : la vérification suivante est refusée
  localement (`503`, `Retry-After: 30`) jusqu'à la fin de la pause ;
- changement de forfait : il ne ferme qu'une page **retrouvée** et relue close sans transaction
  (règle 1-21E). Introuvable → `not-found-at-provider`, rien n'est libéré.

### Interface

Messages FR/EN existants, inchangés, car ils décrivent déjà l'attente :
- « Lien de paiement non récupéré… « Vérifier le paiement » la retrouve sans en créer une
  nouvelle » ;
- « Résultat à vérifier… aucune nouvelle demande ne sera envoyée ».

La création renvoie `201` avec `status: uncertain` et `situation: checkout-link-missing`. Aucun
échec n'est annoncé, aucune invitation à repayer.

## 4. Tests (SasPay simulé, configuration isolée de 1-22D.1)

Le faux SasPay accepte deux comportements de création : `429` sans rien créer, et `429` **après**
création. Il peut aussi masquer une session de la liste paginée.

| Cas | Vérifié |
|---|---|
| Refus local (quota de l'organisation, puis pause) | `429` / `503`, 0 appel, 0 tentative |
| `429` sans session | tentative `uncertain`, ouverte, même `clientOperationId` ; pendant la pause : `503` sans appel ; ensuite recherche sans résultat → reste `uncertain` |
| Rejeu de la même opération | même `paymentId`, `replayed: true`, 0 création |
| Autre opération pendant l'incertitude | `409 PAYMENT_ALREADY_PENDING` |
| Abandon / changement de forfait sans session retrouvée | `not-found-at-provider`, tentative ouverte |
| Rapprochement sans session | tentative toujours ouverte, 0 création, 0 session pour la référence |
| Session créée malgré le `429` | retrouvée et rattachée (`pending`, lien de cette session), payée, 1 session, 1 période |
| Session visible seulement plus tard | d'abord `uncertain` et abandon refusé ; puis rattachée ; abandon alors prouvé (`released`, session `CANCELLED`) |
| Succès notifié pendant le rapprochement | rapprochement `{ examined: 1, failed: 0 }`, `succeeded`, renvoi du webhook sans effet, **1 période** |
| Nouveaux paiements désactivés (`saspay-confirmation-only`, cas 7) | introuvable → reste ouverte ; session apparue → `succeeded`, 1 période |

| Ensemble | Résultat |
|---|---|
| `saspay-quota-isolation` (16 cas, dont 5 nouveaux à la place de l'ancien 7 bis) + `saspay-confirmation-only` (7 cas) | 23 / 23 |
| `saspay-checkout` | 47 / 47 |
| Unitaires `src/subscriptions/payments/saspay` (classement : `429` désormais incertain) | 26 / 26 |
| ESLint (fichiers du lot) | 0 erreur |
| `tsc` | aucune nouvelle erreur ; une erreur préexistante dans `saspay-confirmation-only` (ancienne ligne 107, décalée) |

Commande : `pnpm test:e2e -- <fichiers>` depuis `api/`.

## 5. Compatibilité

- **Paiements déjà fermés** `failed / provider_unavailable` après un `429` : inchangés. Ils
  restent relus comme toute tentative `failed` ; un succès tardif vérifié serait attribué
  (règle 1-21E). Aucune migration.
- **Organisation concernée :** elle garde un paiement ouvert jusqu'à ce que la session soit
  retrouvée, comme après une réponse perdue (1-21B). Le web l'affiche déjà ainsi. Sans session
  réelle, aucune issue n'est outillée (§ 6).
- **API :** la création répond `201` au lieu de `503` dans ce cas. Le web gère déjà le statut
  `uncertain`.
- **Production :** aucune variable ; aucun autre code de réponse modifié.

## 6. Limites

- **Blocage sans issue outillée (préexistant, désormais aussi après un `429`).** *Traité en
  1-22D.3 : recherche et rattachement par le CLI, clôture exceptionnelle sur preuve externe
  (`phase-1-22d3-unresolved-payment-reconciliation.md`).* Si la session
  n'existe vraiment pas, la tentative reste `uncertain` et l'organisation ne peut pas créer
  d'autre paiement.
  - Le CLI de rapprochement exige une référence SasPay (`reference-required`) : il ne peut pas
    clore une tentative sans session.
  - Aucun autre chemin existant ne la clôt.
  - C'est déjà le cas après une réponse perdue ou un 5xx (1-21B) ; ce lot l'étend au `429`,
    conformément à la règle « une recherche sans résultat ne prouve pas l'absence ».
  - **Proposition séparée, non réalisée :** une clôture opérateur explicite et auditée dans le
    CLI, pour une tentative `initiation_uncertain` restée introuvable après plusieurs recherches
    espacées au-delà de la validité de la page (30 min). Elle nécessite une confirmation écrite de
    SasPay ou une décision du propriétaire.
- **Recherche bornée** à 5 pages de 100 sessions : sur un compte très actif, une session ancienne
  peut ne pas être retrouvée.
- **Webhook avant rattachement** (*examiné en 1-22D.3 : comportement conservé ; garanties
  de l'accusé et chemin de récupération dans `phase-1-22d3-unresolved-payment-reconciliation.md`
  § 3*) : une notification reçue avant que la session ne soit
  rattachée (tentative sans référence SasPay) n'est pas reliée par le webhook. Ce n'est pas un
  candidat de 1-21B, et la notification est accusée. Le paiement est confirmé par le
  rapprochement périodique (5 min) ou « Vérifier », qui le retrouvent par sa référence marchand.
- **Non modifié :** `429` sur la fermeture de page (`cancelCheckout`). Il reste « indisponible »,
  ce qui ne cause aucun défaut : rien n'y est fermé, et seul le statut relu ensuite fait foi.
- **Question toujours ouverte :** obtenir de SasPay une réponse écrite sur le `429` (1-21E § 2).

## 7. Documentation corrigée

- `phase-1-21b-saspay-checkout.md` : `429` retiré des refus « aucune session » ; ligne
  « incertaine » ajoutée.
- `phase-1-21a-saspay-migration-plan.md` : renvoi vers ce lot.
- `phase-1-22d-saspay-quota-isolation.md` § 9 : historique du `429` à la création et correction.
- `phase-1-22d1-test-config-isolation.md` § 6 et § 7 : point 2 réalisé, point 1 ouvert.

## 8. Fichiers de ce lot

| Fichier | Nature |
|---|---|
| `api/src/subscriptions/payments/saspay/saspay-payment-provider.ts` | `429` à la création → incertain |
| `api/src/subscriptions/payments/saspay/saspay.spec.ts` | classement mis à jour |
| `api/test/e2e/fake-saspay.ts` | `429` avec ou sans création ; sessions non listées |
| `api/test/saspay-quota-isolation.e2e-spec.ts` | ancien 7 bis remplacé par 5 cas |
| `api/test/saspay-confirmation-only.e2e-spec.ts` | cas 7 |
| Documents du § 7 et ce rapport | corrections |
