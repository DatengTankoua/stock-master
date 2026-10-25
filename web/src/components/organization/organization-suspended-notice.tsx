"use client";

import Link from "next/link";
import { useT } from "next-i18next/client";
import { ShieldAlertIcon } from "lucide-react";
import { useFormat } from "@/i18n/use-format";
import { useLocalizedHref } from "@/i18n/use-localized-href";
import type { OrganizationSuspendedView } from "@/lib/api";

// Commerce suspendu par l'administration de la plateforme : espace limité
// (statut, message destiné au propriétaire, assistance). Aucune donnée du
// commerce n'est chargée. Utilisé à la connexion et dans le shell `/app`.
export function OrganizationSuspendedNotice({
  suspension,
  children,
}: {
  suspension: OrganizationSuspendedView;
  children?: React.ReactNode;
}) {
  const { t } = useT("organization");
  const format = useFormat();
  const href = useLocalizedHref();
  return (
    <section
      role="alert"
      aria-labelledby="organization-suspended-title"
      className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-left text-sm"
    >
      <div className="flex items-start gap-2">
        <ShieldAlertIcon
          className="mt-0.5 size-5 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="min-w-0">
          <h1
            id="organization-suspended-title"
            className="text-base font-semibold"
          >
            {t("suspended.title")}
          </h1>
          {suspension.organizationName && (
            <p className="break-words font-medium">
              {suspension.organizationName}
            </p>
          )}
          {suspension.suspendedAt && (
            <p className="text-xs text-muted-foreground">
              {t("suspended.since", {
                date: format.dateTime(suspension.suspendedAt),
              })}
            </p>
          )}
        </div>
      </div>
      {suspension.isOwner ? (
        <>
          {suspension.message && (
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">
                {t("suspended.messageLabel")}
              </p>
              <p className="whitespace-pre-wrap">{suspension.message}</p>
            </div>
          )}
          <p>{t("suspended.ownerText")}</p>
        </>
      ) : (
        <p>{t("suspended.memberText")}</p>
      )}
      <p className="text-muted-foreground">{t("suspended.kept")}</p>
      <p className="text-xs text-muted-foreground">{t("suspended.offline")}</p>
      <Link
        href={href("/contact")}
        className="inline-flex w-fit items-center rounded-md border px-3 py-2 font-medium hover:bg-muted"
      >
        {t("suspended.contact")}
      </Link>
      {children}
    </section>
  );
}
