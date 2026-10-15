import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { getRequestLocale } from "@/i18n/server";
import en from "@/i18n/documents/contact/en";
import fr from "@/i18n/documents/contact/fr";

// 1-16G — Texte dans la langue de la requête : `i18n/documents/contact/`.
const CONTENT = { fr, en } as const;

export async function generateMetadata() {
  const locale = await getRequestLocale();
  const content = CONTENT[locale];
  return documentMetadata({
    path: "/contact",
    locale,
    title: content.metaTitle,
    description: content.metaDescription,
  });
}

export default async function ContactPage() {
  const content = CONTENT[await getRequestLocale()];
  return (
    <DocumentPage
      path={"/contact"}
      title={content.title}
      intro={content.intro}
      sections={content.sections}
    />
  );
}
