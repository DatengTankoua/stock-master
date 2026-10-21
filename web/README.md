# Stock Master — Frontend (Next.js)

Interface utilisateur de l'application **Stock Master**.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript 5
- Tailwind CSS v4 · `@base-ui/react` (composants headless) · `recharts` (graphiques)
- `socket.io-client` (mises à jour temps réel)
- `next-themes` (thème sombre/clair)
- `sonner` (notifications toast)
- PWA : manifest + service worker (`public/sw.js`)

---

## Démarrer

Le parcours complet (API, MongoDB, MinIO, premier compte) est dans le
[README racine](../README.md#démarrage-local). Depuis la racine :

```bash
pnpm --filter web dev   # http://localhost:3000 (l'API doit tourner sur :4000)
```

- **Variables.** Source de référence : [`.env.example`](.env.example), à
  copier en `.env.local`. Seule `NEXT_PUBLIC_API_URL` est obligatoire.
- **Lecture au build.** `NEXT_PUBLIC_*` et `S3_HOSTNAME` sont figées au build
  et au lancement de `pnpm dev` : relancer après une modification.
  `CSP_IMAGE_ORIGINS` est lue à l'exécution par `src/proxy.ts`.

---

## Pages

| Route | Accès | Description |
|---|---|---|
| `/` | Tous | Grille des sections racines |
| `/sections/[id]` | Tous | Sous-sections et produits d'une section |
| `/products/[id]` | Tous | Détail produit : métriques, historique ventes, journal d'audit |
| `/sales` | Tous | Historique global de toutes les ventes |
| `/analytics` | Admin | Dashboard KPIs, classements, tendance mensuelle |
| `/corbeille` | Admin | Corbeille : restauration ou suppression définitive |
| `/auth/login` | Public | Connexion JWT |
| `/auth/register` | Public | Inscription |

---

## Architecture du code

```
src/
├── app/                    # Pages Next.js (App Router)
│   ├── layout.tsx          # Layout racine (providers, navigation)
│   ├── page.tsx            # Grille des sections
│   ├── analytics/          # Dashboard analytique
│   ├── auth/               # Login / Register
│   ├── corbeille/          # Corbeille (soft delete)
│   ├── objects/            # Alias legacy (redirige vers products)
│   ├── products/[id]/      # Détail produit
│   ├── sales/              # Historique des ventes
│   └── sections/[id]/      # Produits d'une section
│
├── components/
│   ├── layout/             # Navigation, sidebar, header
│   ├── currency/           # Convertisseur EUR ↔ FCFA
│   ├── objects/            # Composants produits (cartes, formulaires)
│   ├── products/           # Métriques, tableaux ventes/audit
│   ├── sections/           # Cartes sections
│   └── ui/                 # Composants atomiques (Button, Dialog, Badge…)
│
├── contexts/
│   └── auth-context.tsx    # Contexte d'authentification global (JWT)
│
├── hooks/
│   ├── use-objects.ts      # Fetch + mutations produits (wraps api.ts)
│   ├── use-products.ts     # Alias de use-objects
│   ├── use-sections.ts     # Fetch + mutations sections
│   ├── use-socket.ts       # Connexion Socket.IO + listeners temps réel
│   └── use-trash.ts        # Fetch corbeille, restauration, suppression
│
└── lib/
    ├── api.ts              # Axios client + toutes les fonctions API typées
    ├── auth.ts             # Helpers JWT (getToken, setToken, removeToken)
    ├── currency.ts         # Conversion EUR ↔ FCFA (taux fixe 655,957)
    └── utils.ts            # Utilitaires (cn, formatDate…)
```

---

## Temps réel (WebSocket)

Le hook `useSocket` se connecte automatiquement à l'API via Socket.IO.  
Les événements `product:created`, `product:updated`, `product:deleted` et `sale:created` déclenchent un rafraîchissement des données sans rechargement de page.

## PWA

L'application est installable sur mobile et desktop. Le manifest est généré dans `src/app/manifest.ts` et le service worker dans `public/sw.js`.

---

## Référencement (SEO)

- **Domaine canonique** : `https://www.stock-master.app` (l'apex redirige vers www en production). Défini dans `src/lib/seo/public-routes.ts` (`CANONICAL_ORIGIN`) ; `SITE.url` reste le texte affiché dans les mentions légales.
- **Pages publiques bilingues** (`/`, `/guide`, `/contact`, textes juridiques, guides pratiques) : l'URL détermine toujours la langue — français sans préfixe, anglais sous `/en` (`/en`, `/en/guide`…, routes `src/app/en/*` qui réexportent les pages françaises ; langue imposée par `src/proxy.ts`) — quels que soient le cookie `stockmaster.lang` et la langue du navigateur. Le sélecteur ouvre l'URL de l'autre langue ; un bandeau propose la version `/en` quand l'anglais est choisi ou que l'appareil est réglé en anglais. `/auth` et `/app` gardent la détection cookie → navigateur → français. Le service worker range une copie hors ligne par URL (FR sans préfixe, EN sous `/en`), sauf pour les guides pratiques (registre `PRACTICAL_GUIDES` de `src/lib/legal/site-identity.ts`, contenus dans `src/i18n/documents/<page>/`).
- **Métadonnées** : `src/lib/seo/metadata.ts` (canonical de la langue rendue, hreflang `fr`/`en`/`x-default`, Open Graph et X avec `public/marketing/og-stock-master-{fr,en}.jpg`). JSON-LD (Organization, WebSite, SoftwareApplication avec les tarifs du catalogue serveur) sur l'accueil ; `Article` sur les guides pratiques (Open Graph `article`), sans auteur ni date tant qu'aucune source fiable ne les fournit.
- **`/robots.txt`** (`src/app/robots.ts`) : tout est explorable ; **`/sitemap.xml`** (`src/app/sitemap.ts`) : uniquement les pages indexables, FR et EN. Les textes juridiques à l'état « projet » sont `noindex` et absents du sitemap jusqu'à leur validation.
- **Non indexé** : `X-Robots-Tag: noindex` sur `/app`, `/auth/*`, `/access`, `/offline` (`next.config.ts`). robots.txt ne protège rien : l'accès reste contrôlé par l'API.
- **Vérification Search Console / Bing** : DNS recommandé ; sinon variables `GOOGLE_SITE_VERIFICATION` / `BING_SITE_VERIFICATION` (voir `.env.example`).
- **Images** : `scripts/generate-seo-images.ps1` régénère les aperçus de partage et le logo allégé (`/brand/stock-master-logo-horizontal-720.png`).

---

## Commandes

```bash
pnpm dev        # serveur de développement (http://localhost:3000)
pnpm build      # build de production (.next ; standalone seulement avec DOCKER_BUILD=true)
pnpm start      # démarre le build de production
pnpm lint       # ESLint
```

## Contrôles et tests

Scripts Node sans navigateur ni serveur (doublures en mémoire), depuis la
racine : `pnpm --filter web <script>`.

| Script | Vérifie | En CI |
|---|---|---|
| `test:i18n` | Mêmes clés, variables, balises et pluriels en FR et EN ; rendu anglais sans repli | Oui |
| `i18n:coverage` | Aucun texte visible écrit en dur | Oui |
| `test:push-reconnect` | Reconnexion push : rattachement sans nouvelle demande, détachement à la déconnexion, « Plus tard », refus respectés | Oui |
| `test:whatsapp-contact` | Numéro et réseaux centralisés ; encodage `wa.me` et `mailto:` (accents, retours à la ligne) ; aucun stockage ni SDK ; montage du bouton | Non |
| `test:batch-sale` | Proposition FEFO et répartition d'une vente par lots | Non |
| `test:security-headers` | En-têtes de sécurité et CSP | Non |
| `test:tenant-brand` | Couleur et nom du commerce | Non |
| `test:coordinator`, `test:catalog-refresh`, `test:products-pagination`, `test:image-renewal` | Rafraîchissement, catalogue, pagination, renouvellement des images | Non |

Le build est aussi en CI, suivi de l'archive juridique :

```bash
pnpm --filter web build
node web/scripts/legal-archive.mjs check --next-dir web/.next
```

Ce contrôle compare le texte servi des documents soumis à acceptation à son
archive ; il lance lui-même `next start`.

Les parcours navigateur (CSP, push livré au service worker, temps réel) se
lancent depuis la [recette isolée](../api/test/recipe/README.md#4-campagne-navigateur).
Ils demandent Playwright, qui n'est pas une dépendance du dépôt.

## Build production (Docker)

Le contexte de build est la **racine du dépôt** : le Dockerfile copie le
lockfile, `web/` et quelques fichiers partagés de `api/src`. Les variables
publiques sont figées au build.

```bash
docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 --build-arg S3_HOSTNAME=localhost -t stock-master-web .
```

Le build multi-stage active `output: "standalone"` (`DOCKER_BUILD=true`).

`S3_HOSTNAME` est **obligatoire** pour ce build. Le Dockerfile la transmet
même vide, et `next.config.ts` la garde alors comme nom d'hôte d'image : le
build échoue en fin de génération avec « Expected a non-empty string ». Elle
désigne l'hôte public des images (`localhost` pour un essai local).
`docker-compose.prod.yml` l'exige déjà.
