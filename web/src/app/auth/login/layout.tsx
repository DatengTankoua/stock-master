import type { Metadata } from "next";
import { getServerT } from "@/i18n/server";

// Titre dans la langue de la requête. Page non indexée : en-tête
// `X-Robots-Tag: noindex` posé sur /auth/* (next.config.ts).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT("auth");
  return { title: `${t("login.metaTitle")} – Stock Master` };
}

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
