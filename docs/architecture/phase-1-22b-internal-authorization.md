# Lot 1-22B — Autorisations internes : validation et correction

État : **3 défauts confirmés par reproduction locale et corrigés.** Rien
n'est commité, poussé ni déployé. Pistes issues de l'audit 1-22A (n° 4, 5
et 6) ; les autres pistes sont hors périmètre (§ 6).

## 1. Référence

| Élément | Valeur |
|---|---|
| Base du lot | `origin/main` `4bb369e` (merge #40) |
| Branche | `security/phase-1-22b-internal-authorization`, sans suivi distant |
| Code audité en 1-22A | `905f694`, contenu dans `4bb369e` (merges #39, #40). Arbres **identiques** : l'audit porte sur le contenu de `main`. |
| Production | Déploiement sur `main` selon le README. Le commit réellement déployé n'a pas pu être vérifié d'ici (pas d'accès Railway ou Vercel, pas de `gh`). |

Le stash et le document 1-22A, non suivi, sont conservés.

## 2. Résultats

| Piste | Verdict | Démonstration avant correction |
|---|---|---|
| Suppression définitive | **Confirmée** | Un membre ayant `trash.manage` seul purge un produit ou une section **actifs** (200). Une purge concurrente à une restauration supprime le produit **restauré**. |
| Invitations après perte de droits de l'auteur | **Confirmée** | Acceptation réussie (200) après suspension, révocation, retrait de `members.invite` ou retrait d'une permission accordée. Le lien « nouveau compte » est envoyé et le compte est créé. |
| Révocation temps réel | **Confirmée** | Un socket dont la poignée de main chevauche une suspension reste connecté et **reçoit** une diffusion produit. Une révocation écrite hors de ce processus ne ferme jamais un socket ouvert. |

Constats vérifiés, sans défaut :
- Aucune opération groupée n'existe côté serveur : le vidage de corbeille du web enchaîne des appels unitaires, chacun contrôlé.
- La passerelle Socket.IO n'a **aucun** handler entrant : un événement émis par le client est ignoré (testé).
- Les diffusions produit restent en visibilité standard, sans champ financier, quel que soit le droit du destinataire.
- Un simple changement de rôle qui conserve l'autorité de l'auteur (vendeur → admin, transfert de propriété) laisse l'invitation valable.

## 3. Corrections

**Suppression définitive** (`products.service.ts`, `sections.service.ts`) :
- La purge exige `deletedAt != null`. La condition est relue dans la transaction de suppression.
- Un élément actif, restauré ou déjà purgé entre-temps renvoie 404. Aucun succès n'est annoncé pour une suppression qui n'a pas eu lieu.
- Les permissions sont inchangées : `products.manage` et `catalog.manage` pour mettre à la corbeille, `trash.manage` pour restaurer ou purger.
- L'isolation par organisation et la libération du stockage après commit ne changent pas.

**Invitations** :
- La règle unique `canGrantInvitation` (`permissions.ts`) s'applique à la création **et** à l'acceptation. Elle exige :
  - une adhésion active ;
  - le rôle owner, ou sinon `members.invite` et des permissions accordées incluses dans celles de l'auteur.
- L'autorité de l'auteur est relue :
  - **dans la transaction** d'acceptation, pour un compte existant comme pour un nouveau compte ;
  - à l'aperçu et à la demande du lien de création.
- En cas d'échec, l'invitation est refusée comme invalide ou expirée (`INVITATION_INVALID_OR_EXPIRED`), sans détail sur l'auteur.
- `updateMembership` supprime, dans **sa** transaction, les invitations en attente que le membre modifié ne peut plus accorder. Une acceptation concurrente écrit le même document invitation : MongoDB sérialise les deux transactions. Les preuves d'identité, le consentement et l'acceptation unique sont inchangés.

**Temps réel** (`events.gateway.ts`, `socket-auth.middleware.ts`) :
- Après l'enregistrement du socket, l'adhésion et la version de session sont relues. Une révocation validée pendant la poignée de main est donc vue. Une révocation postérieure trouve le socket dans le registre, où `disconnectMember` le ferme comme avant.
- Une relecture périodique a lieu ensuite : `SOCKET_MEMBERSHIP_RECHECK_SECONDS`, défaut 60, de 1 à 3600.
- Le socket est fermé si :
  - l'adhésion n'est plus active ;
  - le rôle, les permissions ou l'adhésion ont changé ;
  - la version de session a changé ;
  - la lecture échoue.
- La reconnexion repasse la poignée de main avec l'état courant.

## 4. Tests

Exécutés en local : base MongoDB éphémère sur 127.0.0.1, expéditeur
d'e-mails simulé, stockage factice, garde anti-`.env` de la recette
préchargée. Aucun service réel.

| Contrôle | Résultat |
|---|---|
| Nouveau `test/internal-authorization.e2e-spec.ts` **avant** correction | 13 échecs sur 21, chacun démontrant un défaut ; les 8 contrôles de non-régression passent |
| Même fichier **après** correction | 21 / 21, sur trois exécutions consécutives |
| Unitaires `organizations`, `products`, `sections`, `events`, `auth` | 799 / 799 (35 fichiers), dont les nouveaux tests de `canGrantInvitation` et de la relecture des sockets |
| E2E concernés (18 fichiers) : corbeille, purge, stockage, quotas, historique, invitations, membres, sockets, temps réel des paiements, permissions produit | 18 fichiers sur 18 au vert |
| Typage du code source, ESLint et Prettier sur les fichiers modifiés | propres |

**Tests existants adaptés au nouveau contrat.** Ils purgeaient directement
un élément actif, ou un élément juste restauré. Ils passent désormais par
la corbeille :

| Fichier | Adaptation |
|---|---|
| `app.e2e-spec.ts` | Mise à la corbeille avant la purge |
| `member-activity-notifications.e2e-spec.ts` | Idem ; la notification de corbeille compte désormais « 2 fois » |
| `monthly-history-export.e2e-spec.ts` | Mise à la corbeille avant la purge |
| `product-stock-concurrency.e2e-spec.ts` | Idem |
| `sale-history-purge.e2e-spec.ts` | Idem. La course « vente en cours / purge » devient « vente en cours / mise à la corbeille » : la corbeille attend le commit de la vente, puis la purge fige l'historique. |
| `storage-quota.e2e-spec.ts` | Mise à la corbeille avant la purge |
| `storage-reconciliation.e2e-spec.ts` | Produit de la fixture créé dans la corbeille |
| Unitaires `products`, `sections`, `organizations`, `events.gateway` | Filtres, refus 404, modèle d'invitation et socket simulés |

## 5. Limites

- **Portée entre instances.** Le registre des sockets reste en mémoire. Une révocation ferme immédiatement les sockets de l'instance qui la traite. Sur une autre instance, elle n'est vue qu'à la relecture périodique, soit 60 s au plus par défaut. Ce n'est pas une révocation distribuée instantanée : un adaptateur partagé (Redis ou équivalent) reste requis avant tout déploiement multi-instance.
- **Produits d'une section purgée.** Ils ne sont pas supprimés et gardent la référence à une section disparue, comme avant ce lot (testé). C'est un sujet d'intégrité du catalogue, sans franchissement de permission : la section avait été mise à la corbeille par un membre ayant `catalog.manage`. Non modifié.
- Une modification d'adhésion qui ne passe pas par `updateMembership` (migration, écriture directe) ne supprime pas les invitations en attente. Elles restent toutefois **refusées à l'acceptation**.
- La restauration d'un élément déjà actif reste acceptée ; c'est un no-op.
- Aucune recette navigateur : le web n'est pas modifié, car il ne purge que depuis la corbeille et gère déjà `INVITATION_INVALID_OR_EXPIRED`.

## 6. Déploiement

- Aucune migration et aucun index.
- Variable facultative : `SOCKET_MEMBERSHIP_RECHECK_SECONDS`, défaut 60.
- Seule l'API est concernée.
- **Changements visibles :**
  - Purge d'un élément actif : 404. Le web ne l'utilise pas.
  - Purge concurrente à une restauration ou à une autre purge : 404 au lieu de 200.
  - Les invitations émises par un membre suspendu, révoqué ou privé des droits nécessaires deviennent inutilisables, et celles qui sont en attente sont supprimées à la modification du membre.
  - Les sockets ouverts sont relus périodiquement : cela ajoute deux lectures indexées par socket par intervalle.
- **Hors périmètre, conservé :**
  - SasPay, rapprochement et reçus, avec les garanties de 1-21E ;
  - `JWT_SECRET`, proxy Railway, CSP et HSTS, CI, exports.
