import { SOCIAL_LINKS, type SocialNetworkId } from "@/lib/legal/site-identity";
import { getServerT } from "@/i18n/server";
import { cn } from "@/lib/utils";

// Réseaux sociaux officiels — liens simples rendus côté serveur (pied de page
// public et page Contact). Pictogrammes tracés localement : aucun flux,
// iframe, SDK, script ni requête vers les réseaux avant un clic. Nouvel onglet
// avec `noopener noreferrer` ; nom accessible = nom du réseau.
const ICONS: Record<SocialNetworkId, React.ReactNode> = {
  facebook: (
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  ),
  instagram: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </>
  ),
  youtube: (
    <>
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
      <path d="m10 15 5-3-5-3z" />
    </>
  ),
  tiktok: <path d="M9 12a4 4 0 1 0 4 4V2a5 5 0 0 0 5 5" />,
};

export async function SocialLinks({
  headingId,
  showHeading = true,
  className,
  headingClassName,
  linkClassName,
}: {
  /** Identifiant unique du titre (plusieurs listes sur une page). */
  headingId: string;
  /** `false` quand la page porte déjà le titre (section de la page Contact). */
  showHeading?: boolean;
  className?: string;
  headingClassName?: string;
  linkClassName?: string;
}) {
  const { t } = await getServerT("public");
  return (
    <div className={className} data-testid="social-links">
      {showHeading && (
        <h2 id={headingId} className={headingClassName}>
          {t("social.title")}
        </h2>
      )}
      <ul
        aria-labelledby={showHeading ? headingId : undefined}
        aria-label={showHeading ? undefined : t("social.title")}
        // `!` : neutralise la typographie des pages de document (puces,
        // retrait, espacement et soulignement des listes et des liens).
        className={cn(
          "flex list-none! flex-wrap gap-2 space-y-0! pl-0!",
          showHeading && "mt-2",
        )}
      >
        {SOCIAL_LINKS.map((network) => (
          <li key={network.id}>
            <a
              href={network.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("social.linkLabel", { network: network.name })}
              title={network.name}
              className={cn(
                "inline-flex size-11 items-center justify-center rounded-full border border-current/20 no-underline! transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
                linkClassName,
              )}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
                aria-hidden
                focusable="false"
              >
                {ICONS[network.id]}
              </svg>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
