import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type ProductBatchDocument = HydratedDocument<ProductBatch>;

export const PRODUCT_BATCHES_COLLECTION = 'productbatches';

/**
 * Disponibilité d'un lot (statut ; la date dépassée se calcule à part) :
 * - `available` : vendable si sa date n'est pas dépassée ;
 * - `quarantined` (lot C) : lot ENTIER mis à l'écart, unités physiquement
 *   présentes et comptées dans le stock, jamais vendables ni reçues ;
 * - `withdrawn` (lot C) : lot fermé à la vente et aux réceptions ordinaires
 *   (une perte de tout son stock restant le ferme).
 * Une restitution (annulation, correction de vente ou de perte) ne change
 * JAMAIS le statut : seule une remise à disposition explicite le fait.
 *
 * Ancienne note (lot A) : seul `available` était écrit par le lot A :
 * - `quarantined` (lot C) : unités physiquement présentes, comptées dans le
 *   stock, mais non vendables (mise à l'écart) ;
 * - `withdrawn` (lot C) : lot retiré, quantité restante ramenée à 0 par une
 *   perte journalisée.
 * Aucune transition n'existe encore : valeurs réservées, jamais déduites de
 * la date (l'état « dépassé » se calcule à la lecture).
 */
export enum ProductBatchStatus {
  AVAILABLE = 'available',
  QUARANTINED = 'quarantined',
  WITHDRAWN = 'withdrawn',
}

/**
 * Origine du lot : reprise du stock existant, réception d'unités neuves ou
 * (lot B) destination historique « date inconnue » créée explicitement pour
 * restituer des unités d'une vente antérieure à l'activation, dont le lot
 * d'origine reste inconnu.
 */
export enum ProductBatchOrigin {
  OPENING = 'opening',
  RECEPTION = 'reception',
  RESTITUTION = 'restitution',
}

/**
 * Lot d'une fiche produit suivie par lots. Identité stable (`_id`) ;
 * référence lisible attribuée par le serveur (`L-001`), unique par produit.
 * Dates CIVILES `AAAA-MM-JJ` (aucune heure ni fuseau), `null` = inconnue.
 * Deux lots de même date ne sont jamais fusionnés.
 *
 * `autoIndex: false` : index créés par `ensureProductBatchGuard` (migration
 * explicite), vérifiés avant toute activation.
 */
@Schema({
  collection: PRODUCT_BATCHES_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class ProductBatch {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Product',
    required: true,
  })
  productId: Types.ObjectId;

  @Prop({ type: String, required: true })
  reference: string;

  @Prop({ type: String, default: null })
  manufacturerLot: string | null;

  /** Date civile de réception ; `null` : inconnue (reprise historique). */
  @Prop({ type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ })
  receivedOn: string | null;

  /** Date civile de péremption ; `null` : aucune date connue. */
  @Prop({ type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ })
  expiryDate: string | null;

  @Prop({ type: Number, required: true, min: 0 })
  remainingQuantity: number;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ProductBatchStatus),
    default: ProductBatchStatus.AVAILABLE,
  })
  status: ProductBatchStatus;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ProductBatchOrigin),
  })
  origin: ProductBatchOrigin;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  /** Lot C — dernier changement de statut (motif, auteur, date serveur). */
  @Prop({
    type: {
      from: String,
      to: String,
      reason: String,
      by: { type: MongooseSchema.Types.ObjectId, ref: 'User' },
      at: Date,
    },
    _id: false,
    default: undefined,
  })
  statusChange?: {
    from: ProductBatchStatus;
    to: ProductBatchStatus;
    reason: string;
    by: Types.ObjectId;
    at: Date;
  };

  /**
   * Lot C — prochaine date de contrôle des alertes de péremption (clé de
   * l'index partiel du planificateur) ; `null` : rien à annoncer.
   */
  @Prop({ type: String, default: null })
  expiryAlertNextOn?: string | null;

  /** Lot C — échéances déjà annoncées (déduplication persistante). */
  @Prop({
    type: { soonFor: String, expiredFor: String },
    _id: false,
    default: undefined,
  })
  expiryAlerts?: { soonFor?: string | null; expiredFor?: string | null };
}

export const ProductBatchSchema = SchemaFactory.createForClass(ProductBatch);

/** Référence unique par produit (défense en profondeur de la séquence). */
export const PRODUCT_BATCH_REFERENCE_INDEX_KEY = Object.freeze({
  organizationId: 1,
  productId: 1,
  reference: 1,
} as const);

ProductBatchSchema.index(
  { ...PRODUCT_BATCH_REFERENCE_INDEX_KEY },
  { unique: true },
);
