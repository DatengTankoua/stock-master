# Lots de produits — lot C : alertes de péremption, mise à l'écart et pertes

Suite des lots A ([product-batches-foundation.md](product-batches-foundation.md))
et B ([product-batches-sales.md](product-batches-sales.md)), sur la même
branche `feature/product-batches-foundation` (base `origin/dev` `3b22269`),
en modifications non commitées. Aucun commit, déploiement, activation ni
donnée de production touchée.

**Deux activations distinctes, désactivées par défaut** :

| Drapeau | Couvre |
|---|---|
| `PRODUCT_BATCHES_ENABLED` (lots A et B) | mise à l'écart et pertes (opérations sur les lots), notification de régularisation |
| `EXPIRY_ALERTS_ENABLED` (nouveau) | balayage des alertes de péremption (lots ET produits sans lots), réglage du délai |

Pour chaque drapeau, une valeur autre que `true` ou `false` le désactive
et est signalée au démarrage. **Un drapeau `true` n'active rien sans
portée explicite** (`*_ORGANIZATIONS`) : liste de commerces pilotes, ou
`all` pour une activation générale (§ 6). Vérifications faites uniquement dans la
recette isolée (`recipe.js start --product-batches --expiry-alerts`). Rien
n'est annoncé aux clients.

## 1. Règles métier

### Alertes de péremption

**Règle de date** : jour du commerce des lots A et B (fuseau de l'API,
`Africa/Douala` en production), jamais celui du téléphone. Une date E est
valide le jour E, dépassée à partir de E+1.

**Délai d'anticipation** :

- par commerce (`Organization.expiryAlertLeadDays`) ;
- entier de 0 à 365, 30 par défaut ;
- 0 = alerte le jour même de l'échéance, ce n'est **pas** une
  désactivation.

**Cibles** (stock physique positif, produit actif) :

- chaque lot daté d'un produit suivi par lots, **quel que soit son
  statut** : un lot mis à l'écart reste concerné et son état est indiqué
  dans le détail ;
- la date facultative d'un produit **sans lots** (`expiryDate`). Aucun lot
  n'est créé.

**Deux étapes par cible et par échéance** :

- `expiry-soon` : entrée dans la période (jour ≥ E − délai) ;
- `expiry-expired` : date dépassée.

Ce qui ne déclenche rien :

- aucune répétition quotidienne ;
- aucune alerte pour une cible sans date, sans stock, ou dont le produit
  est à la corbeille ou purgé ;
- une cible **découverte déjà dépassée** ne reçoit que `expiry-expired`.

**Passage au suivi par lots** : la reprise retire la planification de la
fiche (`expiryAlertNextOn` effacé, comme `expiryDate`) ; ses lots ont
leurs propres étapes. Il n'y a pas de double envoi produit + lots. Une
alerte « fiche » déjà en attente au moment de la reprise est annulée
avant l'envoi (`batch-tracked`).

**Produits sans lots** : leur date reste **informative**. La vente n'est
pas bloquée (règle inchangée), alors qu'un lot dépassé est refusé à la
vente depuis le lot B. Seules les alertes s'appliquent à eux.

### Mise à l'écart (lot entier)

- `POST /products/:id/batches/:batchId/quarantine`, motif obligatoire :
  `available` → `quarantined`.
- `POST …/release`, motif obligatoire : `quarantined` ou `withdrawn` →
  `available`.
- Elle porte sur le **lot entier** ; la mise à l'écart partielle n'existe
  pas, l'interface le dit.
- Aucun mouvement de quantité : le stock physique est inchangé. Le lot
  sort de la quantité vendable et des options de vente (vente refusée,
  `BATCH_UNAVAILABLE`), et une réception y est refusée (409).
- Une date dépassée interdit toujours la vente, même après remise à
  disposition.
- Journal `batch_status_changed` : auteur, date serveur, motif, état
  avant / après, stock du lot au moment du changement.
  `batch.statusChange` garde le dernier changement.
- Écriture conditionnée au statut lu : deux demandes concurrentes ne
  s'appliquent qu'une fois (`BATCH_STATUS_UNCHANGED`).

### Pertes et retraits

`POST /products/:id/batches/:batchId/losses` :

- `quantity` entière, au moins 1 et au plus le stock physique du lot ;
- `reason` : `expired` | `damaged` | `other`, commentaire obligatoire
  pour `other` ;
- `clientOperationId` : idempotence (même mécanisme que les réceptions).

Une perte, **dans une transaction** :

- diminue le lot, `remainingQuantity` et `batchTracking.totalQuantity`
  (validateur du lot A respecté) ;
- augmente `lossTracking` de la fiche : unités, et valeur au prix d'achat
  **du moment** ;
- écrit un mouvement `stock_losses` (auteur, heure serveur, coût unitaire
  du moment, statut avant / après) et le journal `batch_loss_recorded` ;
- ne change jamais `initialQuantity` et ne crée ni vente ni chiffre
  d'affaires ;
- est sûre face aux ventes concurrentes (écritures conditionnelles : l'une
  des deux échoue proprement, jamais de quantité négative).

**Statut `withdrawn`** : lot fermé à la vente et aux réceptions
ordinaires.

- **Règle** : une perte de **tout le stock restant** du lot le ferme
  (`withdrawn`, motif `loss`).
- Une perte partielle ne change pas le statut.
- Un lot vidé par des ventes reste `available` (il peut encore recevoir).
- Une remise à disposition explicite le rouvre.

**Restitution vers un lot non vendable** (annulation ou correction d'une
vente antérieure, correction d'une perte) : les unités reviennent
**physiquement** au lot d'origine, **sans changer son statut** (mis à
l'écart, retiré ou dépassé : toujours non vendable). L'historique n'est
jamais bloqué. Le journal de la vente porte
`batches.nonSellable: [{ reference, status, expired }]`.

**Correction d'une perte** (`POST /products/:id/losses/:lossId/corrections`,
commentaire obligatoire, idempotente) :

- c'est un contre-mouvement `correction` **lié** à la perte d'origine,
  conservée telle quelle ;
- `correctedQuantity` de la perte est augmenté conditionnellement, jamais
  au-delà de la quantité perdue : **aucune double restitution, même
  concurrente** ;
- unités rendues au même lot, statut inchangé (aucune remise en vente
  implicite) ;
- `lossTracking` est diminué au coût **de la perte d'origine** ;
  `initialQuantity` est inchangée.

Retours fournisseur et client : hors périmètre.

## 2. Calculs, historique et valorisation

Audit des calculs fondés sur `initialQuantity − remainingQuantity` :

| Usage | Avant | Lot C |
|---|---|---|
| `product-projection.ts` : unités vendues, bénéfice de la fiche | initial − restant | initial − restant − **pertes nettes** ; bénéfice = CA − prix d'achat × unités vendues (**marge sur ventes**, pertes exclues) |
| `analytics.service.ts` (vue d'ensemble, toutes périodes) : coût des ventes | prix × (initial − restant) | prix × (initial − restant − pertes nettes) |
| `analytics` (mois) : gain du mois | ventes du mois × prix | inchangé (fondé sur les ventes) |
| `preserveStockContribution` (purge) : écart figé | initial − restant − vendus | − pertes nettes (une perte n'est jamais figée comme coût de vente) |
| `stock-thresholds.ts` (seuil par défaut) | consommé = initial − restant | **inchangé** : base = stock physique. Une perte peut franchir le seuil et déclencher l'alerte (clé `loss:<id>`), sans être une vente |
| Exports mensuels | ventes | inchangés |

**Séparation des quantités** (`GET /products/:id/batches`, détail du
stock), partition du stock physique **sans double comptage** :

| Catégorie | Contenu |
|---|---|
| `sellableQuantity` | lots disponibles, date non dépassée |
| `expiredQuantity` | lots disponibles dépassés |
| `quarantinedQuantity` | lots mis à l'écart, **toute date** (un lot dépassé ET mis à l'écart n'est compté qu'ici) |
| `withdrawnQuantity` | unités revenues dans un lot retiré |

`lostQuantity` = pertes nettes de leurs corrections.

**Fiche produit** : `unitsSold` (hors pertes), `lostQuantity` et
`lossValueAtCost` (détail du stock ; valeur avec le droit financier).
Quand des pertes existent, le libellé devient « Bénéfice sur ventes (hors
pertes) ». Il n'y a aucun bénéfice net comptable.

**Analyse** (`GET /analytics/stock-health`, `analytics.read`) :

- « Expire bientôt » et « Périmés » : mêmes règles que les alertes, liens
  vers les produits, lot et état ; quantités avec le détail du stock ;
- pertes du mois, nettes des corrections (chacune comptée le mois de son
  mouvement) ; valeur avec le droit financier ;
- note : « les pertes ne sont ni des ventes ni du chiffre d'affaires ; le
  bénéfice estimé est une marge sur ventes et ne les déduit pas ».

**Valorisation** : chaque mouvement garde `unitCostAtMovement` (prix
d'achat de la fiche au moment de la perte ; la correction reprend celui de
la perte). Rien n'est recalculé avec un prix ultérieur, ce que vérifie un
test qui change le prix après la perte. Le libellé est « valeur estimée au
coût d'achat de chaque mouvement ». Pas de marge par lot ni de coût par
réception.

## 3. Permissions

Trois permissions ajoutées. Le propriétaire et l'administrateur les ont
toutes ; le vendeur n'en a aucune sans délégation explicite.

| Opération | Droit |
|---|---|
| Mettre à l'écart / remettre à disposition | `stock.quarantine_batches` |
| Enregistrer / corriger une perte | `stock.record_losses` |
| Régler le délai des alertes | `products.manage_expiry_alerts` (alertes activées, sinon 403) |
| Historique des pertes | `products.view_stock_details` (+ `products.view_financials` pour les valeurs) |
| Recevoir les alertes de péremption | `products.view_stock_details` + préférences `expirySoon` / `expiryExpired` |
| Recevoir « régularisation à examiner » | `stock.adjust` + `sales.view_all` (ceux qui peuvent la traiter) + préférence `regularizationRequested` |

- Le droit de modifier une date (`products.manage_expiry`) ne donne pas
  celui de retirer du stock : testé.
- Organisation du contexte uniquement : un produit ou un lot d'un autre
  commerce donne 404.
- **Catalogues de permissions**, un par combinaison affichée (activations
  indépendantes) :

| Catalogue | Contenu |
|---|---|
| 3 | base |
| 4 | + suivi par lots (web des lots A/B) |
| 5 | 3 + délai des alertes |
| 6 | 3 + lots (suivi, mise à l'écart, pertes) |
| 7 | tout |

  Une permission non affichée par le formulaire est conservée (testé avec
  5 et 7).
- Invitations, acceptation et édition des membres reprennent la liste
  délégable. L'anti-escalade existante s'applique. Une case n'est proposée
  que si l'API annonce la fonctionnalité (`features.productBatches`,
  `features.expiryAlerts`).
- Notifications : les nouvelles catégories ne sont **proposées** (préférences,
  configuration push) que si leur fonctionnalité est activée. Leur contenu
  est générique : ni produit, ni lot, ni quantité. Le détail se relit avec
  les droits actuels.

## 4. Planification et déduplication

- **Planificateur** : le traitement de fond existant des notifications
  (`PushDispatcherService`, processus HTTP), sans dépendance ni service
  externe. Un balayage `scanExpiryAlerts` au plus toutes les 15 min par
  processus, si `EXPIRY_ALERTS_ENABLED=true`, limité à la portée de
  `EXPIRY_ALERTS_ORGANIZATIONS` (§ 6). Les deux index partiels sont
  vérifiés avant chaque balayage (§ 7, étape 6).
- **Requête ciblée** : index **partiels** sur `products` et
  `productbatches` (cibles en stock planifiées seulement), imposés à la
  requête (`hint`) :
  - `expiry_alert_due` `{ expiryAlertNextOn, _id }` : portée `all` ;
  - `expiry_alert_due_org` `{ organizationId, expiryAlertNextOn, _id }` :
    un balayage par commerce pilote, filtré dans la requête.

  Requête `expiryAlertNextOn ≤ aujourd'hui`. Pages de 200, au plus 25
  pages par type de cible (et, en mode pilote, par commerce) et par
  balayage. Pas de scan intégral : une cible n'est relue que le jour où
  une étape devient due. Une cible vide sort de l'index (filtre partiel
  `remainingQuantity > 0`) et y revient à son réapprovisionnement.
- **Déduplication persistante** :
  - clé d'événement `expiry-<étape>:<batch|product>:<id>:<échéance>`
    (index unique des travaux, conservés sans TTL) : jamais deux alertes,
    entre instances, après un redémarrage, ni lors de balayages
    concurrents (testé) ;
  - marques `expiryAlerts.{soonFor, expiredFor}` (échéances annoncées) et
    `expiryAlertNextOn` (prochain contrôle), mises à jour sous condition
    de l'échéance lue.
- **Changement de date** : la nouvelle échéance a ses propres étapes ;
  revenir à une échéance déjà annoncée ne réémet rien ; une modification
  sans changement de date n'affecte rien (testé).
- **Changement de délai** : seules les cibles pas encore annoncées
  « bientôt » sont replanifiées. Allongé : de nouvelles cibles entrent ;
  réduit : rien n'est retiré ni réarmé.
- **Réapprovisionnement** d'un lot vide : annoncé au balayage suivant s'il
  ne l'avait pas été. Une étape déjà annoncée ne l'est pas deux fois.
- **Indisponibilité du planificateur** : au redémarrage, les étapes dues
  sont relues. Une cible dépassée entre-temps reçoit seulement « périmé »
  (testé).
- **Revalidation avant chaque annonce** (centre et push) :
  - produit actif ;
  - même mode (lots ou non) ;
  - lot existant ;
  - stock positif (« vente ou retrait intervenu avant l'envoi » →
    annulée, `no-stock`) ;
  - même échéance ;
  - « bientôt » devenu dépassé → annulée au profit de « périmé » ;
  - puis droits et préférences par membre et par appareil (règle
    `canAccessCategory` existante).
- **Notification de régularisation** (lot B) : clé
  `regularization-requested:<demande>` écrite dans la transaction de la
  demande (aucun doublon). Elle est annulée si la demande est décidée
  avant l'annonce, et pointe vers `/app/sales`. Pas d'exposition entre
  commerces (testé).

## 5. Index et migrations

| Commande | Effet |
|---|---|
| `migrate:product-batches -- --install --apply` (étendue) | ajoute les index de `stock_losses` (par produit, par période) au validateur et aux index des lots A et B. Idempotente. Une garde antérieure est signalée incomplète (activation des lots refusée) jusqu'à cette exécution |
| `migrate:expiry-alerts` (nouvelle) | inventaire en lecture seule |
| `migrate:expiry-alerts -- --apply` | index partiels `expiry_alert_due` et `expiry_alert_due_org` (même filtre partiel) et première date de contrôle des cibles datées jamais planifiées (produits sans lots, lots), au délai du commerce. Idempotente ; ne modifie que `expiryAlertNextOn` |
| `migrate:product-batches` (sans option, étendue) | inventaire en lecture seule ; compte aussi les pertes enregistrées (`losses`), condition d'un retour arrière (§ 8) |
| `migrate:expiry-alerts -- --organizations=<id,id>` (sans `--apply`) | inventaire en lecture seule, plus les **premières alertes prévisibles** : agrégat de tous les commerces (`organizations`, `soon`, `expired`, `maxPerOrganization`) et détail de chaque commerce pilote, désigné par sa position dans la liste (`pilots: [{ pilot: 1, soon, expired }]`). Aucun identifiant journalisé. Lecture complète des produits et lots datés, en une seule fois |
| `migrate:product-batches -- --strip-lot-c-permissions --apply` (nouvelle) | retire **seulement** les trois permissions du lot C ; conserve `stock.manage_batches`. À utiliser avant un retour vers une API du lot B (§ 8) |
| `migrate:product-batches -- --strip-permission --apply` (étendue) | retire **toutes** les permissions des lots A à C, dont `stock.manage_batches`. Réservée au retour vers une API **antérieure aux lots** ; ne pas l'utiliser pour revenir au lot B |

## 6. Portée d'activation : globale ou commerces pilotes

**Constat** : avant cette livraison, aucune activation par commerce
n'existait. `PRODUCT_BATCHES_ENABLED` et `EXPIRY_ALERTS_ENABLED` activent
**globalement** les fonctionnalités, pour **tous** les commerces. Elles le
font toujours si aucune liste n'est définie.

**Ajout minimal** : une portée **explicite** par fonctionnalité, lue à
chaque appel. Refus par défaut. Ce n'est pas un système général de
drapeaux.

Avec le drapeau à `true` :

| `PRODUCT_BATCHES_ORGANIZATIONS` / `EXPIRY_ALERTS_ORGANIZATIONS` | Commerces concernés |
|---|---|
| absente ou vide | **aucun** |
| invalide (identifiant mal formé, `all` mêlé à une liste…) | **aucun** |
| liste d'identifiants d'organisation (`id,id`) | ces commerces seulement (pilote) |
| `all` (valeur exacte, casse indifférente) | **tous** (activation générale) |

Avec le drapeau absent ou à `false` : aucun commerce, quelle que soit la
portée.

- Une seule règle (`productBatchesEnabledFor` / `expiryAlertsEnabledFor` =
  drapeau `true` **et** commerce dans la liste), utilisée par :
  - l'API : routes des lots, ventes par lots, demandes de régularisation,
    pertes, mise à l'écart, réglage du délai, Analyse ;
  - le contexte des fonctionnalités (`/auth/context` → `features`, lu par
    le web) ;
  - les catégories de notifications proposées ;
  - le planificateur : balayage filtré sur la liste ; un travail en attente
    d'un commerce sorti de la liste est annulé (`disabled`).
- Les commerces non listés restent exactement dans l'état actuel (testé :
  contexte, routes 403, vente par lots 409 `PRODUCT_BATCHES_DISABLED`,
  réglage 403, aucune alerte). Testé aussi : portée absente, vide, blanche,
  invalide et `all` mêlé à une liste = aucun commerce ; `all` = tous.
- Au démarrage, l'API journalise la portée : « TOUS les commerces
  (activation globale) », « N commerce(s) pilote(s) », « AUCUN commerce
  (liste de commerces absente…) » ou « AUCUN commerce (liste invalide) ».
- Le web n'a pas de règle propre : il suit `features` du contexte, calculé
  par l'API avec la même règle.
- Un oubli de la liste n'active donc plus personne. L'activation générale
  exige d'écrire `all`.

**Balayage des pilotes** : la requête porte le filtre `organizationId`
(égalité, un commerce à la fois) sur l'index `expiry_alert_due_org`. Les
cibles échues des autres commerces ne sont **ni lues ni comptées** dans
les pages d'un pilote. Elles ne peuvent pas épuiser la limite du balayage
(25 pages de 200) au détriment d'une cible pilote. Testé avec 5 200 cibles
échues hors pilote, placées avant la cible pilote dans l'ordre du
balayage :
- la cible pilote est annoncée (un travail `expiry-soon`, une
  notification interne) ;
- les 5 200 cibles hors pilote ne sont **pas** annoncées, même après le
  traitement des travaux :
  - aucun travail `expiry-soon` / `expiry-expired` ;
  - aucune marque d'alerte posée ;
  - aucune notification pour ce commerce ;
- moins de 200 clés et documents lus au total.

Contre-épreuve : avec l'index sans commerce, 10 408 lectures, et le test
échoue.

## 7. Procédure de livraison

Aucune de ces étapes n'a été exécutée en production. Commandes après
`pnpm --filter api build`, avec `MONGODB_URI` de l'environnement visé.

**Ordre exact**

1. **Sauvegarde** de la base, vérifiée restaurable. C'est un point de
   reprise en cas d'incident grave, **pas** un moyen de retour arrière
   ordinaire (§ 8).
2. **Déployer l'API** (lots A + B + C), drapeaux et listes **absents**.
   Contrôle : aucun avertissement d'activation au démarrage, `/health` OK,
   contexte `features: { productBatches: false, expiryAlerts: false }`.
3. **Déployer le web.** Aucun changement visible : pas de bouton de lot, pas
   de nouvelle catégorie de notification.
4. **Inventaires en lecture seule** (aucune écriture) :
   ```
   pnpm --filter api migrate:product-batches
   pnpm --filter api migrate:expiry-alerts -- --organizations=<id_pilote_1>,<id_pilote_2>
   ```
   Noter :
   - `guard` (attendu avant migration : incomplète ou absente),
     `trackedProducts`, `losses` (attendu : 0) ;
   - `unplanned` par collection ;
   - **premières alertes** :
     - par pilote : `pilots[i].soon` / `pilots[i].expired` = nombre de
       cibles qui recevront une alerte au premier balayage ;
     - pour l'ensemble : `soon + expired` et `maxPerOrganization` =
       volume et pire cas d'une future activation générale (`all`). Ces
       cibles ne sont pas lues par le balayage des pilotes (§ 6).

   Ces nombres ne peuvent être connus qu'au moment de l'inventaire sur les
   vraies données. Ils sont à reporter dans le compte rendu du pilote. En
   e2e, l'inventaire concorde avec les étapes attendues (testé).
5. **Migrations** (idempotentes) :
   ```
   pnpm --filter api migrate:product-batches -- --install --apply
   pnpm --filter api migrate:expiry-alerts -- --apply
   ```
   La seconde écrit seulement `expiryAlertNextOn` sur **toutes** les cibles
   datées, pilotes ou non. C'est inerte tant que le commerce est hors de la
   liste.
6. **Contrôles après migration** : relancer les deux inventaires de
   l'étape 4. Attendu :
   - `guard: "installée"` ;
   - `index: true` sur `products` et `productbatches` (les deux index
     `expiry_alert_due` et `expiry_alert_due_org`) ;
   - `unplanned: 0` ;
   - premières alertes des pilotes inchangées (sauf passage de jour).

   Si l'index manque, le planificateur ne balaie pas. Il journalise à
   chaque tentative « Alertes de péremption : balayage non exécuté (...).
   Exécuter migrate:expiry-alerts -- --apply. » et ne fait **aucun**
   parcours de secours (testé).
7. **Activation des pilotes**, en une seule modification de configuration :
   ```
   PRODUCT_BATCHES_ORGANIZATIONS=<id_pilote_1>,<id_pilote_2>
   EXPIRY_ALERTS_ORGANIZATIONS=<id_pilote_1>,<id_pilote_2>
   PRODUCT_BATCHES_ENABLED=true
   EXPIRY_ALERTS_ENABLED=true
   ```
   - Vérifier le journal de démarrage : « 2 commerce(s) pilote(s) » pour les
     deux fonctionnalités. « TOUS les commerces » ou « AUCUN commerce » :
     revenir immédiatement aux drapeaux `false`.
   - Plus tard, activation générale : `*_ORGANIZATIONS=all`, valeur écrite
     explicitement, après un nouvel inventaire.
   - Prévenir chaque pilote du nombre d'alertes noté à l'étape 4.
   - Activer **pendant les heures d'usage**, avec quelqu'un disponible pour
     suivre le premier balayage. L'activation nocturne ne réduit pas le
     volume : elle reporte seulement la lecture des alertes.
   - Le volume se maîtrise par le choix des pilotes (nombre de premières
     alertes connu) et, au besoin, par l'activation des alertes séparée et
     postérieure à celle des lots.
8. **Permissions** : le propriétaire et les responsables accordent les
   permissions des lots aux membres des pilotes, depuis l'application.
   Aucune attribution en masse.
9. **Contrôle push réel**, le seul qui reste (§ 9). Sur un **appareil de
   test autorisé**, abonné aux notifications d'un compte du commerce pilote :
   - clés VAPID de l'environnement présentes ;
   - abonnement aux catégories « Péremption proche » / « Produits
     périmés » ;
   - un lot daté dans le délai ;
   - attendre le balayage suivant ;
   - vérifier la réception, le texte générique (aucun prix ni quantité)
     et l'ouverture du détail.

   Sans clés VAPID ni abonnement, le centre de notifications reçoit
   **quand même** l'alerte (testé : centre seul, aucun abonnement, travail
   `push-disabled`, aucun envoi).

**Conditions d'arrêt du pilote** (repasser le drapeau concerné à `false`,
voir § 8) :

- journal de démarrage différent de la liste attendue ;
- erreur « balayage non exécuté » répétée après migration ;
- un travail ou une notification de péremption pour un commerce **non
  pilote** (lecture seule) :
  ```
  db.push_jobs.countDocuments({ category: { $in: ['expiry-soon', 'expiry-expired', 'regularization-requested'] }, organizationId: { $nin: [ObjectId('<id_pilote_1>'), ObjectId('<id_pilote_2>')] } })
  ```
  Attendu : 0 ;
- premières alertes d'un pilote nettement au-dessus de l'inventaire de
  l'étape 4 (hors nouvelles dates saisies), ou deux alertes de la même
  étape pour un même lot et une même échéance ;
- une erreur 500 ou 503 sur une vente, une réception, une perte ou une
  correction (garde du validateur, `PRODUCT_BATCH_GUARD_*`) ;
- un stock incohérent signalé par le pilote :
  - unités vendues négatives ;
  - perte comptée comme vente ;
  - total des lots différent du stock du produit ;
- balayage lent : requêtes `productbatches` / `products` sur
  `expiry_alert_due_org` signalées par le profilage MongoDB.

## 8. Désactivation et retour arrière

**Désactiver sans changer de version** (à privilégier) : on garde la même
API, qui connaît les pertes, la mise à l'écart et les alertes.

| Action | Effet | Limite |
|---|---|---|
| Retirer un commerce d'`EXPIRY_ALERTS_ORGANIZATIONS` ou `EXPIRY_ALERTS_ENABLED=false` | plus de balayage pour lui. Ses travaux en attente sont annulés (`disabled`) à leur traitement : aucune étape manuelle sur `push_jobs`. Réglage du délai refusé | les marques d'alerte restent : une réactivation n'annonce pas deux fois la même échéance |
| Retirer un commerce de `PRODUCT_BATCHES_ORGANIZATIONS` ou `PRODUCT_BATCHES_ENABLED=false` | routes des lots refusées (403), ventes par lots refusées (409) | **si le commerce a déjà des produits suivis par lots**, leurs ventes, réceptions et corrections sont refusées jusqu'à la réactivation (lot A : aucun « dé-suivi »). Pour un pilote déjà engagé, préférer désactiver les seules alertes et corriger en avançant |

Une portée absente, vide ou invalide désactive tout (aucun commerce),
sans retour de version.

**Revenir à une version antérieure de l'API** : ce n'est **pas** sûr dès
qu'une perte existe.

- Une API antérieure au lot C (lot B ou avant) ignore `lossTracking`. À la
  **purge** d'un produit (suppression définitive depuis la corbeille,
  permission `trash.manage`), son `preserveStockContribution` calcule
  `initial − restant − ventes` sans retirer les pertes. Elle **écrit** alors
  un `PurgedStockAdjustment` faux : les pertes deviennent un coût des
  ventes définitif dans la vue d'ensemble. Ce n'est pas un simple
  affichage : l'écriture reste après le redéploiement d'une API correcte.
- Désactiver les fonctionnalités ne corrige pas les calculs de l'ancienne
  API : la purge ne dépend d'aucun drapeau.
- Avant la purge déjà, une API antérieure affiche aussi les pertes comme
  des ventes (unités vendues, coût des ventes).

Condition, lue par `migrate:product-batches` (lecture seule) :

| `losses` | Retour vers l'API du lot B | Retour vers une API antérieure aux lots |
|---|---|---|
| 0 (aucune perte jamais enregistrée) | possible : 1) `EXPIRY_ALERTS_ENABLED=false` ; 2) clôturer les travaux en attente des nouvelles catégories, inconnues du lot B : `db.push_jobs.updateMany({ category: { $in: ['expiry-soon', 'expiry-expired', 'regularization-requested'] }, status: 'pending' }, { $set: { status: 'cancelled', outcome: 'rollback' } })` ; 3) `migrate:product-batches -- --strip-lot-c-permissions --apply` (conserve `stock.manage_batches`) | précautions des lots A et B, puis `--strip-permission --apply` |
| > 0 | **non sûr**. Seulement avec une **version de repli préparée**, construite, testée et relue avant le retour : API du lot B qui conserve au moins le calcul de purge du lot C (pertes nettes retirées) et la vue d'ensemble qui les exclut. Cette version **n'existe pas** aujourd'hui | non sûr, pour la même raison |

**Après des pertes, la solution normale reste une API compatible avec le
lot C** (la version actuelle ou une version ultérieure), même avec
certaines fonctionnalités désactivées (tableau « Désactiver sans changer
de version » ci-dessus). Un défaut se corrige par une nouvelle version
compatible, pas par un retour arrière.

**Restaurer la sauvegarde n'est pas un retour arrière ordinaire.** La
restauration remet toute la base à l'instant de la sauvegarde. Elle
**supprime** tout ce qui a été écrit depuis, dans tous les commerces,
pilotes ou non :
- ventes et corrections ;
- encaissements et paiements d'abonnement ;
- réceptions, pertes, produits ;
- membres, invitations, notifications, etc.

Elle relève d'une **procédure distincte de récupération et de
rapprochement**, hors de ce document :
- décision explicite ;
- inventaire des écritures perdues, depuis les journaux et les exports ;
- information des commerces concernés ;
- ressaisie ou réimport contrôlé ;
- rapprochement des stocks et des paiements.

Elle est réservée à un incident grave (corruption), jamais utilisée pour
« annuler » une livraison.

Lots `quarantined` et `withdrawn` sous une API du lot B : refusés à la
vente et aux réceptions (le lot B n'accepte que `available`). Le
validateur protège toujours les totaux.

Web antérieur :

- aucun bouton du lot C ;
- statuts `quarantined` / `withdrawn` non libellés : le lot disparaît
  simplement des options de vente ;
- préférences inconnues ignorées.

Pertes, demandes de régularisation et marques d'alerte : conservées en
base, jamais supprimées. Elles n'ont pas d'effet sur une API antérieure,
hors la purge décrite ci-dessus.

## 9. Contrôles effectués

| Contrôle | Résultat |
|---|---|
| API : `nest build`, ESLint (0 erreur) | OK |
| Jest unitaire complet (dont 10 tests des règles pures et des catalogues) | 106 suites, 1933 tests OK |
| e2e `product-batches-expiry-losses` (lot C) | 24 tests OK (dont 5 de livraison, ci-dessous) |
| e2e lot C + centre de notifications, activité des membres, lots A et B, transaction des ventes, gestion des membres, invitations (relancés après les derniers changements) | 8 suites, 158 tests OK |
| e2e notifications push (catégories proposées selon les activations, préférences) | 13 tests OK |
| e2e débit du dispatcher, date et seuil, contexte (après l'ajout des catégories) | OK |
| Web : `tsc`, ESLint, `test:i18n`, `test:batch-sale`, `test:products-pagination`, `test:catalog-refresh`, `next build` | OK |
| Recette navigateur isolée, 375 px, FR puis EN | 24 contrôles OK |
| **Préparation de la livraison** (après la portée pilote, la vérification de l'index et l'inventaire) : `tsc`, `nest build`, ESLint et Prettier sur les fichiers modifiés | OK |
| Jest unitaire des zones modifiées (`common`, `products`, `push`, `notifications`, `auth`, `sales`, `analytics`), dont la portée par commerce | 48 suites, 833 tests OK |
| e2e lot C, lot A (inventaire, retrait des permissions), contexte, notifications push | 4 suites, 61 tests OK, puis lots A et C relancés après l'ajout de `losses` à l'inventaire : 43 tests OK |

Web inchangé par la préparation de la livraison : il lit déjà
`features` dans le contexte, désormais calculé par commerce. Aucun contrôle
web relancé.

| **Sécurisation de l'activation pilote** (portée explicite, balayage filtré par commerce, index `expiry_alert_due_org`) : `tsc`, `nest build`, ESLint et Prettier sur les fichiers modifiés, `node --check` du lanceur de recette | OK |
| Jest unitaire `common/organization-scope`, `products`, `push` | 263 tests OK |
| e2e lots A, B et C, contexte, notifications push (les suites des lots déclarent désormais `*_ORGANIZATIONS=all`) | 5 suites, 80 tests OK |

**e2e de livraison** (lot C, § 6) :

- centre seul (aucune clé VAPID, aucun abonnement) : notification interne
  créée, travail `push-disabled`, aucun envoi ;
- index `expiry_alert_due` ou `expiry_alert_due_org` supprimé : balayage
  non exécuté (0 travail, aucun parcours de secours), puis normal après
  réinstallation ;
- commerces pilotes :
  - contexte, routes, vente par lots, réglage et balayage réservés au
    pilote ;
  - commerce non pilote inchangé ;
  - portée absente, vide, invalide ou `all` mêlé à une liste = aucun
    commerce ; `all` = tous ;
- balayage pilote : 5 200 cibles échues hors pilote ne consomment pas la
  limite. Cible pilote annoncée. Hors pilote : aucun travail d'alerte,
  aucune marque, aucune notification. Moins de 200 lectures ;
- `--strip-lot-c-permissions` : `stock.manage_batches` conservé ; pertes
  comptées dans l'inventaire ;
- premières alertes prévisibles par pilote (bientôt / périmé), sans
  identifiant dans la sortie.

**e2e du lot C** :

- pertes partielle et totale ;
- idempotence et clé réutilisée ;
- valeur figée malgré un changement de prix ;
- ventes, CA et marge sur ventes inchangés, pertes à part ;
- fermeture du lot, corrections concurrentes plafonnées, remise à
  disposition explicite ;
- vente et perte concurrentes ;
- seuil de stock faible franchi par une perte, sans vente ;
- mise à l'écart sans changement du stock physique, refus de vente et de
  réception, restitution vers un lot à l'écart ou retiré ;
- lot dépassé remis à disposition toujours invendable ;
- partition sans double comptage ;
- permissions distinctes, quantités masquées, isolation, catalogues 5 et
  7 ;
- échéance aujourd'hui, demain, dépassée, sans date, sans stock ;
- planificateur arrêté puis relancé, balayages concurrents ;
- lot à l'écart concerné, réapprovisionnement, corbeille ;
- changements de date, transition vers les lots sans double envoi ;
- revalidation (stock vendu avant l'envoi) ;
- délai 0 à 365, droits, sans réarmement ;
- préférences et destinataires, contenu générique ;
- fonctionnalité désactivée ;
- Analyse et droits ;
- notification de régularisation (unique, réservée aux responsables,
  annulée si décidée, aucune fuite entre commerces).

Fuseaux et changement de jour : tests unitaires (Douala, UTC−12) et e2e
avec horloge contrôlée (`PUSH_CLOCK`).

**Recette navigateur** (`--product-batches --expiry-alerts`, propriétaire,
375 px, FR puis EN) :

- alerte « bientôt » créée par le planificateur au premier passage d'un
  processus API, puis lue dans le centre (détail : lot, date, texte
  générique) ;
- mise à l'écart (motif exigé, confirmation) : stock physique 10,
  vendable 4, à l'écart 6, badge ; remise à disposition ;
- perte d'une unité : physique 9, pertes 1, initial 10, aucune vente ;
- correction : physique 10, pertes nettes 0, historique conservé ;
- Analyse : lot dans « Expire bientôt » ; délai porté à 90 jours, un
  second lot entre dans la période ;
- aucun débordement, aucune erreur JavaScript.

**Transport** : toutes les vérifications push utilisent un **faux
transport** (e2e) ou le seul centre de notifications (recette sans clés
VAPID). **L'envoi push réel n'est pas vérifié.**

## 10. Limites

- Pertes et mise à l'écart : produits suivis par lots seulement, en ligne
  uniquement (l'outbox des ventes est inchangée ; un lot devenu
  indisponible donne un conflit visible, lot B).
- Mise à l'écart partielle non gérée (lot entier).
- Jour du commerce unique (fuseau de l'API) pour tous les commerces.
- Portée pilote : liste en variable d'environnement (redémarrage requis
  pour la changer). Un balayage par commerce pilote : adapté à quelques
  pilotes, pas à des centaines (au-delà, `all`).
- Aucune version de repli « lot B sûre après pertes » n'existe (§ 8).
- Listes de l'Analyse limitées à 100 éléments chacune (totaux affichés).
- Pertes : estimation au coût d'achat du moment, pas une valeur
  comptable ; pas de coût par réception ni de marge par lot.
- Au premier balayage après activation, une alerte « périmé » par cible
  déjà dépassée (voir § 7, étape 4).
- La demande de régularisation n'a pas de détail dédié dans le centre de
  notifications : le lien ouvre la page Ventes et sa carte « Régularisations
  à examiner ».

## 11. Ajustements préparés pour les guides FR / EN (non publiés)

Les pages publiées (`i18n/documents/guide`, `gestion-stock-boutique`)
**ne sont pas modifiées** tant que les fonctionnalités ne sont pas
activées. Textes proposés, à insérer **au moment de l'activation** :

- **Guide (FR)**, rubrique produit :
  - « Suivi par lots : chaque lot a sa date de péremption. Un lot dépassé
    ou mis à l'écart n'est plus vendable ; ses unités restent dans le
    stock jusqu'à une perte enregistrée. »
  - « Pertes : bouton « Enregistrer une perte » sur un lot (péremption,
    casse, autre). Une perte n'est jamais une vente ; elle s'affiche à
    part dans la fiche et l'Analyse. Une erreur se corrige par
    « Corriger », sans effacer l'historique. »
- **Guide (FR)**, rubrique notifications : « Péremption proche » et
  « Produits périmés », délai réglable dans l'Analyse (30 jours par
  défaut).
- **Guide (EN)** : mêmes paragraphes (« Batch tracking… », « Losses… »,
  « Expiry approaching / Expired products »).
- **Article « gestion de stock »** : remplacer la mention « les lots ne
  sont pas suivis » par une phrase neutre sur le suivi par lots et les
  pertes, sans promesse de calendrier.
