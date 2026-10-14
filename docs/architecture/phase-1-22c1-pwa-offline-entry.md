# Phase 1-22C.1 — PWA : lancement et pages publiques hors ligne

**Branche** `fix/phase-1-22c1-pwa-offline-entry` · **Base** `09dc6c4` (1-22C).
Aucun commit, aucun push, aucun fichier `api/`, aucune dépendance ajoutée.

## 1. Cause

Reproduite sur un build de production (Chromium, réseau coupé) :

1. **Lancement depuis l'icône impossible.** `start_url` vaut `/app`, que le
   service worker n'interceptait jamais (seule exception : `/app/catalog`
   exact). Hors ligne : `net::ERR_INTERNET_DISCONNECTED`, page d'erreur du
   navigateur.
2. **Pages publiques absentes.** Seules `/`, `/offline`, `/auth/login` et
   `/auth/register` étaient prévues, et seulement après une visite. Guide,
   contact et pages légales : erreur du navigateur.
3. **Ressources manquantes.** Le précache stockait le HTML mais pas ses
   chunks `/_next/static`. Si le catalogue n'avait jamais été ouvert en ligne
   avec cette version, `/app/catalog` affichait « This page couldn't load ».
4. **Une seule langue.** Une même URL est rendue en FR ou en EN selon le
   cookie. Le cache gardait la langue de la dernière visite, et les textes
   rendus côté serveur (guide, documents légaux) ne se traduisent pas côté
   client.

Point relevé pendant les tests : une page restée ouverte pendant la coupure
relançait l'envoi des ventes dès l'événement `online`, avant de relire
`/auth/context`. Le serveur refusait déjà toute vente non autorisée.

## 2. Comportement retenu (`web/public/sw.js`, v5)

| Requête | Stratégie |
|---|---|
| Liens à jeton (`/auth/invitations/*`, `verify-email`, `reset-password`) | Jamais interceptés (inchangé) |
| Requêtes RSC Next.js (`RSC: 1` ou `?_rsc`) | Jamais interceptées : ni lues ni écrites en cache |
| Navigation `/app` exact (`start_url`) | Réseau ; en cas d'échec réseau, redirection vers `/app/catalog` |
| Navigation `/app/catalog` exact | Inchangé (réseau, sinon shell précaché) |
| Navigation vers une page publique | Réseau d'abord, copie enregistrée si l'URL n'a pas de query ; en cas d'échec réseau, copie dans la langue de l'appareil, sinon écran hors ligne |
| Toute autre navigation (dont `/app/*`, `/access`) | Réseau, sans cache ; seul un **échec réseau** affiche l'écran hors ligne. Une réponse 401, 403, 404 ou 5xx est rendue telle quelle |
| `/_next/static`, `/icons`, `/brand` | Cache d'abord (inchangé) |

- **Deux caches** : `stockmaster-v5` (ressources statiques et shell générique)
  et `stockmaster-pages-v5` (documents publics uniquement). La clé interne
  porte la langue (`/guide?__sw_locale=en`), lue dans `<html lang>`.
- **Préparation à l'installation** : 13 pages × FR/EN, téléchargées **sans
  cookie** (`credentials: "omit"`, langue imposée par `Accept-Language`),
  puis leurs JS, CSS et polices (HTML et en-tête `Link`). Les ressources sont
  écrites **avant** le document, qui n'est donc jamais enregistré incomplet.
- **Échec de préparation** : une erreur réseau ou une réponse 5xx fait
  échouer l'installation. L'ancienne version reste active avec ses caches,
  et le navigateur réessaie plus tard. Une page en 4xx ou redirigée est
  ignorée.
- **Langue hors ligne** : la base `stockmaster-preferences` (déjà écrite par
  la page) donne la langue de l'appareil ; l'autre langue sert de repli.
  Changer de langue sur une copie enregistrée **sans champ de saisie**
  recharge la page dans l'autre langue. Partout ailleurs, aucun
  rechargement.
- **Copie signalée** : la copie servie hors ligne porte
  `<html data-offline-copy="<date>">`. Le bandeau `OfflineCopyNotice`
  affiche « Version enregistrée sur cet appareil le … » et rappelle que
  l'inscription, la connexion et le paiement nécessitent Internet. Il
  propose « Actualiser » dès que le réseau revient.
- **Écran hors ligne** (`/offline`) : bouton Réessayer, liens HTML vers les
  pages disponibles (accueil, tarifs, guide, contact, conditions) et vers le
  catalogue hors ligne.

## 3. Pages couvertes hors ligne

`/`, `/#tarifs`, `/guide`, `/contact`, `/conditions-utilisation`,
`/conditions-abonnement`, `/confidentialite`, `/cookies`,
`/mentions-legales`, `/traitement-donnees`, `/auth/login`,
`/auth/register`, `/auth/forgot-password` et `/offline`, en FR et en EN,
même sans visite préalable (après une première ouverture en ligne). Avec
une session valide, s'ajoutent `/app` (vers `/app/catalog`) et la saisie de
ventes hors ligne, selon les règles de 1-11B/1-11C.

## 4. Session et sécurité

- **Connexion hors ligne** (`/auth/login`) : « Une connexion Internet est
  nécessaire pour vous connecter. » Ce message s'affiche si le navigateur se
  déclare hors ligne (bouton alors désactivé) ou si la page est une copie
  enregistrée. Un envoi qui échoue faute de réseau (`LOGIN_NETWORK_UNAVAILABLE`)
  affiche le même message. Aucun login simulé, aucune mise en file, aucun
  mot de passe conservé.
- **Session existante** : aucun changement des règles de 1-11B/1-11C.
  L'identité est vérifiée localement (empreinte, expiration du JWT) et la
  capacité de vente hors ligne dure au plus 72 h. Avec un jeton expiré :
  « Aucune donnée de catalogue disponible sur cet appareil ».
- **Retour du réseau** (`app/app/layout.tsx`, `use-offline-sales-sync.ts`) :
  l'événement `online` relit toujours le contexte serveur. L'envoi des ventes
  est suspendu (`reconnectPending`) jusqu'à la réponse. En cas de refus
  (401/403), les ventes restent `pending`, sans envoi ni suppression. Le
  hook ne lance plus de passe directement sur `online`.
- **Cache public** : aucune réponse d'API, aucune page `/app/*` hors du shell
  générique, aucun jeton, aucun reçu ni paiement. La purge du service worker
  ne touche que les caches `stockmaster-*` et jamais IndexedDB, donc ni
  l'outbox des ventes ni l'identité hors ligne.

## 5. Fraîcheur et mise à jour

- Une page publique visitée en ligne remplace sa copie (réseau d'abord).
- À l'ouverture d'une page en ligne, ou au retour du réseau, la page demande
  au service worker (`stockmaster:refresh-public-pages`) de réactualiser
  toutes les copies, au plus une fois toutes les **12 h**. Chaque copie
  n'est remplacée qu'en cas de succès complet ; un échec (5xx, coupure)
  conserve la précédente.
- Ces 12 h sont un **intervalle minimal entre deux tentatives**, pas un âge
  maximal garanti. Une tentative n'a lieu que si une page est ouverte en
  ligne, et une copie ne change que si son téléchargement réussit. Un
  appareil resté hors ligne, ou dont les téléchargements échouent, garde des
  copies plus anciennes, datées par le bandeau.
- Une nouvelle version de `sw.js` prépare un jeu complet de copies avant de
  s'activer, sans `postMessage` de rechargement : les pages ouvertes
  continuent avec leur code et les saisies en cours sont conservées.

**PWA déjà installées.** Déployer suffit : au prochain lancement en ligne,
le navigateur détecte le nouveau `sw.js` et installe la v5 en arrière-plan
(environ 2 à 3 Mo). Il l'active ensuite sans recharger la page et supprime
la v4. Les ventes en attente sont conservées. Les nouveaux écrans
apparaissent au chargement de page suivant. `sw.js` ne doit pas être servi
avec un cache HTTP long.

- **Plusieurs onglets ou fenêtres ouverts sur la v4** : dans Chromium,
  l'activation de la v5 peut être retardée d'environ 5 min 30 malgré
  `skipWaiting()` (test G2). Pendant ce délai, la v4 et son cache restent
  intacts et l'application fonctionne comme avant.
- **Conseil aux utilisateurs** : ouvrir l'application une fois avec Internet,
  attendre environ 30 s, puis la fermer et la rouvrir. Ces 30 s sont
  **indicatives** et ne prouvent pas que le cache est prêt (réseau lent,
  plusieurs fenêtres). Seul l'état du service worker le confirme : les
  caches `stockmaster-v5` et `stockmaster-pages-v5` présents, `stockmaster-v4`
  absent (outils de développement).

## 6. Tests

Recette locale (`api/test/recipe`, MongoDB éphémère, fournisseurs simulés),
build de production de la copie isolée. Campagne Playwright hors dépôt :
Chromium 151, émulation mobile 390 × 844, profil persistant, caches jamais
effacés entre les étapes. **15/15**, deux exécutions complètes :

| # | Vérification | Résultat |
|---|---|---|
| U0 | v4 installée, session, catalogue synchronisé, vente en attente | OK |
| U0b | Avant correctif : `/app` hors ligne | `ERR_INTERNET_DISCONNECTED` (cause 1) |
| U1 | Mise à jour v4 → v5 | 26 copies, v4 supprimée, même document, vente conservée |
| S1 | Lancement `/app` hors ligne avec session | `/app/catalog`, rayon et produit, vente `pending` |
| S2 | 13 pages FR hors ligne | Servies par le SW, CSS et polices chargées, aucun chunk en échec, bandeau |
| S3 | Bascule FR → EN hors ligne, puis navigation | 13 pages EN, retour FR |
| S4 | `Link` Next.js hors ligne, `/#tarifs`, requête RSC | Document du SW ; requête RSC en échec réseau (aucun HTML servi) |
| S5 | `/app/sales`, `/app/organization/subscription`, `/access`, fiche produit | Écran de secours ; lien `reset-password` non servi |
| S6 | Retour réseau, contexte refusé (401) | 0 `POST /sales`, vente conservée |
| S7 | Contexte accepté | Vente `synced`, une seule vente en base |
| S8 | Déconnexion puis compte B | Bases identité et catalogue purgées, aucune entrée de cache privée, hors ligne B ne voit rien de A |
| S9 | Sans session, lancement hors ligne | `/auth/login`, message, aucun jeton ni mot de passe stocké |
| S10 | Fraîcheur | Copie remplacée à la visite ; actualisation après 12 h ; copie conservée sur une réponse 500 |
| N1 | Contexte neuf, navigateur EN, première visite puis hors ligne | Pages EN, `/app` → message de connexion EN |
| E1 | Jeton expiré (horloge + 8 j) puis 401 au retour | Aucune donnée ; « accès plus actif » |

**Complément : ancien onglet après la mise à jour** (même recette, scripts
hors dépôt). Une fois chargé, le JS d'un onglet reste en mémoire et n'est
jamais redemandé. L'application n'a aucun `import()` dynamique : du JS
supplémentaire n'est demandé qu'à une navigation côté client.

| # | Vérification | Résultat |
|---|---|---|
| G1 | Onglet ouvert sur `/app/catalog` en v4 (23 JS chargés, 31 chunks en cache v4), mise à jour depuis cet onglet : v5 active en 2 s, v4 supprimée (1 chunk de la v4 absent de la v5), même document. Hors ligne, `router.push` de l'ancien code vers `/guide`, `/app/sales`, `/contact` (jamais chargées) | La requête RSC échoue et Next.js charge un nouveau document : copie v5 ou écran hors ligne. 0 chunk en échec, 0 erreur de page |
| G1b | Même cas, avec `/guide`, `/contact` et `/conditions-utilisation` préchargées en ligne par l'ancien onglet (`/auth/login` v4) | Pages dynamiques, nouvelle requête RSC, puis navigation de document : copies v5, 0 chunk en échec, 0 erreur |
| G2 | v4 → v5 avec deux onglets ouverts | v5 en attente environ 5 min 30, v4 et son cache intacts, puis activation. Même retard avec un ancien SW minimal « cache d'abord » sur `/_next/static` et une installation lente ; aucun retard avec un seul onglet ni sans ce gestionnaire |

La suppression du cache v4 ne retire donc rien qu'un ancien onglet doive
encore télécharger : le cache v4 ne contenait que des fichiers déjà
chargés. Aucun correctif n'a été nécessaire. Seul Chromium (build de la
recette, même build pour v4 et v5) a été testé ; un déploiement réel change
aussi les noms de chunks, d'où le même passage par une navigation de
document.

Non-régression : scénario 11 de la recette (vente conservée pendant un
paiement puis synchronisée) PASS. Contrôles : `eslint` web, `tsc --noEmit`,
`check-i18n` (1 427 clés), `next build`, `git diff --check`.

Dans Playwright, `navigator.onLine` reste vrai sous émulation hors ligne
(constat de 1-11C.3) : le message de connexion vient alors de la copie
enregistrée et de l'échec réseau. **Aucun test sur un téléphone réel ni sur
une PWA installée** : seulement l'émulation mobile. Le lancement depuis
l'icône d'une PWA installée (Android et iPhone) **reste à vérifier sur
téléphone** avec la recette du § 7 : l'émulation ne reproduit ni le mode
standalone, ni l'ouverture par `start_url`, ni la gestion du stockage par
le système.

## 7. Recette manuelle (téléphone)

Android (Chrome) et iPhone (Safari, « Sur l'écran d'accueil ») :

1. Avec Internet : ouvrir le site, se connecter, ouvrir le catalogue et un
   rayon, installer la PWA, attendre environ 30 s (indicatif). Si une étape
   hors ligne échoue, rouvrir l'application en ligne et recommencer.
2. Mode avion. Lancer depuis l'icône : le catalogue s'ouvre avec le message
   hors connexion. Saisir une vente.
3. Hors ligne : ouvrir Aide, Contact, une page légale, l'accueil et les
   tarifs. Vérifier le bandeau « Version enregistrée ». Passer en anglais et
   vérifier le changement de langue.
4. Ouvrir Ventes : l'écran hors ligne s'affiche, et « Réessayer » fonctionne
   une fois le réseau revenu.
5. Réseau rétabli : la vente passe en « synchronisée ».
6. Se déconnecter, repasser en mode avion, relancer l'icône : la page de
   connexion affiche « Une connexion Internet est nécessaire… ».

## 8. Limites

- **Première ouverture en ligne obligatoire** : sans service worker installé,
  rien n'est disponible hors ligne.
- **Révocation non détectable hors ligne** : un accès retiré côté serveur
  n'est connu qu'au retour du réseau. D'ici là, les données locales restent
  consultables jusqu'à l'expiration du JWT (7 j) et dans les limites de
  1-11B/1-11C (catalogue et saisie 72 h). Le serveur refuse ensuite toute
  vente non autorisée.
- **Copies anciennes** : après un déploiement qui ne modifie pas `sw.js`,
  une page non visitée garde sa copie au moins jusqu'à la tentative suivante
  (12 h minimum), et plus longtemps sans réseau ou en cas d'échec. Hors
  ligne, la date affichée l'indique.
- **Activation retardée** (environ 5 min 30) quand plusieurs onglets sont
  ouverts sur l'ancienne version (G2) ; rien n'est perdu pendant ce délai.
- **Captures de l'accueil** (`/_next/image`) non enregistrées : le texte
  alternatif s'affiche à leur place.
- **Chunks des anciens builds** : ils restent dans `stockmaster-v5` jusqu'au
  prochain changement de `CACHE_VERSION`.
- Le navigateur peut vider le stockage en cas de manque de place.
