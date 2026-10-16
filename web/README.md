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

## Prérequis

- Node.js 22+, pnpm 11+
- L'API NestJS doit être en cours d'exécution (voir `../api/README.md`)

## Lancer en dev

```bash
# Depuis la racine du monorepo
pnpm --filter web dev

# Ou depuis le dossier web/
pnpm dev
```

L'app est accessible sur [http://localhost:3000](http://localhost:3000).

## Variables d'environnement

```bash
cp .env.example .env.local
```

| Variable | Défaut | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | URL de l'API NestJS |

> `NEXT_PUBLIC_API_URL` est injectée **au build**. En production Docker, elle est passée via l'`ARG` du Dockerfile.

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
pnpm build      # build de production → .next/standalone
pnpm start      # démarre le build de production
pnpm lint       # ESLint
```

## Build production (Docker)

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.stock-master.app \
  -t stock-master-web \
  ./web
```

Le Dockerfile utilise un build multi-stage avec `output: 'standalone'` pour une image minimale.
