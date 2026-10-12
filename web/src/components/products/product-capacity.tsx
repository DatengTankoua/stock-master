"use client";

import { useEffect, useState } from "react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { fetchProductCapacity, type ProductCapacity } from "@/lib/api";

/**
 * 1-21D — Capacité incluse : « N / plafond produits », total SERVEUR (corbeille
 * comprise), affiché aux membres qui gèrent les produits. Au plafond : rappel
 * que la corbeille est incluse ; seules les nouvelles fiches sont refusées.
 * `refreshKey` relit le total après une création depuis cet onglet. Aucun
 * affichage si le total n'est pas lisible (hors ligne, API antérieure).
 */
export function ProductCapacityNote({ refreshKey }: { refreshKey: number }) {
  const { t } = useT("catalog");
  const format = useFormat();
  const [capacity, setCapacity] = useState<ProductCapacity | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProductCapacity()
      .then((value) => {
        if (!cancelled) setCapacity(value);
      })
      .catch(() => {
        if (!cancelled) setCapacity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!capacity) return null;
  const full = capacity.used >= capacity.limit;
  return (
    <div className="space-y-1 text-xs" data-testid="product-capacity">
      <p className="text-muted-foreground tabular-nums">
        {t("capacity.count", {
          used: format.number(capacity.used),
          limit: format.number(capacity.limit),
        })}
      </p>
      {full && (
        <p
          role="status"
          className="rounded-md bg-muted px-3 py-2 text-foreground"
          data-testid="product-capacity-full"
        >
          {t("capacity.full", {
            limit: format.number(capacity.limit),
            trashed: format.number(capacity.trashed),
          })}
        </p>
      )}
    </div>
  );
}
