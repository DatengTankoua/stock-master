"use client";

import { useState } from "react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/i18n/use-format";
import { useAdminStatus } from "@/components/admin/admin-shell";
import { AdminEmpty, AdminSection } from "@/components/admin/admin-ui";
import {
  OrganizationActionDialog,
  type OrganizationActionKind,
} from "@/components/admin/organization-action-dialog";
import type { AdminOrganizationDetail } from "@/lib/admin/admin-api";

// Fiche organisation : suspension en cours (motif interne et message au
// commerce séparés), actions autorisées par les capacités de la session,
// historique. Les boutons ne sont qu'un affichage : l'API vérifie capacité,
// session, MFA et preuve renforcée à chaque action.

export function OrganizationSuspensionPanel({
  organization,
}: {
  organization: AdminOrganizationDetail;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const suspension = organization.suspension;
  if (organization.status !== "suspended") return null;
  return (
    <section
      role="status"
      className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      <h2 className="mb-2 font-semibold text-destructive">
        {t("organization.suspendedTitle")}
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">
            {t("organization.suspendedAt")}
          </dt>
          <dd>
            {suspension?.suspendedAt
              ? format.dateTime(suspension.suspendedAt)
              : t("none")}
            {suspension?.suspendedBy && (
              <span className="block text-xs text-muted-foreground">
                {t("organization.suspendedBy")} · {suspension.suspendedBy}
              </span>
            )}
          </dd>
        </div>
        <div className="rounded-lg border border-dashed border-border bg-background p-3 sm:col-start-1">
          <dt className="text-xs text-muted-foreground">
            {t("organization.internalReason")}
          </dt>
          <dd className="whitespace-pre-wrap">
            {suspension?.internalReason ?? t("none")}
          </dd>
        </div>
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
          <dt className="text-xs text-muted-foreground">
            {t("organization.clientMessage")}
          </dt>
          <dd className="whitespace-pre-wrap">
            {suspension?.clientMessage ?? t("none")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function OrganizationActions({
  organization,
  onChanged,
}: {
  organization: AdminOrganizationDetail;
  onChanged: () => void;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const { status } = useAdminStatus();
  const [open, setOpen] = useState<OrganizationActionKind | null>(null);
  const capabilities = new Set(status.capabilities ?? []);
  const canSuspend = capabilities.has("platform.organizations.suspend");
  const canExtend = capabilities.has("platform.subscriptions.extend");
  const suspended = organization.status === "suspended";

  return (
    <>
      <AdminSection title={t("organization.actions")}>
        {canSuspend || canExtend ? (
          <div className="flex flex-wrap gap-2">
            {canSuspend && !suspended && (
              <Button variant="destructive" onClick={() => setOpen("suspend")}>
                {t("actions.suspend")}
              </Button>
            )}
            {canSuspend && suspended && (
              <Button onClick={() => setOpen("reactivate")}>
                {t("actions.reactivate")}
              </Button>
            )}
            {canExtend && (
              <Button variant="outline" onClick={() => setOpen("extend")}>
                {t("actions.extend")}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("organization.noActionCapability")}
          </p>
        )}
      </AdminSection>

      <AdminSection title={t("organization.history")}>
        {organization.actions.length === 0 ? (
          <AdminEmpty>{t("organization.noHistory")}</AdminEmpty>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {organization.actions.map((entry) => (
              <li key={entry.operationId} className="flex flex-col gap-1 py-2">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {t(`actions.names.${entry.action}`)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format.dateTime(entry.at)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.actor ?? t("none")}
                </span>
                <span className="whitespace-pre-wrap">{entry.reason}</span>
                {entry.action === "subscription_extend" &&
                  typeof entry.result.startsAt === "string" &&
                  typeof entry.result.endsAt === "string" && (
                    <span className="text-xs text-muted-foreground">
                      {t("actions.resultExtended", {
                        start: format.dateTime(entry.result.startsAt),
                        end: format.dateTime(entry.result.endsAt),
                      })}
                    </span>
                  )}
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      {open && (
        <OrganizationActionDialog
          kind={open}
          organization={organization}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          onApplied={onChanged}
        />
      )}
    </>
  );
}
