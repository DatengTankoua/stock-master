import type { Metadata } from "next";
import { getServerT } from "@/i18n/server";

// Administration de la plateforme : jamais indexée, jamais en cache
// (en-têtes posés par next.config.ts, service worker exclu), rendu à la
// demande. Aucune donnée n'est lue côté serveur : tout passe par le BFF.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT("admin");
  return {
    title: `${t("metaTitle")} – Stock Master`,
    robots: { index: false, follow: false, nocache: true },
  };
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
