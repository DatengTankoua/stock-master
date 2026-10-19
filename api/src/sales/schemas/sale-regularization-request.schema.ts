import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SaleRegularizationRequestDocument =
  HydratedDocument<SaleRegularizationRequest>;

export const SALE_REGULARIZATION_REQUESTS_COLLECTION =
  'sale_regularization_requests';

export enum SaleRegularizationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Schema({ _id: false })
export class RegularizationBatchLine {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  batchId: Types.ObjectId;

  @Prop({ type: String, required: true })
  reference: string;

  @Prop({ type: String, default: null })
  expiryDate: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;
}
const RegularizationBatchLineSchema = SchemaFactory.createForClass(
  RegularizationBatchLine,
);

/**
 * Lot B — demande de régularisation d'une vente hors ligne refusée
 * `BATCH_EXPIRED_AT_SYNC`, transmise EXPLICITEMENT par son vendeur quand il
 * n'a pas `stock.adjust` (son outbox lui est propre). Un responsable du
 * même commerce l'approuve (motif) ou la rejette (motif) ; elle n'est
 * jamais effacée.
 *
 * Conserve l'opération d'origine à l'identique (`clientOperationId`,
 * payload, `requestHash`) : l'approbation crée la vente SOUS CETTE CLÉ
 * (`sale_operations`), au nom du vendeur d'origine. Le rejeu de l'outbox
 * du vendeur retrouve donc la même vente (jamais une seconde), et deux
 * approbations concurrentes butent sur la même clé.
 *
 * Heures distinctes : `declaredOccurredAt` (heure de la vente DÉCLARÉE par
 * l'appareil, non vérifiée), `createdAt` (réception de la demande par le
 * serveur), `decidedAt` (décision, horloge serveur).
 *
 * `autoIndex: false` : index unique `{ organizationId, clientOperationId }`
 * créé par la garde des lots (`migrate:product-batches -- --install`).
 */
@Schema({
  collection: SALE_REGULARIZATION_REQUESTS_COLLECTION,
  timestamps: { createdAt: true, updatedAt: false },
  autoIndex: false,
})
export class SaleRegularizationRequest {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: String, required: true })
  clientOperationId: string;

  /** Vendeur d'origine (auteur de la vente et de la demande). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  sellerId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: String, required: true })
  productName: string;

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;

  @Prop({ type: Number, required: true, min: 0 })
  salePrice: number;

  @Prop({ type: String, default: null })
  buyerName: string | null;

  @Prop({ type: String, default: null })
  buyerContact: string | null;

  /** Heure DÉCLARÉE par l'appareil du vendeur (non vérifiée). */
  @Prop({ type: Date, required: true })
  declaredOccurredAt: Date;

  @Prop({ type: [RegularizationBatchLineSchema], required: true })
  batchAllocations: RegularizationBatchLine[];

  @Prop({ type: Boolean, default: false })
  unknownExpiryConfirmed: boolean;

  /** Références des lots dépassés à la réception (vente déclarée avant). */
  @Prop({ type: [String], default: [] })
  expiredReferences: string[];

  /** Hash canonique de l'opération d'origine (rejeu de l'outbox). */
  @Prop({ type: String, required: true })
  requestHash: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SaleRegularizationStatus),
    default: SaleRegularizationStatus.PENDING,
  })
  status: SaleRegularizationStatus;

  /** Responsable qui a décidé (distinct du vendeur d'origine). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  decidedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  decidedAt: Date | null;

  @Prop({ type: String, default: null })
  decisionReason: string | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Sale', default: null })
  saleId: Types.ObjectId | null;
}

export const SaleRegularizationRequestSchema = SchemaFactory.createForClass(
  SaleRegularizationRequest,
);

export const SALE_REGULARIZATION_REQUEST_INDEX_KEY = Object.freeze({
  organizationId: 1,
  clientOperationId: 1,
} as const);

SaleRegularizationRequestSchema.index(
  { ...SALE_REGULARIZATION_REQUEST_INDEX_KEY },
  { unique: true },
);
