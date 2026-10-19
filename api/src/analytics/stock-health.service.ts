import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  ProductBatch,
  ProductBatchDocument,
} from '../products/batches/schemas/product-batch.schema';
import {
  StockLoss,
  StockLossDocument,
  StockLossKind,
} from '../products/batches/schemas/stock-loss.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import { businessDate } from '../products/batches/business-date';
import {
  addCivilDays,
  normalizeLeadDays,
} from '../products/expiry/expiry-alerts';
import { expiryAlertsEnabledFor } from '../products/expiry/expiry-alerts-config';
import { monthBounds, processTimeZone } from './month-range';

export const STOCK_HEALTH_LIST_MAX = 100;

export interface StockHealthItem {
  kind: 'batch' | 'product';
  productId: string;
  productName: string;
  batchId?: string;
  reference?: string;
  expiryDate: string;
  /** Statut du lot (un lot mis à l'écart reste listé, état indiqué). */
  status?: string;
  /** Stock physique : seulement avec `products.view_stock_details`. */
  quantity?: number;
}

/**
 * Lot C — « Expire bientôt », « Périmés » et pertes de l'Analyse.
 *
 * Mêmes règles que les alertes : jour du commerce, délai du commerce, stock
 * physique positif, produits actifs ; lots (tout statut) des produits
 * suivis, date de la fiche pour les produits sans lots. Les pertes sont
 * NETTES de leurs corrections (chacune comptée le mois de son mouvement),
 * jamais des ventes ; valeur estimée au prix d'achat de chaque mouvement.
 */
@Injectable()
export class StockHealthService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(ProductBatch.name)
    private batchModel: Model<ProductBatchDocument>,
    @InjectModel(StockLoss.name) private lossModel: Model<StockLossDocument>,
    @InjectModel(Organization.name)
    private organizationModel: Model<OrganizationDocument>,
  ) {}

  async get(
    organizationId: string,
    visibility: { stockDetails: boolean; financials: boolean },
    month?: string,
  ) {
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new BadRequestException('Mois invalide.');
    }
    const orgOid = new Types.ObjectId(organizationId);
    const org = await this.organizationModel
      .findById(orgOid)
      .select({ expiryAlertLeadDays: 1 })
      .lean<{ expiryAlertLeadDays?: number }>()
      .exec();
    const leadDays = normalizeLeadDays(org?.expiryAlertLeadDays);
    const today = businessDate();
    const horizon = addCivilDays(today, leadDays);

    const products = await this.productModel
      .find({ organizationId: orgOid, deletedAt: null })
      .select({
        name: 1,
        stockTracking: 1,
        expiryDate: 1,
        remainingQuantity: 1,
      })
      .lean<
        Array<{
          _id: Types.ObjectId;
          name: string;
          stockTracking?: string;
          expiryDate?: string | null;
          remainingQuantity: number;
        }>
      >()
      .exec();
    const names = new Map(products.map((p) => [p._id.toHexString(), p.name]));
    const tracked = products.filter((p) => p.stockTracking === 'batches');
    const items: StockHealthItem[] = [];
    for (const p of products) {
      if (p.stockTracking === 'batches' || !p.expiryDate) continue;
      if (p.remainingQuantity <= 0 || p.expiryDate > horizon) continue;
      items.push({
        kind: 'product',
        productId: p._id.toHexString(),
        productName: p.name,
        expiryDate: p.expiryDate,
        ...(visibility.stockDetails ? { quantity: p.remainingQuantity } : {}),
      });
    }
    if (tracked.length > 0) {
      const batches = await this.batchModel
        .find({
          organizationId: orgOid,
          productId: { $in: tracked.map((p) => p._id) },
          remainingQuantity: { $gt: 0 },
          expiryDate: { $type: 'string', $lte: horizon },
        })
        .select({
          productId: 1,
          reference: 1,
          expiryDate: 1,
          status: 1,
          remainingQuantity: 1,
        })
        .lean()
        .exec();
      for (const b of batches) {
        items.push({
          kind: 'batch',
          productId: b.productId.toHexString(),
          productName: names.get(b.productId.toHexString()) ?? '—',
          batchId: b._id.toHexString(),
          reference: b.reference,
          expiryDate: b.expiryDate!,
          status: b.status,
          ...(visibility.stockDetails ? { quantity: b.remainingQuantity } : {}),
        });
      }
    }
    items.sort((a, b) =>
      a.expiryDate === b.expiryDate
        ? a.productName.localeCompare(b.productName)
        : a.expiryDate < b.expiryDate
          ? -1
          : 1,
    );
    const expired = items.filter((i) => i.expiryDate < today);
    const soon = items.filter((i) => i.expiryDate >= today);

    const period = month ?? currentMonth();
    const { start, end } = monthBounds(period);
    const [losses] = await this.lossModel
      .aggregate<{ quantity: number; value: number }>([
        {
          $match: {
            organizationId: orgOid,
            createdAt: { $gte: start, $lt: end },
          },
        },
        {
          $project: {
            sign: {
              $cond: [{ $eq: ['$kind', StockLossKind.CORRECTION] }, -1, 1],
            },
            quantity: 1,
            unitCostAtMovement: 1,
          },
        },
        {
          $group: {
            _id: null,
            quantity: { $sum: { $multiply: ['$sign', '$quantity'] } },
            value: {
              $sum: {
                $multiply: ['$sign', '$quantity', '$unitCostAtMovement'],
              },
            },
          },
        },
      ])
      .exec();

    return {
      businessDate: today,
      timeZone: processTimeZone(),
      leadDays,
      alertsEnabled: expiryAlertsEnabledFor(organizationId),
      soon: soon.slice(0, STOCK_HEALTH_LIST_MAX),
      soonTotal: soon.length,
      expired: expired.slice(0, STOCK_HEALTH_LIST_MAX),
      expiredTotal: expired.length,
      losses: {
        month: period,
        ...(visibility.stockDetails
          ? { lostQuantity: losses?.quantity ?? 0 }
          : {}),
        ...(visibility.financials && visibility.stockDetails
          ? { lossValueAtCost: losses?.value ?? 0 }
          : {}),
      },
    };
  }
}

function currentMonth(): string {
  return businessDate().slice(0, 7);
}
