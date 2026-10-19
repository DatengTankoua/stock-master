# Lots de produits — lot B : ventes, corrections, annulations et hors ligne

Suite du lot A ([product-batches-foundation.md](product-batches-foundation.md)),
sur la même branche `feature/product-batches-foundation` (base `origin/dev`
`3b22269`), en modifications non commitées. Aucun commit, aucun
déploiement, aucune activation ni donnée de production touchée.

**Toujours désactivé par défaut** (`PRODUCT_BATCHES_ENABLED` absent).
Vérifié uniquement dans la recette isolée. Rien n'est annoncé aux clients.

## 1. Règles métier

### Vente d'un produit suivi par lots

- `POST /sales` porte `batchAllocations: [{ batchId, quantity }]` (1 à
  20 lots distincts). La somme doit être **exactement** la quantité vendue
  (sinon 400 `BATCH_ALLOCATION_MISMATCH`).
- Les lots sont ceux **remis au client**, choisis ou confirmés par le
  vendeur. Le serveur ne les remplace jamais : un lot devenu insuffisant,
  dépassé ou indisponible donne un 409, sans substitution.
- **FEFO** (suggestion seulement) : lots datés non dépassés, péremption la
  plus proche d'abord. En cas d'égalité : réception la plus ancienne
  (inconnue en dernier), puis référence, puis identifiant. L'ordre est total
  et identique côté API (`batch-order.ts`) et web (`lib/batch-sale.ts`).
- **Lots sans date** : listés à part, jamais suggérés. Leur vente exige
  `unknownExpiryConfirmed: true`, après un avertissement explicite
  (sinon 409 `BATCH_EXPIRY_UNCONFIRMED`).
- **Lots dépassés ou non disponibles** : exclus des options et refusés par
  l'API.
- Une suggestion **ne réserve rien**. La confirmation revalide tout.
- La vente enregistre un **instantané** de chaque lot : `batchId`,
  référence, date de péremption, numéro fabricant et quantité. Il est trié
  FEFO, figé et jamais recalculé depuis les lots courants. Champs :
  `batchAllocations` (affectation courante) et `originalBatchAllocations`
  (affectation à la création, jamais modifiée).
- `initialQuantity` est inchangée par une vente (comme avant).

### Transaction et concurrence

Une seule transaction, dans cet ordre :

1. trace idempotente (`sale_operations`, mécanisme existant) ;
2. lecture du produit (organisation, actif, suivi par lots) et des lots
   (même organisation et même produit, sinon 409 `BATCH_UNAVAILABLE` : un
   lot étranger se comporte comme un lot absent) ;
3. contrôle des dates ;
4. décrément conditionnel de chaque lot (`status: available`,
   `remainingQuantity ≥ q`) ;
5. décrément conditionnel de la fiche (`remainingQuantity` et
   `batchTracking.totalQuantity`, du même montant) ;
6. alertes de stock (`stockAlertFor`, même clé `sale:<id>`), vente, journal
   `SOLD` (avec les lots) et activité.

Un échec à n'importe quelle étape annule tout : pas de vente partielle, pas
de décrément orphelin. Les écritures conditionnelles et les conflits
d'écriture MongoDB (transaction rejouée par le pilote) empêchent toute
quantité négative ou tout double décrément. Le validateur du lot A
garantit que la fiche reste égale au total suivi.

### Règle temporelle

- **Jour du commerce** = date civile dans le fuseau de l'API
  (`processTimeZone`, `Africa/Douala` en production). C'est la règle du
  lot A, jamais le fuseau du téléphone.
- Le serveur évalue chaque lot daté (date E) à la **réception** de la
  vente :

| Situation | Résultat |
|---|---|
| E ≥ aujourd'hui | accepté, quelle que soit l'heure déclarée |
| E < aujourd'hui et jour déclaré de la vente > E | 409 `BATCH_EXPIRED` (définitif) |
| E < aujourd'hui et jour déclaré ≤ E (vente hors ligne saisie avant, reçue après) | 409 `BATCH_EXPIRED_AT_SYNC` |

- L'heure déclarée (`occurredAt`, déjà bornée à −14 j / +5 min) vient de
  l'appareil : **elle ne suffit pas** à établir la validité. Une vente
  `BATCH_EXPIRED_AT_SYNC` n'est ni acceptée ni effacée : elle reste en
  conflit visible.
- **Régularisation** : `expiredBatchRegularization: { reason }` (motif ≥ 3
  caractères), réservée à `stock.adjust`. Elle n'agit **que** dans le cas
  `expired_at_sync`. Un lot dépassé au jour déclaré reste refusé, même
  avec ce champ : ce n'est jamais une autorisation de vendre aujourd'hui.
  La vente garde son heure réelle et porte `expiredBatchRegularization`
  (motif, auteur, date, jour du commerce, références). Le journal `SOLD`
  la reprend.
- Vendeur sans `stock.adjust` : demande de régularisation à un
  responsable (§ 1 bis).
- Aucun indicateur « périmé » n'est stocké. Le web recalcule la validité à
  chaque affichage avec `max(jour courant de l'appareil dans le fuseau du
  commerce, dernier jour annoncé par le serveur)`. Le changement de jour
  est donc pris en compte sans vente ni relecture, et une horloge reculée
  ne rend jamais un lot de nouveau vendable.
- **Restriction hors ligne explicite** : un lot qui expire le jour même
  est signalé (« si la vente n'est pas synchronisée avant minuit, elle
  devra être régularisée »).

### Stock physique et quantité vendable

- Un lot dépassé garde son stock physique, mais il n'est pas vendable.
  `GET /products/:id/batches` expose `sellable` par lot, et
  `sellableQuantity` / `expiredQuantity` avec le détail du stock.
- **Le seuil de stock faible n'est pas modifié** : il porte toujours sur
  `remainingQuantity`, le stock physique total, lots dépassés compris.
  L'interface le dit dans la section « Lots ».

### Corrections (`PATCH /sales/:id`)

Nouvelle quantité = quantité − `batchReturns` − restitutions +
`batchAllocations`.

| Cas | Règle |
|---|---|
| Prix seul | aucun stock touché |
| Diminution | `batchReturns` : lots **d'origine** de la vente, dans la limite de leurs unités |
| Augmentation | `batchAllocations` : lots vendables aujourd'hui (règle du jour, jamais régularisable) |
| Échange de lot | retour + ajout, quantité inchangée |
| Quantité seule (ancien client) | 409 `SALE_BATCH_CORRECTION_REQUIRED` |

- Un retour dans un lot dépassé depuis la vente lui rend ses unités
  physiques, mais ne le rend pas vendable.
- Chaque correction ajoute une entrée à `batchHistory` : date, auteur,
  quantité et affectation avant / après, retours, ajouts, restitutions,
  motif. L'affectation d'origine n'est jamais effacée.
- Le journal `SALE_UPDATED` porte les mêmes informations.

### Annulations (`DELETE /sales/:id`)

- Les unités sont rendues **exactement** aux lots enregistrés sur la
  vente, même s'ils sont dépassés depuis.
- Le journal `SALE_CANCELLED` garde les lots crédités : la vente est
  supprimée (règle existante), sa traçabilité est conservée.

### Ventes antérieures à l'activation

- Aucun lot n'est attribué rétroactivement : leur origine reste inconnue
  (pas de `batchAllocations`).
- Correction sans impact sur le stock (prix) : droits actuels.
- Restitution de quantité (diminution ou annulation) : destinations
  **explicites** obligatoires (`restitutions` vers des lots existants du
  produit, non retirés), un **motif** (`restitutionReason`) et
  `stock.adjust`. Sans elles : 409 `SALE_BATCH_RESTITUTION_REQUIRED`.
- Lot réellement inconnu : `historicalRestitution: { quantity, confirmed:
  true }` crée un « lot historique, date inconnue » (`origin:
  'restitution'`, sans date). Il exige aussi `products.manage` (identité
  d'un lot) et la confirmation explicite. Aucune fusion avec un lot
  existant.
- Ces restitutions sont des **destinations**, distinctes du lot d'origine
  (`historical`, `originUnknown: true` dans le journal). Ce ne sont pas
  des réceptions : `initialQuantity` est inchangée.
- Une correction d'erreur de saisie n'est **pas** un retour client. Les
  retours commerciaux ne sont pas créés.

### Corbeille, restauration, purge

| Situation | Effet |
|---|---|
| Produit à la corbeille | vente refusée (404, comme avant) ; retour et annulation restitués aux lots (produit restaurable) |
| Restauration | aucun stock touché |
| Produit purgé | aucune restitution dans un produit inexistant : correction de quantité 409 `SALE_PRODUCT_PURGED` ; prix seul permis ; annulation = vente retirée **sans** restitution (comportement existant des produits ordinaires), journal `stockRestored: false` |
| Lots d'un produit purgé | conservés avec le journal (lot A) |

## 1 bis. Régularisation par un responsable

L'outbox est propre à chaque vendeur. Un vendeur sans `stock.adjust` ne
peut donc pas régulariser lui-même : il **transmet explicitement** la vente
en conflit à un responsable. C'est un parcours ciblé, pas un système
général de validation. Il n'y a ni partage de compte ni attribution
temporaire de droits.

**Demande** (`POST /sales/regularizations`, droits de vente) :

- le corps est l'opération en attente **telle quelle** : même
  `clientOperationId`, même payload, même heure déclarée ;
- le serveur exige que le refus soit confirmé et que la vente soit
  éligible :
  - aucune vente n'existe déjà pour cette opération (sinon 409
    `SALE_REGULARIZATION_ALREADY_APPLIED`) ;
  - lots du commerce et du produit, au moins un lot `expired_at_sync`,
    aucun lot dépassé au jour déclaré (sinon 409
    `SALE_REGULARIZATION_NOT_NEEDED` ou `BATCH_EXPIRED`) ;
- elle est idempotente par opération : une répétition renvoie la même
  demande. Le même identifiant avec un autre contenu ou un autre auteur
  donne 409. Un index unique `{ organizationId, clientOperationId }` est
  installé par la garde des lots ;
- elle est persistée dans `sale_regularization_requests` :
  - vendeur d'origine, produit, quantité, prix, acheteur ;
  - heure **déclarée** (`declaredOccurredAt`) ;
  - lots et quantités (instantané), lots dépassés à la réception ;
  - hash canonique de l'opération d'origine ;
  - heure de **réception** serveur (`createdAt`) ;
- aucun stock n'est réservé ; audit `sale_regularization_requested`.

**Examen** (`GET /sales/regularizations`) :

- un responsable (`stock.adjust` + `sales.view_all`) voit tout le
  commerce ;
- un vendeur ne voit que ses demandes (filtre par `clientOperationIds`
  pour son outbox).

**Approbation** (`POST /sales/regularizations/:id/approve`, motif) :

- droits revérifiés par l'API (`stock.adjust` + `sales.view_all`) ;
  organisation du contexte (une demande d'un autre commerce donne 404) ;
- la vente est créée par le chemin de vente habituel, **au nom du vendeur
  d'origine**, avec son heure déclarée, **sous la clé de son opération**
  (`sale_operations`) et le hash d'origine ;
- revalidation complète : produit, lots, quantités, dates, éligibilité.
  Un stock devenu insuffisant donne 409 `BATCH_INSUFFICIENT` et la demande
  reste en attente ;
- la décision (`pending` → `approved`, `saleId`) est écrite **dans la même
  transaction** que la vente, conditionnée à `pending` ;
- unicité garantie :
  - deux approbations concurrentes butent sur la même clé d'opération :
    une seule vente, la seconde renvoie la demande approuvée ;
  - une nouvelle approbation après coup est sans effet ;
  - le rejeu de l'opération d'origine par l'outbox (avant ou en même
    temps) échoue sur le contrôle de date (aucune écriture) ; après
    l'approbation, il **retrouve la même vente** (rejeu idempotent).

**Rejet** (`POST /sales/regularizations/:id/reject`, motif obligatoire) :

- la demande passe à `rejected`, elle est conservée et consultable, avec
  son motif ;
- aucune vente n'est créée ; la décision est définitive (une approbation
  ultérieure donne 409 `SALE_REGULARIZATION_DECIDED`) ;
- audit `sale_regularization_rejected`.

**Traçabilité et heures distinctes** :

| Donnée | Où | Nature |
|---|---|---|
| Heure de la vente | `sale.occurredAt`, `declaredOccurredAt` | **déclarée** par l'appareil, non vérifiée indépendamment |
| Réception de la demande | `request.createdAt`, `regularization.receivedAt` | horloge serveur |
| Décision | `request.decidedAt`, `regularization.at`, journal | horloge serveur |
| Vendeur d'origine | `sale.sellerId`, `regularization.requestedBy`, journal `SOLD` (acteur) | — |
| Responsable approbateur | `regularization.actorId`, `request.decidedBy`, journal `sale_regularization_approved` (acteur, `sellerId` en détail) | — |

**Outbox du vendeur** :

- « Demander une régularisation » (en ligne) ; l'opération porte
  `regularization: requested` ;
- **tant qu'elle attend** : ni correction (une nouvelle opération pourrait
  doubler la vente approuvée) ni abandon ; stock réservé localement ;
- le résultat est relu en ligne au montage puis toutes les 20 s :
  - **approuvée** : l'opération repart avec le **même UUID** et le
    serveur renvoie la vente existante (synchronisée, une seule vente) ;
  - **rejetée** : conflit visible avec le motif ; correction ou abandon de
    nouveau possibles ;
- un vendeur qui a `stock.adjust` régularise directement (bouton
  « Régulariser », § 4).

**Responsable** : carte « Régularisations à examiner » sur la page
Ventes. Elle affiche le vendeur, les lots, l'heure déclarée (« appareil,
non vérifiée »), l'heure de réception, les lots dépassés et la décision
(auteur, date, motif). Approuver ou rejeter exige un motif.

## 2. Contrats API et compatibilité

| Route | Changement |
|---|---|
| `POST /sales` | + `batchAllocations`, `unknownExpiryConfirmed`, `expiredBatchRegularization` (facultatifs) |
| `PATCH /sales/:id` | + `batchReturns`, `batchAllocations`, `unknownExpiryConfirmed`, `restitutions`, `historicalRestitution`, `restitutionReason` |
| `DELETE /sales/:id` | corps facultatif : `restitutions`, `historicalRestitution`, `restitutionReason` |
| `GET /products/:id/batches/sale-options?quantity=N` | nouveau (voir § 3) |
| `POST /sales/regularizations`, `GET /sales/regularizations`, `POST /sales/regularizations/:id/approve` et `/reject` | nouveaux (§ 1 bis) |
| `GET /products`, `/products/:id` | + `batchSale` (identité des lots vendables) pour un produit suivi, **seulement si la fonctionnalité est activée** ; jamais dans les diffusions temps réel |
| `GET /products/:id/batches` | + `sellable`, `sellableQuantity`, `expiredQuantity` |
| Ventes renvoyées | + `batchAllocations`, `originalBatchAllocations`, `batchHistory`, `expiredBatchRegularization` |

- **Idempotence** : les champs de lots entrent dans le hash canonique
  seulement s'ils sont présents. Le hash d'une vente sans lots est
  identique à celui des versions antérieures (test unitaire dédié) : les
  rejeux d'outbox existants restent valides. L'affectation est triée et
  normalisée : l'ordre et la casse sont sans effet.
- **Anciens clients** (web antérieur, en ligne ou outbox) : une vente sans
  affectation d'un produit suivi donne 409 `SALE_BATCH_ALLOCATION_REQUIRED`
  (« mettez à jour l'application puis choisissez les lots vendus »), sans
  écriture. L'outbox antérieure le classe en conflit, sans bloquer les
  autres ventes.
- **Fonctionnalité désactivée** : `sale-options` répond 403
  `PRODUCT_BATCHES_DISABLED` (comme les routes du lot A). Les ventes,
  corrections et annulations par lots répondent **409** avec le même code.
  Un 403 aurait été classé par l'outbox comme un accès révoqué, et
  **toute** la file du vendeur aurait été bloquée.
- **Produits ordinaires** : chemin inchangé. Une affectation envoyée sur
  un produit non suivi donne 409 `BATCH_TRACKING_NOT_ENABLED`, sans
  écriture.
- Codes d'erreur stables : `batches/product-batch-errors.ts`. Messages
  FR/EN : `common/i18n/error-messages.ts`.

## 3. Permissions et visibilité

Aucune nouvelle permission.

| Opération | Droits exigés par l'API |
|---|---|
| Vendre par lots, choisir les lots, options de vente | `sales.record` (droits de vente actuels, sans droits de gestion des lots ni des dates) |
| Corriger, rendre aux lots d'origine, ajouter des unités, annuler | droits actuels de correction (`sales.record` + périmètre own / all) |
| Restituer des unités d'origine inconnue vers des lots | + `stock.adjust` |
| Destination « lot historique » | + `stock.adjust` + `products.manage` |
| Régulariser une vente `BATCH_EXPIRED_AT_SYNC` (sa propre outbox) | + `stock.adjust` |
| Demander une régularisation (vendeur) | `sales.record` (ses propres opérations) |
| Examiner, approuver ou rejeter une demande | `stock.adjust` + `sales.view_all` (la vente est créée au nom d'un collègue et en révèle le prix) |

- **Projection minimale** (`sale-options`) : identité, dates, état de
  date, suggestion FEFO **plafonnée à la quantité demandée**, et
  `uncovered` (unités non couvertes par les lots datés). Les quantités par
  lot ne figurent qu'avec `products.view_stock_details`.
- **Limite connue** : en variant la quantité demandée, un vendeur peut
  déduire jusqu'à N unités par lot. Ce n'est pas plus que le stock total
  du produit, qui fait déjà partie de la projection standard.
- `batchSale` (liste, fiche, cache hors ligne) ne contient **aucune**
  quantité.
- Les lots d'une vente (quantités affectées) suivent les droits de
  consultation de cette vente (`sales.view_own` / `view_all`), comme sa
  quantité.
- Isolation : organisation du contexte uniquement. Un produit d'un autre
  commerce donne 404 ; un lot d'un autre produit ou commerce, 409
  `BATCH_UNAVAILABLE`.

## 4. Hors ligne

Extension du parcours existant, sans nouvelle infrastructure.

- **Cache** : le snapshot du catalogue (même `schemaVersion`, champ
  facultatif) conserve `batchSale`, c'est-à-dire l'identité des lots
  vendables à l'écriture et le jour du commerce, **sans quantités**. Comme
  le prix d'achat (snapshot v3), un détail du stock n'est jamais mis en
  cache, puisque les droits ne sont pas vérifiables hors ligne.
- **Opération en attente** : `batchAllocations` (lots choisis),
  `unknownExpiryConfirmed`, et, pour l'affichage seulement,
  `display.batchLabels` (« L-002 × 3 »). L'outbox valide l'affectation à
  l'ajout (lots distincts, somme exacte).
- **Ventes locales en attente** : les unités engagées par lot sont déduites
  des quantités affichées (règle `reservesStock` existante, appliquée à
  l'heure de la lecture serveur affichée) **quand ces quantités sont
  connues**, c'est-à-dire en ligne avec le détail du stock. Hors ligne,
  aucune quantité par lot n'est connue. Le formulaire le dit (« disponibilité
  non vérifiée, rien n'est réservé ») ; seul le stock indicatif total
  s'applique.
- **Synchronisation** : la vente part avec **ses** lots. Le serveur ne la
  réaffecte jamais. Un refus de lot (`BATCH_*`,
  `SALE_BATCH_ALLOCATION_REQUIRED`, `PRODUCT_BATCHES_DISABLED`) est un
  **conflit terminal visible**, qui ne bloque jamais les autres ventes et
  ne compte jamais comme stock réservé.
- **Résolution explicite**, sans double vente (mécanisme `replaces`
  existant : le remplaçant est ajouté et l'original abandonné dans la même
  transaction IndexedDB, et l'original a été refusé de façon certaine par
  le serveur) :
  - « Corriger » : nouveau choix des lots (affectation précédente
    pré-remplie) ;
  - « Régulariser » (`BATCH_EXPIRED_AT_SYNC`, utilisateur avec
    `stock.adjust`) : même vente, mêmes lots, **même heure réelle**
    (`keepOccurredAt`), plus un motif ;
  - « Demander une régularisation » (`BATCH_EXPIRED_AT_SYNC`, utilisateur
    sans `stock.adjust`) : transmise à un responsable (§ 1 bis) ;
  - sinon, « Abandonner » sur confirmation explicite.
- **En ligne** : un refus de lot à la confirmation laisse le formulaire
  ouvert, relit les lots et propose une nouvelle répartition. La nouvelle
  saisie remplace l'opération refusée.

## 5. Vérifications

| Contrôle | Résultat |
|---|---|
| API : `nest build`, ESLint (0 erreur ; avertissements `any` dans les e2e, comme ailleurs) | OK |
| API : Jest unitaire complet | 105 suites, 1923 tests OK |
| API : e2e `product-batches-sales` (lot B) | 14 tests OK |
| API : e2e lot A + ventes, idempotence, historique, date/seuil, pagination, isolation, activité, permissions | 10 suites, 159 tests OK |
| Web : `tsc`, ESLint, `test:i18n`, `i18n-coverage`, 6 scripts existants + `test:batch-sale` (8 tests), `next build` | OK |
| Recette navigateur isolée, 375 px, FR puis EN | 37 contrôles OK (ci-dessous) |
| Recette : vente antérieure annulée vers un lot historique confirmé (375 px, FR/EN) | 10 contrôles OK : confirmation exigée, lot `restitution` sans date, `initialQuantity` inchangée |
| Recette : correction 4 → 3 en 1280 px (retour pré-rempli vers le lot d'origine) | OK |

**e2e lot B** (`api/test/product-batches-sales.e2e-spec.ts`) :

- options FEFO (lots sans date à part, dépassés exclus, suggestion
  plafonnée) ;
- vente répartie sur deux lots avec instantané figé ;
- refus sans écriture : somme fausse, doublon, dépassé, sans date non
  confirmé, épuisé, sans affectation, transaction annulée sur le second
  lot ;
- lot d'un autre produit ou commerce ;
- produit ordinaire ;
- ventes concurrentes (8 sur un lot de 5 : exactement 5 acceptées) ;
- rejeux séquentiels et concurrents, clé réutilisée ;
- prix seul, diminution, augmentation, lot dépassé refusé, échange,
  historique avant / après ;
- annulation vers un lot dépassé depuis (stock physique, non vendable) ;
- vente antérieure : aucun lot inventé, motif et droits, lot historique
  confirmé, `initialQuantity` inchangée ;
- vendeur par défaut sans quantités exposées ;
- fonctionnalité désactivée ;
- vente déclarée avant péremption et reçue après (conflit, rejeu, refus
  le jour même, régularisation tracée) ;
- corbeille et purge.

Invariant contrôlé après chaque scénario : somme des lots = stock de la
fiche = total suivi, aucune quantité négative, `initialQuantity`
inchangée.

**Recette navigateur** (`recipe.js start --product-batches`, Chrome
375 px, FR puis EN) :

- suggestion FEFO 8 + 2 (lot sans date non suggéré) puis vente ;
- lot sans date : confirmation exigée puis acceptée ;
- historique : « Lots : L-001 × 8, L-002 × 2 » ;
- annulation annonçant les lots d'origine, restitution exacte ;
- coupure réseau : vente sur L-002 depuis le cache ; un collègue épuise
  L-002 ; à la reconnexion, **conflit visible** sans réaffectation ni
  écriture ; « Corriger » vers L-001 ; une seule vente ;
- seconde vente hors ligne synchronisée une seule fois après reconnexion ;
- aucun débordement horizontal, aucune erreur JavaScript.

Défauts trouvés et corrigés pendant la recette :

- les quantités par lot déduisaient des ventes déjà synchronisées (heure de
  lecture inconnue dans le panneau des ventes en attente). Le sélecteur
  utilise désormais l'heure de sa propre lecture serveur ;
- libellé « disponibles » remplacé par « vendue(s) dans ce lot » dans les
  retours d'une correction ;
- message d'erreur de restitution effacé dès la modification du
  formulaire. **Rejoué au navigateur** (FR/EN, 375 px) : l'erreur
  « confirmez la création du lot historique » disparaît dès que la case est
  cochée.

### Finalisation : régularisation et notifications

| Contrôle | Résultat |
|---|---|
| e2e `product-batches-sales` (lot B + régularisation + notifications) | 18 tests OK |
| e2e lot A + idempotence des ventes (garde : index ajouté ; `createFresh` modifié) | OK (3 suites, 55 tests au total avec le lot B) |
| Jest unitaire ventes et produits | 311 tests OK |
| API `nest build`, ESLint (0 erreur) ; web `tsc`, ESLint, `test:i18n`, `test:batch-sale` | OK |
| Recette navigateur : régularisation par un responsable, 375 px, FR puis EN | 36 contrôles OK |
| Recette navigateur : erreur de restitution effacée (FR/EN) | 12 contrôles OK |

**e2e de régularisation** :

- vendeur sans `stock.adjust` : refus confirmé (409), auto-régularisation
  refusée (403) ;
- demande idempotente ; même clé avec un autre contenu refusée ;
- refus d'approbation pour le vendeur, pour un membre `stock.adjust` sans
  `sales.view_all` et pour un autre commerce (404) ;
- visibilité : le vendeur ne voit que ses demandes ;
- **trois approbations concurrentes + rejeu concurrent de l'outbox** : une
  seule vente, puis le rejeu retrouve la même vente, stock décrémenté une
  fois ;
- traçabilité : vendeur d'origine ≠ approbateur, heure déclarée, réception
  postérieure ; journaux `SOLD` (vendeur), `requested`, `approved`
  (responsable) ;
- plus aucune demande possible ensuite ;
- rejet motivé conservé, définitif, sans vente ;
- revalidation à l'approbation (stock insuffisant : 409, demande toujours
  en attente) ; vente valide refusée comme non éligible.

**Recette de régularisation (sans attendre minuit, sans modifier
l'horloge globale)** :

- horloge **du navigateur du vendeur** contrôlée (Playwright `clock`,
  veille 22:00) pour l'heure déclarée de la vente, saisie hors ligne sur un
  lot qui expire « aujourd'hui » ;
- puis donnée de recette : dernier jour du lot passé à « hier », ce qui
  reproduit le passage de minuit côté serveur ;
- à la reconnexion : conflit visible chez le vendeur (compte recette sans
  `stock.adjust`) ;
- demande transmise : le texte annonce l'heure déclarée « non vérifiée » ;
  l'opération attend, ni « Corriger » ni « Abandonner » ;
- le vendeur se voit refuser l'approbation (403) ;
- le propriétaire examine la carte (heures déclarée et de réception
  distinctes) puis approuve avec un motif ;
- de retour dans l'outbox du vendeur, le résultat est retrouvé et
  l'opération synchronisée : **une seule vente**, mêmes lots, stock
  décrémenté une fois, vendeur d'origine ≠ approbateur. Une nouvelle
  approbation est sans effet ;
- second cas rejeté avec motif : motif affiché au vendeur, correction et
  abandon de nouveau proposés, demande conservée, aucune vente ;
- aucun débordement, aucune erreur JavaScript.

**Notifications de stock** (e2e, mécanismes de test existants : runtime
push activé avec une paire VAPID **générée par le test** et un **faux
transport** sans réseau, dispatcher exécuté explicitement par `runOnce`) :

- produit suivi, seuil 5 :
  - 10 → 6 : aucun événement ;
  - 6 → 4 : **un** événement `stock-low` ;
  - **rejeu** de la même vente : toujours un ;
  - 4 → 3 : **pas de répétition** ;
  - 3 → 0 : `stock-depleted` seul (**rupture prioritaire**, aucun
    `stock-low` de plus) ;
- destinataires et préférences :
  - propriétaire : `stock-low` puis `stock-depleted` ;
  - membre avec le détail du stock mais préférence `stockLow` coupée :
    seulement la rupture ;
  - vendeur sans `products.view_stock_details` : rien.

Ces contrôles portent sur la création des événements et le calcul des
livraisons. **L'envoi push réel** (service de push du navigateur, clés
VAPID de production) **reste non vérifié**.

## 6. Limites

- Un seul prix d'achat par produit : ni valorisation ni marge par lot.
- Régularisation par un responsable :
  - la demande doit être transmise **en ligne** par le vendeur ;
  - le résultat n'est relu que lorsque le vendeur ouvre l'application en
    ligne (montage, puis toutes les 20 s sur la page des ventes en
    attente) ;
  - ~~aucune notification n'avertit le responsable d'une nouvelle
    demande~~ (lot C : notification « Régularisations à examiner ») ;
  - une approbation postérieure de plus de 14 jours à l'heure déclarée
    reste possible : la fenêtre de 14 jours est contrôlée à la demande ;
  - l'historique des ventes affiche l'heure d'enregistrement (`createdAt`,
    comportement existant), l'heure déclarée figure sur la vente et dans
    la régularisation.
- L'envoi push réel n'est pas vérifié (seuls les événements et livraisons
  calculés le sont, avec un faux transport).
- Hors ligne, aucune quantité par lot (choix d'après l'identité et les
  dates seulement, revalidé à la synchronisation).
- `sale-options` peut révéler jusqu'à N unités par lot (voir § 3).
- Les retours commerciaux ne sont pas pris en charge (seules les
  corrections d'erreur de saisie le sont).
- Pas de notification de péremption, de mise à l'écart ni de perte (lot C).
- Ajout de stock hors réception (`additionalStock`) et date de fiche :
  toujours refusés (409 `PRODUCT_BATCH_TRACKED`) pour un produit suivi.

## 7. Déploiement et retour arrière

**Ordre**

1. API, puis web. Les champs de vente sont facultatifs. Le validateur et
   les index du lot A sont des prérequis de toute activation
   (`migrate:product-batches -- --install --apply`). Cette commande
   installe désormais aussi l'index unique des demandes de régularisation.
   Une garde installée avant ce lot est signalée incomplète (activation
   refusée, 503) jusqu'à une nouvelle exécution, qui est idempotente.
2. Drapeau absent en production. Ne l'activer qu'après le lot C ou une
   décision explicite, en recette d'abord.
3. Web avant API : sans effet. Le web n'ouvre la vente par lots qu'en
   présence de `batchSale` (fourni seulement par une API à jour, avec la
   fonctionnalité activée).

**Retour arrière**

| Vers | Conséquence | Condition |
|---|---|---|
| API lot A | ventes par lots refusées (400, champs inconnus rejetés par `forbidNonWhitelisted`) ; ventes sans lots refusées (409) ; aucune incohérence | aucune |
| API antérieure aux lots | ventes, corrections et annulations d'un produit suivi refusées par le validateur MongoDB (erreur 500, aucune écriture) ; ventes avec `batchAllocations` refusées (400) | validateur conservé (`--remove-validator` refuse tant qu'un produit est suivi) ; retirer `stock.manage_batches` avant (lot A) |
| Web antérieur | « vente indisponible » (lot A) ou ventes sans lots refusées par l'API (409, conflit visible) | aucune |

> **Après livraison du lot C** : la procédure à suivre est celle de
> [product-batches-expiry-losses.md § 8](product-batches-expiry-losses.md).
> Dès qu'une perte est enregistrée, revenir à une API antérieure au lot C
> n'est pas sûr : sa purge écrirait un `PurgedStockAdjustment` faux. Pour
> revenir au lot B sans perte, utiliser `--strip-lot-c-permissions`, pas
> `--strip-permission`, qui retire aussi `stock.manage_batches`.

- Demandes de régularisation (`sale_regularization_requests`) : ignorées
  par une API antérieure, conservées en base. Une opération d'outbox en
  attente de décision reste « en attente » chez le vendeur, sans correction
  ni abandon possibles, jusqu'au redéploiement d'une API qui répond. Elle
  n'est jamais transformée en vente en silence. Décider (approuver ou
  rejeter) les demandes en attente avant un retour arrière évite ce
  blocage.
- Les champs ajoutés aux ventes (`batchAllocations`, `batchHistory`…)
  sont ignorés par une API antérieure : aucune perte, mais une correction
  ou une annulation par une API antérieure reste refusée par le validateur
  tant que le produit est suivi.
- Ventes en attente dans les outbox : envoyées telles quelles après la
  remise à jour. Une API antérieure les refuse sans écriture (conflit
  visible), jamais en silence.

## 8. Travail restant pour le lot C

> **Mise à jour : lot C réalisé** sur la même branche, voir
> [product-batches-expiry-losses.md](product-batches-expiry-losses.md) :
> alertes de péremption (planifiées, dédupliquées, revalidées), mise à
> l'écart, pertes et corrections, calculs séparant ventes et pertes,
> notification « régularisation à examiner » (la limite du § 6 sur
> l'absence de notification du responsable est levée). Liste d'origine
> conservée ci-dessous.

- Alertes de péremption (jour du commerce, délai configurable),
  notifications et Analyse, sur `expiredQuantity` / dates des lots.
- Mise à l'écart (`quarantined` : stock physique, non vendable) et retrait
  (`withdrawn`) : à exclure de la vente (déjà fait pour tout statut ≠
  `available`) et des destinations de restitution (déjà fait pour
  `withdrawn`).
- Pertes journalisées (péremption, casse) : décrément du lot et de la
  fiche, mouvement distinct des ventes, `initialQuantity` inchangée.
- **Audit préalable** des calculs `initialQuantity − remainingQuantity`
  (fiche, Analyse, exports, purge, seuil par défaut) : une perte ne doit
  jamais devenir une vente, du chiffre d'affaires ou du bénéfice (détail
  dans le rapport A, § 12).
- Décision explicite sur la base du seuil de stock faible (physique ou
  vendable) ; inchangée en B.
- Éventuelle notification du responsable à l'arrivée d'une demande de
  régularisation (catégorie existante ou nouvelle, à décider).
