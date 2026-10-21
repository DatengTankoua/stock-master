# Date de péremption et seuil de stock faible personnalisé

Branche `feature/product-expiry-stock-threshold` (depuis `origin/dev`,
`f4e36c8`). Aucune donnée de production touchée ; aucun commit.

> **Évolutions ultérieures** (rapport conservé tel quel) : suivi par lots,
> vente par lots et pertes dans [product-batches-foundation.md](product-batches-foundation.md),
> [product-batches-sales.md](product-batches-sales.md) et
> [product-batches-expiry-losses.md](product-batches-expiry-losses.md) ; les
> alertes de péremption couvrent aussi la date des produits sans lots (qui ne
> bloque toujours pas les ventes). Guides alignés : [documentation-cleanup.md](documentation-cleanup.md).

## 1. Modèle et validation

| Champ (`products`) | Stockage | Valeurs | Absent |
|---|---|---|---|
| `expiryDate` | chaîne `AAAA-MM-JJ` (date civile, aucune heure ni fuseau) | jour réel, années 2000–2100 ; date passée acceptée | aucune date |
| `lowStockThreshold` | nombre ≥ 0, mêmes règles de précision que le stock (`IsNumber`, `Min(0)`) | `0` explicite, jamais assimilé à vide | règle par défaut |

- Validation : `products/product-fields.ts` (décorateur `IsCivilDate`,
  conversion multipart). Une chaîne vide n'est jamais convertie en `0`
  (`Number('')` évité).
- Création (multipart) : vide = non renseigné. Modification : absent =
  inchangé ; `null` (JSON) ou `""` (multipart) = effacement (`$unset`).
- Projection standard (tout membre autorisé à consulter, diffusion
  Socket.IO comprise) : `expiryDate` et `lowStockThreshold`, `null` sinon.
  Aucun champ de stock détaillé n'est révélé : le seuil par défaut est
  décrit, jamais calculé en unités.
- Aucune gestion de lots : une date par fiche, signalée dans le formulaire.
  Aucune vente bloquée, aucune notification de péremption.

## 2. Règle centrale du stock faible

`products/stock-level.ts` est l'unique source de vérité, utilisée par :

- le statut (`computeStatus`) ;
- le catalogue et la fiche produit ;
- l'Analyse (`classifyStock`, `lowStockCount`) ;
- les alertes (ventes, corrections, annulations, modification de produit) ;
- leur revalidation avant envoi (dispatcher) ;
- le détail des notifications.

- **Seuil personnalisé** : faible si `restant < seuil` (strict). Au seuil,
  le produit n'est pas faible. Avec `0`, il n'est jamais faible.
- **Défaut, inchangé** : `stockLowReached` (1-16A.1), soit
  `5 × (initial − restant) ≥ 4 × initial`. Cela revient à un restant ≤ 20 %
  de `initialQuantity`, ajouts de stock compris. L'ancienne formule du statut
  (`restant / initial <= 0.2`) donne le même résultat pour des quantités
  entières. Les deux étaient déjà équivalentes ; une seule subsiste.
- **Rupture** (`restant = 0`) : prioritaire, traitement inchangé.
- **Analyse** :
  - avec un seuil personnalisé, le produit est dans « Stock faible » dès
    qu'il est sous le seuil, estimation ou non (« Bientôt épuisé » reste
    prioritaire) ;
  - avec la règle par défaut, comportement inchangé : seulement quand
    l'estimation manque.

## 3. Alertes

`stockAlertFor(avant, après)` s'applique à chaque écriture atomique.

- `depleted` : passage réel d'un stock positif à 0.
- `low` : ENTRÉE dans l'état faible (pas faible avant, faible après, stock
  positif) :
  - rester sous le seuil ne déclenche rien ;
  - en sortir réarme l'alerte ;
  - la rupture est seule annoncée si la même écriture atteint 0.
- **Ventes, corrections, annulations** : le seuil est lu dans le document de
  l'écriture atomique elle-même (`decrementStock`, `adjustStock`).
- **Modification du seuil** :
  - l'écriture et la réévaluation ont lieu dans une transaction ;
  - l'état avant vient de `findOneAndUpdate(returnDocument: 'before')`,
    l'état après d'une relecture dans la même session ;
  - clé d'événement `stock-low:<produit>:product-update:<opération>`
    (unique, upsert) ;
  - une même valeur renvoyée ne produit aucune écriture ;
  - des modifications simultanées produisent une seule alerte, car la
    transaction perdante est rejouée et voit l'état déjà faible.
- **Destinataires et préférences** : inchangés
  (`products.view_stock_details`, préférences du centre et du push).
- **Revalidation avant envoi** : le seuil actuel est relu. Un produit
  réapprovisionné, ou dont le seuil a été abaissé, est marqué `restocked`.

## 4. Permissions

| Clé | Libellé | Exigée pour |
|---|---|---|
| `products.manage_expiry` | Gérer les dates de péremption | renseigner, modifier ou effacer `expiryDate` |
| `stock.manage_thresholds` | Personnaliser les seuils de stock | renseigner, modifier ou effacer `lowStockThreshold` |

- **Complément, jamais remplacement** :
  - en création comme en modification, `products.manage` reste requis ;
  - le prix et le stock exigent toujours `stock.adjust` ;
  - toute présence du champ sans le droit entraîne un 403 sur la requête
    entière, sans rien écrire.
  - à la création, ce contrôle a lieu avant l'envoi de la photo.
- **Rôles** :
  - propriétaire et administrateur : accordées par défaut (toutes les
    délégables, union non réductible) ;
  - vendeur : jamais sans ajout explicite (refus par défaut).
- **Invitations** :
  - validation, anti-escalade (`canGrantInvitation`) et recopie à
    l'acceptation existantes, sans changement de code ;
  - une invitation sans ces droits reste acceptable et n'en attribue
    aucun.
- **Anciennes invitations, selon le rôle** : une invitation ne porte que
  son rôle et sa liste de permissions supplémentaires, sans numéro de
  version. L'acceptation recopie les deux telles quelles dans la
  membership. Les droits effectifs sont recalculés à chaque requête par
  `effectivePermissions` (droits standard, rôle et permissions
  supplémentaires).
  - **Administrateur** : obtient les deux nouvelles permissions par les
    droits de son rôle (`DEFAULT_PERMISSIONS_BY_ROLE.admin` = toutes les
    délégables), sans qu'elles soient écrites dans la membership. Il en va
    de même d'un administrateur déjà membre avant ce lot.
  - **Vendeur à droits partiels** : aucune nouvelle permission sans
    attribution explicite. Le rôle vendeur n'apporte que `sales.record` et
    `sales.view_own`, et la liste recopiée ne contient pas les nouvelles
    clés.
  - **Contrôles réalisés** :
    - administrateur invité sans permission supplémentaire : droits
      effectifs incluant les deux nouvelles (e2e « administrateur invité ») ;
    - vendeur invité avec `products.manage` seul : droits effectifs sans
      elles, modification de la date refusée en 403 (e2e « forme
      antérieure ») ;
    - propriétaire et administrateur autorisés par défaut (unitaire du
      contrôleur).
  - **Limite** : ces invitations ont été créées par l'API actuelle. Aucune
    invitation insérée avec un format antérieur n'a été testée. Le format
    stocké étant identique, il n'existe pas d'autre chemin de code.
- **Membres** :
  - catalogue de permissions 3 (`CURRENT_PERMISSION_CATALOG`) ; le web
    déclare `?permissionsCatalog=3` ;
  - un ancien formulaire (catalogue 2) conserve ces permissions sans pouvoir
    les retirer.
- **Journal d'audit existant** : nouvelles actions `expiry_changed` et
  `threshold_changed` (`{ from, to }`). L'activité des membres est annoncée
  au propriétaire par le circuit existant.
- **Isolation** : le filtre composite organisation est inchangé ; un
  produit d'un autre commerce renvoie 404, sans lecture ni écriture.

## 5. Compatibilité et migration

- **Produits existants** : ni date ni seuil, comportement identique. Aucune
  migration de données, aucun index : aucune requête ne filtre sur ces
  champs.
- **Hors ligne** : aucune fonctionnalité ajoutée.
  - L'allowlist du catalogue hors ligne est inchangée, sans date ni seuil.
  - Le statut mis en cache est celui calculé par le serveur, seuil compris.
  - L'outbox des ventes n'est pas modifiée.
- **Web récent avec une API antérieure** : les champs sont absents
  (`undefined`), donc les formulaires ne les proposent pas.
- **Ordre de déploiement** : API, puis web. Dans l'ordre inverse, accorder
  ces permissions échoue avec 400, sans rien enregistrer (même situation
  qu'en 1-19A).
- **Retour arrière** : `pnpm --filter api migrate:product-field-permissions`.
  - Sans option : inventaire en lecture seule.
  - `--strip --apply` : retrait idempotent des deux permissions dans
    `organizationmemberships` et `organizationinvitations`.
  - Les champs produit restent en base et sont ignorés par l'ancienne API
    (règle par défaut). Non exécuté en production.

## 6. Interfaces (FR/EN, i18n)

- **Formulaires de création et de modification**
  (`product-optional-fields.tsx`) :
  - champs affichés seulement avec `products.manage` et le droit propre ;
  - avertissement pour une date passée ;
  - mention « pas de lots » ;
  - boutons « Retirer la date » et « Revenir à la règle par défaut » ;
  - envoi des seuls champs modifiés.
- **Carte et fiche produit** (`product-info.ts`) :
  - date affichée sans décalage de fuseau, « dépassée » à partir du
    lendemain (jour civil de l'appareil) ;
  - seuil « Personnalisé : sous N » ou « Par défaut ».
- **Historique, notification, Analyse** :
  - historique de la fiche : valeurs avant et après ;
  - détail des notifications : seuil appliqué ;
  - Analyse : seuil personnalisé ou par défaut pour chaque produit.
- **Documentation** :
  - guide d'utilisation et guide pratique mis à jour (FR/EN) ;
  - pertes, retours et lots restent à noter à part.

## 7. Vérifications

| Contrôle | Résultat |
|---|---|
| Unitaires API concernés (produits, ventes, push, analyse, organisations, notifications, audit, corbeille, migrations) | 45 suites, 685 tests OK |
| Nouveaux unitaires : règle centrale, dates (fuseaux `Pacific/Kiritimati`, `Africa/Douala`, `Etc/GMT+12`), DTO, contrôleur, projection, Analyse | inclus ci-dessus |
| E2E `product-expiry-stock-threshold` (replica set réel) | 17 OK |
| E2E existants liés : centre de notifications, push, permissions produit, invitations, membres, activité, Analyse, concurrence de stock, transactions de vente, pagination | 10 suites, 168 OK |
| `tsc` API (build), `nest build`, ESLint et Prettier des fichiers modifiés | OK |
| Erreurs de type des specs API | identiques à `origin/dev` |
| Web : `tsc`, ESLint, `test:i18n`, `i18n:coverage`, 6 scripts de test, `next build` | OK |
| Recette locale (navigateur, 375 px, FR/EN) | voir ci-dessous |

**Recette locale** :

- création réelle par l'API (requête multipart envoyée depuis la page) ;
  formulaire de création inspecté par son texte et le DOM, pas soumis ;
- modification réelle par le formulaire ;
- envoi limité aux champs modifiés ;
- alerte à l'entrée sous le seuil après modification du seuil ;
- invitation et membre au catalogue 3 ;
- Analyse ;
- aucun débordement horizontal.

## 8. Limites

- Une date par fiche, sans lots ; pas de blocage des ventes ni d'alerte de
  péremption.
- « Dépassée » suit le jour civil de l'appareil qui affiche.
- Le seuil ne concerne que l'état « Stock faible ». La rupture garde sa
  règle.
- Pour la règle par défaut, l'Analyse n'affiche toujours un produit en
  « Stock faible » que si l'estimation manque (comportement antérieur
  conservé).
- La capture d'écran automatique du formulaire de création est restée
  blanche (artefact de l'outil). Son rendu a été vérifié par mesures du DOM
  (dimensions, superposition, opacité) et par celui du formulaire de
  modification, qui partage le même composant. Il n'a jamais été soumis
  depuis l'interface : à valider manuellement (§ 9, étape 1).

## 9. Validation manuelle (parcours court)

**Préparation.**

- Pile locale fictive : `pnpm --filter api build`, puis
  `node api/test/recipe/recipe.js start`. Aucune donnée de production.
- Ouvrir `http://127.0.0.1:3200/auth/login`. Mot de passe :
  `Recette-locale-14d2h!`.
- Vérifier sur téléphone ou à 375 px, puis sur ordinateur, en FR et en EN.
- Comptes utilisés :
  - `proprietaire.actif@recette.local` (propriétaire) ;
  - `vendeur.actif@recette.local` (vendeur).

1. **Créer un produit avec une date et un seuil de 5.**
   - Connecté en propriétaire : Catalogue, nouvelle section, « Ajouter un
     produit ».
   - Saisir : quantité initiale 10, une date future, un seuil de 5, une
     photo.
   - **À inspecter visuellement (non vérifié de façon concluante)** :
     - les deux champs, leurs aides et la mention « pas de lots » sont
       lisibles ;
     - le formulaire défile jusqu'au bouton « Ajouter » ;
     - aucun débordement horizontal ;
     - une date passée affiche l'avertissement sans bloquer l'envoi.
   - Résultat attendu : la carte affiche la date ; la fiche affiche
     « Personnalisé : sous 5 unités ».
2. **Au seuil, puis sous le seuil.**
   - Vendre 5 unités : il en reste 5, le statut reste « En stock ».
   - Vendre 1 unité : il en reste 4, le statut passe à « Stock faible ».
   - La cloche affiche une notification « Stock presque épuisé ». Le centre
     de notifications fait foi si le push est bloqué.
3. **Pas de répétition.**
   - Vendre 1 unité (il en reste 3) : le statut reste « Stock faible ».
   - Aucune nouvelle notification de stock.
4. **Retirer la date et revenir au seuil par défaut.**
   - « Modifier », puis « Retirer la date » et « Revenir à la règle par
     défaut », puis « Enregistrer ».
   - La carte n'affiche plus de date. La fiche indique « Par défaut (20 %
     du stock initial) ».
   - L'historique ajoute « Date de péremption modifiée » et « Seuil de
     stock faible modifié ».
   - Avec 3 restants sur 10, la règle par défaut (≤ 2) donne « En stock »,
     sans alerte.
5. **Vendeur sans les deux permissions.**
   - En propriétaire : Organisation, Membres, « Modifier » le vendeur.
     Cocher seulement « Gérer les produits » (et « Ajuster le stock »), puis
     enregistrer.
   - Se reconnecter en vendeur. « Ajouter un produit » et « Modifier »
     n'affichent ni la date ni le seuil. Les autres champs restent
     modifiables.
   - La fiche affiche toujours la date et le seuil existants (lecture
     permise).
   - Les autres contrôles de ce lot ont montré que l'API refuse ces champs
     (403) même hors de l'interface.

**Déploiement** : API, puis web (§ 5). Arrêt de la pile :
`node api/test/recipe/recipe.js stop`.
