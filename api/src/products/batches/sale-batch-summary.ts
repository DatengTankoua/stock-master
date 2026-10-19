import { Model, Types } from 'mongoose';
import { processTimeZone } from '../../analytics/month-range';
import type { ProductDocument } from '../schemas/product.schema';
import {
  ProductBatchDocument,
  ProductBatchStatus,
} from './schemas/product-batch.schema';
import { businessDate } from './business-date';
import { compareFefo } from './batch-order';

/**
 * Lot B — identité MINIMALE des lots vendables d'un produit suivi, projetée
 * avec la liste des produits (et donc mise en cache hors ligne) : de quoi
 * choisir les lots d'une vente sans réseau. Aucune quantité (détail du
 * stock, jamais mis en cache hors ligne), aucun état « périmé » figé : le
 * client recalcule la validité avec le jour courant, jamais antérieur à
 * `businessDate`.
 */
export interface SaleBatchSummary {
  _id: string;
  reference: string;
  expiryDate: string | null;
  manufacturerLot: string | null;
}

export interface ProductBatchSale {
  /** Jour du commerce à la lecture (borne basse de l'horloge hors ligne). */
  businessDate: string;
  timeZone: string;
  /** Disponibles, non vides, non dépassés à la lecture ; ordre FEFO. */
  batches: SaleBatchSummary[];
}

export async function saleBatchSummaries(
  batchModel: Model<ProductBatchDocument>,
  organizationId: string,
  products: readonly ProductDocument[],
): Promise<Map<string, ProductBatchSale>> {
  const tracked = products.filter((p) => p.stockTracking === 'batches');
  const result = new Map<string, ProductBatchSale>();
  if (tracked.length === 0) return result;
  const today = businessDate();
  const timeZone = processTimeZone();
  const rows = await batchModel
    .find({
      organizationId: new Types.ObjectId(organizationId),
      productId: { $in: tracked.map((p) => p._id) },
      status: ProductBatchStatus.AVAILABLE,
      remainingQuantity: { $gt: 0 },
      $or: [{ expiryDate: null }, { expiryDate: { $gte: today } }],
    })
    .exec();
  rows.sort(compareFefo);
  for (const product of tracked) {
    result.set(product._id.toString(), {
      businessDate: today,
      timeZone,
      batches: [],
    });
  }
  for (const batch of rows) {
    result.get(batch.productId.toString())?.batches.push({
      _id: batch._id.toHexString(),
      reference: batch.reference,
      expiryDate: batch.expiryDate ?? null,
      manufacturerLot: batch.manufacturerLot ?? null,
    });
  }
  return result;
}
