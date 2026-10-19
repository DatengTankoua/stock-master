"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { AlertTriangleIcon } from "lucide-react";
import { useFormat } from "@/i18n/use-format";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchSaleBatchOptions,
  isNetworkError,
  type ApiProductBatchSale,
  type ApiSaleBatchOptions,
} from "@/lib/api";
import {
  availableAfterPending,
  batchDateState,
  classifySaleBatches,
  localBusinessDate,
  pendingBatchUsage,
  suggestFefo,
  type BatchEntry,
  type SaleBatchLike,
} from "@/lib/batch-sale";
import type { OutboxOperation } from "@/lib/offline-sales-outbox-db";

// Lot B — choix des lots d'une vente (ou des unités ajoutées à une vente).
// En ligne : options du serveur (FEFO, suggestion plafonnée, quantités par
// lot seulement avec le détail du stock). Hors ligne : identité des lots en
// cache, validité recalculée avec le jour courant, aucune quantité. Rien
// n'est réservé : le serveur revalide tout à la confirmation.

export interface BatchPickerValue {
  /** Saisie par lot (texte brut du champ). */
  quantities: Record<string, string>;
  unknownConfirmed: boolean;
  /** Lots sans date affichés (pour le contrôle de confirmation). */
  undatedIds: Set<string>;
  /** Disponible connu par lot (après ventes locales en attente). */
  available: Map<string, number | undefined>;
  /** Référence lisible par lot affiché. */
  references: Map<string, string>;
}

/** Libellés « L-002 × 3 » d'une affectation (affichage local). */
export function labelsOf(value: BatchPickerValue): string[] {
  return entriesOf(value).map(
    (e) => `${value.references.get(e.batchId) ?? "?"} × ${e.quantity}`,
  );
}

export function entriesOf(value: BatchPickerValue): BatchEntry[] {
  return Object.entries(value.quantities)
    .filter(([, q]) => /^\d+$/.test(q.trim()) && Number(q) > 0)
    .map(([batchId, q]) => ({ batchId, quantity: Number(q) }));
}

interface BatchAllocationPickerProps {
  productId: string;
  /** Quantité à répartir (`null` : saisie invalide, rien à proposer). */
  quantity: number | null;
  online: boolean;
  /** Cache (liste des produits) : seule source hors ligne. */
  batchSale?: ApiProductBatchSale;
  /**
   * Ventes locales (outbox) : unités engagées par lot, comptées seulement
   * si la lecture serveur affichée ne les inclut pas encore.
   */
  operations: ReadonlyArray<OutboxOperation>;
  /** Opération remplacée (correction) : jamais comptée. */
  excludeOperationId?: string;
  /** Affectation initiale (correction d'un conflit). */
  initial?: BatchEntry[];
  initialUnknownConfirmed?: boolean;
  /** Incrémenté pour forcer une relecture (après un refus). */
  refreshKey?: number;
  disabled?: boolean;
  onChange: (value: BatchPickerValue) => void;
  idPrefix?: string;
}

export function BatchAllocationPicker({
  productId,
  quantity,
  online,
  batchSale,
  operations,
  excludeOperationId,
  initial,
  initialUnknownConfirmed = false,
  refreshKey = 0,
  disabled = false,
  onChange,
  idPrefix = "ba",
}: BatchAllocationPickerProps) {
  const { t } = useT("sales");
  const format = useFormat();
  const [server, setServer] = useState<ApiSaleBatchOptions | null>(null);
  // Début de la lecture serveur affichée (réservations locales : une vente
  // confirmée AVANT est déjà incluse dans ses quantités).
  const [serverLoadedAt, setServerLoadedAt] = useState<number | undefined>();
  const [serverFailed, setServerFailed] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initial ?? []).map((e) => [e.batchId, String(e.quantity)]),
    ),
  );
  const [unknownConfirmed, setUnknownConfirmed] = useState(
    initialUnknownConfirmed,
  );
  // Saisie modifiée par le vendeur : la suggestion ne l'écrase plus.
  const touched = useRef((initial?.length ?? 0) > 0);

  // Options serveur (en ligne), relues quand la quantité change.
  useEffect(() => {
    if (!online || quantity === null || quantity < 1) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const startedAt = Date.now();
      fetchSaleBatchOptions(productId, quantity)
        .then((data) => {
          if (cancelled) return;
          setServer(data);
          setServerLoadedAt(startedAt);
          setServerFailed(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setServerFailed(true);
          if (!isNetworkError(err)) setServer(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [productId, quantity, online, refreshKey]);

  const source: "server" | "cache" | "none" =
    online && server && !serverFailed ? "server" : batchSale ? "cache" : "none";

  const { dated, undated, today, expiredCount } = useMemo(() => {
    if (source === "server" && server) {
      const day = localBusinessDate(server.timeZone, server.businessDate);
      const all: SaleBatchLike[] = [...server.dated, ...server.undated];
      const c = classifySaleBatches(all, day);
      return {
        ...c,
        today: day,
        expiredCount: c.expired + server.excludedExpiredBatches,
      };
    }
    if (source === "cache" && batchSale) {
      const day = localBusinessDate(batchSale.timeZone, batchSale.businessDate);
      const c = classifySaleBatches(batchSale.batches, day);
      return { ...c, today: day, expiredCount: c.expired };
    }
    return { dated: [], undated: [], today: "", expiredCount: 0 };
  }, [source, server, batchSale]);

  const pendingUsage = useMemo(
    () =>
      pendingBatchUsage(
        operations,
        productId,
        source === "server" ? serverLoadedAt : undefined,
        excludeOperationId,
      ),
    [operations, productId, source, serverLoadedAt, excludeOperationId],
  );

  // Suggestion FEFO tant que le vendeur n'a rien modifié.
  useEffect(() => {
    if (touched.current || quantity === null || quantity < 1) return;
    const hasPending = pendingUsage.size > 0;
    const suggestion =
      source === "server" && server && !hasPending
        ? server.suggestion
        : suggestFefo(dated, quantity, pendingUsage);
    setQuantities(
      Object.fromEntries(
        suggestion.map((e) => [e.batchId, String(e.quantity)]),
      ),
    );
  }, [source, server, dated, quantity, pendingUsage]);

  const available = useMemo(() => {
    const map = new Map<string, number | undefined>();
    for (const b of [...dated, ...undated]) {
      map.set(b._id, availableAfterPending(b, pendingUsage));
    }
    return map;
  }, [dated, undated, pendingUsage]);

  // Seuls les lots affichés comptent (un lot devenu dépassé disparaît).
  useEffect(() => {
    const shown = new Set([...dated, ...undated].map((b) => b._id));
    onChange({
      quantities: Object.fromEntries(
        Object.entries(quantities).filter(([id]) => shown.has(id)),
      ),
      unknownConfirmed,
      undatedIds: new Set(undated.map((b) => b._id)),
      available,
      references: new Map(
        [...dated, ...undated].map((b) => [b._id, b.reference]),
      ),
    });
  }, [quantities, unknownConfirmed, dated, undated, available, onChange]);

  const set = (batchId: string, value: string) => {
    touched.current = true;
    setQuantities((prev) => ({ ...prev, [batchId]: value }));
  };

  const allocated = Object.entries(quantities)
    .filter(([id]) => available.has(id))
    .reduce((s, [, q]) => s + (/^\d+$/.test(q.trim()) ? Number(q) : 0), 0);
  const undatedUsed = undated.some((b) => Number(quantities[b._id] ?? 0) > 0);

  if (source === "none") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {online ? t("batches.loading") : t("batches.noCache")}
      </p>
    );
  }

  const row = (batch: SaleBatchLike) => {
    const state = batchDateState(batch.expiryDate, today);
    const max = available.get(batch._id);
    const id = `${idPrefix}-${batch._id}`;
    return (
      <li
        key={batch._id}
        className="grid grid-cols-[1fr_5.5rem] items-center gap-2 py-2"
      >
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={id} className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{batch.reference}</span>
            {state === "expires-today" && (
              <Badge
                variant="outline"
                className="text-amber-700 dark:text-amber-400"
              >
                {t("batches.expiresToday")}
              </Badge>
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {batch.expiryDate
              ? t("batches.expiry", {
                  date: format.civilDate(batch.expiryDate),
                })
              : t("batches.noExpiry")}
            {batch.manufacturerLot ? ` · ${batch.manufacturerLot}` : ""}
            {max !== undefined
              ? ` · ${t("batches.available", { count: max })}`
              : ""}
          </p>
        </div>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min="0"
          step="1"
          max={max}
          value={quantities[batch._id] ?? ""}
          placeholder="0"
          disabled={disabled}
          onChange={(e) => set(batch._id, e.target.value)}
          aria-label={t("batches.quantityFor", { reference: batch.reference })}
        />
      </li>
    );
  };

  return (
    <fieldset className="space-y-2 rounded-md border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t("batches.title")}</legend>
      <p className="text-xs text-muted-foreground">
        {source === "server"
          ? t("batches.hintOnline")
          : t("batches.hintOffline")}
      </p>
      {dated.length === 0 && undated.length === 0 ? (
        <p className="text-sm text-destructive">{t("batches.none")}</p>
      ) : null}
      {dated.length > 0 && (
        <ul className="divide-y" aria-label={t("batches.datedLabel")}>
          {dated.map(row)}
        </ul>
      )}
      {undated.length > 0 && (
        <div className="space-y-1 rounded-md bg-muted/60 p-2">
          <p className="flex items-start gap-1.5 text-xs font-medium">
            <AlertTriangleIcon
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
              aria-hidden
            />
            {t("batches.undatedWarning")}
          </p>
          <ul className="divide-y" aria-label={t("batches.undatedLabel")}>
            {undated.map(row)}
          </ul>
          {undatedUsed && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={unknownConfirmed}
                onChange={(e) => setUnknownConfirmed(e.target.checked)}
              />
              {t("batches.undatedConfirm")}
            </label>
          )}
        </div>
      )}
      {expiredCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("batches.expiredExcluded", { count: expiredCount })}
        </p>
      )}
      {dated.some((b) => b.expiryDate === today) && !online && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("batches.expiresTodayOffline")}
        </p>
      )}
      <p
        role="status"
        className={`text-sm font-medium ${
          quantity !== null && allocated === quantity
            ? "text-green-700 dark:text-green-400"
            : "text-amber-700 dark:text-amber-400"
        }`}
      >
        {t("batches.allocated", { allocated, total: quantity ?? 0 })}
      </p>
    </fieldset>
  );
}
