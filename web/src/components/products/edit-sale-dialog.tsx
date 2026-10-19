"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateSale,
  deleteSale,
  fetchProductBatches,
  getApiErrorMessage,
  type ApiProductBatch,
  type ApiProductBatchSale,
  type ApiSale,
  type BatchQuantityEntry,
  type LegacyRestitutionPayload,
} from "@/lib/api";
import {
  BatchAllocationPicker,
  entriesOf,
  type BatchPickerValue,
} from "@/components/products/batch-allocation-picker";
import { allocationProblem } from "@/lib/batch-sale";
import { hasPermission } from "@/lib/organization-permissions";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOfflineSales } from "@/contexts/offline-sales-context";
import { SaleBatchDetails } from "@/components/sales/sale-batch-details";

interface EditSaleDialogProps {
  sale: ApiSale | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUpdated: () => void;
  onDeleted: () => void;
  // Lot B : produit suivi par lots (corrections par lots).
  batchTracked?: boolean;
  productId?: string;
  batchSale?: ApiProductBatchSale;
}

const INT = /^\d+$/;
const toInt = (v: string | undefined) =>
  v !== undefined && INT.test(v.trim()) ? Number(v) : 0;

/**
 * Lot B — destinations des unités d'origine inconnue (vente antérieure au
 * suivi par lots) : lots existants du produit ou « lot historique, date
 * inconnue » confirmé, avec motif. Jamais une réception.
 */
interface LegacyState {
  quantities: Record<string, string>;
  historical: string;
  historicalConfirmed: boolean;
  reason: string;
}

function emptyLegacy(): LegacyState {
  return {
    quantities: {},
    historical: "",
    historicalConfirmed: false,
    reason: "",
  };
}

function legacyTotal(s: LegacyState): number {
  return (
    Object.values(s.quantities).reduce((sum, q) => sum + toInt(q), 0) +
    toInt(s.historical)
  );
}

function legacyPayload(s: LegacyState): LegacyRestitutionPayload {
  const restitutions = Object.entries(s.quantities)
    .filter(([, q]) => toInt(q) > 0)
    .map(([batchId, q]) => ({ batchId, quantity: toInt(q) }));
  return {
    ...(restitutions.length ? { restitutions } : {}),
    ...(toInt(s.historical) > 0
      ? {
          historicalRestitution: {
            quantity: toInt(s.historical),
            confirmed: true as const,
          },
        }
      : {}),
    restitutionReason: s.reason.trim(),
  };
}

function LegacyRestitutionFields({
  units,
  destinations,
  canRestitute,
  canCreateHistorical,
  value,
  onChange,
  idPrefix,
}: {
  units: number;
  destinations: ApiProductBatch[] | null;
  canRestitute: boolean;
  canCreateHistorical: boolean;
  value: LegacyState;
  onChange: (v: LegacyState) => void;
  idPrefix: string;
}) {
  const { t } = useT("sales");
  const format = useFormat();
  if (!canRestitute) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("edit.legacyNoRight")}
      </p>
    );
  }
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">
        {t("edit.legacyTitle")}
      </legend>
      <p className="text-xs text-muted-foreground">{t("edit.legacyText")}</p>
      {destinations === null ? (
        <p className="text-xs text-muted-foreground">{t("batches.loading")}</p>
      ) : (
        <ul className="divide-y">
          {destinations.map((b) => (
            <li
              key={b._id}
              className="grid grid-cols-[1fr_5.5rem] items-center gap-2 py-2"
            >
              <Label htmlFor={`${idPrefix}-${b._id}`} className="block">
                <span className="font-semibold">{b.reference}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {b.expiryDate
                    ? t("batches.expiry", {
                        date: format.civilDate(b.expiryDate),
                      })
                    : t("batches.noExpiry")}
                </span>
              </Label>
              <Input
                id={`${idPrefix}-${b._id}`}
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                placeholder="0"
                aria-label={t("edit.destinationFor", {
                  reference: b.reference,
                })}
                value={value.quantities[b._id] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    quantities: {
                      ...value.quantities,
                      [b._id]: e.target.value,
                    },
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
      {canCreateHistorical && (
        <div className="space-y-1 rounded-md bg-muted/60 p-2">
          <Label htmlFor={`${idPrefix}-historical`}>
            {t("edit.historical")}
          </Label>
          <Input
            id={`${idPrefix}-historical`}
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            placeholder="0"
            value={value.historical}
            onChange={(e) => onChange({ ...value, historical: e.target.value })}
          />
          {toInt(value.historical) > 0 && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={value.historicalConfirmed}
                onChange={(e) =>
                  onChange({ ...value, historicalConfirmed: e.target.checked })
                }
              />
              {t("edit.historicalConfirm")}
            </label>
          )}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-reason`}>{t("edit.reason")}</Label>
        <Input
          id={`${idPrefix}-reason`}
          maxLength={200}
          value={value.reason}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
        />
      </div>
      <p
        role="status"
        className={`text-sm font-medium ${
          legacyTotal(value) === units
            ? "text-green-700 dark:text-green-400"
            : "text-amber-700 dark:text-amber-400"
        }`}
      >
        {t("batches.allocated", {
          allocated: legacyTotal(value),
          total: units,
        })}
      </p>
    </fieldset>
  );
}

function legacyError(
  s: LegacyState,
  units: number,
  t: (
    key:
      | "edit.errors.legacy"
      | "edit.errors.reason"
      | "edit.errors.historicalConfirm",
  ) => string,
): string | null {
  if (legacyTotal(s) !== units) return t("edit.errors.legacy");
  if (toInt(s.historical) > 0 && !s.historicalConfirmed) {
    return t("edit.errors.historicalConfirm");
  }
  if (s.reason.trim().length < 3) return t("edit.errors.reason");
  return null;
}

export function EditSaleDialog({
  sale,
  open,
  onOpenChange,
  onUpdated,
  onDeleted,
  batchTracked = false,
  productId,
  batchSale,
}: EditSaleDialogProps) {
  const { t } = useT("sales");
  const format = useFormat();
  const { authContext } = useOrganizationShell();
  const { online, operations } = useOfflineSales();
  const [quantity, setQuantity] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lot B.
  const [returns, setReturns] = useState<Record<string, string>>({});
  const [legacy, setLegacy] = useState<LegacyState>(emptyLegacy);
  const [cancelLegacy, setCancelLegacy] = useState<LegacyState>(emptyLegacy);
  const [added, setAdded] = useState<BatchPickerValue | null>(null);
  const [destinations, setDestinations] = useState<ApiProductBatch[] | null>(
    null,
  );
  const onAdded = useCallback((v: BatchPickerValue) => setAdded(v), []);

  const allocations = useMemo(() => sale?.batchAllocations ?? [], [sale]);
  const isBatchSale = batchTracked || allocations.length > 0;
  const allocatedTotal = allocations.reduce((s, a) => s + a.quantity, 0);
  const unknownOrigin = sale ? sale.quantity - allocatedTotal : 0;
  const canRestitute = hasPermission(authContext, "stock.adjust");
  const canCreateHistorical =
    canRestitute && hasPermission(authContext, "products.manage");

  const newQty = INT.test(quantity.trim()) ? Number(quantity) : null;
  const delta = sale && newQty !== null ? newQty - sale.quantity : 0;
  const giveBack = delta < 0 ? -delta : 0;
  const returnedTotal = Object.values(returns).reduce(
    (s, q) => s + toInt(q),
    0,
  );
  const legacyUnits = Math.max(
    0,
    giveBack - Math.min(giveBack, allocatedTotal),
  );

  useEffect(() => {
    if (sale) {
      setQuantity(String(sale.quantity));
      setSalePrice(String(sale.salePrice));
      setReturns({});
      setLegacy(emptyLegacy());
      setCancelLegacy(emptyLegacy());
      setError(null);
    }
  }, [sale]);

  // Diminution : retours proposés à partir des derniers lots affectés.
  useEffect(() => {
    if (giveBack === 0) {
      setReturns({});
      return;
    }
    let need = Math.min(giveBack, allocatedTotal);
    const next: Record<string, string> = {};
    for (const a of [...allocations].reverse()) {
      if (need <= 0) break;
      const take = Math.min(need, a.quantity);
      next[a.batchId] = String(take);
      need -= take;
    }
    setReturns(next);
  }, [giveBack, allocatedTotal, allocations]);

  // Destinations possibles (unités d'origine inconnue).
  const needsDestinations =
    isBatchSale &&
    unknownOrigin > 0 &&
    (legacyUnits > 0 || deleteOpen) &&
    canRestitute &&
    Boolean(productId);
  useEffect(() => {
    if (!needsDestinations || !productId || destinations !== null) return;
    fetchProductBatches(productId)
      .then((data) =>
        setDestinations(data.batches.filter((b) => b.status !== "withdrawn")),
      )
      .catch(() => setDestinations([]));
  }, [needsDestinations, productId, destinations]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sale) return;
    setError(null);
    const payload: Parameters<typeof updateSale>[1] = {
      quantity: parseInt(quantity, 10),
      salePrice: parseFloat(salePrice),
    };
    if (isBatchSale && newQty !== null && delta !== 0) {
      if (delta < 0) {
        const returnsEntries: BatchQuantityEntry[] = Object.entries(returns)
          .filter(([, q]) => toInt(q) > 0)
          .map(([batchId, q]) => ({ batchId, quantity: toInt(q) }));
        if (returnedTotal + legacyUnits !== giveBack) {
          setError(t("edit.errors.returns"));
          return;
        }
        if (returnsEntries.length) payload.batchReturns = returnsEntries;
        if (legacyUnits > 0) {
          const problem = legacyError(legacy, legacyUnits, t);
          if (problem) {
            setError(problem);
            return;
          }
          Object.assign(payload, legacyPayload(legacy));
        }
      } else {
        const problem = added
          ? allocationProblem({
              entries: entriesOf(added),
              quantity: delta,
              undatedIds: added.undatedIds,
              unknownConfirmed: added.unknownConfirmed,
              available: added.available,
            })
          : "sum";
        if (problem) {
          setError(
            t(
              problem === "unknown-unconfirmed"
                ? "batches.errors.unknownUnconfirmed"
                : problem === "above-available"
                  ? "batches.errors.aboveAvailable"
                  : "batches.errors.sum",
            ),
          );
          return;
        }
        payload.batchAllocations = entriesOf(added!);
        if (entriesOf(added!).some((x) => added!.undatedIds.has(x.batchId))) {
          payload.unknownExpiryConfirmed = true;
        }
      }
    }
    setLoading(true);
    try {
      await updateSale(sale._id, payload);
      toast.success(t("edit.updated"));
      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (e?: React.MouseEvent) => {
    if (!sale) return;
    let restitution: LegacyRestitutionPayload | undefined;
    if (isBatchSale && unknownOrigin > 0) {
      const problem = legacyError(cancelLegacy, unknownOrigin, t);
      if (problem) {
        e?.preventDefault();
        setError(problem);
        return;
      }
      restitution = legacyPayload(cancelLegacy);
    }
    setDeleteLoading(true);
    try {
      await deleteSale(sale._id, restitution);
      toast.success(t("edit.deleted"));
      setDeleteOpen(false);
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      e?.preventDefault();
      setError(getApiErrorMessage(err));
    } finally {
      setDeleteLoading(false);
    }
  };

  const qty = parseInt(quantity || "1", 10);
  const price = parseFloat(salePrice || "0");
  const total = !isNaN(qty) && !isNaN(price) ? qty * price : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("edit.title")}</DialogTitle>
          </DialogHeader>
          {sale && (
            <form onSubmit={handleSubmit} className="space-y-4 mt-2" noValidate>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="es-qty">{t("form.quantity")}</Label>
                  <Input
                    id="es-qty"
                    type="number"
                    min="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="es-price">{t("edit.price")}</Label>
                  <Input
                    id="es-price"
                    type="number"
                    min="0"
                    step="1"
                    value={salePrice}
                    onChange={(e) => setSalePrice(e.target.value)}
                    required
                  />
                  {total > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("form.total", { amount: format.fcfa(total) })}
                    </p>
                  )}
                </div>
              </div>

              {isBatchSale && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("edit.batchesTitle")}
                  </p>
                  <SaleBatchDetails sale={sale} />
                  {unknownOrigin > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("batches.originUnknown")}
                    </p>
                  )}
                </div>
              )}

              {isBatchSale && giveBack > 0 && allocations.length > 0 && (
                <fieldset className="space-y-2 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">
                    {t("edit.returnsTitle", { count: giveBack })}
                  </legend>
                  <ul className="divide-y">
                    {allocations.map((a) => (
                      <li
                        key={a.batchId}
                        className="grid grid-cols-[1fr_5.5rem] items-center gap-2 py-2"
                      >
                        <Label htmlFor={`es-ret-${a.batchId}`}>
                          <span className="font-semibold">{a.reference}</span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("edit.soldFromBatch", { count: a.quantity })}
                          </span>
                        </Label>
                        <Input
                          id={`es-ret-${a.batchId}`}
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max={a.quantity}
                          step="1"
                          value={returns[a.batchId] ?? ""}
                          placeholder="0"
                          aria-label={t("batches.quantityFor", {
                            reference: a.reference,
                          })}
                          onChange={(e) =>
                            setReturns((prev) => ({
                              ...prev,
                              [a.batchId]: e.target.value,
                            }))
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}

              {isBatchSale && legacyUnits > 0 && (
                <LegacyRestitutionFields
                  units={legacyUnits}
                  destinations={destinations}
                  canRestitute={canRestitute}
                  canCreateHistorical={canCreateHistorical}
                  value={legacy}
                  onChange={(v) => {
                    setLegacy(v);
                    setError(null);
                  }}
                  idPrefix="es-leg"
                />
              )}

              {isBatchSale && delta > 0 && productId && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t("edit.addTitle")}</p>
                  <BatchAllocationPicker
                    productId={productId}
                    quantity={delta}
                    online={online}
                    batchSale={batchSale}
                    operations={operations}
                    onChange={onAdded}
                    idPrefix="es-add"
                  />
                </div>
              )}

              {error && !deleteOpen && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2Icon className="mr-1 h-4 w-4" />
                  {t("actions.delete")}
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button type="submit" disabled={loading}>
                    {loading ? t("form.saving") : t("actions.save")}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("edit.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {isBatchSale && sale
                ? unknownOrigin > 0
                  ? t("edit.deleteLegacyText", { count: unknownOrigin })
                  : t("edit.deleteBatchText", {
                      list: allocations
                        .map((a) => `${a.reference} × ${a.quantity}`)
                        .join(", "),
                    })
                : t("edit.deleteText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {isBatchSale && unknownOrigin > 0 && (
            <LegacyRestitutionFields
              units={unknownOrigin}
              destinations={destinations}
              canRestitute={canRestitute}
              canCreateHistorical={canCreateHistorical}
              value={cancelLegacy}
              onChange={(v) => {
                setCancelLegacy(v);
                setError(null);
              }}
              idPrefix="es-cancel"
            />
          )}
          {error && deleteOpen && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={
                deleteLoading ||
                (isBatchSale && unknownOrigin > 0 && !canRestitute)
              }
            >
              {deleteLoading ? t("edit.deleting") : t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
