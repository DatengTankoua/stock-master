import type { Metadata } from "next";
import type { Locale } from "@/i18n/settings";
import { SITE } from "@/lib/legal/site-identity";
import { localizedPath } from "@/lib/seo/public-routes";

// Référencement — URL de la langue RENDUE, qui est toujours celle de l'URL
// demandée (`/en` ou non, voir `public-routes.ts`) ; alternatives hreflang
// réciproques (x-default : version française, celle des URL sans préfixe)
// et aperçu de partage. Les URL relatives sont résolues par `metadataBase`
// (layout).

/** Image de partage 1200 × 630 : logo officiel et vraie capture de l'app. */
export const SHARE_IMAGE: Record<
  Locale,
  { url: string; width: number; height: number }
> = {
  fr: { url: "/marketing/og-stock-master-fr.jpg", width: 1200, height: 630 },
  en: { url: "/marketing/og-stock-master-en.jpg", width: 1200, height: 630 },
};

const OG_LOCALE: Record<Locale, string> = { fr: "fr_FR", en: "en_GB" };

export function shareImage(locale: Locale, alt: string) {
  return { ...SHARE_IMAGE[locale], alt, type: "image/jpeg" };
}

export function languageAlternates(path: string) {
  return {
    fr: localizedPath(path, "fr"),
    en: localizedPath(path, "en"),
    "x-default": localizedPath(path, "fr"),
  };
}

export function publicPageMetadata({
  path,
  locale,
  title,
  description,
  shareTitle = title,
  shareDescription = description,
  imageAlt,
  index = true,
  type = "website",
}: {
  /** Chemin de la page sans préfixe de langue (`/`, `/guide`…). */
  path: string;
  locale: Locale;
  title: string;
  description: string;
  shareTitle?: string;
  shareDescription?: string;
  imageAlt: string;
  index?: boolean;
  /** `article` pour les guides pratiques (aucune date ni auteur ajoutés). */
  type?: "website" | "article";
}): Metadata {
  const url = localizedPath(path, locale);
  const image = shareImage(locale, imageAlt);
  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates(path) },
    openGraph: {
      type,
      siteName: SITE.name,
      url,
      title: shareTitle,
      description: shareDescription,
      locale: OG_LOCALE[locale],
      alternateLocale: [OG_LOCALE[locale === "fr" ? "en" : "fr"]],
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: shareTitle,
      description: shareDescription,
      images: [image],
    },
    ...(index ? {} : { robots: { index: false, follow: true } }),
  };
}
