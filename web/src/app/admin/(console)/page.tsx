"use client";

import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import {
  AdminError,
  AdminLoading,
  AdminSection,
  Stat,
  useAdminData,
} from "@/components/admin/admin-ui";
import type { AdminOverview } from "@/lib/admin/admin-api";

export default function AdminOverviewPage() {
  const { t } = useT("admin");
  const format = useFormat();
  const { data, error, loading, retry } =
    useAdminData<AdminOverview>("overview");

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">{t("overview.title")}</h1>
        {data && (
          <p className="text-xs text-muted-foreground">
            {t("overview.generatedAt", {
              date: format.dateTime(data.generatedAt),
            })}
          </p>
        )}
      </header>
      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && (
        <>
          <AdminSection title={t("overview.sections.organizations")}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label={t("overview.organizations")}
                value={format.number(data.organizations.total)}
              />
              <Stat
                label={t("overview.suspended")}
                value={format.number(data.organizations.suspended)}
              />
            </div>
          </AdminSection>
          <AdminSection title={t("overview.sections.subscriptions")}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat
                label={t("overview.trial")}
                value={format.number(data.subscriptions.trial)}
              />
              <Stat
                label={t("overview.paid")}
                value={format.number(data.subscriptions.paid)}
              />
              <Stat
                label={t("overview.offered")}
                value={format.number(data.subscriptions.offered)}
              />
              <Stat
                label={t("overview.manual")}
                value={format.number(data.subscriptions.manual)}
              />
              <Stat
                label={t("overview.scheduled")}
                value={format.number(data.subscriptions.scheduled)}
              />
              <Stat
                label={t("overview.expired")}
                value={format.number(data.subscriptions.expired)}
              />
              <Stat
                label={t("overview.noPeriod")}
                value={format.number(data.subscriptions.none)}
              />
            </div>
          </AdminSection>
          <div className="grid gap-4 lg:grid-cols-2">
            <AdminSection title={t("overview.sections.registrations")}>
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label={t("overview.last7")}
                  value={format.number(data.registrations.last7Days)}
                />
                <Stat
                  label={t("overview.last30")}
                  value={format.number(data.registrations.last30Days)}
                />
              </div>
            </AdminSection>
            <AdminSection title={t("overview.sections.revenue")}>
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label={t("overview.collected")}
                  value={format.fcfa(data.payments.collected30Days.amount)}
                  hint={t("overview.collectedCount", {
                    count: data.payments.collected30Days.count,
                  })}
                />
                <Stat
                  label={t("overview.toReview")}
                  value={format.number(data.payments.toReview)}
                />
              </div>
            </AdminSection>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("overview.definitions")}
          </p>
        </>
      )}
    </div>
  );
}
