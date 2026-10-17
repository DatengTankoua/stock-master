import { stockLowReached } from '../push/stock-thresholds';

/**
 * Seuil de stock faible et statut de stock : source UNIQUE pour le statut
 * des produits (catalogue, fiche), la page Analyse, les alertes et leur
 * revalidation avant envoi.
 *
 * - Seuil personnalisé (`lowStockThreshold`, nombre ≥ 0) : stock faible
 *   quand la quantité restante est STRICTEMENT inférieure au seuil. `0` est
 *   une valeur explicite : le produit n'est jamais « faible », seule la
 *   rupture est signalée.
 * - Seuil absent (`null` ou champ inexistant) : règle par défaut EXISTANTE,
 *   inchangée (1-16A.1, `stockLowReached`) : 80 % ou plus de la quantité
 *   initiale consommés, soit un restant ≤ 20 % de `initialQuantity`, qui
 *   inclut les ajouts de stock. Comparaison exacte sur entiers, identique
 *   à l'ancienne division `restant / initial <= 0.2` du statut pour des
 *   quantités entières (celles saisies par l'interface).
 * - Rupture (restant à 0) : traitement inchangé, prioritaire sur le stock
 *   faible.
 */
export interface StockLevel {
  initialQuantity: number;
  remainingQuantity: number;
  lowStockThreshold?: number | null;
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/** Seuil personnalisé valide (sinon : règle par défaut). */
export function customLowStockThreshold(
  value: number | null | undefined,
): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function isLowStock(level: StockLevel): boolean {
  const threshold = customLowStockThreshold(level.lowStockThreshold);
  if (threshold !== null) {
    return (
      Number.isFinite(level.remainingQuantity) &&
      level.remainingQuantity < threshold
    );
  }
  return stockLowReached(level.initialQuantity, level.remainingQuantity);
}

export function stockStatus(level: StockLevel): StockStatus {
  if (level.remainingQuantity === 0) return 'out_of_stock';
  return isLowStock(level) ? 'low_stock' : 'in_stock';
}

/**
 * Alerte due pour UNE écriture atomique (valeurs avant / après de la même
 * opération) :
 * - `depleted` : passage réel d'un stock positif à zéro ;
 * - `low` : ENTRÉE dans l'état de stock faible (faible après, pas avant),
 *   stock encore positif. Rester sous le seuil ne déclenche rien ; en
 *   sortir (réapprovisionnement, correction, seuil abaissé) réarme
 *   l'alerte suivante. Un changement de seuil est une écriture comme une
 *   autre : il n'alerte que s'il fait entrer le produit dans l'état faible.
 * La rupture est prioritaire : jamais deux alertes pour la même écriture.
 */
export function stockAlertFor(
  before: StockLevel,
  after: StockLevel,
): 'depleted' | 'low' | null {
  if (before.remainingQuantity > 0 && after.remainingQuantity === 0) {
    return 'depleted';
  }
  if (after.remainingQuantity > 0 && !isLowStock(before) && isLowStock(after)) {
    return 'low';
  }
  return null;
}
