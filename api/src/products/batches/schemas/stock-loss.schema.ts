import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { ProductBatchStatus } from './product-batch.schema';

export type StockLossDocument = HydratedDocument<StockLoss>;

export const STOCK_LOSSES_COLLECTION = 'stock_losses';

export enum StockLossKind {
  /** Sortie définitive d'unités d'un lot. */
  LOSS = 'loss',
  /** Contre-mouvement d'une perte saisie par erreur (liée à l'origine). */
  CORRECTION = 'correction',
}

export enum StockLossReason {
  EXPIRED = 'expired',
  DAMAGED = 'damaged',
  OTHER = 'other',
}

/**
 * Lot C — mouvement de perte (ou sa correction), JAMAIS supprimé ni
 * modifié, sauf `correctedQuantity` de la perte d'origine, augmenté
 * conditionnellement par chaque correction (jamais au-delà de la quantité
 * perdue : aucune double restitution).
 *
 * Valorisation : `unitCostAtMovement` = prix d'achat de la fiche AU MOMENT
 * de la perte (la correction reprend celui de la perte corrigée) ; la
 * valeur estimée n'est jamais recalculée avec un prix ultérieur. Ce n'est
 * pas une valeur comptable : une estimation au coût d'achat courant de
 * l'époque.
 */
@Schema({
  collection: STOCK_LOSSES_COLLECTION,
  timestamps: { createdAt: true, updatedAt: false },
  // Index créés par la garde des lots (`migrate:product-batches --install`).
  autoIndex: false,
})
export class StockLoss {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  batchId: Types.ObjectId;

  @Prop({ type: String, required: true })
  batchReference: string;

  @Prop({ type: String, required: true, enum: Object.values(StockLossKind) })
  kind: StockLossKind;

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;

  @Prop({
    type: String,
    enum: [...Object.values(StockLossReason), null],
    default: null,
  })
  reason: StockLossReason | null;

  @Prop({ type: String, default: null })
  comment: string | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  unitCostAtMovement: number;

  /** Perte d'origine d'une correction. */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  correctsLossId: Types.ObjectId | null;

  /** Unités déjà restituées par des corrections (perte d'origine). */
  @Prop({ type: Number, default: 0, min: 0 })
  correctedQuantity: number;

  @Prop({
    type: String,
    enum: Object.values(ProductBatchStatus),
    required: true,
  })
  statusBefore: ProductBatchStatus;

  @Prop({
    type: String,
    enum: Object.values(ProductBatchStatus),
    required: true,
  })
  statusAfter: ProductBatchStatus;

  @Prop({ type: String, required: true })
  clientOperationId: string;
}

export const StockLossSchema = SchemaFactory.createForClass(StockLoss);

/** Historique par produit (fiche). */
export const STOCK_LOSS_PRODUCT_INDEX_KEY = Object.freeze({
  organizationId: 1,
  productId: 1,
  createdAt: -1,
} as const);
/** Pertes d'une période (Analyse). */
export const STOCK_LOSS_PERIOD_INDEX_KEY = Object.freeze({
  organizationId: 1,
  createdAt: -1,
} as const);
StockLossSchema.index({ ...STOCK_LOSS_PRODUCT_INDEX_KEY });
StockLossSchema.index({ ...STOCK_LOSS_PERIOD_INDEX_KEY });
