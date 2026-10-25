# Fenêtres modales sur téléphone

Branche `fix/mobile-dialogs`, créée depuis `origin/dev` (`d6a0b6f`).
L'arbre de travail était propre : rien à préserver, aucun stash ni reset.
Aucun commit, push ou déploiement. Aucune invitation réelle : vérifications
sur la recette isolée, avec des comptes fictifs.

## 1. Cause

`DialogContent` (`web/src/components/ui/dialog.tsx`) était centré par
`top-1/2` et `translate(-50%)`, sans hauteur maximale ni défilement. Quand
le contenu dépasse la hauteur de l'écran, la fenêtre déborde en haut et en
bas. Le titre et le bouton de fermeture sortent de l'écran, comme les
dernières permissions et le bouton d'envoi, et rien ne permet de les
atteindre : la page derrière est bloquée par la fenêtre modale.

Quelques formulaires (produit, vente, lots) avaient un correctif local,
`max-h-[calc(100dvh-2rem)] overflow-y-auto`. Toute la fenêtre défilait
alors, y compris le titre, la fermeture et le bouton d'envoi. Ce correctif
ignorait aussi le clavier : `100dvh` ne rétrécit pas quand le clavier
virtuel s'ouvre (iOS, Chrome Android récent).

Deux défauts s'y ajoutaient :

- le titre en `leading-none` faisait se chevaucher les lignes d'un titre
  long ;
- le titre pouvait passer sous le bouton de fermeture.

`AlertDialogContent` avait la même absence de bornage. À 320 px, sa largeur
`max-w-xs` (320 px) touchait aussi les bords de l'écran.

Enfin, `duration-100` (prévu pour l'animation d'ouverture) mettait aussi
`top` et `max-height` en transition de 100 ms, car la propriété de
transition par défaut est `all`. Après l'ouverture du clavier, la fenêtre
gardait donc son ancienne taille pendant une fraction de seconde.

## 2. Approche

**Composant partagé, toujours borné.** Le nouveau module
`ui/dialog-viewport.tsx` publie, tant qu'une fenêtre est ouverte, la zone
réellement visible (`visualViewport` : hauteur, largeur, décalages) en
variables CSS sur `<html>`. Il réagit au clavier, aux barres du navigateur
et au zoom. Les variables sont retirées à la fermeture de la dernière
fenêtre. Sans `visualViewport`, les valeurs de repli sont `100dvh` et
`100%`.

Les fenêtres `Dialog` et `AlertDialog` :

- sont centrées dans cette zone ;
- gardent une marge de 1rem en dehors des zones sûres (`env(safe-area-inset-*)`) ;
- ne dépassent jamais cette zone, ni en hauteur ni en largeur ;
- font défiler leur contenu à l'intérieur (`overscroll-contain`).

La colonne de grille `minmax(0,1fr)` et `break-words` empêchent tout
débordement horizontal. Quand la zone visible rétrécit (ouverture du
clavier), le champ actif d'une fenêtre est ramené dans sa zone défilante, à
l'image suivante. `transition-none` supprime les transitions de géométrie ;
les animations d'ouverture et de fermeture sont des keyframes, elles ne
changent pas.

**Petites fenêtres inchangées.** Le mode par défaut garde la taille et
l'apparence des confirmations, menus et petits formulaires. Ils ne
défilent que si le contenu dépasse. Aucune fenêtre ne passe en plein écran.

**Variante `layout="form"` pour les formulaires longs.** L'en-tête (titre et
fermeture) et le pied (erreur, bouton d'envoi) restent fixes. Seul le
nouveau `DialogBody` défile. Le `<form>` englobe le corps et le pied
(`flex min-h-0 flex-1 flex-col`) : l'envoi par Entrée et le bouton
`submit` sont inchangés. Le message d'erreur (`role="alert"`) est placé
dans le pied, juste au-dessus du bouton, et reste donc toujours visible.

**Permissions.** `PermissionCheckboxes` garde sa logique : options
filtrées, droits standard exclus, administrateur avec toutes les cases
cochées et désactivées, sélection vendeur conservée. Seule la présentation
change :

- toute la ligne est cliquable, sur au moins 44 px de haut ;
- la case mesure 20 px ;
- les libellés longs reviennent à la ligne.

Il n'existe pas de groupes de permissions dans le code (ni web ni API). La
liste plate existante est donc conservée, sans nouveau texte ni
regroupement inventé. Les fenêtres de permissions passent en `sm:max-w-lg`
sur ordinateur, sur deux colonnes.

**Inchangé.** Base UI gère le focus piégé, le retour au déclencheur,
Échap, le blocage du défilement de la page et les libellés. Les gardes de
fermeture existantes (`!submitting`, `!saving`), les états désactivés et
les états de chargement sont conservés. Il n'y a aucun changement de
permissions, de charge utile API ni de règle de délégation. Les fenêtres ne
contiennent que des `<select>` natifs, qui ne sont jamais coupés par le
défilement. Les menus Base UI (langue, thème) sont hors des fenêtres.

## 3. Fenêtres corrigées

| Fenêtre | Traitement |
|---|---|
| Nouvelle invitation (formulaire et lien créé) | `layout="form"`, `sm:max-w-lg` |
| Modifier un membre | `layout="form"`, `sm:max-w-lg` |
| Enregistrer / corriger une vente | `layout="form"` (aucun bornage auparavant) |
| Nouveau produit, Modifier un produit | `layout="form"` (remplace le correctif local) |
| Modifier une vente, opérations de lots, activation et édition de lots | Correctif local retiré : bornage partagé tenant compte du clavier |
| Toutes les autres `Dialog` et `AlertDialog` (confirmations, menu « Plus », régularisations, conditions, catalogue hors ligne…) | Bornage partagé, rendu inchangé |

La fenêtre WhatsApp garde son placement propre (en bas, déjà borné). Son
test passe.

## 4. Contrôles réalisés

- `tsc --noEmit`, ESLint et Prettier : OK sur les fichiers touchés.
- `test:i18n` et `i18n:coverage` : OK. Aucun texte ajouté.
- `test:whatsapp-contact` (15) et `test:batch-sale` (8) : OK.
- `pnpm lint` : 0 erreur, aucun avertissement sur les fichiers touchés.
- `next build` (web et copie de recette) : OK.

**Navigateur (Chromium, Playwright 1.62).** Contrôles faits sur la recette
isolée (`--product-batches --expiry-alerts`, liste complète de 24
permissions). Le script de contrôle et ses captures ne font pas partie du
dépôt.

Matrice testée :

- largeurs 320×568, 375×667, 390×844 (mode mobile tactile) et 1280×800 ;
- FR et EN, thèmes clair et sombre.

Résultat sur le build final : **880/880 contrôles**. Les mesures se font
sur la zone visible :

- la fenêtre, le titre, la fermeture et les actions restent dans l'écran,
  en haut comme en bas de la liste ;
- aucun débordement horizontal, ni de la page ni de la fenêtre ;
- toutes les lignes de permission mesurent au moins 44 px ;
- le défilement de la page est bloqué.

Parcours de l'invitation :

- sélection de trois droits, défilement, réduction de hauteur, puis
  sélection relue intacte ;
- désélection d'un droit ;
- envoi **intercepté** : la charge utile relevée est
  `{"role":"seller","permissions":["catalog.manage","products.manage_expiry_alerts"]}`,
  la réponse est fictive et aucune invitation n'est créée ;
- Échap ferme la fenêtre et rend le focus au bouton « Inviter » ;
- à la réouverture, le formulaire est vierge (comportement existant) ;
- en administrateur, toutes les cases sont cochées et désactivées ; le
  retour à vendeur conserve la sélection.

Modification d'un membre : une case est basculée, le PATCH réel part
vers la base éphémère et la réouverture relit la valeur. L'état initial
est ensuite restauré.

Autres fenêtres :

- les formulaires produit et vente (produit fictif inséré dans la base
  éphémère, vente jamais validée) restent corrects à pleine hauteur et à
  55 % de hauteur ;
- dans le formulaire de vente, le champ « Nom acheteur » qui a le focus
  reste visible après la réduction de hauteur (320, 375 et 1280 px) ;
- la confirmation de transfert reste compacte (moins de 80 % de la
  hauteur), avec une marge latérale à 320 px.

## 5. Limites

- **Clavier.** Il est simulé en réduisant la fenêtre du navigateur à 55 %
  de sa hauteur. Le clavier réel d'iOS Safari et d'Android n'a pas été
  testé sur appareil. Le suivi de `visualViewport` vise ce cas, mais un
  contrôle manuel sur un vrai téléphone (iPhone avec encoche et Android)
  reste à faire.
- **Zones sûres.** Elles valent 0 dans Chromium de bureau : leur prise en
  compte n'est vérifiée que par le code, pas à l'écran.
- **Défaut de page hors périmètre.** À 320 px, la page d'une section
  (`/app/catalog/[id]`) est plus large que l'écran (369 px) à cause de sa
  rangée de boutons d'en-tête. Les fenêtres n'en sont plus affectées, car
  elles sont centrées sur la zone visible. La page elle-même reste à
  corriger dans un autre lot.
- Non couverts dans ce lot : l'administration de la plateforme et la
  double authentification (lot séparé).
