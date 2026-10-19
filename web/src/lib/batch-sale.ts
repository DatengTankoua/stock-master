// Lot B — logique PURE de la vente par lots (aucune E/S) : jour du commerce
// côté appareil, validité des dates, FEFO, unités déjà engagées par les
// ventes locales en attente, contrôle d'une affectation. Le serveur reste
// l'autorité : tout est revalidé à la confirmation.

import {
  reservesStock,
  type StockReservationInput,
} from "./offline-sales-policy";

export interface SaleBatchLike {
  _id: string;
  reference: string;
  expiryDate: string | null;
  manufacturerLot: string | null;
  receivedOn?: string | null;
  /** Connue seulement avec `products.view_stock_details` (et en ligne). */
  remainingQuantity?: number;
}

export interface BatchEntry {
  batchId: string;
  quantity: number;
}

/**
 * Jour du commerce vu de l'appareil : date civile de MAINTENANT dans le
 * fuseau du commerce, jamais antérieure au dernier jour annoncé par le
 * serveur (`floor`). Une horloge reculée ne rend donc jamais un lot
 * dépassé de nouveau vendable ; le changement de jour est pris en compte
 * sans attendre une vente ni une relecture.
 */
export function localBusinessDate(
  timeZone: string,
  floor: string,
  now: number = Date.now(),
): string {
  let today = floor;
  try {
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
  } catch {
    // Fuseau inconnu de l'appareil : on s'en tient au jour du serveur.
  }
  return today > floor ? today : floor;
}

export type BatchDateState = "valid" | "expires-today" | "expired" | "unknown";

export function batchDateState(
  expiryDate: string | null,
  today: string,
): BatchDateState {
  if (!expiryDate) return "unknown";
  if (expiryDate < today) return "expired";
  return expiryDate === today ? "expires-today" : "valid";
}

/** FEFO déterministe (même ordre que le serveur). */
export function compareFefo(a: SaleBatchLike, b: SaleBatchLike): number {
  const key = (v: string | null | undefined) => v ?? "9999-12-31";
  const pairs: [string, string][] = [
    [key(a.expiryDate), key(b.expiryDate)],
    [key(a.receivedOn), key(b.receivedOn)],
    [a.reference, b.reference],
    [a._id, b._id],
  ];
  for (const [x, y] of pairs) if (x !== y) return x < y ? -1 : 1;
  return 0;
}

/**
 * Lots proposables aujourd'hui : datés non dépassés (FEFO) et sans date
 * (à part). Les lots dépassés sont exclus, jamais proposés.
 */
export function classifySaleBatches<T extends SaleBatchLike>(
  batches: readonly T[],
  today: string,
): { dated: T[]; undated: T[]; expired: number } {
  const dated: T[] = [];
  const undated: T[] = [];
  let expired = 0;
  for (const batch of batches) {
    const state = batchDateState(batch.expiryDate, today);
    if (state === "expired") expired += 1;
    else if (state === "unknown") undated.push(batch);
    else dated.push(batch);
  }
  dated.sort(compareFefo);
  undated.sort(compareFefo);
  return { dated, undated, expired };
}

/**
 * Unités déjà engagées par lot par les ventes LOCALES de ce produit qui
 * réservent encore du stock (même règle que le stock indicatif).
 */
export function pendingBatchUsage(
  operations: ReadonlyArray<
    StockReservationInput & {
      payload: { batchAllocations?: BatchEntry[] };
    }
  >,
  productId: string,
  serverLoadedAt?: number,
  excludeOperationId?: string,
): Map<string, number> {
  const usage = new Map<string, number>();
  for (const op of operations) {
    if (op.payload.productId !== productId) continue;
    if (
      excludeOperationId &&
      (op as { clientOperationId?: string }).clientOperationId ===
        excludeOperationId
    ) {
      continue;
    }
    if (!reservesStock(op, serverLoadedAt)) continue;
    for (const entry of op.payload.batchAllocations ?? []) {
      usage.set(
        entry.batchId,
        (usage.get(entry.batchId) ?? 0) + entry.quantity,
      );
    }
  }
  return usage;
}

/** Quantité disponible affichable (inconnue → `undefined`). */
export function availableAfterPending(
  batch: SaleBatchLike,
  usage: ReadonlyMap<string, number>,
): number | undefined {
  if (batch.remainingQuantity === undefined) return undefined;
  return Math.max(0, batch.remainingQuantity - (usage.get(batch._id) ?? 0));
}

/**
 * Suggestion FEFO sur les lots datés : quantités connues → réparties ;
 * inconnues (vendeur sans détail du stock hors ligne) → tout sur le premier
 * lot, à confirmer. Jamais un lot sans date.
 */
export function suggestFefo(
  dated: readonly SaleBatchLike[],
  quantity: number,
  usage: ReadonlyMap<string, number> = new Map(),
): BatchEntry[] {
  if (quantity < 1 || dated.length === 0) return [];
  if (dated.every((b) => b.remainingQuantity === undefined)) {
    return [{ batchId: dated[0]._id, quantity }];
  }
  const out: BatchEntry[] = [];
  let need = quantity;
  for (const batch of dated) {
    if (need <= 0) break;
    const available = availableAfterPending(batch, usage) ?? 0;
    const take = Math.min(need, available);
    if (take > 0) {
      out.push({ batchId: batch._id, quantity: take });
      need -= take;
    }
  }
  return out;
}

export type AllocationProblem =
  "sum" | "unknown-unconfirmed" | "above-available" | null;

/** Contrôle local d'une affectation (le serveur revalide tout). */
export function allocationProblem(params: {
  entries: readonly BatchEntry[];
  quantity: number;
  undatedIds: ReadonlySet<string>;
  unknownConfirmed: boolean;
  available?: ReadonlyMap<string, number | undefined>;
}): AllocationProblem {
  const sum = params.entries.reduce((s, e) => s + e.quantity, 0);
  if (sum !== params.quantity || params.entries.some((e) => e.quantity < 1)) {
    return "sum";
  }
  if (
    !params.unknownConfirmed &&
    params.entries.some((e) => params.undatedIds.has(e.batchId))
  ) {
    return "unknown-unconfirmed";
  }
  if (
    params.available &&
    params.entries.some((e) => {
      const max = params.available!.get(e.batchId);
      return max !== undefined && e.quantity > max;
    })
  ) {
    return "above-available";
  }
  return null;
}

/** Codes serveur d'un refus de lot : actualisation proposée. */
export const BATCH_REFRESH_CODES = new Set([
  "BATCH_INSUFFICIENT",
  "BATCH_UNAVAILABLE",
  "BATCH_EXPIRED",
  "BATCH_EXPIRY_UNCONFIRMED",
  "BATCH_ALLOCATION_MISMATCH",
]);
