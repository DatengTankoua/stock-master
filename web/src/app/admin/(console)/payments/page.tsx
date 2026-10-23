"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  Pager,
  selectClass,
  useAdminData,
} from "@/components/admin/admin-ui";
import { PAYMENT_STATUSES, PaymentList } from "@/components/admin/payment-list";
import type { AdminPage, AdminPaymentRow } from "@/lib/admin/admin-api";

function Payments() {
  const { t } = useT("admin");
  const router = useRouter();
  const raw = useSearchParams().get("organizationId") ?? "";
  const organizationId = /^[0-9a-f]{24}$/.test(raw) ? raw : "";
  const [filters, setFilters] = useState({ status: "", page: 1 });
  const query = new URLSearchParams({ page: String(filters.page) });
  if (filters.status) query.set("status", filters.status);
  if (organizationId) query.set("organizationId", organizationId);
  const { data, error, loading, retry } = useAdminData<
    AdminPage<AdminPaymentRow>
  >(`payments?${query.toString()}`);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t("payments.title")}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-48 flex-col gap-1.5">
          <Label htmlFor="payment-status">{t("payments.status")}</Label>
          <select
            id="payment-status"
            className={selectClass}
            value={filters.status}
            onChange={(event) =>
              setFilters({ status: event.target.value, page: 1 })
            }
          >
            <option value="">{t("payments.all")}</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`payments.statuses.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {organizationId && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("payments.filteredBy")}
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.replace("/admin/payments")}
            >
              {t("payments.clearFilter")}
            </Button>
          </p>
        )}
      </div>
      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && data.items.length === 0 && (
        <AdminEmpty>{t("payments.empty")}</AdminEmpty>
      )}
      {data && data.items.length > 0 && (
        <>
          <PaymentList payments={data.items} />
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

export default function AdminPaymentsPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Payments />
    </Suspense>
  );
}
