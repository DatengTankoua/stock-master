import type { ProductBatchSale } from './batches/sale-batch-summary';
import type { Types } from 'mongoose';
import {
  DelegablePermission,
  hasPermission,
  OrganizationRole,
} from '../organizations/permissions';
import {
  customLowStockThreshold,
  stockStatus,
  type StockStatus,
} from './stock-level';

/**
 * 1-12H — projection UNIQUE des informations produit selon les permissions
 * effectives. Toute réponse HTTP portant un produit passe par ici ; un champ
 * non autorisé est ABSENT (jamais remplacé par 0 ou une valeur inventée).
 *
 * - standard (tout membre autorisé à consulter) : nom, prix de vente cible,
 *   stock restant, statut, date de péremption et seuil de stock faible
 *   personnalisé (`null` : aucune date / règle par défaut) ;
 * - `products.view_stock_details` : stock initial, unités vendues ;
 * - `products.view_financials` : prix d'achat unitaire, coût total d'achat,
 *   CA réel, bénéfice réel, marge.
 */
export interface ProductVisibility {
  stockDetails: boolean;
  financials: boolean;
}

/** Diffusion commune à toute l'organisation (Socket.IO) : standard seul. */
export const COMMON_VISIBILITY: ProductVisibility = Object.freeze({
  stockDetails: false,
  financials: false,
});

export function productVisibility(context: {
  role: OrganizationRole;
  permissions: readonly DelegablePermission[];
}): ProductVisibility {
  return {
    stockDetails: hasPermission(context, 'products.view_stock_details'),
    financials: hasPermission(context, 'products.view_financials'),
  };
}

export type ProductStatus = StockStatus;

/** Champs lus sur le document (Mongoose ou objet simple). */
export interface ProductSource {
  _id: Types.ObjectId | string;
  sectionId: Types.ObjectId | string;
  name: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  expiryDate?: string | null;
  lowStockThreshold?: number | null;
  stockTracking?: 'batches' | null;
  lossTracking?: { netQuantity?: number; netValueAtCost?: number } | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Produit projeté : allowlist explicite, jamais le document brut. */
export interface ProductView {
  _id: string;
  sectionId: string;
  name: string;
  /**
   * URL de lecture calculée à chaque réponse par le service (signée à durée
   * limitée, ou ancienne URL) ; `null` sans photo lisible. Jamais lue telle
   * quelle sur le document.
   */
  imageUrl: string | null;
  salePrice: number;
  remainingQuantity: number;
  /** Date civile `AAAA-MM-JJ`, `null` sans date. */
  expiryDate: string | null;
  /** Seuil personnalisé, `null` : règle par défaut. */
  lowStockThreshold: number | null;
  /**
   * Mode de suivi du stock (standard). `batches` : quantités réparties en
   * lots ; la date de la fiche est alors `null` (dates portées par les lots).
   */
  stockTracking: 'none' | 'batches';
  deletedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  initialQuantity?: number;
  purchasePrice?: number;
}

/**
 * Métriques d'un produit. `unitsSold` = stock initial − stock restant
 * (définition inchangée, indépendante du vendeur connecté). CA réel, bénéfice
 * et marge sont calculés sur l'agrégat serveur de TOUTES les ventes du
 * produit dans l'organisation (`actualRevenue`), jamais sur une liste
 * filtrée par vendeur ou paginée.
 */
export interface ProductMetricsView {
  product: ProductView;
  status: ProductStatus;
  unitsSold?: number;
  /** Lot C — pertes nettes (unités), jamais comptées comme vendues. */
  lostQuantity?: number;
  /** Lot C — pertes nettes estimées au prix d'achat de chaque mouvement. */
  lossValueAtCost?: number;
  totalPurchaseCost?: number;
  actualRevenue?: number;
  actualProfit?: number;
  /** Bénéfice réel / CA réel × 100 ; `null` sans CA (non calculable). */
  margin?: number | null;
  /**
   * Lot B — identité des lots vendables d'un produit suivi (liste et
   * fiche, jamais les diffusions). Aucune quantité.
   */
  batchSale?: ProductBatchSale;
}

function num(value: unknown): number {
  // Garde NaN (documents malformés), comme l'ancien `withMetrics`.
  return Number(value) || 0;
}

export function computeStatus(p: ProductSource): ProductStatus {
  // `num` garde NaN (documents malformés) : comportement inchangé.
  return stockStatus({
    initialQuantity: num(p.initialQuantity),
    remainingQuantity: num(p.remainingQuantity),
    lowStockThreshold: p.lowStockThreshold,
  });
}

/** Seuil exposé : valeur personnalisée valide, sinon `null` (défaut). */
function exposedThreshold(p: ProductSource): number | null {
  return customLowStockThreshold(p.lowStockThreshold);
}

function exposedExpiryDate(p: ProductSource): string | null {
  // Suivi par lots : aucune date unique pour tout le stock.
  if (p.stockTracking === 'batches') return null;
  return typeof p.expiryDate === 'string' && p.expiryDate !== ''
    ? p.expiryDate
    : null;
}

export function toProductView(
  p: ProductSource,
  visibility: ProductVisibility,
  imageUrl: string | null,
): ProductView {
  const view: ProductView = {
    _id: p._id.toString(),
    sectionId: p.sectionId.toString(),
    name: p.name,
    imageUrl,
    salePrice: p.salePrice,
    remainingQuantity: p.remainingQuantity,
    expiryDate: exposedExpiryDate(p),
    lowStockThreshold: exposedThreshold(p),
    stockTracking: p.stockTracking === 'batches' ? 'batches' : 'none',
    deletedAt: p.deletedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  if (visibility.stockDetails) view.initialQuantity = p.initialQuantity;
  if (visibility.financials) view.purchasePrice = p.purchasePrice;
  return view;
}

/**
 * `actualRevenue` n'est requis (et lu) que si `financials` : l'appelant ne
 * calcule jamais l'agrégat des ventes pour un membre sans ce droit.
 */
export function toProductMetricsView(
  p: ProductSource,
  visibility: ProductVisibility,
  imageUrl: string | null,
  actualRevenue?: number,
): ProductMetricsView {
  const view: ProductMetricsView = {
    product: toProductView(p, visibility, imageUrl),
    status: computeStatus(p),
  };
  // Lot C : les pertes nettes (lots) ne sont jamais des ventes.
  const lost = num(p.lossTracking?.netQuantity);
  const unitsSold = num(p.initialQuantity) - num(p.remainingQuantity) - lost;
  if (visibility.stockDetails) {
    view.unitsSold = unitsSold;
    if (lost !== 0) view.lostQuantity = lost;
  }
  if (visibility.financials) {
    const buyPrice = num(p.purchasePrice);
    const revenue = num(actualRevenue);
    // Formules métier conservées (1-7B) : bénéfice réel = CA réel − prix
    // d'achat unitaire courant × unités vendues ; coût total = prix d'achat
    // × stock initial. Lot C : c'est une MARGE SUR VENTES — les pertes en
    // sont exclues (unités vendues hors pertes) et affichées à part, à leur
    // valeur estimée au moment du mouvement ; aucun bénéfice net comptable.
    if (lost !== 0) {
      view.lossValueAtCost = num(p.lossTracking?.netValueAtCost);
    }
    const profit = revenue - buyPrice * unitsSold;
    view.totalPurchaseCost = buyPrice * num(p.initialQuantity);
    view.actualRevenue = revenue;
    view.actualProfit = profit;
    view.margin = revenue > 0 ? (profit / revenue) * 100 : null;
  }
  return view;
}

/**
 * Historique d'audit (`audit.read`) : les détails qui révèlent un champ
 * restreint sont retirés selon la même visibilité (prix d'achat ; stock
 * initial et quantités ajoutées).
 */
const FINANCIAL_AUDIT_KEYS = ['purchasePrice', 'valueAtCost'];
// Lots : quantités reçues (`added`), répartition et total de la reprise.
const STOCK_DETAIL_AUDIT_KEYS = [
  'initialQuantity',
  'added',
  'allocations',
  'totalQuantity',
  // Lot C : quantités perdues / restituées, stock du lot au moment du statut.
  'lostQuantity',
  'restoredQuantity',
  'remainingQuantity',
];

export function projectAuditDetails(
  details: Record<string, unknown> | null | undefined,
  visibility: ProductVisibility,
): Record<string, unknown> | null | undefined {
  if (!details || typeof details !== 'object') return details;
  const hidden = [
    ...(visibility.financials ? [] : FINANCIAL_AUDIT_KEYS),
    ...(visibility.stockDetails ? [] : STOCK_DETAIL_AUDIT_KEYS),
  ];
  if (hidden.length === 0) return details;
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => !hidden.includes(key)),
  );
}
