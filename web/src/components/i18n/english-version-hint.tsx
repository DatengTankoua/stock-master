"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LanguagesIcon, XIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { readLocaleCookie, useLocale } from "@/i18n/locale-provider";
import { localizedPath, publicPageOf } from "@/lib/seo/public-routes";

// Référencement — les URL publiques sans préfixe sont toujours en
// français, quels que soient le cookie et la langue du navigateur. Quand
// l'anglais a été choisi (cookie), ou sur un appareil réglé en anglais sans
// choix enregistré, un bandeau propose la version /en de la même page.
// Calculé dans le navigateur uniquement (le HTML servi est identique pour
// tous) ; fermeture mémorisée jusqu'au rechargement, sans aucun stockage.
let dismissed = false;

function prefersEnglish(): boolean {
  const saved = readLocaleCookie();
  if (saved) return saved === "en";
  const first = navigator.languages?.[0] ?? navigator.language ?? "";
  return first.toLowerCase().startsWith("en");
}

export function EnglishVersionHint() {
  // Textes toujours en anglais : ils s'adressent à un lecteur anglophone.
  const { t } = useT("public", { lng: "en" });
  const { changeLocale } = useLocale();
  const pathname = usePathname();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    const page = publicPageOf(window.location.pathname);
    const show =
      !dismissed && page !== null && page.locale === "fr" && prefersEnglish();
    // Synchronisation avec le navigateur (langue, URL), après hydratation.
    setTarget(show && page ? localizedPath(page.path, "en") : null);
  }, [pathname]);

  if (!target) return null;
  // Bandeau flottant en bas d'écran : affiché après le premier rendu, il ne
  // décale jamais le contenu de la page (aucun décalage de mise en page).
  return (
    <div
      lang="en"
      role="region"
      // Repère du bouton WhatsApp flottant, relevé tant que le bandeau est là.
      data-language-hint=""
      aria-label={t("languageHint.text")}
      className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border bg-background/95 px-4 py-2 text-center text-sm text-muted-foreground shadow-lg backdrop-blur-sm"
    >
      <LanguagesIcon className="size-4 shrink-0" aria-hidden />
      <p>{t("languageHint.text")}</p>
      <a
        href={target}
        hrefLang="en"
        className="inline-flex min-h-10 items-center font-medium text-foreground underline underline-offset-4"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          changeLocale("en");
        }}
      >
        {t("languageHint.link")}
      </a>
      <button
        type="button"
        aria-label={t("languageHint.dismiss")}
        className="inline-flex size-10 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => {
          dismissed = true;
          setTarget(null);
        }}
      >
        <XIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
