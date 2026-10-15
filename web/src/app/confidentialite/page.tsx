import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { legalDocument } from "@/lib/legal/site-identity";
import { getRequestLocale } from "@/i18n/server";
import en from "@/i18n/documents/confidentialite/en";
import fr from "@/i18n/documents/confidentialite/fr";

// 1-16G — Texte dans la langue de la requête : `i18n/documents/confidentialite/`.
// Chaque langue publiée est archivée et vérifiée (`legal-archive.mjs`).
const CONTENT = { fr, en } as const;
const doc = legalDocument("/confidentialite");

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

export default async function ConfidentialitePage() {
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
