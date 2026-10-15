import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { legalDocument } from "@/lib/legal/site-identity";
import { getRequestLocale } from "@/i18n/server";
import en from "@/i18n/documents/cookies/en";
import fr from "@/i18n/documents/cookies/fr";

// 1-16G — Texte dans la langue de la requête : `i18n/documents/cookies/`.
// Document non soumis à acceptation : pas d'archive (statut « projet »).
const CONTENT = { fr, en } as const;
const doc = legalDocument("/cookies");

export async function generateMetadata() {
  const locale = await getRequestLocale();
  const content = CONTENT[locale];
  return documentMetadata({
    path: doc.href,
    locale,
    title: content.metaTitle,
    description: content.metaDescription,
    doc,
  });
}

export default async function CookiesPage() {
  const content = CONTENT[await getRequestLocale()];
  return (
    <DocumentPage
      path={doc.href}
      title={content.title}
      doc={doc}
      intro={content.intro}
      sections={content.sections}
    />
  );
}
