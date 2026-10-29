import type { Types } from 'mongoose';
import type { PlatformCapability } from './platform-admin-capabilities';

/**
 * Notifications INTERNES de l'administration de la plateforme : événements
 * importants signalés aux administrateurs (cloche, compteur, page dédiée).
 *
 * Distinctes du centre de notifications des commerces (`notifications`,
 * destinataires = membres), des messages de service et des campagnes : ni
 * collection, ni destinataire, ni route communs. Aucun push, aucun e-mail.
 *
 * Règles pures (sans base) : catégories, droits de consultation, clés de
 * déduplication, règles des paiements et des campagnes. Testées par
 * `platform-admin-notifications.spec.ts`.
 */

export const NOTIFICATION_TYPES = [
  'organization_created',
  'payment_confirmed',
  'payment_review',
  'support_request',
  'campaign_audience_partial',
  'campaign_completed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CATEGORIES = [
  'organizations',
  'payments',
  'support',
  'campaigns',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const TYPE_CATEGORY: Readonly<
  Record<NotificationType, NotificationCategory>
> = Object.freeze({
  organization_created: 'organizations',
  payment_confirmed: 'payments',
  payment_review: 'payments',
  support_request: 'support',
  campaign_audience_partial: 'campaigns',
  campaign_completed: 'campaigns',
});

/**
 * Capacité de CONSULTATION exigée par catégorie : celle qui ouvre déjà la
 * page cible (fiche, paiements, campagnes : `platform.read`). Jamais une
 * capacité d'action (suspendre, envoyer, lancer) : la notification informe
 * de ce que l'administrateur peut déjà consulter, sans rien ouvrir de plus.
 */
export const CATEGORY_CAPABILITY: Readonly<
  Record<NotificationCategory, PlatformCapability>
> = Object.freeze({
  organizations: 'platform.read',
  payments: 'platform.read',
  support: 'platform.read',
  campaigns: 'platform.read',
});

/** Catégories visibles avec ces capacités (relues à chaque requête). */
export function visibleCategories(
  capabilities: ReadonlySet<PlatformCapability> | undefined,
): NotificationCategory[] {
  if (!capabilities) return [];
  return NOTIFICATION_CATEGORIES.filter((category) =>
    capabilities.has(CATEGORY_CAPABILITY[category]),
  );
}

export type NotificationTargetKind = 'organization' | 'payment' | 'campaign';

/**
 * Paramètres CONTRÔLÉS (jamais de texte libre saisi par un client ou un
 * administrateur, hors nom du commerce déjà affiché dans l'administration) :
 * le web compose titre et résumé depuis `type` + paramètres, en FR ou EN.
 * Jamais : contenu d'une demande d'assistance, d'une campagne ou d'un
 * message, adresse e-mail, téléphone, jeton, URL du prestataire.
 */
export interface NotificationParams {
  organizationName?: string | null;
  amount?: number;
  currency?: string;
  term?: string;
  months?: number;
  incidentCode?: string | null;
  reference?: string;
  supportCategory?: string;
  audienceTotal?: number;
  results?: CampaignFinalCounts;
}

export interface PlatformAdminNotificationDoc {
  _id: Types.ObjectId;
  /** Identité de déduplication stable (index unique). */
  eventKey: string;
  type: NotificationType;
  category: NotificationCategory;
  /** Date de l'événement métier (lue dans l'état persistant). */
  occurredAt: Date;
  /** Entrée dans le centre (bornes de lecture et d'attribution). */
  createdAt: Date;
  target: {
    kind: NotificationTargetKind;
    id: string;
    /** Commerce concerné (lien de repli, filtre des paiements). */
    organizationId: string | null;
  };
  params: NotificationParams;
}

/** État de lecture d'UNE notification pour UN administrateur (unique). */
export interface PlatformAdminNotificationReadDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  notificationId: Types.ObjectId;
  /** Recopiés pour compter les lues avec le même filtre que la liste. */
  category: NotificationCategory;
  notificationCreatedAt: Date;
  readAt: Date;
}

/** Curseur du balayage d'une source (et point d'activation). */
export interface PlatformAdminNotificationCursorDoc {
  _id: string;
  at: Date;
  updatedAt: Date;
}

export const NOTIFICATION_PAGE_SIZE = 20;
export const NOTIFICATION_RECENT_LIMIT = 5;
/** « Tout marquer comme lu » : lignes écrites au plus par demande. */
export const MARK_ALL_MAX = 5_000;
export const MARK_ALL_BATCH = 500;
export const MAX_ORGANIZATION_NAME = 120;

// ─── Clés de déduplication ─────────────────────────────────────────────

export const notificationKeys = Object.freeze({
  organizationCreated: (organizationId: string) =>
    `organization_created:${organizationId}`,
  paymentConfirmed: (paymentId: string) => `payment_confirmed:${paymentId}`,
  /** Un incident donné n'est signalé qu'une fois pour un paiement. */
  paymentReview: (paymentId: string, incident: string | null) =>
    `payment_review:${paymentId}:${incident ?? 'none'}`,
  supportRequest: (requestId: string) => `support_request:${requestId}`,
  campaignAudiencePartial: (campaignId: string) =>
    `campaign_audience_partial:${campaignId}`,
  campaignCompleted: (campaignId: string) => `campaign_completed:${campaignId}`,
});

// ─── Paiements ─────────────────────────────────────────────────────────

/**
 * Paiement nécessitant une intervention : statut `review` UNIQUEMENT
 * (discordance, encaissement en conflit, réponses incohérentes : traitement
 * opérateur documenté, aucune issue automatique). Jamais `pending`,
 * `uncertain` (repris par le rapprochement périodique) ni `failed` (refus
 * du payeur). Un remboursement consigné (`refundedAt`) est déjà traité.
 */
export function paymentNeedsIntervention(payment: {
  status?: unknown;
  refundedAt?: unknown;
}): boolean {
  return payment.status === 'review' && !payment.refundedAt;
}

/**
 * Paiement confirmé : `succeeded` AVEC sa période (écrits dans la même
 * transaction) et sa date de confirmation. Une prolongation offerte n'est
 * jamais un paiement (aucun document `subscription_payments`).
 */
export function paymentIsConfirmed(payment: {
  status?: unknown;
  periodId?: unknown;
  confirmedAt?: unknown;
}): boolean {
  return (
    payment.status === 'succeeded' &&
    payment.periodId != null &&
    payment.confirmedAt instanceof Date
  );
}

// ─── Campagnes ─────────────────────────────────────────────────────────

export interface CampaignFinalCounts {
  accepted: number;
  skipped: number;
  failed: number;
  uncertain: number;
}

export type CampaignDeliveryCounts = CampaignFinalCounts & {
  pending: number;
  sending: number;
};

/**
 * Délai après le gel de l'audience avant de conclure : une constitution
 * interrompue (bail expiré) peut encore insérer sa dernière page.
 */
export const CAMPAIGN_COMPLETION_GRACE_MS = 5 * 60_000;

export interface CampaignState {
  status: 'draft' | 'launched';
  audience: {
    status: 'none' | 'preparing' | 'ready';
    total: number;
    frozenAt?: Date | null;
    incomplete?: boolean;
  };
}

/** Audience close partielle (constitution interrompue) : à vérifier. */
export function campaignAudienceIsPartial(campaign: CampaignState): boolean {
  return (
    campaign.status === 'launched' &&
    campaign.audience.status === 'ready' &&
    campaign.audience.incomplete === true
  );
}

/**
 * Fin du traitement : audience GELÉE depuis le délai de grâce et plus
 * aucune livraison `pending` ni `sending`. Un interrupteur d'envoi coupé
 * laisse les livraisons `pending` : la campagne n'est jamais terminée.
 */
export function campaignIsCompleted(
  campaign: CampaignState,
  counts: CampaignDeliveryCounts,
  now: Date,
): boolean {
  if (campaign.status !== 'launched') return false;
  if (campaign.audience.status !== 'ready') return false;
  const frozenAt = campaign.audience.frozenAt;
  if (!(frozenAt instanceof Date)) return false;
  if (now.getTime() - frozenAt.getTime() < CAMPAIGN_COMPLETION_GRACE_MS) {
    return false;
  }
  return counts.pending === 0 && counts.sending === 0;
}

export function finalCounts(
  counts: CampaignDeliveryCounts,
): CampaignFinalCounts {
  return {
    accepted: counts.accepted,
    skipped: counts.skipped,
    failed: counts.failed,
    uncertain: counts.uncertain,
  };
}

export function organizationNameParam(name: unknown): string | null {
  return typeof name === 'string' && name.length > 0
    ? name.slice(0, MAX_ORGANIZATION_NAME)
    : null;
}

// ─── Réponse ───────────────────────────────────────────────────────────

export interface NotificationView {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  occurredAt: string;
  createdAt: string;
  read: boolean;
  readAt: string | null;
  /** `available: false` : cible disparue (« Élément indisponible »). */
  target: {
    kind: NotificationTargetKind;
    id: string;
    organizationId: string | null;
    available: boolean;
  };
  params: NotificationParams;
}

/**
 * Forme publique : champs listés un par un (jamais le document brut), les
 * paramètres filtrés sur la liste blanche ci-dessus.
 */
export function toNotificationView(
  doc: PlatformAdminNotificationDoc,
  readAt: Date | null,
  available: boolean,
): NotificationView {
  const p = doc.params ?? {};
  const params: NotificationParams = {};
  if (p.organizationName !== undefined)
    params.organizationName = p.organizationName;
  if (typeof p.amount === 'number') params.amount = p.amount;
  if (typeof p.currency === 'string') params.currency = p.currency;
  if (typeof p.term === 'string') params.term = p.term;
  if (typeof p.months === 'number') params.months = p.months;
  if (p.incidentCode !== undefined) params.incidentCode = p.incidentCode;
  if (typeof p.reference === 'string') params.reference = p.reference;
  if (typeof p.supportCategory === 'string')
    params.supportCategory = p.supportCategory;
  if (typeof p.audienceTotal === 'number')
    params.audienceTotal = p.audienceTotal;
  if (p.results) {
    params.results = {
      accepted: p.results.accepted,
      skipped: p.results.skipped,
      failed: p.results.failed,
      uncertain: p.results.uncertain,
    };
  }
  return {
    id: doc._id.toHexString(),
    type: doc.type,
    category: doc.category,
    occurredAt: doc.occurredAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    read: readAt !== null,
    readAt: readAt?.toISOString() ?? null,
    target: {
      kind: doc.target.kind,
      id: doc.target.id,
      organizationId: doc.target.organizationId,
      available,
    },
    params,
  };
}
