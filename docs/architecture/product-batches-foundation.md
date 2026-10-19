# Lots de produits — lot A : structure, réceptions et reprise du stock

Branche `feature/product-batches-foundation`, créée depuis `origin/dev`
(`3b22269`, fusion de #56 : date de péremption et seuil personnalisé, déjà
en production et présents sur la branche). Aucun commit, aucun
déploiement, aucune donnée de production touchée.

**Fonctionnalité désactivée par défaut.** Elle n'est activée que dans la
recette isolée (`recipe.js start --product-batches`). Elle n'est annoncée
nulle part côté marketing.

## 1. État initial (avant ce lot)

**Invariants existants**

- `remainingQuantity ≥ 0`, garanti par écriture atomique conditionnelle.
- `initialQuantity` = stock initial + entrées (`additionalStock`). Il sert de
  base à la règle par défaut du stock faible (≤ 20 %) et aux unités vendues.
- Une seule date de péremption par fiche (`expiryDate`, date civile).
- Ventes idempotentes (`sale_operations`, `clientOperationId`), outbox hors
  ligne rejouée par le web.

**Points d'écriture du stock** (`ProductsService`)

| Écriture | Appelant |
|---|---|
| `create` : stock initial | création de produit |
| `update` : `additionalStock` (`$inc` initial + restant) | modification de produit |
| `decrementStock` | vente en ligne et outbox hors ligne (`SalesService.create`) |
| `adjustStock` (`save()`) | correction de quantité d'une vente, annulation |

La corbeille, la restauration et la purge ne modifient pas le stock. La
purge fige l'historique des ventes (1-15D).

## 2. Modèle retenu

Une fiche produit, un mode de suivi :

- **sans lots** (`stockTracking` absent) : fonctionnement actuel, aucune
  migration ;
- **par lots** (`stockTracking: 'batches'`) : stock réparti entre lots.

**Lot** (`productbatches`)

| Champ | Rôle |
|---|---|
| `organizationId`, `productId` | rattachement (filtre composite systématique) |
| `_id` | identifiant interne stable |
| `reference` | référence lisible `L-001`, attribuée par le serveur, unique par produit |
| `manufacturerLot` | numéro fabricant facultatif |
| `receivedOn` | date civile de réception (`null` : inconnue, reprise historique) |
| `expiryDate` | date civile de péremption (`null` : aucune date connue) |
| `remainingQuantity` | quantité restante, ≥ 0 |
| `status` | `available` seul écrit ; `quarantined` et `withdrawn` réservés au lot C |
| `origin` | `opening` (reprise) ou `reception` |
| `createdBy`, timestamps | traçabilité |

- Deux lots de même date ne sont jamais fusionnés. Aucune date de péremption
  n'est déduite de la date de réception.
- Aucun indicateur « périmé » stocké. `expiryState` (`unknown`, `valid`,
  `expired`) est calculé à chaque lecture.
- **Règle de date commune** (`batches/business-date.ts`) : jour civil du
  commerce dans le fuseau de l'API (`processTimeZone`, `TZ`, soit
  `Africa/Douala` en production), le même que l'Analyse. Aucune
  organisation n'a de fuseau propre : ce choix est explicite, jamais celui
  du téléphone. Une date D reste utilisable le jour D, dépassée à partir de
  D+1.

**Fiche** (`products`) : `batchTracking` = `{ totalQuantity, sequence,
enabledAt, enabledBy, operationId, legacyExpiryDate }`.

**Opérations idempotentes** (`productbatchoperations`) : index unique
`{ organizationId, clientOperationId }`, même principe que `sale_operations`.
Un rejeu par le même auteur avec la même requête renvoie l'état courant
sans écriture. Une autre requête donne 409 `IDEMPOTENCY_KEY_REUSED`, un
autre auteur 409 `IDEMPOTENCY_KEY_CONFLICT`.

## 3. Quantités : source de vérité et invariants

- **Source de vérité** : les lots.
- `remainingQuantity` de la fiche est conservé pour compatibilité
  (catalogue, Analyse, alertes).
- Deux garanties distinctes :
  1. **Somme des lots = `batchTracking.totalQuantity`** : garantie
     uniquement par les transactions métier. Toute écriture de quantité
     passe par `ProductBatchesService`, dans **une** transaction : trace
     idempotente, lots, fiche (`$inc` identiques sur `remainingQuantity` et
     `batchTracking.totalQuantity`), journal. Aucune contrainte de base ne
     relie les documents `productbatches` à la fiche. L'e2e la vérifie après
     chaque opération (`expectConsistent`).
  2. **`remainingQuantity == batchTracking.totalQuantity` sur la fiche** :
     garantie par la base (garde MongoDB ci-dessous), quel que soit le code
     qui écrit.
- Quantités entières strictement positives (comme les ventes), aucune
  quantité négative (`min: 0` + `$inc` positifs uniquement en lot A).

**Garde MongoDB** (`batches/product-batch-guard.ts`). C'est le validateur
de la collection `products` (niveau `strict`, action `error`). Il accepte
deux formes de document :

- `stockTracking` absent ou `null` : aucune contrainte supplémentaire ;
- `stockTracking: 'batches'` : `batchTracking.totalQuantity ≥ 0` et
  `remainingQuantity == batchTracking.totalQuantity`.

Il contrôle un **document produit** après chaque insertion ou mise à jour.
Il ne lit pas les lots : il ne vérifie ni leur somme, ni leurs quantités,
ni leur existence.

Écritures d'une API **sans lots** (antérieure ou retour arrière) sur un
produit suivi :

| Ancienne écriture | Forme | Effet |
|---|---|---|
| Vente en ligne ou outbox (`decrementStock`) | `$inc: { remainingQuantity: -q }` | **refusée** (erreur 121) ; la transaction de vente est annulée, aucune vente ni trace d'idempotence écrite |
| Correction de quantité d'une vente (`adjustStock`) | `save()` → `$set: { remainingQuantity }` | **refusée**, transaction annulée |
| Annulation d'une vente (`adjustStock`) | idem | **refusée**, la vente n'est pas supprimée |
| Ajout de stock (`update`, `additionalStock`) | `$inc` sur `initialQuantity` et `remainingQuantity` | **refusée** |
| Date de la fiche (`update`, `expiryDate`) | `$set` / `$unset` sans quantité | **non bloquée** : l'égalité reste vraie. La nouvelle API ignore cette date pour un produit suivi (projection `expiryDate: null`, refus 409 en écriture) |
| Nom, prix, photo, seuil, section | sans quantité | non bloquée, sans effet sur la cohérence des lots |
| Corbeille, restauration | `deletedAt` | non bloquée, sans effet sur le stock |
| Purge (`findOneAndDelete`) | suppression | non contrôlée par un validateur ; lots et journal conservés, orphelins |
| Création d'un produit | insertion sans `stockTracking` | acceptée (forme « sans lots ») |

Le validateur ne bloque **pas** non plus :

- une écriture directe sur `productbatches` (hors API) ;
- une écriture qui modifierait `remainingQuantity` et
  `batchTracking.totalQuantity` du même montant sans toucher les lots
  (aucun code existant ne le fait) ;
- le retrait de `stockTracking` (aucun code existant ne le fait).

Une ancienne API reçoit l'erreur 121 comme une erreur inattendue (500) :
refus brutal, mais aucune incohérence n'est écrite.

**`initialQuantity`**

| Opération | `remainingQuantity` | `initialQuantity` | Journal |
|---|---|---|---|
| Reprise (ventilation) | inchangé | **inchangé** | `batch_tracking_enabled` |
| Réception (nouveau lot ou lot existant) | `+q` | `+q` (entrée, comme `additionalStock`) | `batch_received` |
| Modification d'identité | inchangé | inchangé | `batch_updated` (`{ from, to }`) |

Le journal existant (`AuditLog`) est réutilisé : auteur, date, lot concerné.
Les quantités (`added`, `allocations`, `totalQuantity`) ne sont projetées
qu'avec `products.view_stock_details`. Les anciennes ventes ne sont jamais
réécrites.

**Prix d'achat** : un seul `purchasePrice` par fiche. La valorisation et la
marge restent calculées comme aujourd'hui (prix de la fiche × unités). Un
prix différent par réception n'est **pas** enregistré ni utilisé : aucune
marge par lot n'est calculée ni affichée. À traiter si un coût par lot est
demandé (lot B ou ultérieur).

## 4. API (lot A)

| Route | Effet |
|---|---|
| `GET /products/:id/batches` | lots, prochaine échéance connue, présence d'unités sans date, date historique |
| `POST /products/:id/batch-tracking` | reprise du stock existant (activation) |
| `POST /products/:id/batches` | réception dans un **nouveau** lot |
| `POST /products/:id/batches/:batchId/receptions` | réception dans un lot **existant désigné** : quantité seule (toute autre propriété → 400) |
| `PATCH /products/:id/batches/:batchId` | identité seule (date, numéro, réception) ; jamais de quantité |

- Une réception dans un lot existant ne remplace jamais sa date ni son
  numéro fabricant. Une modification de date n'est jamais une réception.
- Date de réception future refusée (`BATCH_DATE_IN_FUTURE`). Celle d'un lot
  reçu ne peut être effacée.
- Codes d'erreur stables : `batches/product-batch-errors.ts`. Messages
  traduits FR/EN (`common/i18n/error-messages.ts`).

## 5. Reprise du stock existant

Procédure explicite, transactionnelle et idempotente :

1. Le client envoie `expectedRemainingQuantity` (stock affiché) et la
   répartition.
2. Somme ≠ stock annoncé : 400 `BATCH_ALLOCATION_MISMATCH`.
3. Stock modifié entre-temps : 409 `BATCH_STOCK_CHANGED`. L'écriture est
   conditionnée à `remainingQuantity` et au mode lus ; une vente concurrente
   est donc détectée. L'interface propose « Actualiser ».
4. Stock non entier : refus.
5. Écriture : lots `opening`, `stockTracking: 'batches'`, `batchTracking`,
   journal. Aucune vente ni entrée de stock fictive : total et
   `initialQuantity` inchangés.

Exemple vérifié : 28 unités → L-001 (8) + L-002 (20) ; stock 28, initial 28.

- **Répartition inconnue** : un seul « lot historique, date inconnue »,
  choisi explicitement et confirmé par case à cocher. Jamais plusieurs lots
  fabriqués.
- **Date historique** : proposée ligne par ligne (« Utiliser cette date »),
  jamais imposée. Elle est conservée dans `batchTracking.legacyExpiryDate`
  et dans le journal. La fiche n'expose plus de date unique
  (`expiryDate: null`) : elle affiche « Suivi du stock : par lots », et la
  section Lots affiche la prochaine échéance connue et signale les unités
  sans date.
- **Pas de désactivation** : aucune route ne repasse en mode sans lots. Le
  validateur ne peut pas être retiré tant qu'un produit est suivi.

## 6. Permissions

Une seule permission ajoutée : **`stock.manage_batches`** (activer le suivi
et répartir le stock existant). Accordée par défaut au propriétaire et à
l'administrateur (sémantique « tous droits » inchangée), jamais au vendeur
sans délégation explicite. Les autres droits sont réutilisés, sans changer
leur portée (`stock.manage_thresholds` non concerné).

| Opération | Droits exigés par l'API |
|---|---|
| Consulter les lots (identité, dates) | tout membre actif |
| … et leurs quantités, total, journal des quantités | + `products.view_stock_details` |
| Activer le suivi, répartir le stock existant | `stock.manage_batches` |
| Recevoir dans un **nouveau** lot (crée son identité) | `products.manage` + `stock.adjust` |
| Recevoir dans un lot existant | `stock.adjust` |
| Modifier l'identité d'un lot | `products.manage` |
| Renseigner ou modifier une date de péremption (toute opération) | + `products.manage_expiry` |

- Refus 403 uniforme, rien n'est écrit. L'organisation vient toujours du
  contexte (garde), jamais de la requête. Un produit ou un lot d'un autre
  commerce donne 404, comme un absent.
- **Catalogue de permissions 4** (`PERMISSION_CATALOGS`). Un web qui
  n'affiche pas la permission (fonctionnalité désactivée) déclare le
  catalogue 3 : une permission déjà accordée est conservée, jamais retirée à
  l'insu de l'auteur.
- Invitations : la case n'est proposée (invitation comme édition d'un
  membre) que si l'API annonce la fonctionnalité. L'API accepte la
  permission dans une invitation et la transmet à l'acceptation comme les
  autres ; fonctionnalité désactivée, elle n'ouvre rien (routes en 403).

## 7. Protection tant que le lot B n'existe pas

**Drapeau** `PRODUCT_BATCHES_ENABLED` (`batches/product-batches-config.ts`) :

- absent ou `false` : désactivé (défaut, production) ;
- `true` : activé ;
- toute autre valeur : désactivé et signalé au démarrage.

Désactivé, toutes les routes des lots répondent 403
`PRODUCT_BATCHES_DISABLED`. `GET /auth/context` annonce
`features.productBatches` ; le web n'affiche rien sans cette annonce.

**Activation impossible sans garde** : la reprise vérifie le validateur et
les index ; s'ils manquent, elle répond 503
`PRODUCT_BATCH_GUARD_MISSING`.

**Opérations incompatibles refusées côté serveur, indépendamment du
drapeau** (elles suivent les données du produit), avec 409
`PRODUCT_BATCH_TRACKED` et sans écriture :

| Opération | Mécanisme |
|---|---|
| Vente en ligne et outbox (y compris d'un ancien client) | `decrementStock` filtré sur `stockTracking: null`, puis 409 |
| Correction de quantité, annulation de vente | `adjustStock` : refus, transaction annulée |
| Ajout de stock (`additionalStock`), date de la fiche | `update` : refus avant écriture et écriture conditionnée (activation concurrente) |
| Écriture d'une ancienne API modifiant `remainingQuantity` seul | validateur MongoDB (détail au § 3) |

- L'outbox classe `PRODUCT_BATCH_TRACKED` en refus définitif : l'opération
  passe en conflit sans bloquer les autres ventes. Le catalogue hors ligne
  mémorise `stockTracking` et ne propose pas la vente d'un produit suivi.
- L'outbox elle-même n'est pas modifiée.
- Produits ordinaires : comportement inchangé (filtre `stockTracking: null`
  toujours vrai), vérifié par les e2e existants et par un e2e dédié.

## 8. Interface (FR/EN, mobile)

- Fiche produit : section « Lots » (seulement si l'API l'annonce). Un
  produit sans lots n'y affiche qu'une carte « Activer le suivi par lots »,
  et seulement avec `stock.manage_batches`.
- Reprise : total à répartir, choix « je connais la répartition » / « lot
  historique », lignes quantité + date + numéro, reste calculé en direct
  (proposé à la ligne suivante), confirmation obligatoire.
- Réception : nouveau lot (quantité, date de réception, péremption,
  numéro) ou lot existant (quantité seule, identité rappelée).
- Modification d'identité.
- Produit suivi : « Vendre » remplacé par un message, champ « Ajouter du
  stock » et date de la fiche masqués. L'API reste l'autorité.
- Erreurs : messages par code, sans détail technique.
- Fichiers : `web/src/components/products/product-batches-section.tsx`,
  `web/src/lib/api.ts`, `web/src/lib/organization-permissions.ts`.

## 9. Contrôles effectués

| Contrôle | Résultat |
|---|---|
| API : `nest build`, ESLint des fichiers modifiés | OK |
| API : `tsc` sur les specs | aucune erreur dans `product-batches.e2e-spec.ts` (filtre d'audit typé par `AuditAction`) ; erreurs de typage Mongoose préexistantes dans d'autres specs non modifiés, laissées en l'état |
| API : Jest unitaire complet | 105 suites, 1917 tests OK |
| API : `product-batches.e2e-spec.ts` | 19 tests OK |
| API : e2e connexes (ventes, idempotence, outbox, date/seuil, permissions, invitations, membres, contexte, isolation, pagination, activité) | 10 suites, 175 tests OK |
| Web : `tsc`, ESLint, `test:i18n`, scripts de test, `next build` | OK |
| Recette isolée, Chromium 375 px, FR puis EN | OK (ci-dessous) |

**Couverture de l'e2e des lots** : désactivé par défaut (403, contexte
sans la fonctionnalité) ; garde absente (503) ; reprise 28 → 8 + 20 (total
et `initialQuantity` inchangés, date historique conservée) ; lot
historique ; répartition incorrecte (400) ou devenue obsolète (409) ;
quantités et dates invalides ; réception nouvelle et dans un lot existant
(identité jamais remplacée) ; rejeu de la même réception ; réceptions et
rejeux concurrents ; historique des modifications ; ventes (en ligne et
outbox), corrections, annulations, ajout de stock et date refusés ; garde
MongoDB contre une écriture ignorant les lots ; produits ordinaires
inchangés ; matrice des droits ; quantités masquées sans
`products.view_stock_details` ; isolation entre commerces ;
invitations/membres et catalogues 3/4 ; outils de retour arrière.

**Recette navigateur** (propriétaire, 375 px, FR et EN) : section visible ;
ventilation 8 + 20 avec reste proposé ; confirmation exigée ; stock 28 et
initial 28 après reprise ; bouton de vente remplacé ; quantité 0 refusée
avec message clair ; nouveau lot (12) puis réception de 5 dans L-001 sans
champ de date ; lots 13/20/12, total 45, date de L-001 inchangée ;
modification du numéro fabricant ; vente API refusée (409) ; aucun
débordement horizontal ; aucune erreur JavaScript. Correction apportée
pendant la recette : séparateur « libellé : valeur » traduit (« : » avec
espace insécable en FR, « : » en EN).

## 10. Ordre de déploiement et retour arrière

**Déploiement (le jour où le lot sera livré, drapeau désactivé)**

1. API puis web, drapeau absent. Rien ne change pour les clients.
2. Aucune migration automatique : `migrate:product-batches` n'est pas dans
   le pré-déploiement.
3. **Ne pas activer en production avant le lot B.** Pour une recette :
   `migrate:product-batches -- --install --apply` (validateur + index),
   puis `PRODUCT_BATCHES_ENABLED=true` avec une portée explicite
   (`PRODUCT_BATCHES_ORGANIZATIONS`, voir
   [product-batches-expiry-losses.md § 6](product-batches-expiry-losses.md)).

**Retour arrière**

- Drapeau désactivé et aucun produit suivi : simple redéploiement de
  l'API antérieure.
- Si la permission a été accordée : `migrate:product-batches --
  --strip-permission --apply` **avant** de redéployer une API antérieure
  (elle refuserait cette permission inconnue).
- **Des produits sont suivis par lots** : le validateur doit rester en
  place. Une ancienne API qui tenterait de vendre, corriger, annuler ou
  réapprovisionner un de ces produits est refusée par MongoDB (erreur 500
  côté client, aucune incohérence écrite ; liste exacte au § 3). Elle peut
  en revanche modifier la date de la fiche, que la nouvelle API ignore pour
  un produit suivi. `--remove-validator` refuse de le retirer tant qu'un
  produit est suivi. Il n'existe aucune procédure de « dé-suivi » : un
  retour arrière avec des produits suivis suppose d'accepter que ces
  produits restent non vendables jusqu'au redéploiement d'une API qui les
  connaît.
- Inventaire en lecture seule : `migrate:product-batches` sans option.

> **Après livraison du lot C** : la procédure à suivre est celle de
> [product-batches-expiry-losses.md § 8](product-batches-expiry-losses.md).
> Dès qu'une perte est enregistrée, revenir à une API antérieure au lot C
> n'est pas sûr : sa purge écrirait un `PurgedStockAdjustment` faux. Pour
> revenir au lot B sans perte, utiliser `--strip-lot-c-permissions`, pas
> `--strip-permission`, qui retire aussi `stock.manage_batches`.

## 11. Limites du lot A

> **Mise à jour (lot B, même branche).** Les deux premières limites
> ci-dessous sont levées par le lot B : ventes, corrections et annulations
> par lots, et procédure explicite de restitution pour les ventes
> antérieures à l'activation. Les refus correspondants ont désormais des
> codes précis : `SALE_BATCH_ALLOCATION_REQUIRED`,
> `SALE_BATCH_CORRECTION_REQUIRED`, `SALE_BATCH_RESTITUTION_REQUIRED`.
> Voir [product-batches-sales.md](product-batches-sales.md). Restent
> refusés (409 `PRODUCT_BATCH_TRACKED`) : l'ajout de stock hors réception
> et la date de la fiche. La fonctionnalité reste désactivée par défaut.

- ~~Aucune vente, correction ou annulation sur un produit suivi par
  lots.~~ (lot B)
- ~~Une vente antérieure à l'activation ne peut plus être corrigée ni
  annulée.~~ Lot B : prix modifiable ; restitution de quantité avec
  destinations explicites, motif et `stock.adjust`, sans inventer le lot
  d'origine.
- Un seul prix d'achat par fiche (voir § 3).
- La purge d'un produit suivi conserve ses lots et leur journal (aucune
  suppression de traçabilité) ; ils ne sont plus affichés.
- Pas d'alerte de péremption ; `quarantined` et `withdrawn` sont réservés.

## 12. Travail restant

**Lot B — ventes par lots, corrections et hors ligne**

- Choix du lot à la vente, décrément du lot et de la fiche dans la même
  transaction.
- **Sélection automatique** (par défaut : péremption la plus proche) : lots
  `available` uniquement, et **exclusion des lots périmés dès B**
  (`expiryState === 'expired'` selon le jour du commerce de
  `business-date.ts`), sans attendre les alertes du lot C. La vente d'un lot
  périmé, si elle est un jour permise, doit être un choix explicite,
  distinct de la sélection automatique.
- **Lots réellement vendus conservés sur la vente** : lot(s) et quantité
  par lot enregistrés sur le document de vente au moment de l'écriture
  (une vente peut en couvrir plusieurs), jamais recalculés après coup.
  Ils servent de base à la correction, à l'annulation et à l'historique.
- Correction et annulation : restitution exacte aux lots enregistrés sur
  la vente.
- **Ventes antérieures à l'activation** : leur lot d'origine est inconnu et
  ne doit jamais être inventé (ni déduit d'une date, ni affecté au lot
  historique par défaut). Leur correction ou annulation exige une procédure
  explicite : choix du lot de restitution par un utilisateur autorisé, ou
  mouvement d'ajustement journalisé comme tel, avec un audit qui distingue
  ce cas.
- Outbox hors ligne : instantané des lots ou affectation serveur, conflits
  de lot épuisé. **Aucune réaffectation silencieuse** : si le lot choisi ou
  attendu hors ligne n'est plus disponible à la synchronisation (épuisé,
  périmé, mis à l'écart), la vente est refusée en conflit visible, jamais
  imputée sans le dire à un autre lot.
- Retrait du refus 409 `PRODUCT_BATCH_TRACKED` opération par opération.
- Éventuel coût d'achat par réception et impact sur la marge.
- Activation en production seulement après B, avec la garde installée.

> **Mise à jour (lot C, même branche)** : alertes de péremption, mise à
> l'écart, pertes et contre-mouvements, audit des calculs
> `initialQuantity − remainingQuantity` : voir
> [product-batches-expiry-losses.md](product-batches-expiry-losses.md).
> Les statuts `quarantined` et `withdrawn` sont désormais écrits ; la garde
> (`--install`) crée aussi les index des pertes.

**Lot C — péremption, mise à l'écart et pertes** (réalisé, voir ci-dessus)

- Alertes de péremption (jour du commerce, délai configurable),
  notifications et Analyse.
- Mise à l'écart (`quarantined` : compté dans le stock, non vendable) et
  retrait (`withdrawn`).
- Pertes journalisées (péremption, casse) : décrément du lot et de la fiche,
  sans toucher `initialQuantity`, avec un mouvement distinct des ventes.
- **Audit préalable des calculs `initialQuantity − remainingQuantity`.**
  Une perte réduit `remainingQuantity` sans vente : tout calcul qui déduit
  des ventes de cette différence la compterait comme vendue. Une perte ne
  doit **jamais** devenir une vente, du chiffre d'affaires ou du bénéfice
  dans l'Analyse, les exports mensuels ou les fiches produit. Points
  repérés à auditer (liste de départ, à compléter) :
  - `products/product-projection.ts` (`toProductMetricsView`) :
    `unitsSold` et bénéfice de la fiche (`prix d'achat × unitsSold`) ;
  - `analytics/analytics.service.ts` (vue d'ensemble) : unités et coût
    dérivés de la différence ;
  - `products/products.service.ts` (`preserveStockContribution`) : coût
    figé à la purge ;
  - `push/stock-thresholds.ts` : règle par défaut du stock faible (une
    perte peut légitimement y compter comme consommation : à décider
    explicitement) ;
  - exports mensuels (`reports/monthly-history.service.ts`) et tout autre
    calcul qui utiliserait ces champs.

  Chaque calcul doit soit soustraire les pertes journalisées, soit
  s'appuyer sur les ventes enregistrées. Un test doit montrer qu'une perte
  ne change ni les ventes, ni le chiffre d'affaires, ni le bénéfice.
