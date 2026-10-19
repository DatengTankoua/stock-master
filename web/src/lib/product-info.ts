import type { TFunction } from "i18next";
import { isExpiryPast } from "@/lib/product-expiry";

// 1-12H — source UNIQUE des informations produit affichées (fiche, cartes,
// modal du catalogue, hors ligne). Ne décide rien : l'API a déjà projeté le
// produit selon les permissions effectives, un champ absent n'est jamais
// rendu (ni remplacé par 0) — aucune condition contradictoire par vue.

export type ProductInfoKey =
  | "salePrice"
  | "stock"
  | "expiryDate"
  | "stockTracking"
  | "lowStockThreshold"
  | "initialQuantity"
  | "unitsSold"
  | "purchasePrice"
  | "totalPurchaseCost"
  | "actualRevenue"
  | "lostQuantity"
  | "lossValueAtCost"
  | "actualProfit"
  | "margin";

// 1-16G : libellés dans `catalog` (`info.*`), montants formatés par
// l'appelant selon la langue (devise inchangée).
export interface ProductInfoFormat {
  t: TFunction<"catalog">;
  fcfa: (amount: number) => string;
  /** Date civile `AAAA-MM-JJ` localisée, sans décalage de fuseau. */
  civilDate: (value: string) => string;
}

export interface ProductInfoItem {
  key: ProductInfoKey;
  label: string;
  value: string;
  tone?: "positive" | "negative";
}

/** Champs lus : tous optionnels sauf le standard (prix cible, stock). */
export interface ProductInfoSource {
  salePrice: number;
  remainingQuantity: number;
  expiryDate?: string | null;
  stockTracking?: "none" | "batches";
  lowStockThreshold?: number | null;
  initialQuantity?: number;
  unitsSold?: number;
  purchasePrice?: number;
  totalPurchaseCost?: number;
  actualRevenue?: number;
  actualProfit?: number;
  lostQuantity?: number;
  lossValueAtCost?: number;
  margin?: number | null;
}

export interface IndicativeStock {
  value: number;
  hasReservation: boolean;
}

export function productInfoItems(
  product: ProductInfoSource,
  stock: IndicativeStock,
  format: ProductInfoFormat,
  options: { showServerStock?: boolean } = {},
): ProductInfoItem[] {
  const { t, fcfa } = format;
  const items: ProductInfoItem[] = [
    {
      key: "salePrice",
      label: t("info.salePrice"),
      value: fcfa(product.salePrice),
    },
    {
      key: "stock",
      // Comportement 1-11C.3 conservé : stock serveur moins ventes locales
      // non confirmées, libellé « Stock indicatif » s'il y en a.
      label: stock.hasReservation
        ? t("info.indicativeStock")
        : t("info.remainingStock"),
      value:
        stock.hasReservation && options.showServerStock
          ? t("info.withServerStock", {
              value: stock.value,
              server: product.remainingQuantity,
            })
          : String(stock.value),
    },
  ];
  // Date de péremption : seulement si renseignée ; « dépassée » au plus tôt
  // le lendemain de la date (jour civil de l'appareil).
  if (product.expiryDate) {
    const past = isExpiryPast(product.expiryDate);
    items.push({
      key: "expiryDate",
      label: t("info.expiryDate"),
      value: past
        ? t("info.expiryPast", { date: format.civilDate(product.expiryDate) })
        : format.civilDate(product.expiryDate),
      ...(past ? { tone: "negative" as const } : {}),
    });
  }
  // Suivi par lots : aucune date unique pour tout le stock (dates des lots
  // dans la section « Lots » de la fiche).
  if (product.stockTracking === "batches") {
    items.push({
      key: "stockTracking",
      label: t("info.stockTracking"),
      value: t("info.byBatches"),
    });
  }
  // Seuil : personnalisé (valeur, `0` compris) ou règle par défaut ; absent
  // (API antérieure) : rien n'est affiché.
  if (product.lowStockThreshold !== undefined) {
    items.push({
      key: "lowStockThreshold",
      label: t("info.lowStockThreshold"),
      value:
        product.lowStockThreshold === null
          ? t("info.thresholdDefault")
          : t("info.thresholdCustom", { count: product.lowStockThreshold }),
    });
  }
  if (product.initialQuantity !== undefined) {
    items.push({
      key: "initialQuantity",
      label: t("info.initialQuantity"),
      value: String(product.initialQuantity),
    });
  }
  if (product.unitsSold !== undefined) {
    items.push({
      key: "unitsSold",
      label: t("info.unitsSold"),
      value: String(product.unitsSold),
    });
  }
  if (product.purchasePrice !== undefined) {
    items.push({
      key: "purchasePrice",
      label: t("info.purchasePrice"),
      value: fcfa(product.purchasePrice),
    });
  }
  if (product.totalPurchaseCost !== undefined) {
    items.push({
      key: "totalPurchaseCost",
      label: t("info.totalPurchaseCost"),
      value: fcfa(product.totalPurchaseCost),
    });
  }
  if (product.actualRevenue !== undefined) {
    items.push({
      key: "actualRevenue",
      label: t("info.actualRevenue"),
      value: fcfa(product.actualRevenue),
    });
  }
  // Lot C : pertes affichées À PART (jamais des ventes) ; le bénéfice est
  // alors explicitement une marge sur ventes, hors pertes.
  if (product.lostQuantity !== undefined) {
    items.push({
      key: "lostQuantity",
      label: t("info.lostQuantity"),
      value: String(product.lostQuantity),
    });
  }
  if (product.lossValueAtCost !== undefined) {
    items.push({
      key: "lossValueAtCost",
      label: t("info.lossValueAtCost"),
      value: fcfa(product.lossValueAtCost),
      tone: "negative",
    });
  }
  if (product.actualProfit !== undefined) {
    items.push({
      key: "actualProfit",
      label:
        product.lostQuantity !== undefined
          ? t("info.actualProfitExclLosses")
          : t("info.actualProfit"),
      value: fcfa(product.actualProfit),
      tone: product.actualProfit >= 0 ? "positive" : "negative",
    });
  }
  if (product.margin !== undefined) {
    items.push({
      key: "margin",
      label: t("info.margin"),
      // `null` = aucun CA : marge non calculable (affichage historique « — »).
      value: product.margin === null ? "—" : `${product.margin.toFixed(1)}%`,
    });
  }
  return items;
}
