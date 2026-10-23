"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "next-i18next/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type {
  AdminOrganizationRow,
  AdminPage,
  SubscriptionClass,
} from "@/lib/admin/admin-api";

const CLASSES: SubscriptionClass[] = [
  "trial",
  "paid",
  "manual",
  "scheduled",
  "expired",
  "none",
];

export default function AdminOrganizationsPage() {
  const { t } = useT("admin");
  const format = useFormat();
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState({
    q: "",
    status: "",
    subscription: "",
    page: 1,
  });
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);
  if (filters.subscription) query.set("subscription", filters.subscription);
  query.set("page", String(filters.page));
  const { data, error, loading, retry } = useAdminData<
    AdminPage<AdminOrganizationRow>
  >(`organizations?${query.toString()}`);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t("organizations.title")}</h1>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((f) => ({ ...f, q: draft.trim().slice(0, 60), page: 1 }));
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-search">{t("organizations.search")}</Label>
          <Input
            id="org-search"
            type="search"
            maxLength={60}
            placeholder={t("organizations.searchPlaceholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-status">{t("organizations.status")}</Label>
          <select
            id="org-status"
            className={selectClass}
            value={filters.status}
            onChange={(event) =>
              setFilters((f) => ({ ...f, status: event.target.value, page: 1 }))
            }
          >
            <option value="">{t("organizations.all")}</option>
            <option value="active">{t("status.active")}</option>
            <option value="suspended">{t("status.suspended")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-subscription">
            {t("organizations.subscription")}
          </Label>
          <select
            id="org-subscription"
            className={selectClass}
            value={filters.subscription}
            onChange={(event) =>
              setFilters((f) => ({
                ...f,
                subscription: event.target.value,
                page: 1,
              }))
            }
          >
            <option value="">{t("organizations.all")}</option>
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {t(`classes.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">{t("organizations.search")}</Button>
      </form>

      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && data.items.length === 0 && (
        <AdminEmpty>{t("organizations.empty")}</AdminEmpty>
      )}
      {data && data.items.length > 0 && (
        <>
          <ul className="divide-y divide-border rounded-xl ring-1 ring-foreground/10">
            <li className="hidden grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
              <span>{t("organizations.columns.name")}</span>
              <span>{t("organizations.columns.createdAt")}</span>
              <span>{t("organizations.columns.subscription")}</span>
              <span>{t("organizations.columns.coverage")}</span>
              <span>{t("organizations.columns.members")}</span>
            </li>
            {data.items.map((org) => (
              <li key={org.id}>
                <Link
                  href={`/admin/organizations/${org.id}`}
                  className="grid gap-1 px-4 py-3 text-sm hover:bg-muted md:grid-cols-[2fr_1fr_1fr_1fr_1fr] md:items-center md:gap-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {org.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {org.slug}
                      {org.status === "suspended" &&
                        ` · ${t("status.suspended")}`}
                    </span>
                  </span>
                  <span className="text-muted-foreground md:text-foreground">
                    <span className="md:hidden">
                      {t("organizations.columns.createdAt")} ·{" "}
                    </span>
                    {format.date(org.createdAt)}
                  </span>
                  <span>
                    <Badge
                      variant={
                        org.subscription === "expired" ||
                        org.subscription === "none"
                          ? "outline"
                          : "secondary"
                      }
                    >
                      {t(`classes.${org.subscription}`)}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground md:text-foreground">
                    <span className="md:hidden">
                      {t("organizations.columns.coverage")} ·{" "}
                    </span>
                    {org.coverageEndsAt
                      ? format.date(org.coverageEndsAt)
                      : t("none")}
                  </span>
                  <span className="text-muted-foreground md:text-foreground">
                    <span className="md:hidden">
                      {t("organizations.columns.members")} ·{" "}
                    </span>
                    {format.number(org.activeMembers)}
                  </span>
                </Link>
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
