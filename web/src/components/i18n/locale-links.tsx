"use client";

import { useLocale } from "@/i18n/locale-provider";
import { LOCALES, type Locale } from "@/i18n/settings";
import { localizedPath } from "@/lib/seo/public-routes";

// Nom de chaque langue écrit dans cette langue (jamais traduit).
const NATIVE_NAMES: Record<Locale, string> = {
  fr: "Français",
  en: "English",
};

// Référencement — liens « Français / English » vers la même page publique
// dans chaque langue : de vrais liens (`hreflang`), lisibles par les robots
// sans JavaScript. Au clic, le choix est enregistré comme avec le
// sélecteur (cookie), puis la page de la langue choisie est ouverte.
export function LocaleLinks({
  path,
  label,
  className,
}: {
  /** Page affichée, sans préfixe de langue. */
  path: string;
  label: string;
  className?: string;
}) {
  const { locale: current, changeLocale } = useLocale();
  return (
    <nav aria-label={label}>
      <ul className="flex gap-4">
        {LOCALES.map((locale) => (
          <li key={locale}>
            <a
              href={localizedPath(path, locale)}
              hrefLang={locale}
              lang={locale}
              aria-current={locale === current ? "page" : undefined}
              className={className}
              onClick={(event) => {
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                changeLocale(locale);
              }}
            >
              {NATIVE_NAMES[locale]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
