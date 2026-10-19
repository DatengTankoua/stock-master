"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchStockHealth,
  getApiErrorMessage,
  updateExpirySettings,
  type ApiStockHealth,
  type ApiStockHealthItem,
} from "@/lib/api";

// Lot C — « Expire bientôt », « Périmés » et pertes du mois. Jour et délai
// du commerce (serveur), stock physique : un lot mis à l'écart reste listé
// avec son état. Les pertes ne sont jamais des ventes : elles ne sont pas
// déduites du bénéfice estimé, présenté comme une marge sur ventes.

export function StockHealthSection({
  month,
  canConfigure,
}: {
  month?: string;
  canConfigure: boolean;
}) {
  const { t } = useT("analytics");
  const tr = t as unknown as (k: string, o?: object) => string;
  const format = useFormat();
  const [health, setHealth] = useState<ApiStockHealth | null>(null);
  const [failed, setFailed] = useState(false);
  const [lead, setLead] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchStockHealth(month)
      .then((data) => {
        if (cancelled) return;
        setHealth(data);
        setLead(String(data.leadDays));
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [month, reloadKey]);

  if (failed || !health) return null;

  const saveLead = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = /^\d+$/.test(lead.trim()) ? Number(lead) : -1;
    if (n < 0 || n > 365) {
      toast.error(tr("stockHealth.leadInvalid"));
      return;
    }
    setSaving(true);
    try {
      await updateExpirySettings(n);
      toast.success(tr("stockHealth.leadSaved"));
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const list = (items: ApiStockHealthItem[], expired: boolean) =>
    items.length === 0 ? (
      <p className="text-sm text-muted-foreground">
        {tr(expired ? "stockHealth.noneExpired" : "stockHealth.noneSoon")}
      </p>
    ) : (
      <ul className="divide-y rounded-lg border text-sm">
        {items.map((item) => (
          <li
            key={item.batchId ?? item.productId}
            className="flex flex-wrap items-center justify-between gap-2 p-3"
          >
            <div className="min-w-0">
              <Link
                href={`/app/catalog/products/${item.productId}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {item.productName}
              </Link>
              <p className="text-xs text-muted-foreground">
                {item.reference
                  ? `${tr("stockHealth.batch", { reference: item.reference })} · `
                  : ""}
                {tr("stockHealth.expiry", {
                  date: format.civilDate(item.expiryDate),
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {item.status && item.status !== "available" && (
                <Badge variant="outline">
                  {tr(`stockHealth.status.${item.status}`)}
                </Badge>
              )}
              {item.quantity !== undefined && (
                <span className="text-xs font-medium">
                  {tr("stockHealth.physical", { count: item.quantity })}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <section
      aria-labelledby="stock-health-title"
      className="flex flex-col gap-4 rounded-2xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="stock-health-title" className="text-lg font-semibold">
            {tr("stockHealth.title")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {tr("stockHealth.subtitle", {
              days: health.leadDays,
              date: format.civilDate(health.businessDate),
            })}
          </p>
        </div>
        {canConfigure && health.alertsEnabled && (
          <form onSubmit={saveLead} className="flex items-end gap-2" noValidate>
            <div className="space-y-1">
              <Label htmlFor="sh-lead" className="text-xs">
                {tr("stockHealth.leadLabel")}
              </Label>
              <Input
                id="sh-lead"
                type="number"
                inputMode="numeric"
                min="0"
                max="365"
                step="1"
                className="w-24"
                value={lead}
                disabled={saving}
                onChange={(e) => setLead(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={saving}>
              {tr("stockHealth.leadSave")}
            </Button>
          </form>
        )}
      </div>
      {canConfigure && health.alertsEnabled && (
        <p className="text-xs text-muted-foreground">
          {tr("stockHealth.leadHelp")}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {tr("stockHealth.soon", { count: health.soonTotal })}
          </h3>
          {list(health.soon, false)}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {tr("stockHealth.expired", { count: health.expiredTotal })}
          </h3>
          {list(health.expired, true)}
        </div>
      </div>
      {health.losses.lostQuantity !== undefined && (
        <div className="space-y-1 text-sm">
          <h3 className="font-semibold">{tr("stockHealth.lossesTitle")}</h3>
          <p>
            {tr("stockHealth.lostUnits", {
              count: health.losses.lostQuantity,
            })}
            {health.losses.lossValueAtCost !== undefined
              ? ` · ${tr("stockHealth.lossValue", {
                  amount: format.fcfa(health.losses.lossValueAtCost),
                })}`
              : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {tr("stockHealth.lossesNote")}
          </p>
        </div>
      )}
    </section>
  );
}
