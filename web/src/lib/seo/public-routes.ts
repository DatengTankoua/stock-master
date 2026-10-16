import {
  HELP_PAGES,
  LEGAL_DOCUMENTS,
  PRACTICAL_GUIDES,
} from "@/lib/legal/site-identity";
import type { Locale } from "@/i18n/settings";

// Référencement — URL publiques bilingues. Module sans dépendance lourde :
// chargé par le proxy (chaque requête), le rendu serveur et le navigateur.
//
// L'URL détermine TOUJOURS la langue d'une page publique bilingue, quels
// que soient le cookie de préférence et la langue du navigateur :
// - français : URL sans préfixe (`/`, `/guide`…) ;
// - anglais : mêmes pages sous `/en` (`/en`, `/en/guide`…), routes
//   `app/en/*` qui réexportent les pages françaises.
// Un robot reçoit donc toujours la langue déclarée par hreflang. /auth,
// /app et les autres routes ne sont pas concernées (cookie, sinon
// navigateur, sinon français).

/**
 * Origine canonique publique. En production, `stock-master.app` redirige
 * (308) vers `www.stock-master.app` : canonical, hreflang, sitemap et
 * Open Graph pointent donc vers www. `SITE.url` (texte des mentions
 * légales, archivé) reste inchangé.
 */
export const CANONICAL_ORIGIN = "https://www.stock-master.app";

export const EN_PREFIX = "/en";

/**
 * Pages publiques disponibles en français et en anglais. Les guides
 * pratiques n'ont pas de copie hors ligne : `public/sw.js` (BILINGUAL_PAGES)
 * ne prépare que l'accueil, les pages d'aide et les textes juridiques.
 */
export const LOCALIZED_PUBLIC_PATHS: readonly string[] = Object.freeze([
  "/",
  ...HELP_PAGES.map((page) => page.href),
  ...PRACTICAL_GUIDES.map((page) => page.href),
  ...LEGAL_DOCUMENTS.map((doc) => doc.href),
]);

const LOCALIZED = new Set(LOCALIZED_PUBLIC_PATHS);

/**
 * Pages proposées à l'indexation (sitemap). Un texte juridique à l'état de
 * « projet » reste consultable mais non indexé (`noindex`, voir
 * `document-metadata.ts`) : il n'entre dans le sitemap qu'une fois validé.
 */
export function isIndexablePublicPath(path: string): boolean {
  if (!LOCALIZED.has(path)) return false;
  const doc = LEGAL_DOCUMENTS.find((d) => d.href === path);
  return !doc || doc.status !== "projet";
}

export const INDEXABLE_PUBLIC_PATHS: readonly string[] = Object.freeze(
  LOCALIZED_PUBLIC_PATHS.filter(isIndexablePublicPath),
);

export function isLocalizedPublicPath(pathname: string): boolean {
  return LOCALIZED.has(pathname);
}

/** `/en/guide` → `/guide`, `/en` → `/` ; `null` pour toute autre URL. */
export function englishBasePath(pathname: string): string | null {
  if (pathname === EN_PREFIX) return "/";
  if (!pathname.startsWith(`${EN_PREFIX}/`)) return null;
  const base = pathname.slice(EN_PREFIX.length);
  return LOCALIZED.has(base) ? base : null;
}

/** Chemin d'une page publique bilingue dans une langue. */
export function localizedPath(path: string, locale: Locale): string {
  if (locale !== "en") return path;
  return path === "/" ? EN_PREFIX : `${EN_PREFIX}${path}`;
}

/**
 * Lien vers une page publique dans la langue affichée (ancre et paramètres
 * conservés). Tout autre lien est rendu tel quel.
 */
export function localizedHref(href: string, locale: Locale): string {
  if (!href.startsWith("/")) return href;
  const match = /^([^?#]*)(.*)$/.exec(href);
  const path = match?.[1] || "/";
  if (!LOCALIZED.has(path)) return href;
  return `${localizedPath(path, locale)}${match?.[2] ?? ""}`;
}

/**
 * Page publique bilingue désignée par un chemin du navigateur, et sa
 * langue, toujours imposée par l'URL (`en` sous `/en`, `fr` sinon).
 */
export function publicPageOf(
  pathname: string,
): { path: string; locale: Locale } | null {
  const english = englishBasePath(pathname);
  if (english) return { path: english, locale: "en" };
  return LOCALIZED.has(pathname) ? { path: pathname, locale: "fr" } : null;
}

export function absoluteUrl(path: string): string {
  return `${CANONICAL_ORIGIN}${path}`;
}
