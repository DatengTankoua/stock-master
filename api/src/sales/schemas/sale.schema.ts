import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SaleDocument = HydratedDocument<Sale>;

/**
 * Lot B — unités d'UN lot affectées à une vente. Instantané figé à
 * l'écriture (référence, dates, numéro fabricant) : jamais recalculé depuis
 * l'état courant des lots.
 */
@Schema({ _id: false })
export class SaleBatchAllocation {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  batchId: Types.ObjectId;

  @Prop({ type: String, required: true })
  reference: string;

  @Prop({ type: String, default: null })
  expiryDate: string | null;

  @Prop({ type: String, default: null })
  manufacturerLot: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;
}
export const SaleBatchAllocationSchema =
  SchemaFactory.createForClass(SaleBatchAllocation);

/**
 * Lot B — restitution d'unités d'une vente ANTÉRIEURE à l'activation (lot
 * d'origine inconnu, jamais inventé) vers un lot DE DESTINATION choisi
 * explicitement. Distincte d'une affectation d'origine.
 */
@Schema({ _id: false })
export class SaleBatchRestitution {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  batchId: Types.ObjectId;

  @Prop({ type: String, required: true })
  reference: string;

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;

  /** Destination « lot historique, date inconnue » créée pour l'occasion. */
  @Prop({ type: Boolean, default: false })
  historical: boolean;
}
export const SaleBatchRestitutionSchema =
  SchemaFactory.createForClass(SaleBatchRestitution);

/** Lot B — une correction (avant / après), jamais effacée. */
@Schema({ _id: false })
export class SaleBatchHistoryEntry {
  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  quantityBefore: number;

  @Prop({ type: Number, required: true })
  quantityAfter: number;

  @Prop({ type: [SaleBatchAllocationSchema], default: [] })
  allocationsBefore: SaleBatchAllocation[];

  @Prop({ type: [SaleBatchAllocationSchema], default: [] })
  allocationsAfter: SaleBatchAllocation[];

  /** Unités rendues aux lots d'origine. */
  @Prop({ type: [SaleBatchAllocationSchema], default: [] })
  returned: SaleBatchAllocation[];

  /** Unités supplémentaires affectées. */
  @Prop({ type: [SaleBatchAllocationSchema], default: [] })
  added: SaleBatchAllocation[];

  /** Unités d'origine inconnue restituées vers des lots de destination. */
  @Prop({ type: [SaleBatchRestitutionSchema], default: [] })
  restitutions: SaleBatchRestitution[];

  @Prop({ type: String, default: null })
  reason: string | null;
}
export const SaleBatchHistoryEntrySchema = SchemaFactory.createForClass(
  SaleBatchHistoryEntry,
);

/** Lot B — vente hors ligne d'un lot dépassé à la réception, régularisée. */
@Schema({ _id: false })
export class SaleExpiredBatchRegularization {
  @Prop({ type: String, required: true })
  reason: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  at: Date;

  /** Jour du commerce à la réception par le serveur. */
  @Prop({ type: String, required: true })
  businessDate: string;

  @Prop({ type: [String], default: [] })
  references: string[];

  // Régularisation APPROUVÉE sur demande du vendeur (lot B) : `actorId` est
  // alors le responsable approbateur, `requestedBy` le vendeur d'origine.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  requestId?: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  requestedBy?: Types.ObjectId | null;

  /** Heure DÉCLARÉE par l'appareil (non vérifiée indépendamment). */
  @Prop({ type: Date, default: null })
  declaredOccurredAt?: Date | null;

  /** Réception de la demande par le serveur. */
  @Prop({ type: Date, default: null })
  receivedAt?: Date | null;
}
export const SaleExpiredBatchRegularizationSchema =
  SchemaFactory.createForClass(SaleExpiredBatchRegularization);

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Sale {
  /**
   * Rattachement organisationnel (phase 1-1B). Rétrocompatible : `null` sur
   * les documents existants, à remplir par la migration (phase 1-2) ; jamais
   * fourni par le client. `createdAt: -1` de l'index tenant ci-dessous
   * reflète le tri chronologique descendant du service
   * (`sales.service.ts`).
   *
   * **Frontière d'isolation multi-tenant** : le type doit résolument être
   * `ObjectId`, pas `Mixed`. Déclaration via `MongooseSchema.Types.ObjectId`
   * car `@nestjs/mongoose@11.0.4` résout une classe BSON passée en
   * `@Prop({ type })` comme définition de classe imbriquée (les chemins
   * `productId`/`sellerId` existants, même déclaration BSON, sont affectés
   * de la même façon : dette préexistante, hors périmètre 1-1B, cf. rapport
   * de phase).
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    required: false,
  })
  organizationId: Types.ObjectId | null;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Product' })
  productId: Types.ObjectId;

  /**
   * Nom du produit ENREGISTRÉ AU MOMENT DE LA VENTE, lu côté serveur dans la
   * transaction de vente (jamais fourni par le client). Absent sur les
   * ventes antérieures à cet instantané.
   */
  @Prop()
  productName?: string;

  /**
   * 1-15D — DERNIER nom connu du produit, figé juste avant sa suppression
   * définitive (`purge`) ou reconstruit depuis le journal d'audit par le CLI
   * de rattrapage (`audit`). Distinct de `productName` : ce n'est pas
   * forcément le nom au moment de la vente. Jamais écrasé une fois posé.
   */
  @Prop({ type: String, required: false })
  lastKnownProductName?: string;

  /**
   * 1-15D — prix d'achat unitaire connu au même moment (celui qu'utilisaient
   * les analyses tant que le produit existait). Donnée financière : exclue
   * de toute lecture par défaut (`select: false`), lue uniquement par les
   * agrégations d'analyse (`analytics.read`).
   */
  @Prop({ type: Number, required: false, select: false })
  lastKnownUnitCost?: number;

  /** 1-15D — origine de `lastKnown*` ; sa présence rend l'opération idempotente. */
  @Prop({ type: String, enum: ['purge', 'audit'], required: false })
  lastKnownSource?: 'purge' | 'audit';

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  salePrice: number;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  sellerId: Types.ObjectId;

  @Prop({ trim: true })
  buyerName?: string;

  @Prop({ trim: true })
  buyerContact?: string;

  /**
   * 1-11C.1 — heure RÉELLE de la vente (fournie par le client dans la fenêtre
   * autorisée, sinon heure serveur). `createdAt` reste l'heure technique de
   * persistance. Absent sur les ventes antérieures : les analytics se
   * replient alors sur `createdAt`.
   */
  @Prop({ type: Date, required: false })
  occurredAt?: Date;

  /**
   * Lot B — affectation COURANTE aux lots (somme = unités dont le lot est
   * connu). Absente : vente d'un produit sans lots, ou vente antérieure à
   * l'activation (lot d'origine inconnu, jamais attribué rétroactivement).
   */
  @Prop({ type: [SaleBatchAllocationSchema], default: undefined })
  batchAllocations?: SaleBatchAllocation[];

  /** Lot B — affectation à la création, conservée telle quelle. */
  @Prop({ type: [SaleBatchAllocationSchema], default: undefined })
  originalBatchAllocations?: SaleBatchAllocation[];

  /** Lot B — corrections successives (avant / après), jamais effacées. */
  @Prop({ type: [SaleBatchHistoryEntrySchema], default: undefined })
  batchHistory?: SaleBatchHistoryEntry[];

  @Prop({ type: SaleExpiredBatchRegularizationSchema, required: false })
  expiredBatchRegularization?: SaleExpiredBatchRegularization;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

/**
 * Index tenant composite (1-1B) : le service lit les ventes par
 * `createdAt` descendant (convention démontrée en lecture seule,
 * `sales.service.ts`), d'où l'ordre `organizationId → productId →
 * createdAt(-1)`. Déclaré uniquement — création reportée à la migration.
 */
SaleSchema.index({
  organizationId: 1,
  productId: 1,
  createdAt: -1,
});
