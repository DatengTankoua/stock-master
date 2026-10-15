"use client";

import { useCallback } from "react";
import { useLocale } from "@/i18n/locale-provider";
import { localizedHref } from "@/lib/seo/public-routes";

// Référencement — lien vers une page publique bilingue dans la langue
// affichée (`/guide` → `/en/guide` en anglais) ; tout autre lien est rendu
// tel quel. Côté serveur : `localizedHref(href, lng)`.
export function useLocalizedHref(): (href: string) => string {
  const { locale } = useLocale();
  return useCallback((href: string) => localizedHref(href, locale), [locale]);
}
