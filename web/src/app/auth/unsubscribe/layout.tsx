import type { Metadata } from "next";
import { getServerT } from "@/i18n/server";

// Désabonnement des e-mails promotionnels : le lien porte un jeton en query
// string. Rendu dynamique → `Cache-Control: private, no-cache, no-store` ;
// aucun référent transmis, page non indexée, aucune ressource tierce.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT("legal");
  return {
    title: `${t("unsubscribe.metaTitle")} – Stock Master`,
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default function UnsubscribeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
