import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { getServerT } from "@/i18n/server";
import { localizedHref } from "@/lib/seo/public-routes";
import {
  PUBLIC_LANGUAGE_SWITCHER_CLASS,
  PUBLIC_THEME_TOGGLE_CLASS,
} from "@/components/public/header-classes";

// 1-16C — En-tête des pages publiques secondaires (guide, contact, textes
// juridiques). Sans appel réseau ni état de session : la page reste
// identique en visite anonyme, session ouverte ou session limitée.
// 1-16F : contrôle du thème en fin d'en-tête.
// 1-21D : marges resserrées sous 640 px (zones de clic de 44 px conservées).
const linkClass =
  "inline-flex min-h-11 items-center rounded-md px-1.5 sm:px-2 text-sm font-medium text-(--brand-ink)/80 hover:text-(--brand-ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)";

export async function PublicHeader() {
  const { t, lng } = await getServerT("public");
  const href = (path: string) => localizedHref(path, lng);
  return (
    <header className="sticky top-0 z-30 border-b border-(--brand-ink)/10 bg-(--public-bg)/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        {/* 1-21D : `block min-w-0` — le lien (et la marque, `max-w-full`)
            peut rétrécir sur un téléphone étroit au lieu de déborder ; la
            navigation garde sa taille (`shrink-0`). */}
        <Link
          href={href("/")}
          className="block min-w-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--brand-ink)"
          aria-label={t("header.backHome")}
        >
          <Wordmark size="small" priority />
        </Link>
        <nav aria-label={t("header.help")} className="shrink-0">
          <ul className="flex items-center gap-0.5 sm:gap-3">
            <li>
              <Link href={href("/guide")} className={linkClass}>
                {t("header.guide")}
              </Link>
            </li>
            <li>
              <Link href={href("/contact")} className={linkClass}>
                {t("header.contact")}
              </Link>
            </li>
            <li>
              <LanguageSwitcher className={PUBLIC_LANGUAGE_SWITCHER_CLASS} />
            </li>
            <li>
              <ThemeToggle className={PUBLIC_THEME_TOGGLE_CLASS} />
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
