"use client";

import { useT } from "next-i18next/client";
import type { ApiSale } from "@/lib/api";

// Lot B — lots d'une vente (instantané figé à la vente, corrections
// comprises), affichés à qui peut consulter cette vente.
export function SaleBatchDetails({ sale }: { sale: ApiSale }) {
  const { t } = useT("sales");
  const allocations = sale.batchAllocations ?? [];
  const corrections = sale.batchHistory?.length ?? 0;
  if (
    allocations.length === 0 &&
    corrections === 0 &&
    !sale.expiredBatchRegularization
  ) {
    return null;
  }
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {allocations.length > 0 && (
        <p>
          {t("batches.saleLots", {
            list: allocations
              .map((a) => `${a.reference} × ${a.quantity}`)
              .join(", "),
          })}
        </p>
      )}
      {sale.expiredBatchRegularization && (
        <p className="text-amber-700 dark:text-amber-400">
          {t("batches.regularized", {
            reason: sale.expiredBatchRegularization.reason,
          })}
        </p>
      )}
      {corrections > 0 && (
        <p>{t("batches.corrected", { count: corrections })}</p>
      )}
    </div>
  );
}
