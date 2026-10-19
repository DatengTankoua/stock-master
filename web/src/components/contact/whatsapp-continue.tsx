"use client";

import { useId, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { WhatsAppIcon } from "@/components/contact/whatsapp-icon";
import { useHydratedOnlineStatus } from "@/hooks/use-online-status";
import { whatsappHref } from "@/lib/whatsapp-contact";
import { cn } from "@/lib/utils";

// Contact WhatsApp — fin commune de la fenêtre publique et de la section
// Assistance : texte exact transmis (visible), avertissement, lien
// `wa.me`. Un simple lien : aucune requête avant le clic, aucun envoi depuis
// le site, aucun message marqué comme envoyé. Le texte saisi reste dans
// l'état du composant parent (jamais dans un stockage du navigateur) : il
// est conservé si WhatsApp ne s'ouvre pas. L'alternative e-mail est
// toujours affichée (aucune détection de l'application installée).
export function WhatsAppContinue({
  text,
  emailAlternative,
  className,
}: {
  /** Texte prérempli, tel qu'il sera transmis (déjà composé). */
  text: string;
  emailAlternative: React.ReactNode;
  className?: string;
}) {
  const { t } = useT("common");
  const online = useHydratedOnlineStatus();
  const [opened, setOpened] = useState(false);
  const id = useId();

  return (
    <div className={cn("space-y-3", className)}>
      {text && (
        <div className="space-y-1">
          <p id={`${id}-preview`} className="text-xs font-medium">
            {t("whatsapp.previewLabel")}
          </p>
          <p
            aria-labelledby={`${id}-preview`}
            className="max-h-32 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap"
          >
            {text}
          </p>
        </div>
      )}

      {!online && (
        <p
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
        >
          {t("whatsapp.offline")}
        </p>
      )}

      <p id={`${id}-notice`} className="text-sm text-muted-foreground">
        {t("whatsapp.notice")}
      </p>

      <a
        href={whatsappHref(text)}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={`${id}-notice`}
        onClick={() => setOpened(true)}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0b6b4a] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#095a3e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto"
      >
        <WhatsAppIcon className="size-5" />
        {t("whatsapp.continue")}
        <ExternalLinkIcon className="size-4 opacity-80" aria-hidden />
        <span className="sr-only">{t("whatsapp.newWindow")}</span>
      </a>

      <p role="status" className="text-sm empty:hidden">
        {opened ? t("whatsapp.afterOpen") : ""}
      </p>

      <div className="border-t pt-3 text-sm text-muted-foreground">
        {emailAlternative}
      </div>
    </div>
  );
}
