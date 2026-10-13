import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SubscriptionTerm } from '../../subscription-terms';

export type SubscriptionPaymentDocument = HydratedDocument<SubscriptionPayment>;

export const SUBSCRIPTION_PAYMENTS_COLLECTION = 'subscription_payments';

/**
 * 1-14D.2B — États d'une demande de paiement.
 *
 * Ouverts (`open: true`, bloquent toute nouvelle collecte) :
 * - `initiating` : demande persistée, droit d'initier réservé ;
 * - `pending`    : collecte acceptée par le prestataire, en attente du payeur ;
 * - `uncertain`  : issue de l'initiation inconnue (réponse perdue) — JAMAIS
 *   un échec, jamais réinitié ;
 * - `review`     : discordance (montant, devise, référence) — traitement
 *   opérateur, aucune attribution (conserve `open` de l'état précédent).
 * Fermés : `succeeded` (terminal, période attribuée), `failed` (refus
 * confirmé ; seul un succès vérifié peut encore le faire évoluer).
 */
export enum SubscriptionPaymentStatus {
  INITIATING = 'initiating',
  PENDING = 'pending',
  UNCERTAIN = 'uncertain',
  REVIEW = 'review',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** Codes d'incident GÉNÉRIQUES (jamais un message ou une réponse brute). */
export enum SubscriptionPaymentIncident {
  INITIATION_REJECTED = 'initiation_rejected',
  INITIATION_UNCERTAIN = 'initiation_uncertain',
  PROVIDER_UNAVAILABLE = 'provider_unavailable',
  PROVIDER_MISMATCH = 'provider_mismatch',
  LATE_FAILURE_AFTER_SUCCESS = 'late_failure_after_success',
  /**
   * 1-21B — page de paiement close ou tentative échouée sans succès
   * constaté : paiement OUVERT, à vérifier (succès tardif encore accepté).
   */
  CHECKOUT_UNRESOLVED = 'checkout_unresolved',
  /** 1-21B — réponses du prestataire incohérentes : vérification opérateur. */
  PROVIDER_INCONSISTENT = 'provider_inconsistent',
  /**
   * 1-21E — page close (expirée, ou fermée à la demande du propriétaire)
   * SANS aucune transaction engagée, statut revérifié chez le prestataire :
   * aucun débit possible, paiement clos (`failed`), nouvelle tentative
   * libérée. Un succès vérifié ultérieur resterait attribué (jamais perdu).
   */
  CHECKOUT_CLOSED = 'checkout_closed',
  /**
   * 1-21E — encaissement CONFIRMÉ alors que son renouvellement a déjà reçu
   * son attribution automatique (autre tentative) : aucune seconde période,
   * paiement conservé (`review`, `collectedAt`), traitement opérateur.
   */
  RENEWAL_ALREADY_GRANTED = 'renewal_already_granted',
  /**
   * 1-21E — encaissement CONFIRMÉ d'une tentative REMPLACÉE par une autre
   * (changement de forfait) : l'ancien forfait n'est jamais attribué
   * silencieusement ; paiement conservé (`review`, `collectedAt`).
   */
  REPLACED_PAYMENT_COLLECTED = 'replaced_payment_collected',
  /**
   * 1-21E — encaissement REMBOURSÉ hors de Stock Master, consigné par
   * l'opérateur (CLI, audité) : plus aucune attribution possible.
   */
  REFUNDED_OUTSIDE = 'refunded_outside',
}

/** 1-21E — incidents d'un encaissement confirmé en attente de résolution. */
export const COLLECTED_CONFLICT_INCIDENTS: readonly SubscriptionPaymentIncident[] =
  Object.freeze([
    SubscriptionPaymentIncident.RENEWAL_ALREADY_GRANTED,
    SubscriptionPaymentIncident.REPLACED_PAYMENT_COLLECTED,
  ]);

/**
 * Registre des demandes de paiement d'abonnement. `autoIndex: false` : les
 * index ne sont JAMAIS créés au démarrage (migration
 * `migrate:subscription-payment-indexes`, vérification fail-fast en
 * production). Aucun TTL, aucune suppression automatique.
 *
 * Jamais stockés : téléphone en clair, PIN, jeton, secret, réponse brute du
 * prestataire.
 */
@Schema({
  collection: SUBSCRIPTION_PAYMENTS_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class SubscriptionPayment {
  /** Contexte serveur (`OrganizationGuard`), jamais le corps. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    immutable: true,
  })
  organizationId: Types.ObjectId;

  /** Propriétaire authentifié (`sub` du JWT). */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  })
  requestedBy: Types.ObjectId;

  /** UUID v4 en minuscules, généré une fois par le client. */
  @Prop({ type: String, required: true, immutable: true })
  clientOperationId: string;

  /** HMAC de la demande normalisée ; jamais exposé. */
  @Prop({ type: String, required: true, immutable: true })
  requestFingerprint: string;

  @Prop({
    type: String,
    enum: SubscriptionTerm,
    required: true,
    immutable: true,
  })
  term: SubscriptionTerm;

  /** Montant TOTAL figé depuis le catalogue serveur (XAF, entier). */
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    min: 1,
    validate: {
      validator: (value: unknown) => Number.isSafeInteger(value),
      message: 'amount doit être un entier.',
    },
  })
  amount: number;

  @Prop({ type: String, enum: ['XAF'], required: true, immutable: true })
  currency: 'XAF';

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  pricingVersion: number;

  @Prop({ type: String, required: true, immutable: true })
  provider: string;

  @Prop({ type: String, required: true, immutable: true })
  merchantReference: string;

  @Prop({ type: String, default: null })
  providerReference: string | null;

  @Prop({
    type: String,
    enum: SubscriptionPaymentStatus,
    required: true,
  })
  status: SubscriptionPaymentStatus;

  @Prop({ type: Boolean, required: true })
  open: boolean;

  /**
   * 1-21B — `null` quand le prestataire n'a demandé aucun numéro (page de
   * paiement hébergée) ; jamais le numéro en clair.
   */
  @Prop({ type: String, default: null, immutable: true })
  payerPhoneMasked: string | null;

  /**
   * 1-21B — Page de paiement hébergée VALIDÉE (HTTPS, hôte autorisé du
   * prestataire), rouverte telle quelle par le payeur : jamais une nouvelle
   * session pour un retour ou un rechargement. Aucun secret.
   */
  @Prop({ type: String, default: null })
  providerCheckoutUrl: string | null;

  /**
   * 1-21E — Fin de validité de la page hébergée : renvoyée par le
   * prestataire, sinon demandée à la création. Fixée une fois, jamais
   * repoussée par un rechargement ; `null` avant 1-21E (création + durée).
   */
  @Prop({ type: Date, default: null })
  providerCheckoutExpiresAt: Date | null;

  /**
   * 1-21E — RENOUVELLEMENT auquel appartient la tentative : son propre `_id`
   * pour une première tentative, celui de la tentative remplacée sinon.
   * Absent (paiements antérieurs) = son propre `_id`. Immuable.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, immutable: true })
  renewalId: Types.ObjectId | null;

  /**
   * 1-21E — Tentative REMPLACÉE par celle-ci (changement de forfait ou
   * nouvelle tentative après une page close), écrit à l'insertion : la
   * relation survit à tout redémarrage. Immuable.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, immutable: true })
  replacesPaymentId: Types.ObjectId | null;

  /**
   * 1-21E — Renouvellement dont CE paiement porte l'attribution
   * AUTOMATIQUE (moteur de confirmation) : index unique partiel → au plus
   * une attribution automatique par renouvellement, entre processus.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  autoGrantRenewalId: Types.ObjectId | null;

  /**
   * 1-21E — STATUT FINANCIER : encaissement confirmé par le prestataire
   * (vérifié), indépendamment de l'attribution d'une période. Jamais remis
   * à `null` ; un paiement encaissé n'est jamais `failed`.
   */
  @Prop({ type: Date, default: null })
  collectedAt: Date | null;

  /**
   * 1-21E — Montant DÉBITÉ au payeur (centimes de la devise), lu chez le
   * prestataire à l'encaissement ; `null` (paiements antérieurs) = `amount`.
   */
  @Prop({ type: Number, default: null })
  paidAmountMinor: number | null;

  /**
   * 1-21E — Poursuite SUSPENDUE : une tentative remplacée du même
   * renouvellement a été encaissée ; aucun lien proposé.
   */
  @Prop({ type: Date, default: null })
  renewalConflictAt: Date | null;

  /**
   * 1-21E — Remboursement effectué HORS de Stock Master et consigné par
   * l'opérateur (audit de rapprochement). Définitif : aucune attribution par
   * webhook, vérification, rapprochement périodique ni CLI.
   */
  @Prop({ type: Date, default: null })
  refundedAt: Date | null;

  /**
   * 1-21B — Transaction du prestataire RATTACHÉE (lue sur sa session) :
   * unique par prestataire (index partiel), jamais deux paiements internes.
   */
  @Prop({ type: String, default: null })
  providerTransactionId: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SubscriptionPeriod',
    default: null,
  })
  periodId: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: [...Object.values(SubscriptionPaymentIncident), null],
    default: null,
  })
  incidentCode: SubscriptionPaymentIncident | null;

  @Prop({ type: Date, default: null })
  initiatedAt: Date | null;

  @Prop({ type: Date, default: null })
  confirmedAt: Date | null;

  @Prop({ type: Date, default: null })
  failedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastCheckedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SubscriptionPaymentSchema =
  SchemaFactory.createForClass(SubscriptionPayment);

export const OPEN_PAYMENT_STATUSES: readonly SubscriptionPaymentStatus[] =
  Object.freeze([
    SubscriptionPaymentStatus.INITIATING,
    SubscriptionPaymentStatus.PENDING,
    SubscriptionPaymentStatus.UNCERTAIN,
  ]);
