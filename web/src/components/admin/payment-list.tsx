"use client";

import Link from "next/link";
import { useT } from "next-i18next/client";
import { Badge } from "@/components/ui/badge";
import { useFormat } from "@/i18n/use-format";
import type { AdminPaymentRow } from "@/lib/admin/admin-api";

const STATUSES = [
  "initiating",
  "pending",
  "uncertain",
  "review",
  "succeeded",
  "failed",
] as const;
const TERMS = ["monthly", "quarterly", "semiannual", "annual"] as const;

type PaymentStatus = (typeof STATUSES)[number];
type Term = (typeof TERMS)[number];

export const PAYMENT_STATUSES = STATUSES;

/** Paiements : montant, devise, période, statut, référence ; rien d'autre. */
export function PaymentList({
  payments,
  showOrganization = true,
}: {
  payments: AdminPaymentRow[];
  showOrganization?: boolean;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const statusLabel = (status: string) =>
    (STATUSES as readonly string[]).includes(status)
      ? t(`payments.statuses.${status as PaymentStatus}`)
      : status;
  const termLabel = (term: string) =>
    (TERMS as readonly string[]).includes(term)
      ? t(`terms.${term as Term}`)
      : term;

  return (
    <ul className="divide-y divide-border rounded-xl ring-1 ring-foreground/10">
      {payments.map((payment) => (
        <li
          key={payment.id}
          className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[1fr_1.4fr_1fr_1.4fr_1fr] md:items-center md:gap-3"
        >
          <span>
            <span className="block">
              {payment.createdAt
                ? format.dateTime(payment.createdAt)
                : t("none")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {payment.provider}
            </span>
          </span>
          <span className="min-w-0">
            {showOrganization && (
              <Link
                href={`/admin/organizations/${payment.organization.id}`}
                className="block truncate font-medium hover:underline"
              >
                {payment.organization.name ?? payment.organization.id}
              </Link>
            )}
            <span
              className="block truncate font-mono text-xs text-muted-foreground"
              title={t("payments.columns.reference")}
            >
              {payment.providerReference ?? payment.merchantReference}
            </span>
          </span>
          <span>
            <span className="block font-medium tabular-nums">
              {payment.currency === "XAF"
                ? format.fcfa(payment.amount)
                : `${format.number(payment.amount)} ${payment.currency}`}
            </span>
            <span className="block text-xs text-muted-foreground">
              {termLabel(payment.term)}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {payment.period
              ? `${format.date(payment.period.startsAt)} → ${format.date(payment.period.endsAt)}`
              : t("none")}
          </span>
          <span>
            <Badge
              variant={
                payment.status === "succeeded"
                  ? "secondary"
                  : payment.status === "failed"
                    ? "outline"
                    : "default"
              }
            >
              {statusLabel(payment.status)}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}
