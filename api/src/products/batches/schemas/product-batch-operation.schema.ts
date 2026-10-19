import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type ProductBatchOperationDocument =
  HydratedDocument<ProductBatchOperation>;

export const PRODUCT_BATCH_OPERATIONS_COLLECTION = 'productbatchoperations';

export enum ProductBatchOperationKind {
  ENABLE_TRACKING = 'enable_tracking',
  RECEIVE_NEW = 'receive_new',
  RECEIVE_EXISTING = 'receive_existing',
  // Lot C.
  LOSS = 'loss',
  LOSS_CORRECTION = 'loss_correction',
}

/**
 * Trace idempotente d'une opération de lot (même principe que
 * `sale_operations`) : première écriture de la transaction, index unique
 * `{ organizationId, clientOperationId }`. Un rejeu (relance réseau,
 * double clic) renvoie l'état courant sans nouvelle écriture ; un rejeu
 * concurrent bute sur l'index unique.
 */
@Schema({
  collection: PRODUCT_BATCH_OPERATIONS_COLLECTION,
  timestamps: { createdAt: true, updatedAt: false },
  autoIndex: false,
})
export class ProductBatchOperation {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: String, required: true })
  clientOperationId: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ProductBatchOperationKind),
  })
  kind: ProductBatchOperationKind;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Product',
    required: true,
  })
  productId: Types.ObjectId;

  /** Lot reçu (réceptions) ; `null` pour la reprise (plusieurs lots). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  batchId: Types.ObjectId | null;

  /** SHA-256 hex de la requête canonique (serveur uniquement). */
  @Prop({ type: String, required: true })
  requestHash: string;
}

export const ProductBatchOperationSchema = SchemaFactory.createForClass(
  ProductBatchOperation,
);

export const PRODUCT_BATCH_OPERATION_INDEX_KEY = Object.freeze({
  organizationId: 1,
  clientOperationId: 1,
} as const);

ProductBatchOperationSchema.index(
  { ...PRODUCT_BATCH_OPERATION_INDEX_KEY },
  { unique: true },
);
