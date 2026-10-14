# Lot 1-22F — En-têtes de sécurité et compatibilité PWA

État : **une CSP à nonce est livrée en mode APPLIQUÉ** (`Content-Security-Policy`, pas
`Report-Only`). Elle s'accompagne de HSTS, `Referrer-Policy`, `X-Content-Type-Options`,
`X-Frame-Options` et `Permissions-Policy`. Les copies hors ligne de la PWA gardent leur propre
politique. Recette locale sur build de production : **33/33**. Complément : navigation interne
**5/5**, retour arrière réel v6 → v5 **9/9**. Rien n'est commité, poussé ni
déployé. Aucune variable hébergée n'a été modifiée et l'authentification est inchangée.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `f28c9c8` (1-22E, commité et poussé sur sa branche, non fusionné dans `main`) ; arbre propre au départ |
| Branche | `security/phase-1-22f-browser-security-headers`, sans stash, reset ni nettoyage |
| Versions | Next.js 16.3.6, next-i18next 16.3.1, React 19.2.4 |
| Sources consultées | Guide CSP livré avec Next.js 16.3.6 (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) ; Cloudflare, « Turnstile — Content Security Policy » ; Vercel, « Encryption and TLS » (HSTS) |

Le stash (`stash@{0}`) est conservé.

## 2. Inventaire

### 2.1 En-têtes avant ce lot

| Couche | En-têtes | Remarque |
|---|---|---|
| `web/next.config.ts` | `Referrer-Policy: no-referrer`, `no-store`, `noindex`, seulement sur `/auth/verify-email` et `/auth/reset-password` | Aucune CSP |
| `nginx/nginx.conf` (déploiement Docker Compose) | `X-Frame-Options SAMEORIGIN`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` au niveau `http`, donc sur les trois hôtes | Aucun HSTS ni CSP |
| Vercel (web en production, d'après l'audit 1-22A) | D'après la documentation : HSTS `max-age=63072000` par défaut sur un domaine personnalisé | **Non vérifié en production** |
| API NestJS (Railway) | `nosniff` sur le téléchargement des historiques | Hors du périmètre navigateur de ce lot |

Les en-têtes **réellement déployés** n'ont pas été observés : aucun accès à la production. Ce
rapport décrit la configuration du dépôt et son comportement local.

### 2.2 Ressources nécessaires (relevées dans le code, puis éprouvées)

| Besoin | Origine | Directive |
|---|---|---|
| Scripts Next.js (chunks, flux RSC en ligne), script de thème en ligne | même origine, nonce | `script-src` |
| Turnstile : `api.js` chargé à la demande, puis iframe | `https://challenges.cloudflare.com` | `script-src` (via `'strict-dynamic'`), `frame-src` |
| API REST et Socket.IO | `NEXT_PUBLIC_API_URL` et son équivalent `ws(s)` | `connect-src` |
| Photos et logos : `next/image` `unoptimized`, URL signées par l'API (R2 en production, vhost `s3.` en Compose) | hôte de stockage | `img-src` |
| Aperçus avant envoi, téléchargement des exports | `blob:` (et `data:` pour les icônes en ligne) | `img-src` |
| Polices Geist (`next/font/google`, auto-hébergées) | même origine | `font-src` |
| Styles : Tailwind (fichier), `<style>` insérés à l'exécution par `sonner` et `next-themes`, attributs `style` de React | même origine et en ligne | `style-src` |
| Service worker, manifeste | même origine | `worker-src`, `manifest-src` |
| Départ vers SasPay (`location.assign`), impression du reçu (`window.print`) | navigation | Non soumis à la CSP |

## 3. CSP livrée

**Mode : appliqué.** L'en-tête est `Content-Security-Policy`, pas `-Report-Only`. Il n'y a ni
`report-uri` ni `report-to` : aucune collecte externe.

```
default-src 'self';
script-src 'self' 'nonce-<par requête>' 'strict-dynamic' https://challenges.cloudflare.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: <CSP_IMAGE_ORIGINS, sinon https:>;
font-src 'self';
connect-src 'self' <origine de l'API> <ws(s) de l'API>;
frame-src https://challenges.cloudflare.com;
worker-src 'self'; manifest-src 'self'; media-src 'self';
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

**Pourquoi un nonce, et à quel coût.** Toutes les pages étaient **déjà** rendues à la demande :
la mise en page racine lit la langue dans la requête (`getRequestLocale`). Le build le confirme :
toutes les routes sont `ƒ`, sauf `manifest.webmanifest`. Le nonce ne bascule donc aucune page en
rendu dynamique. Alternatives écartées :
- `'unsafe-inline'` pour les scripts : il annulerait la protection contre l'injection ;
- SRI : expérimental, et il ne couvre que les fichiers externes ;
- hachages : le contenu des scripts en ligne de Next.js change à chaque page.

**Mise en œuvre.**
- `web/src/proxy.ts` génère un nonce de 128 bits par requête. Il pose la CSP sur la
  **requête**, que Next.js lit pour mettre le nonce sur ses scripts, et sur la **réponse**,
  puis délègue au proxy de langue existant. Des en-têtes `x-nonce` ou
  `Content-Security-Policy` envoyés par le client sont écrasés.
- Le script de thème de `layout.tsx` reçoit ce nonce.
- La politique est construite par `web/src/lib/security-headers.ts`.

**Exceptions justifiées.**

| Exception | Raison | Pour la retirer |
|---|---|---|
| `style-src 'unsafe-inline'` | `sonner` et `next-themes` insèrent des `<style>` sans nonce ; React rend des attributs `style`. Un style injecté n'exécute aucun script | Bibliothèques acceptant un nonce |
| `img-src https:` tant que `CSP_IMAGE_ORIGINS` est absente | Le web ne connaît pas l'hôte des images : elles sont signées par l'API et servies sans optimisation. Le deviner casserait les photos | Déclarer `CSP_IMAGE_ORIGINS` (§ 7) |
| `https://challenges.cloudflare.com` et `'self'` dans `script-src` | Repli des navigateurs sans CSP 3, qui ignorent `'strict-dynamic'`. Les navigateurs récents ne retiennent que le nonce | — |
| `'unsafe-eval'` | **`next dev` seulement**, jamais en production (guide Next.js) | — |

**PWA.** Avant ce lot, le service worker reconstruisait chaque document enregistré avec le seul
`Content-Type`. Une page servie hors ligne se serait donc exécutée **sans aucune politique**.
Le service worker passe en v6 :
- chaque document enregistré (pages publiques FR/EN, catalogue hors ligne, écran hors ligne)
  garde la CSP reçue avec lui, et le nonce de cette CSP est celui des scripts du même HTML ;
- la copie marquée « version enregistrée » la conserve aussi ;
- les copies v5, sans CSP, sont purgées à l'activation.

Conserver le couple HTML/CSP garde les deux **cohérents**, mais **réutilise le nonce** du
document enregistré : chaque ouverture hors ligne de cette copie présente le même nonce, au lieu
d'un nonce neuf par réponse. Ce nonce n'est pas secret pour du JavaScript qui s'exécute déjà
dans la page : il reste lisible par `script.nonce`. Le navigateur ne le masque qu'à la lecture
de l'attribut (`getAttribute`, sélecteurs CSS). Ce masquage limite certaines fuites par
injection de HTML ou de CSS. Il ne protège pas contre un script déjà exécuté, qui dispose de
toute façon de la page.

Une copie est remplacée de deux façons :
- à chaque visite **en ligne** de la page (réseau d'abord) ;
- pour les autres pages, par une tentative d'actualisation demandée par une page ouverte en
  ligne, au chargement ou à l'événement `online`. Le service worker n'en lance une que si
  12 h au moins se sont écoulées depuis la **tentative** précédente : le repère est posé avant
  la tentative, réussie ou non.

Dans les deux cas, la copie n'est remplacée que si le réseau répond et que le document et ses
ressources sont entièrement récupérés ; sinon, la copie précédente reste en place. Un appareil
qui ne revient pas en ligne garde donc indéfiniment la même copie, et le même nonce.

## 4. Autres en-têtes

Ces en-têtes sont posés par `next.config.ts` sur toutes les réponses du web. La règle globale
vient **en premier**, pour que `no-referrer` sur les liens à jeton continue de l'emporter.

| En-tête | Valeur | Raison |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000` | Même valeur que celle documentée par Vercel ; hôte exact seulement. **Ni `includeSubDomains` ni `preload`** : les sous-domaines n'ont pas été validés. Aucun domaine n'est soumis au préchargement |
| `X-Content-Type-Options` | `nosniff` | — |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `no-referrer` conservé sur `/auth/verify-email` et `/auth/reset-password` (vérifié) |
| `X-Frame-Options` | `DENY` | Complète `frame-ancestors 'none'` pour les anciens navigateurs ; l'application n'est jamais encadrée |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` | Capacités jamais utilisées. Les photos passent par `<input type=file>`. Presse-papiers, notifications et push restent permis |

**nginx (Compose).** Les en-têtes globaux sont retirés : le web reçoit désormais les siens de
Next.js, et les garder les aurait dupliqués. L'API et le vhost `s3.` reçoivent HSTS (hôte exact),
`nosniff`, `X-Frame-Options DENY` et `Referrer-Policy`, avec `always`. `docker-compose.prod.yml`
transmet `CSP_IMAGE_ORIGINS=https://${S3_HOSTNAME}` au web.

## 5. Recette

**Pile utilisée :** `api/test/recipe/recipe.js start`, avec un build Next.js de **production**,
l'API compilée, MongoDB éphémère, le stockage et les paiements simulés. Le script
`api/test/recipe/csp-scenarios.js` s'exécute avec Playwright 1.62.1 existant (Chromium 151).
Dans chaque page, il relève les événements `securitypolicyviolation` et les messages de console,
et il vérifie aussi que la fonctionnalité marche, pas seulement que l'en-tête est présent.

| Scénario | Résultat |
|---|---|
| Pages publiques FR et EN (`/`, `/guide`, `/contact`, `/confidentialite`, connexion, inscription, mot de passe oublié, `/offline`) : statut, langue, script de thème exécuté, aucune violation | 16/16 |
| Connexion refusée affichée : React hydraté et actif, FR et EN | 2/2 |
| Turnstile : `api.js` et iframe servis localement **sous `https://challenges.cloudflare.com`** ; script chargé dynamiquement autorisé, iframe affichée, aucune violation. Iframe d'une autre origine : bloquée (`frame-src`) | 2/2 |
| Catalogue et photo signée (stockage simulé) ; temps réel (produit ajouté par l'API visible sans rechargement, `ws://…/socket.io`) ; aperçu `blob:` ; export Excel téléchargé | 4/4 |
| Départ vers la page SasPay simulée (même onglet), retour, paiement réussi, reçu ouvert, `window.print`, vue impression (boutons masqués) | 1/1 |
| **Script injecté dans le HTML** : `<script>` en ligne, `<script src>` externe, faux nonce et gestionnaire `onerror` ; **aucun n'est exécuté**, 4 violations `enforce`, le script de thème légitime s'exécute | 1/1 |
| PWA : v5 de la base installée ; **mise à jour réelle v5 → v6** (fichier remplacé côté serveur) ; caches v5 purgés ; copies v6 avec leur CSP et un nonce égal à celui du HTML ; hors ligne, la copie **applique** sa CSP ; page publique enregistrée fonctionnelle ; `/app` → catalogue hors ligne avec le produit ; page non préparée → écran hors ligne ; retour du réseau | 7/7 |

**Complément : navigation interne** (scénario `NAV`, rejoué seul et non avec toute la
campagne). Les préchargements du routeur (`next-router-prefetch`) sont refusés : le JS d'une
route cible n'est donc demandé qu'au clic. Un marqueur posé dans la page prouve l'absence de
rechargement complet.

| Navigation (build de production) | Même document | Nouveaux chunks JS | Violations | Résultat |
|---|---|---|---|---|
| Accueil public → connexion (lien), puis connexion refusée affichée | oui | 5 | 0 | OK |
| Application : accueil → catalogue | oui | 1 | 0 | OK |
| Application : catalogue → ventes | oui | 1 | 0 | OK |
| Précédent → catalogue (liste rendue), puis ouverture d'un rayon | oui | — | 0 | OK |

5/5. Les chunks chargés au clic sont insérés par le runtime Next.js et acceptés par
`'strict-dynamic'`. Après la connexion, l'invitation à activer les notifications (fenêtre
modale) est fermée par « Plus tard » : sans cela, elle masque le menu.

**Complément : retour arrière réel v6 → v5** (orchestration ponctuelle, hors dépôt) :
- l'ancien web (`f28c9c8`, service worker v5, sans CSP) est construit dans une seconde copie
  isolée ;
- il **remplace réellement** le serveur web de la recette sur la même origine
  (`127.0.0.1:3200`), l'API restant en place ;
- après l'essai, la copie est supprimée et `web/` n'a pas été touché.

| Étape | Résultat |
|---|---|
| v6 active, seuls les caches v6 présents | OK |
| Vente saisie pendant une coupure de l'API (`POST /sales` refusé) : en attente dans l'outbox | OK |
| Serveur : ancien web servi (`sw.js` v5, aucune CSP sur les pages) | OK |
| **Appareil inchangé** tant qu'il ne recontacte pas le site : v6 toujours active | OK |
| Une navigation ordinaire : le navigateur relit `sw.js`, installe et active v5, purge les caches v6 (≈ 3 s après la navigation, sur ce poste) | OK |
| Vente toujours en attente après l'activation de v5 (IndexedDB non touché par le service worker) | OK |
| Hors ligne sous v5 : `/app` → catalogue, produit visible, vente conservée ; page publique enregistrée servie | OK |
| Réseau et API revenus : la vente est synchronisée **une seule fois**, l'outbox est vidée | OK |

9/9. Procédure de reproduction : § 7.

Autres vérifications :
- `web/scripts/test-security-headers.mjs` (`pnpm --filter web test:security-headers`) :
  **7/7**. Couvre : pas de `unsafe-inline` ni `unsafe-eval` **pour les scripts** en
  production (`style-src` autorise `'unsafe-inline'`, § 3), directives
  verrouillées, origines de l'API, filtrage de `CSP_IMAGE_ORIGINS` (`*` et `javascript:`
  refusés), HSTS sans `includeSubDomains`, nonce de 128 bits.
- `tsc` web, `eslint` des fichiers web modifiés, `next build` : OK.

**Non vérifié :**
- `nginx -t` : Docker n'était pas démarré sur ce poste.
- Les scripts de recette ne sont pas dans le périmètre ESLint de l'API (déjà le cas
  auparavant) ; `node --check` passe.

**Écart de recette.** Lors d'une première exécution, avant que tous les contextes refusent cet
hôte, une page d'inscription a demandé le vrai `api.js` à `challenges.cloudflare.com`. C'est
une requête GET publique, sans donnée envoyée. Ensuite, Cloudflare et SasPay n'ont plus été
joints.

## 6. Limites

- **La CSP ne règle pas le risque du JWT dans `localStorage`.** Un script qui s'exécute malgré
  la politique lit le jeton : dépendance compromise, script autorisé détourné, scripts chargés
  par un script de confiance sous `'strict-dynamic'`. La CSP réduit l'injection de scripts,
  elle ne l'exclut pas. La migration vers des cookies n'est pas faite dans ce lot.
- **Styles et images.** `style-src 'unsafe-inline'` permet l'injection de CSS (exfiltration
  limitée par sélecteurs). Tant que `CSP_IMAGE_ORIGINS` n'est pas déclarée, `img-src https:`
  laisse un canal de sortie par URL d'image.
- **Turnstile réel non éprouvé.** La recette prouve que l'origine officielle est autorisée pour
  le script et l'iframe. Elle ne prouve pas que le vrai widget n'a besoin de rien d'autre.
  Cloudflare indique que Turnstile fonctionne avec `'strict-dynamic'` et propage le nonce ;
  `connect-src` ne lui est nécessaire qu'en mode pré-autorisation, non utilisé ici.
- **Navigateurs.** Seul Chromium a été éprouvé. Firefox, Safari et la PWA iOS restent à vérifier
  à la main.
- **Copies hors ligne.** Une copie v5 déjà présente sur un appareil est servie sans CSP jusqu'à
  l'installation de v6, qui la remplace à la première visite en ligne.
- **Production non observée** (§ 2.1). Un en-tête ajouté par l'hébergeur, en double ou
  contradictoire, reste à vérifier après déploiement.

## 7. Déploiement et retour arrière

**Ordre.**
1. **Avant le déploiement (recommandé)** : relever dans le navigateur, en production, l'hôte
   réel des photos (l'URL signée d'une image), puis déclarer sur Vercel (Production)
   `CSP_IMAGE_ORIGINS=https://<hôte exact>`. Exemple R2 :
   `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`. Sans cette variable, le repli
   `https:` évite toute casse.
2. Déployer le web (Vercel). L'API est inchangée. En Compose : reconstruire le web et recharger
   nginx (`nginx -t` d'abord).

**Après le déploiement** (navigateur privé, outils de développement) :
- `curl -sI https://<domaine>/auth/login` : CSP appliquée, un seul `Strict-Transport-Security`,
  pas de `includeSubDomains`, `Referrer-Policy: no-referrer` sur `/auth/verify-email` ;
- aucune violation dans la console sur : accueil FR/EN, connexion, **inscription avec le vrai
  Turnstile**, catalogue avec photos, temps réel, export, page d'abonnement jusqu'au départ vers
  SasPay (sans payer) ;
- PWA installée : après mise à jour du service worker, ouverture hors ligne d'une page publique
  et du catalogue.

**Retour arrière.** Deux étapes distinctes, à ne pas confondre :

1. **Serveur** : `vercel rollback` (workflow existant) ou redéploiement du commit précédent.
   Effet immédiat pour toute page chargée **par le réseau** : plus de CSP. La variable
   `CSP_IMAGE_ORIGINS` peut rester en place, car seul ce code la lit.
2. **Appareils** : un appareil qui a installé v6 la garde, avec ses copies hors ligne et leurs
   CSP, jusqu'à ce que son navigateur relise `sw.js` et y trouve v5. Cela se produit à une
   navigation **en ligne** dans le site ; la recette l'a vérifié (§ 5). Ensuite, v5
   s'installe, s'active (`skipWaiting`) et purge les caches v6. Les ventes en attente
   (IndexedDB) sont conservées puis synchronisées une seule fois.

   **Aucun délai universel n'est garanti.** Un appareil qui ne rouvre pas le site, ou qui
   reste hors ligne, reste en v6 aussi longtemps. Cet état mixte (appareil v6, serveur
   ancien) a fonctionné pendant la recette jusqu'à la navigation suivante. Le délai
   d'≈ 3 s mesuré est celui de ce poste, une fois la navigation faite ; ce n'est pas une
   promesse.

En cas de blocage ciblé, corriger la directive concernée. Ne pas passer en `Report-Only` sans
le signaler : ce mode ne protège plus rien.

**Reproduire le retour arrière en local.**
1. Lancer `recipe.js start`.
2. Avec Playwright, ouvrir un contexte autorisant les service workers, se connecter, attendre
   v6, puis saisir une vente pendant que `POST /sales` est refusé.
3. Construire l'ancien web (`git archive <commit précédent> web`, puis `prepareIsolatedWeb`
   et `next build` avec `webEnv()`) dans une copie sous la racine du dépôt.
4. Arrêter le processus web de la recette (`webPid` de l'état), puis lancer
   `next start -H 127.0.0.1 -p 3200` depuis cette copie.
5. Naviguer, contrôler les caches et l'outbox, passer hors ligne, puis rétablir le réseau.

Le script utilisé est resté hors du dépôt : il arrête un processus de la recette, ce qui
n'entre pas dans les commandes de recette documentées.

## 8. Fichiers

| Fichier | Rôle |
|---|---|
| `web/src/lib/security-headers.ts` | Politique et en-têtes fixes (module pur) |
| `web/src/proxy.ts` | Nonce et CSP par requête, composés avec le proxy de langue |
| `web/src/app/layout.tsx` | Nonce du script de thème |
| `web/next.config.ts` | En-têtes fixes globaux |
| `web/public/sw.js` | v6 : CSP conservée avec chaque document enregistré |
| `nginx/nginx.conf`, `docker-compose.prod.yml` | En-têtes de l'API et de `s3.` (Compose), `CSP_IMAGE_ORIGINS` |
| `web/scripts/test-security-headers.mjs`, `web/package.json` | Tests unitaires de la politique |
| `api/test/recipe/csp-scenarios.js`, `recipe-common.js`, `README.md` | Recette navigateur ; clé Turnstile fictive facultative ; origine des images de la recette |
