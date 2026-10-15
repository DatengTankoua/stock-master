import type { MetadataRoute } from "next";
import { LOCALES } from "@/i18n/settings";
import { languageAlternates } from "@/lib/seo/metadata";
import {
  INDEXABLE_PUBLIC_PATHS,
  absoluteUrl,
  localizedPath,
} from "@/lib/seo/public-routes";

// Référencement — uniquement les pages publiques canoniques à indexer, en
// français et en anglais, avec leurs alternatives hreflang. Exclus : /app,
// /auth, /access, /offline, routes techniques et textes juridiques encore
// à l'état de « projet » (noindex). Aucune date de modification : aucune
// source fiable n'en fournit une par page.
export default function sitemap(): MetadataRoute.Sitemap {
  return INDEXABLE_PUBLIC_PATHS.flatMap((path) => {
    const languages = Object.fromEntries(
      Object.entries(languageAlternates(path)).map(([lang, href]) => [
        lang,
        absoluteUrl(href),
      ]),
    );
    return LOCALES.map((locale) => ({
      url: absoluteUrl(localizedPath(path, locale)),
      alternates: { languages },
    }));
  });
}
