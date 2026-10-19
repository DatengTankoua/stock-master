import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

/** État du suivi par lots d'une fiche (voir `Product.batchTracking`). */
@Schema({ _id: false })
export class BatchTrackingState {
  @Prop({ type: Number, required: true, min: 0 })
  totalQuantity: number;

  /** Dernier numéro de référence attribué (`L-001`, `L-002`…). */
  @Prop({ type: Number, required: true, min: 0 })
  sequence: number;

  @Prop({ type: Date, required: true })
  enabledAt: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  enabledBy: Types.ObjectId;

  @Prop({ type: String, required: true })
  operationId: string;

  /** Date de la fiche avant la reprise, conservée (jamais imposée aux lots). */
  @Prop({ type: String, default: null })
  legacyExpiryDate: string | null;
}

export const BatchTrackingStateSchema =
  SchemaFactory.createForClass(BatchTrackingState);

@Schema({ timestamps: true })
export class Product {
  /**
   * Rattachement organisationnel (phase 1-1B). Rétrocompatible : `null` sur
   * les documents existants, à remplir par la migration (phase 1-2) ; jamais
   * fourni par le client.
   *
   * **Frontière d'isolation multi-tenant** : le type doit résolument être
   * `ObjectId`, pas `Mixed`. Déclaration via `MongooseSchema.Types.ObjectId`
   * car `@nestjs/mongoose@11.0.4` résout une classe BSON passée en
   * `@Prop({ type })` comme définition de classe imbriquée (le chemin
   * `sectionId` existant, même déclaration BSON, est affecté de la même
   * façon : dette préexistante, hors périmètre 1-1B, cf. rapport de phase).
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    required: false,
  })
  organizationId: Types.ObjectId | null;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Section' })
  sectionId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  /**
   * Ancienne référence (URL publique d'avant R2), conservée telle quelle :
   * jamais convertie ni fabriquée. Les nouveaux produits n'en ont pas.
   */
  @Prop({ type: String, required: false })
  imageUrl?: string;

  /**
   * Photo (R2 privé) : clé de l'objet et identité du stockage qui l'a reçu
   * (`S3Service.storage`). Jamais d'URL signée en base.
   */
  @Prop({ type: String, default: null })
  imageKey: string | null;

  @Prop({ type: String, default: null })
  imageStorage: string | null;

  @Prop({ required: true, min: 0 })
  purchasePrice: number;

  @Prop({ required: true, min: 0 })
  salePrice: number;

  @Prop({ required: true, min: 1 })
  initialQuantity: number;

  @Prop({ required: true, min: 0 })
  remainingQuantity: number;

  /**
   * Date de péremption CIVILE `AAAA-MM-JJ` (aucune heure ni fuseau), sur la
   * fiche entière (pas de lots). Facultative : absente sur les produits
   * existants, sans migration.
   */
  @Prop({ type: String, required: false, match: /^\d{4}-\d{2}-\d{2}$/ })
  expiryDate?: string | null;

  /**
   * Seuil de stock faible personnalisé (≥ 0, `0` explicite). Absent : règle
   * par défaut existante (`products/stock-level.ts`). Sans migration.
   */
  @Prop({ type: Number, required: false, min: 0 })
  lowStockThreshold?: number | null;

  /**
   * Mode de suivi du stock. Absent : sans lots (fonctionnement historique,
   * aucune migration). `batches` : quantités réparties entre lots
   * (`productbatches`), activé UNIQUEMENT par la reprise explicite
   * (`ProductBatchesService.enableTracking`), jamais désactivable.
   */
  @Prop({ type: String, required: false, enum: ['batches'] })
  stockTracking?: 'batches';

  /**
   * Suivi par lots (présent seulement avec `stockTracking: 'batches'`).
   * `totalQuantity` reflète la somme des lots et doit rester ÉGAL à
   * `remainingQuantity` : le validateur MongoDB de la collection l'exige
   * (`product-batch-guard.ts`). Une écriture qui ne connaît pas les lots
   * (ancienne API, `$inc` du stock seul) est donc refusée par la base.
   */
  @Prop({ type: BatchTrackingStateSchema, required: false })
  batchTracking?: BatchTrackingState;

  /**
   * Lot C — pertes NETTES de leurs corrections (lots) : unités et valeur
   * estimée au prix d'achat EN VIGUEUR à chaque mouvement (jamais
   * recalculée). Absent : aucune perte. Séparent les unités vendues
   * (initial − restant − pertes nettes) des sorties sans vente.
   */
  @Prop({
    type: { netQuantity: Number, netValueAtCost: Number },
    _id: false,
    default: undefined,
  })
  lossTracking?: { netQuantity: number; netValueAtCost: number };

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

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

/**
 * Index tenant composite (1-1B) : rattachement premier, puis section.
 * Déclaré uniquement — création reportée à la migration (phase 1-2).
 */
ProductSchema.index({
  organizationId: 1,
  sectionId: 1,
  deletedAt: 1,
});
