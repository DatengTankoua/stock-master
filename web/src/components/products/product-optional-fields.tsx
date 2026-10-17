"use client";

import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isExpiryPast } from "@/lib/product-expiry";

// Date de péremption et seuil de stock faible : champs facultatifs communs
// à la création et à la modification. Affichés seulement avec le droit
// propre (en plus de `products.manage`) ; l'API revérifie tout. Valeurs
// locales en texte : « vide » (aucune date / règle par défaut) reste
// distinct de « 0 » (seuil explicite).
interface ProductOptionalFieldsProps {
  idPrefix: string;
  showExpiry: boolean;
  showThreshold: boolean;
  expiryDate: string;
  onExpiryDateChange: (value: string) => void;
  threshold: string;
  onThresholdChange: (value: string) => void;
  /** Boutons d'effacement (modification d'une fiche existante). */
  clearable?: boolean;
  disabled?: boolean;
}

export function ProductOptionalFields({
  idPrefix,
  showExpiry,
  showThreshold,
  expiryDate,
  onExpiryDateChange,
  threshold,
  onThresholdChange,
  clearable = false,
  disabled = false,
}: ProductOptionalFieldsProps) {
  const { t } = useT("catalog");
  if (!showExpiry && !showThreshold) return null;
  const expiryId = `${idPrefix}-expiry`;
  const thresholdId = `${idPrefix}-threshold`;
  const past = isExpiryPast(expiryDate);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {showExpiry && (
        <div className="space-y-2">
          <Label htmlFor={expiryId}>{t("product.expiryDate")}</Label>
          <Input
            id={expiryId}
            type="date"
            min="2000-01-01"
            max="2100-12-31"
            value={expiryDate}
            disabled={disabled}
            aria-describedby={`${expiryId}-help${past ? ` ${expiryId}-past` : ""}`}
            onChange={(e) => onExpiryDateChange(e.target.value)}
          />
          <p id={`${expiryId}-help`} className="text-xs text-muted-foreground">
            {t("product.expiryHelp")}
          </p>
          {past && (
            <p
              id={`${expiryId}-past`}
              role="status"
              className="text-xs font-medium text-amber-700 dark:text-amber-400"
            >
              {t("product.expiryPastWarning")}
            </p>
          )}
          {clearable && expiryDate !== "" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onExpiryDateChange("")}
            >
              {t("product.expiryClear")}
            </Button>
          )}
        </div>
      )}
      {showThreshold && (
        <div className="space-y-2">
          <Label htmlFor={thresholdId}>{t("product.lowStockThreshold")}</Label>
          <Input
            id={thresholdId}
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={threshold}
            disabled={disabled}
            aria-describedby={`${thresholdId}-help`}
            onChange={(e) => onThresholdChange(e.target.value)}
          />
          <p
            id={`${thresholdId}-help`}
            className="text-xs text-muted-foreground"
          >
            {t("product.thresholdHelp")}
          </p>
          {clearable && threshold !== "" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onThresholdChange("")}
            >
              {t("product.thresholdReset")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Texte saisi → seuil : vide = `null` (règle par défaut), `0` conservé. */
export function parseThresholdInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
