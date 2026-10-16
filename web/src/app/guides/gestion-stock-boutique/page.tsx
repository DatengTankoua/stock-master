import type { Metadata } from "next";
import { DocumentPage } from "@/components/legal/document-page";
import { JsonLd } from "@/components/seo/json-ld";
import { getRequestLocale, getServerT } from "@/i18n/server";
import type { Locale } from "@/i18n/settings";
import { SITE } from "@/lib/legal/site-identity";
import { SHARE_IMAGE, publicPageMetadata } from "@/lib/seo/metadata";
import {
  CANONICAL_ORIGIN,
  absoluteUrl,
  localizedPath,
} from "@/lib/seo/public-routes";
import type { ArticleContent } from "@/i18n/documents/types";
import en from "@/i18n/documents/gestion-stock-boutique/en";
import fr from "@/i18n/documents/gestion-stock-boutique/fr";

// Guide pratique (registre `PRACTICAL_GUIDES`) : texte dans la langue de
// l'URL (`/en/...` en anglais), gabarit des pages longues publiques.
const PATH = "/guides/gestion-stock-boutique";
const CONTENT: Record<Locale, ArticleContent> = { fr, en };

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const content = CONTENT[locale];
  const { t } = await getServerT("common");
  return publicPageMetadata({
    path: PATH,
    locale,
    title: `${content.metaTitle} — ${SITE.name}`,
    description: content.metaDescription,
    shareTitle: content.title,
    imageAlt: t("meta.shareImageAlt"),
    type: "article",
  });
}

export default async function StockManagementGuidePage() {
  const locale = await getRequestLocale();
  const content = CONTENT[locale];
  return (
    <>
      <JsonLd data={structuredData(locale, content)} />
      <DocumentPage
        path={PATH}
        title={content.title}
        intro={content.intro}
        sections={content.sections}
        closing={content.closing}
      />
    </>
  );
}

// Référencement — Article limité aux champs vérifiables : aucun auteur,
// aucune date de publication ou de modification (non connues avant la mise
// en ligne), aucun avis. Éditeur : l'organisation déclarée sur l'accueil.
function structuredData(locale: Locale, content: ArticleContent) {
  const url = absoluteUrl(localizedPath(PATH, locale));
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: content.title,
    description: content.metaDescription,
    inLanguage: locale,
    url,
    mainEntityOfPage: url,
    image: absoluteUrl(SHARE_IMAGE[locale].url),
    isPartOf: { "@id": `${CANONICAL_ORIGIN}/#website` },
    publisher: {
      "@type": "Organization",
      "@id": `${CANONICAL_ORIGIN}/#organization`,
      name: SITE.name,
      url: `${CANONICAL_ORIGIN}/`,
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl("/icons/icon-512.png"),
        width: 512,
        height: 512,
      },
    },
  };
}
