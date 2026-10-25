"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import type { TFunction } from "i18next";
import {
  LayersIcon,
  PackagePlusIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useFormat } from "@/i18n/use-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  enableBatchTracking,
  fetchProductBatches,
  getApiErrorCode,
  getApiErrorMessage,
  isNetworkError,
  productBatchesEnabled,
  receiveIntoBatch,
  receiveNewBatch,
  updateProductBatch,
  type ApiProduct,
  type ApiProductBatch,
  type ApiProductBatches,
  type BatchIdentityPayload,
} from "@/lib/api";
import { hasPermission } from "@/lib/organization-permissions";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOfflineSales } from "@/contexts/offline-sales-context";
import {
  BatchLossDialog,
  BatchLossHistory,
  BatchStatusDialog,
} from "@/components/products/batch-stock-operations";

// Lots d'une fiche produit (lot A) : consultation, reprise du stock existant,
// réceptions et identité. Affiché seulement si l'API annonce la
// fonctionnalité ; chaque droit est revérifié par l'API. Les produits sans
// lots restent inchangés : une seule carte d'information.

const QUANTITY = /^\d+$/;
const BATCH_ERROR_KEYS: Record<string, string> = {
  BATCH_STOCK_CHANGED: "stockChanged",
  BATCH_ALLOCATION_MISMATCH: "allocationMismatch",
  BATCH_TRACKING_ALREADY_ENABLED: "alreadyEnabled",
  BATCH_TRACKING_NOT_ENABLED: "notEnabled",
  BATCH_NOT_FOUND: "notFound",
  BATCH_DATE_IN_FUTURE: "dateInFuture",
  BATCH_RECEIVED_ON_REQUIRED: "receivedOnRequired",
  PRODUCT_BATCH_GUARD_MISSING: "unavailable",
  PRODUCT_BATCHES_DISABLED: "unavailable",
  IDEMPOTENCY_KEY_REUSED: "retry",
  IDEMPOTENCY_KEY_CONFLICT: "retry",
};

/** Message compréhensible, jamais le détail technique d'une validation. */
function describeBatchError(error: unknown, t: TFunction<"catalog">): string {
  const code = getApiErrorCode(error);
  if (code && BATCH_ERROR_KEYS[code]) {
    return t(
      `batches.errors.${BATCH_ERROR_KEYS[code]}` as "batches.errors.retry",
    );
  }
  if (isNetworkError(error)) return getApiErrorMessage(error);
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  if (status === 400) return t("batches.errors.invalid");
  return getApiErrorMessage(error);
}

function newOperationId(): string {
  return crypto.randomUUID();
}

/**
 * Clé d'idempotence STABLE tant que la requête ne change pas : une relance
 * (réseau coupé, double clic) réutilise la même clé ; une requête modifiée
 * en reçoit une nouvelle.
 */
function useOperationKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return useCallback((body: unknown) => {
    const serialized = JSON.stringify(body);
    if (last.current?.body !== serialized) {
      last.current = { body: serialized, key: newOperationId() };
    }
    return last.current.key;
  }, []);
}

interface ProductBatchesSectionProps {
  product: ApiProduct;
  /** Relecture de la fiche après une écriture (stock, historique). */
  onChanged: () => void;
}

export function ProductBatchesSection({
  product,
  onChanged,
}: ProductBatchesSectionProps) {
  const { t } = useT("catalog");
  const format = useFormat();
  const { authContext } = useOrganizationShell();
  const enabled = productBatchesEnabled(authContext);
  const tracked = product.stockTracking === "batches";
  const can = {
    enable: hasPermission(authContext, "stock.manage_batches"),
    expiry: hasPermission(authContext, "products.manage_expiry"),
    receiveExisting: hasPermission(authContext, "stock.adjust"),
    receiveNew:
      hasPermission(authContext, "products.manage") &&
      hasPermission(authContext, "stock.adjust"),
    edit: hasPermission(authContext, "products.manage"),
    // Lot C (en ligne uniquement).
    quarantine: hasPermission(authContext, "stock.quarantine_batches"),
    losses: hasPermission(authContext, "stock.record_losses"),
    viewStock: hasPermission(authContext, "products.view_stock_details"),
  };
  const { online } = useOfflineSales();
  const [data, setData] = useState<ApiProductBatches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "enable" }
    | { kind: "receive-new" }
    | { kind: "receive"; batch: ApiProductBatch }
    | { kind: "edit"; batch: ApiProductBatch }
    | {
        kind: "status";
        batch: ApiProductBatch;
        action: "quarantine" | "release";
      }
    | { kind: "loss"; batch: ApiProductBatch }
    | null
  >(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchProductBatches(product._id));
      setError(null);
    } catch (err) {
      setError(describeBatchError(err, t));
    }
  }, [product._id, t]);

  useEffect(() => {
    if (enabled && tracked) void load();
  }, [enabled, tracked, load, product.updatedAt]);

  if (!enabled) {
    // Fonctionnalité non annoncée : rien pour un produit ordinaire.
    return tracked ? (
      <p className="text-sm text-muted-foreground">{t("batches.disabled")}</p>
    ) : null;
  }

  const done = (message: string) => (result: ApiProductBatches) => {
    setData(result);
    setDialog(null);
    toast.success(message);
    onChanged();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <LayersIcon className="h-4 w-4" aria-hidden />
          {t("batches.title")}
        </CardTitle>
        {tracked && can.receiveNew && (
          <Button size="sm" onClick={() => setDialog({ kind: "receive-new" })}>
            <PlusIcon className="mr-1 h-4 w-4" aria-hidden />
            {t("batches.newBatch")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!tracked && (
          <>
            <p className="text-muted-foreground">{t("batches.notTracked")}</p>
            {can.enable ? (
              <>
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("batches.enableWarning")}
                </p>
                <Button size="sm" onClick={() => setDialog({ kind: "enable" })}>
                  {t("batches.enable")}
                </Button>
              </>
            ) : null}
          </>
        )}

        {tracked && error && (
          <div className="flex items-center gap-3">
            <p className="text-destructive">{error}</p>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              {t("actions.retry")}
            </Button>
          </div>
        )}

        {tracked && data && (
          <>
            <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              <div>
                <dt className="inline text-muted-foreground">
                  {t("batches.nextExpiry")}
                  {t("batches.sep")}
                </dt>
                <dd className="inline font-medium">
                  {data.nextExpiryDate
                    ? format.civilDate(data.nextExpiryDate)
                    : t("batches.noKnownDate")}
                </dd>
              </div>
              {data.totalQuantity !== undefined && (
                <div>
                  <dt className="inline text-muted-foreground">
                    {t("batches.total")}
                    {t("batches.sep")}
                  </dt>
                  <dd className="inline font-medium">{data.totalQuantity}</dd>
                </div>
              )}
              {data.sellableQuantity !== undefined && (
                <div>
                  <dt className="inline text-muted-foreground">
                    {t("batches.sellableTotal")}
                    {t("batches.sep")}
                  </dt>
                  <dd className="inline font-medium">
                    {data.sellableQuantity}
                  </dd>
                </div>
              )}
              {data.expiredQuantity !== undefined &&
                data.expiredQuantity > 0 && (
                  <div className="sm:col-span-2">
                    <dt className="inline text-muted-foreground">
                      {t("batches.expiredTotal")}
                      {t("batches.sep")}
                    </dt>
                    <dd className="inline font-medium text-destructive">
                      {data.expiredQuantity}
                    </dd>
                  </div>
                )}
              {(
                [
                  ["quarantinedQuantity", "batches.quarantinedTotal"],
                  ["withdrawnQuantity", "batches.withdrawnTotal"],
                  ["lostQuantity", "batches.lostTotal"],
                ] as const
              ).map(([field, label]) =>
                (data[field] ?? 0) > 0 ? (
                  <div key={field}>
                    <dt className="inline text-muted-foreground">
                      {t(label)}
                      {t("batches.sep")}
                    </dt>
                    <dd className="inline font-medium">{data[field]}</dd>
                  </div>
                ) : null,
              )}
              {data.totalQuantity !== undefined && (
                <p className="text-muted-foreground sm:col-span-2">
                  {t("batches.thresholdNote")}
                </p>
              )}
              {data.hasUnknownExpiry && (
                <p className="text-muted-foreground sm:col-span-2">
                  {t("batches.someUnknown")}
                </p>
              )}
              {data.legacyExpiryDate && (
                <p className="text-muted-foreground sm:col-span-2">
                  {t("batches.legacyDate", {
                    date: format.civilDate(data.legacyExpiryDate),
                  })}
                </p>
              )}
            </dl>
            {data.batches.length === 0 ? (
              <p className="text-muted-foreground">{t("batches.empty")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.batches.map((batch) => (
                  <BatchRow
                    key={batch._id}
                    batch={batch}
                    onReceive={
                      can.receiveExisting && batch.status === "available"
                        ? () => setDialog({ kind: "receive", batch })
                        : undefined
                    }
                    onEdit={
                      can.edit
                        ? () => setDialog({ kind: "edit", batch })
                        : undefined
                    }
                    onStatus={
                      can.quarantine && online
                        ? (action) =>
                            setDialog({ kind: "status", batch, action })
                        : undefined
                    }
                    onLoss={
                      can.losses &&
                      online &&
                      (batch.remainingQuantity === undefined ||
                        batch.remainingQuantity > 0)
                        ? () => setDialog({ kind: "loss", batch })
                        : undefined
                    }
                  />
                ))}
              </ul>
            )}
            {!online && (can.quarantine || can.losses) && (
              <p className="text-xs text-muted-foreground">
                {t("batches.ops.onlineOnly")}
              </p>
            )}
            {can.viewStock && (
              <BatchLossHistory
                productId={product._id}
                canCorrect={can.losses}
                online={online}
                refreshKey={data}
                onChanged={done(t("batches.ops.corrected_done"))}
              />
            )}
          </>
        )}
      </CardContent>

      {dialog?.kind === "enable" && (
        <EnableTrackingDialog
          product={product}
          canExpiry={can.expiry}
          onClose={() => setDialog(null)}
          onRefresh={onChanged}
          onDone={done(t("batches.enabled"))}
        />
      )}
      {dialog?.kind === "receive-new" && data && (
        <ReceiveDialog
          productId={product._id}
          businessDate={data.businessDate}
          canExpiry={can.expiry}
          onClose={() => setDialog(null)}
          onDone={done(t("batches.received"))}
        />
      )}
      {dialog?.kind === "receive" && data && (
        <ReceiveDialog
          productId={product._id}
          businessDate={data.businessDate}
          batch={dialog.batch}
          canExpiry={can.expiry}
          onClose={() => setDialog(null)}
          onDone={done(t("batches.received"))}
        />
      )}
      {dialog?.kind === "status" && (
        <BatchStatusDialog
          productId={product._id}
          batch={dialog.batch}
          action={dialog.action}
          onClose={() => setDialog(null)}
          onDone={done(
            t(
              dialog.action === "quarantine"
                ? "batches.ops.quarantined_done"
                : "batches.ops.released_done",
            ),
          )}
        />
      )}
      {dialog?.kind === "loss" && (
        <BatchLossDialog
          productId={product._id}
          batch={dialog.batch}
          onClose={() => setDialog(null)}
          onDone={done(t("batches.ops.loss_done"))}
        />
      )}
      {dialog?.kind === "edit" && data && (
        <EditBatchDialog
          productId={product._id}
          businessDate={data.businessDate}
          batch={dialog.batch}
          canExpiry={can.expiry}
          onClose={() => setDialog(null)}
          onDone={done(t("batches.updated"))}
        />
      )}
    </Card>
  );
}

function BatchRow({
  batch,
  onReceive,
  onEdit,
  onStatus,
  onLoss,
}: {
  batch: ApiProductBatch;
  onReceive?: () => void;
  onEdit?: () => void;
  onStatus?: (action: "quarantine" | "release") => void;
  onLoss?: () => void;
}) {
  const { t } = useT("catalog");
  const format = useFormat();
  return (
    <li className="space-y-1.5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{batch.reference}</span>
        {batch.origin === "opening" &&
          !batch.expiryDate &&
          !batch.receivedOn && (
            <Badge variant="secondary">{t("batches.historical")}</Badge>
          )}
        {batch.expiryState === "expired" && (
          <Badge variant="destructive">{t("batches.expired")}</Badge>
        )}
        {batch.status === "quarantined" && (
          <Badge variant="outline">{t("batches.status.quarantined")}</Badge>
        )}
        {batch.status === "withdrawn" && (
          <Badge variant="secondary">{t("batches.status.withdrawn")}</Badge>
        )}
        {!batch.sellable &&
          batch.status === "available" &&
          batch.expiryState !== "expired" &&
          batch.remainingQuantity === 0 && (
            <Badge variant="secondary">{t("batches.status.empty")}</Badge>
          )}
        {batch.remainingQuantity !== undefined && (
          <span className="ml-auto text-sm font-medium">
            {t("batches.quantity", { count: batch.remainingQuantity })}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-3">
        <div>
          <dt className="inline text-muted-foreground">
            {t("batches.expiryDate")}
            {t("batches.sep")}
          </dt>
          <dd className="inline">
            {batch.expiryDate
              ? format.civilDate(batch.expiryDate)
              : t("batches.unknownDate")}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">
            {t("batches.receivedOn")}
            {t("batches.sep")}
          </dt>
          <dd className="inline">
            {batch.receivedOn
              ? format.civilDate(batch.receivedOn)
              : t("batches.unknownDate")}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">
            {t("batches.manufacturerLot")}
            {t("batches.sep")}
          </dt>
          <dd className="inline break-all">{batch.manufacturerLot ?? "—"}</dd>
        </div>
      </dl>
      {batch.statusChange && batch.status !== "available" && (
        <p className="text-xs text-muted-foreground">
          {t("batches.statusSince", {
            date: format.dateWith(batch.statusChange.at, {
              dateStyle: "medium",
            }),
            reason:
              batch.statusChange.reason === "loss"
                ? t("batches.statusLoss")
                : batch.statusChange.reason,
          })}
        </p>
      )}
      {(onReceive || onEdit || onStatus || onLoss) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {onReceive && (
            <Button size="sm" variant="outline" onClick={onReceive}>
              <PackagePlusIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t("batches.receive")}
            </Button>
          )}
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <PencilIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t("batches.edit")}
            </Button>
          )}
          {onStatus && batch.status === "available" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatus("quarantine")}
            >
              {t("batches.ops.quarantine")}
            </Button>
          )}
          {onStatus && batch.status !== "available" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatus("release")}
            >
              {t("batches.ops.release")}
            </Button>
          )}
          {onLoss && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={onLoss}
            >
              {t("batches.ops.loss")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Reprise du stock existant ───────────────────────────────────────────────

interface Row {
  id: number;
  quantity: string;
  expiryDate: string;
  manufacturerLot: string;
}

function EnableTrackingDialog({
  product,
  canExpiry,
  onClose,
  onRefresh,
  onDone,
}: {
  product: ApiProduct;
  canExpiry: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onDone: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const format = useFormat();
  const total = product.remainingQuantity;
  const legacy = product.expiryDate ?? null;
  const [mode, setMode] = useState<"split" | "unknown">("split");
  const [rows, setRows] = useState<Row[]>([
    { id: 1, quantity: "", expiryDate: "", manufacturerLot: "" },
  ]);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const operationKey = useOperationKey();

  const allocated = rows.reduce(
    (sum, r) => sum + (QUANTITY.test(r.quantity) ? Number(r.quantity) : 0),
    0,
  );
  const left = total - allocated;
  const update = (id: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let batches: BatchIdentityPayload[];
    if (mode === "unknown" || total === 0) {
      batches = total === 0 ? [] : [{ quantity: total }];
    } else {
      if (
        rows.some((r) => !QUANTITY.test(r.quantity) || Number(r.quantity) < 1)
      ) {
        setError(t("batches.errors.quantity"));
        return;
      }
      if (left !== 0) {
        setError(t("batches.errors.allocationMismatch"));
        return;
      }
      batches = rows.map((r) => ({
        quantity: Number(r.quantity),
        expiryDate: canExpiry && r.expiryDate ? r.expiryDate : null,
        manufacturerLot: r.manufacturerLot.trim() || null,
      }));
    }
    if (!confirmed) {
      setError(t("batches.errors.confirm"));
      return;
    }
    const body = { expectedRemainingQuantity: total, batches };
    setSaving(true);
    try {
      onDone(
        await enableBatchTracking(product._id, {
          clientOperationId: operationKey(body),
          ...body,
        }),
      );
    } catch (err) {
      setStale(getApiErrorCode(err) === "BATCH_STOCK_CHANGED");
      setError(describeBatchError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("batches.enableTitle")}</DialogTitle>
          <DialogDescription>{t("batches.enableText")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
            {t("batches.toAllocate", { count: total })}
          </p>
          {total > 0 && (
            <fieldset className="space-y-2" disabled={saving}>
              <legend className="sr-only">{t("batches.modeLabel")}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  className="mt-1"
                  checked={mode === "split"}
                  onChange={() => setMode("split")}
                />
                {t("batches.modeSplit")}
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  className="mt-1"
                  checked={mode === "unknown"}
                  onChange={() => setMode("unknown")}
                />
                {t("batches.modeUnknown")}
              </label>
            </fieldset>
          )}
          {legacy && canExpiry && mode === "split" && total > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("batches.legacyHint", { date: format.civilDate(legacy) })}
            </p>
          )}
          {mode === "unknown" && total > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("batches.unknownText", { count: total })}
            </p>
          )}
          {mode === "split" && total > 0 && (
            <div className="space-y-3">
              {rows.map((row, index) => (
                <fieldset
                  key={row.id}
                  className="space-y-2 rounded-md border p-3"
                  disabled={saving}
                >
                  <legend className="px-1 text-xs font-medium">
                    {t("batches.rowLabel", { index: index + 1 })}
                  </legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor={`b-qty-${row.id}`}>
                        {t("batches.quantityLabel")}
                      </Label>
                      <Input
                        id={`b-qty-${row.id}`}
                        type="number"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        value={row.quantity}
                        onChange={(e) =>
                          update(row.id, { quantity: e.target.value })
                        }
                      />
                    </div>
                    {canExpiry && (
                      <div className="space-y-1">
                        <Label htmlFor={`b-exp-${row.id}`}>
                          {t("batches.expiryOptional")}
                        </Label>
                        <Input
                          id={`b-exp-${row.id}`}
                          type="date"
                          min="2000-01-01"
                          max="2100-12-31"
                          value={row.expiryDate}
                          onChange={(e) =>
                            update(row.id, { expiryDate: e.target.value })
                          }
                        />
                        {legacy && row.expiryDate === "" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              update(row.id, { expiryDate: legacy })
                            }
                          >
                            {t("batches.useLegacy")}
                          </Button>
                        )}
                      </div>
                    )}
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor={`b-lot-${row.id}`}>
                        {t("batches.manufacturerOptional")}
                      </Label>
                      <Input
                        id={`b-lot-${row.id}`}
                        maxLength={64}
                        value={row.manufacturerLot}
                        onChange={(e) =>
                          update(row.id, { manufacturerLot: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setRows((prev) => prev.filter((r) => r.id !== row.id))
                      }
                    >
                      {t("batches.removeRow")}
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || rows.length >= 50}
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    {
                      id: Math.max(...prev.map((r) => r.id)) + 1,
                      quantity: left > 0 ? String(left) : "",
                      expiryDate: "",
                      manufacturerLot: "",
                    },
                  ])
                }
              >
                <PlusIcon className="mr-1 h-4 w-4" aria-hidden />
                {t("batches.addRow")}
              </Button>
              <p
                role="status"
                className={`text-sm font-medium ${
                  left === 0
                    ? "text-green-700 dark:text-green-400"
                    : "text-amber-700 dark:text-amber-400"
                }`}
              >
                {t("batches.allocated", { allocated, total, left })}
              </p>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={saving}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("batches.confirm")}
          </label>
          {error && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{error}</p>
              {stale && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onRefresh();
                    onClose();
                  }}
                >
                  {t("batches.refresh")}
                </Button>
              )}
            </div>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? t("saving") : t("batches.enableSubmit")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Réception ───────────────────────────────────────────────────────────────

function ReceiveDialog({
  productId,
  businessDate,
  batch,
  canExpiry,
  onClose,
  onDone,
}: {
  productId: string;
  businessDate: string;
  /** Lot existant désigné : quantité seule. Absent : nouveau lot. */
  batch?: ApiProductBatch;
  canExpiry: boolean;
  onClose: () => void;
  onDone: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const format = useFormat();
  const [quantity, setQuantity] = useState("");
  const [receivedOn, setReceivedOn] = useState(businessDate);
  const [expiryDate, setExpiryDate] = useState("");
  const [manufacturerLot, setManufacturerLot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const operationKey = useOperationKey();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!QUANTITY.test(quantity) || Number(quantity) < 1) {
      setError(t("batches.errors.quantity"));
      return;
    }
    if (!batch && (!receivedOn || receivedOn > businessDate)) {
      setError(t("batches.errors.dateInFuture"));
      return;
    }
    setSaving(true);
    try {
      if (batch) {
        const body = { quantity: Number(quantity) };
        onDone(
          await receiveIntoBatch(productId, batch._id, {
            ...body,
            clientOperationId: operationKey([batch._id, body]),
          }),
        );
      } else {
        const body: BatchIdentityPayload = {
          quantity: Number(quantity),
          receivedOn,
          manufacturerLot: manufacturerLot.trim() || null,
          ...(canExpiry && expiryDate ? { expiryDate } : {}),
        };
        onDone(
          await receiveNewBatch(productId, {
            ...body,
            clientOperationId: operationKey(body),
          }),
        );
      }
    } catch (err) {
      setError(describeBatchError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {batch
              ? t("batches.receiveTitle", { reference: batch.reference })
              : t("batches.newBatchTitle")}
          </DialogTitle>
          <DialogDescription>
            {batch ? t("batches.receiveText") : t("batches.newBatchText")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {batch && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs">
              {t("batches.identitySummary", {
                expiry: batch.expiryDate
                  ? format.civilDate(batch.expiryDate)
                  : t("batches.unknownDate"),
                lot: batch.manufacturerLot ?? "—",
              })}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="r-qty">{t("batches.receivedQuantity")}</Label>
            <Input
              id="r-qty"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={quantity}
              disabled={saving}
              onChange={(e) => setQuantity(e.target.value)}
              autoFocus
            />
          </div>
          {!batch && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="r-received">{t("batches.receivedOn")}</Label>
                <Input
                  id="r-received"
                  type="date"
                  min="2000-01-01"
                  max={businessDate}
                  value={receivedOn}
                  disabled={saving}
                  onChange={(e) => setReceivedOn(e.target.value)}
                />
              </div>
              {canExpiry && (
                <div className="space-y-1">
                  <Label htmlFor="r-expiry">
                    {t("batches.expiryOptional")}
                  </Label>
                  <Input
                    id="r-expiry"
                    type="date"
                    min="2000-01-01"
                    max="2100-12-31"
                    value={expiryDate}
                    disabled={saving}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="r-lot">
                  {t("batches.manufacturerOptional")}
                </Label>
                <Input
                  id="r-lot"
                  maxLength={64}
                  value={manufacturerLot}
                  disabled={saving}
                  onChange={(e) => setManufacturerLot(e.target.value)}
                />
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? t("saving") : t("batches.receiveSubmit")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Identité ────────────────────────────────────────────────────────────────

function EditBatchDialog({
  productId,
  businessDate,
  batch,
  canExpiry,
  onClose,
  onDone,
}: {
  productId: string;
  businessDate: string;
  batch: ApiProductBatch;
  canExpiry: boolean;
  onClose: () => void;
  onDone: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const [manufacturerLot, setManufacturerLot] = useState(
    batch.manufacturerLot ?? "",
  );
  const [receivedOn, setReceivedOn] = useState(batch.receivedOn ?? "");
  const [expiryDate, setExpiryDate] = useState(batch.expiryDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const payload: {
      manufacturerLot?: string | null;
      receivedOn?: string | null;
      expiryDate?: string | null;
    } = {};
    const lot = manufacturerLot.trim() || null;
    if (lot !== (batch.manufacturerLot ?? null)) payload.manufacturerLot = lot;
    const received = receivedOn || null;
    if (received !== (batch.receivedOn ?? null)) {
      if (received && received > businessDate) {
        setError(t("batches.errors.dateInFuture"));
        return;
      }
      payload.receivedOn = received;
    }
    const expiry = expiryDate || null;
    if (canExpiry && expiry !== (batch.expiryDate ?? null)) {
      payload.expiryDate = expiry;
    }
    if (Object.keys(payload).length === 0) {
      setError(t("product.noChange"));
      return;
    }
    setSaving(true);
    try {
      onDone(await updateProductBatch(productId, batch._id, payload));
    } catch (err) {
      setError(describeBatchError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("batches.editTitle", { reference: batch.reference })}
          </DialogTitle>
          <DialogDescription>{t("batches.editText")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {canExpiry && (
              <div className="space-y-1">
                <Label htmlFor="e-expiry">{t("batches.expiryOptional")}</Label>
                <Input
                  id="e-expiry"
                  type="date"
                  min="2000-01-01"
                  max="2100-12-31"
                  value={expiryDate}
                  disabled={saving}
                  onChange={(e) => setExpiryDate(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="e-received">{t("batches.receivedOn")}</Label>
              <Input
                id="e-received"
                type="date"
                min="2000-01-01"
                max={businessDate}
                value={receivedOn}
                disabled={saving}
                onChange={(e) => setReceivedOn(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="e-lot">{t("batches.manufacturerOptional")}</Label>
              <Input
                id="e-lot"
                maxLength={64}
                value={manufacturerLot}
                disabled={saving}
                onChange={(e) => setManufacturerLot(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? t("saving") : t("actions.save")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
