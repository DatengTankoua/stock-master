"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useT } from "next-i18next/client";
import { ArrowLeftIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useFormat } from "@/i18n/use-format";
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminSection,
  useAdminData,
} from "@/components/admin/admin-ui";
import { PaymentList } from "@/components/admin/payment-list";
import {
  OrganizationActions,
  OrganizationSuspensionPanel,
} from "@/components/admin/organization-actions";
import { OrganizationMessages } from "@/components/admin/organization-messages";
import {
  AdminApiError,
  type AdminOrganizationDetail,
} from "@/lib/admin/admin-api";

const NOT_FOUND = new AdminApiError(404, "PLATFORM_ADMIN_NOT_FOUND", null);
const isKind = (v: string): v is "trial" | "subscription" =>
  v === "trial" || v === "subscription";
const isSource = (v: string): v is "trial" | "manual" | "payment" | "offered" =>
  v === "trial" || v === "manual" || v === "payment" || v === "offered";
const isTerm = (
  v: string,
): v is "monthly" | "quarterly" | "semiannual" | "annual" =>
  v === "monthly" || v === "quarterly" || v === "semiannual" || v === "annual";

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children}</dd>
    </div>
  );
}

export default function AdminOrganizationPage() {
  const { t } = useT("admin");
  const format = useFormat();
  const params = useParams<{ id: string }>();
  const id = /^[0-9a-f]{24}$/.test(params.id ?? "") ? params.id : null;
  const { data, error, loading, retry } = useAdminData<AdminOrganizationDetail>(
    id ? `organizations/${id}` : null,
  );
  const megabytes = (bytes: number) =>
    `${format.number(bytes / 1_000_000, { maximumFractionDigits: 1 })} MB`;

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/admin/organizations"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        {t("organization.back")}
      </Link>
      {!id && <AdminError error={NOT_FOUND} />}
      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && (
        <>
          <header className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold">
              {data.name}
            </h1>
            <Badge variant="secondary">
              {t(`classes.${data.subscription.class}`)}
            </Badge>
            {data.status === "suspended" && (
              <Badge variant="outline">{t("status.suspended")}</Badge>
            )}
          </header>
          <OrganizationSuspensionPanel organization={data} />
          <OrganizationActions organization={data} onChanged={retry} />
          <OrganizationMessages organization={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <AdminSection title={t("organization.identity")}>
              <dl className="divide-y divide-border">
                <Row label={t("organization.slug")}>{data.slug}</Row>
                <Row label={t("organization.status")}>
                  {t(`status.${data.status}`)}
                </Row>
                <Row label={t("organization.currency")}>{data.currency}</Row>
                <Row label={t("organization.createdAt")}>
                  {format.dateTime(data.createdAt)}
                </Row>
              </dl>
            </AdminSection>
            <AdminSection title={t("organization.owner")}>
              {data.owner ? (
                <dl className="divide-y divide-border">
                  <Row label={t("login.email")}>{data.owner.email}</Row>
                  <Row label={t("organization.owner")}>{data.owner.name}</Row>
                  <Row label={t("organization.emailVerified")}>
                    {data.owner.emailVerified ? t("yes") : t("no")}
                  </Row>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("organization.ownerNone")}
                </p>
              )}
            </AdminSection>
            <AdminSection title={t("organization.members")}>
              <dl className="divide-y divide-border">
                <Row label={t("organization.roles.owner")}>
                  {format.number(data.members.owner)}
                </Row>
                <Row label={t("organization.roles.admin")}>
                  {format.number(data.members.admin)}
                </Row>
                <Row label={t("organization.roles.seller")}>
                  {format.number(data.members.seller)}
                </Row>
              </dl>
            </AdminSection>
            <AdminSection title={t("organization.quotas")}>
              <dl className="divide-y divide-border">
                <Row label={t("organization.products")}>
                  {format.number(data.quotas.products.used)} /{" "}
                  {format.number(data.quotas.products.limit)}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t("organization.trashed", {
                      count: data.quotas.products.trashed,
                    })}
                  </span>
                </Row>
                <Row label={t("organization.storage")}>
                  {data.quotas.storage
                    ? `${megabytes(data.quotas.storage.usedBytes)} / ${megabytes(data.quotas.storage.limitBytes)}`
                    : t("organization.storageUnavailable")}
                </Row>
              </dl>
            </AdminSection>
            <AdminSection title={t("organization.subscription")}>
              <dl className="divide-y divide-border">
                <Row label={t("organization.coverageEndsAt")}>
                  {data.subscription.coverageEndsAt
                    ? format.dateTime(data.subscription.coverageEndsAt)
                    : t("none")}
                </Row>
              </dl>
              <h3 className="mt-3 mb-1 text-xs font-medium text-muted-foreground">
                {t("organization.periods")}
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {data.subscription.periods.map((period) => (
                  <li
                    key={period.startsAt}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <span>
                      {isKind(period.kind)
                        ? t(`kinds.${period.kind}`)
                        : period.kind}
                      {" · "}
                      {isSource(period.source)
                        ? t(`sources.${period.source}`)
                        : period.source}
                      {period.term &&
                        ` · ${isTerm(period.term) ? t(`terms.${period.term}`) : period.term}`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {format.date(period.startsAt)} →{" "}
                      {format.date(period.endsAt)}
                      {period.current && (
                        <Badge className="ml-2" variant="secondary">
                          {t("organization.current")}
                        </Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </AdminSection>
            <AdminSection title={t("organization.features")}>
              <dl className="divide-y divide-border">
                <Row label={t("organization.productBatches")}>
                  {data.features.productBatches
                    ? t("organization.enabled")
                    : t("organization.disabled")}
                </Row>
                <Row label={t("organization.expiryAlerts")}>
                  {data.features.expiryAlerts
                    ? t("organization.enabled")
                    : t("organization.disabled")}
                </Row>
              </dl>
            </AdminSection>
          </div>
          <AdminSection title={t("organization.payments")}>
            {data.recentPayments.length === 0 ? (
              <AdminEmpty>{t("organization.noPayments")}</AdminEmpty>
            ) : (
              <>
                <PaymentList
                  payments={data.recentPayments}
                  showOrganization={false}
                />
                <Link
                  href={`/admin/payments?organizationId=${data.id}`}
                  className="mt-3 inline-block text-sm text-primary hover:underline"
                >
                  {t("organization.allPayments")}
                </Link>
              </>
            )}
          </AdminSection>
        </>
      )}
    </div>
  );
}
