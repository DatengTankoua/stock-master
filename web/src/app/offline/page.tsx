"use client";

import { WifiOffIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

// 1-22C.1 : pages préparées hors ligne par le service worker. Liens HTML
// simples (jamais `Link`) : le document est servi par le cache, sans
// requête de données Next.js.
const OFFLINE_LINKS = [
  { href: "/", key: "home" },
  { href: "/#tarifs", key: "pricing" },
  { href: "/guide", key: "guide" },
  { href: "/contact", key: "contact" },
  { href: "/conditions-utilisation", key: "terms" },
  { href: "/app/catalog", key: "catalog" },
] as const;

// Page de repli hors connexion (1-11A) : servie par le service worker
// (public/sw.js) quand une navigation échoue sans réseau (1-22C.1 : toute
// page non préparée, y compris sous /app). Aucune donnée métier, aucune
// mutation ni appel réseau déclenché ici.
export default function OfflinePage() {
  const { t } = useT("common");
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      {/* 1-16F : thème disponible aussi hors connexion (préférence locale).
          1-16G : langue aussi (ressources déjà dans le bundle). */}
      <div className="absolute top-3 right-3 flex items-center gap-1">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      <Wordmark size="medium" />
      <WifiOffIcon className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-bold">{t("offline.title")}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        {t("offline.text")}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white"
        style={{ backgroundColor: "var(--brand-solid)" }}
      >
        {t("actions.retry")}
      </button>
      <nav aria-labelledby="offline-available" className="mt-2 max-w-sm">
        <h2 id="offline-available" className="text-sm font-semibold">
          {t("offline.availableTitle")}
        </h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {OFFLINE_LINKS.map(({ href, key }) => (
            <li key={key}>
              <a href={href} className="underline underline-offset-4">
                {t(`offline.links.${key}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
