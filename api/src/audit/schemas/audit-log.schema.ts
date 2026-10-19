import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

export enum AuditAction {
  CREATED = 'created',
  SOLD = 'sold',
  PRICE_CHANGED = 'price_changed',
  STOCK_CHANGED = 'stock_changed',
  NAME_CHANGED = 'name_changed',
  SECTION_CHANGED = 'section_changed',
  DELETED = 'deleted',
  SALE_UPDATED = 'sale_updated',
  SALE_CANCELLED = 'sale_cancelled',
  // Champs facultatifs de la fiche : `{ from, to }`, `null` = absent.
  EXPIRY_CHANGED = 'expiry_changed',
  THRESHOLD_CHANGED = 'threshold_changed',
  // Lots : reprise du stock existant (répartition, aucune entrée de stock),
  // réception (nouveau lot ou lot existant) et modification d'identité
  // (jamais une quantité).
  BATCH_TRACKING_ENABLED = 'batch_tracking_enabled',
  BATCH_RECEIVED = 'batch_received',
  BATCH_UPDATED = 'batch_updated',
  // Lot B : demande de régularisation d'une vente hors ligne (vendeur),
  // approbation ou rejet motivé (responsable). Jamais effacée.
  SALE_REGULARIZATION_REQUESTED = 'sale_regularization_requested',
  SALE_REGULARIZATION_APPROVED = 'sale_regularization_approved',
  SALE_REGULARIZATION_REJECTED = 'sale_regularization_rejected',
  // Lot C : statut d'un lot (mise à l'écart, remise à disposition), perte
  // et sa correction (contre-mouvement lié). Jamais effacés.
  BATCH_STATUS_CHANGED = 'batch_status_changed',
  BATCH_LOSS_RECORDED = 'batch_loss_recorded',
  BATCH_LOSS_CORRECTED = 'batch_loss_corrected',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  /**
   * Rattachement organisationnel (phase 1-1B). Rétrocompatible : `null` sur
   * les documents existants, à remplir par la migration (phase 1-2) ; jamais
   * fourni par le client.
   *
   * **Frontière d'isolation multi-tenant** : le type doit résolument être
   * `ObjectId`, pas `Mixed`. Déclaration via `MongooseSchema.Types.ObjectId`
   * car `@nestjs/mongoose@11.0.4` résout une classe BSON passée en
   * `@Prop({ type })` comme définition de classe imbriquée (les chemins
   * `parentId`/`sectionId`/`productId`/`sellerId`/`actorId` existants sont
   * affectés de la même façon : dette préexistante, hors périmètre 1-1B,
   * cf. rapport de phase).
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

  @Prop({ required: true, enum: Object.values(AuditAction) })
  action: AuditAction;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  actorId: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  details: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

/**
 * Index tenant composite (1-1B) : historique `organizationId → productId →
 * action`, tri chronologique descendant (`-1`) démontré en lecture seule
 * (`audit.service.ts`). Déclaré uniquement — création reportée à la
 * migration (phase 1-2), jamais exécutée ici contre MongoDB/Atlas.
 */
AuditLogSchema.index({
  organizationId: 1,
  productId: 1,
  action: 1,
  createdAt: -1,
});
