"use client";

import { useState } from "react";
import { useT } from "next-i18next/client";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useFormat } from "@/i18n/use-format";
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  Pager,
  selectClass,
  useAdminData,
} from "@/components/admin/admin-ui";
import type { AdminAuditRow, AdminPage } from "@/lib/admin/admin-api";

const ACTIONS = [
  "login_password",
  "mfa_verify",
  "mfa_recovery_code",
  "mfa_enroll_start",
  "mfa_enroll_confirm",
  "mfa_step_up",
  "mfa_factor_replace_start",
  "mfa_factor_replace_confirm",
  "recovery_codes_regenerate",
  "logout",
  "session_rejected",
  "access_grant",
  "access_revoke",
  "mfa_reset",
  "key_rotation",
  "organization_view",
  "payments_view",
  "audit_view",
  "capability_grant",
  "capability_revoke",
  "organization_suspend",
  "organization_reactivate",
  "subscription_extend",
  "organization_message",
  "organization_message_retry",
  "organization_message_archive",
  "organization_message_restore",
] as const;
type Action = (typeof ACTIONS)[number];
const OUTCOMES = ["success", "failure", "denied"] as const;

export default function AdminAuditPage() {
  const { t } = useT("admin");
  const format = useFormat();
  const [filters, setFilters] = useState({ action: "", outcome: "", page: 1 });
  const query = new URLSearchParams({ page: String(filters.page) });
  if (filters.action) query.set("action", filters.action);
  if (filters.outcome) query.set("outcome", filters.outcome);
  const { data, error, loading, retry } = useAdminData<
    AdminPage<AdminAuditRow>
  >(`audit?${query.toString()}`);
  const actionLabel = (action: string) =>
    (ACTIONS as readonly string[]).includes(action)
      ? t(`audit.actions.${action as Action}`)
      : action;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">{t("audit.title")}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("audit.notice")}
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-[16rem_12rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action">{t("audit.action")}</Label>
          <select
            id="audit-action"
            className={selectClass}
            value={filters.action}
            onChange={(event) =>
              setFilters((f) => ({ ...f, action: event.target.value, page: 1 }))
            }
          >
            <option value="">{t("audit.all")}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`audit.actions.${a}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-outcome">{t("audit.outcome")}</Label>
          <select
            id="audit-outcome"
            className={selectClass}
            value={filters.outcome}
            onChange={(event) =>
              setFilters((f) => ({
                ...f,
                outcome: event.target.value,
                page: 1,
              }))
            }
          >
            <option value="">{t("audit.all")}</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {t(`audit.outcomes.${o}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && data.items.length === 0 && (
        <AdminEmpty>{t("audit.empty")}</AdminEmpty>
      )}
      {data && data.items.length > 0 && (
        <>
          <ul className="divide-y divide-border rounded-xl ring-1 ring-foreground/10">
            {data.items.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[10rem_1.2fr_1.4fr_1fr_6rem] md:items-center md:gap-3"
              >
                <span className="text-xs text-muted-foreground">
                  {format.dateTime(entry.at)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">
                    {entry.actor?.email ??
                      entry.actorLabel ??
                      t(`audit.actorTypes.${entry.actorType}`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`audit.actorTypes.${entry.actorType}`)}
                  </span>
                </span>
                <span>{actionLabel(entry.action)}</span>
                <span
                  className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                  title={entry.detail ?? undefined}
                >
                  {[entry.targetId, entry.detail].filter(Boolean).join(" · ") ||
                    t("none")}
                </span>
                <span>
                  <Badge
                    variant={
                      entry.outcome === "success" ? "secondary" : "outline"
                    }
                  >
                    {t(`audit.outcomes.${entry.outcome}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={(page) => setFilters((f) => ({ ...f, page }))}
          />
        </>
      )}
    </div>
  );
}
