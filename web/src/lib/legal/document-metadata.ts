import type { Metadata } from "next";
import type { Locale } from "@/i18n/settings";
import { getServerT } from "@/i18n/server";
import { SITE, type PublicDocument } from "./site-identity";
import { publicPageMetadata } from "@/lib/seo/metadata";

// 1-16C — Métadonnées des pages publiques. Un document à l'état de projet
// n'est pas proposé à l'indexation (`noindex`) : il reste consultable par
// lien, mais n'apparaît pas comme texte de référence dans les moteurs.
// Référencement : URL canonique de la langue rendue, hreflang FR/EN et
// aperçu de partage (voir `lib/seo/metadata.ts`).
export async function documentMetadata({
  path,
  locale,
  title,
  description,
  doc,
}: {
  /** Chemin sans préfixe de langue (`/guide`, `/cookies`…). */
  path: string;
  locale: Locale;
  title: string;
  description: string;
  doc?: PublicDocument;
}): Promise<Metadata> {
  const { t } = await getServerT("common");
  return publicPageMetadata({
    path,
    locale,
    title: `${title} — ${SITE.name}`,
    description,
    imageAlt: t("meta.shareImageAlt"),
    index: doc?.status !== "projet",
  });
}
