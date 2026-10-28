import type { Connection, Types } from 'mongoose';
import type { EncryptedTotpSecret } from './totp-secret-cipher';
import type { PlatformCapability } from './platform-admin-capabilities';

/**
 * Collections de l'administration de la plateforme. Accès par le pilote
 * natif (mises à jour conditionnelles atomiques, transactions) ; aucune
 * n'est déclarée comme modèle Mongoose : aucun `save()` générique, aucun
 * index créé au démarrage (migration `create-platform-admin-indexes`).
 *
 * Aucune route ne modifie `platform_admin_grants` : seule la commande
 * opérateur `platform-admin` l'écrit. `platform_admin_audit` est en ajout
 * seul (aucune mise à jour ni suppression dans le code).
 */
export const PLATFORM_ADMIN_COLLECTIONS = Object.freeze({
  grants: 'platform_admin_grants',
  factors: 'platform_admin_mfa_factors',
  recoveryCodes: 'platform_admin_recovery_codes',
  sessions: 'platform_admin_sessions',
  challenges: 'platform_admin_challenges',
  audit: 'platform_admin_audit',
  operations: 'platform_admin_operations',
  // Communications de service (message figé, livraisons, compteurs).
  messages: 'platform_messages',
  messageDeliveries: 'platform_message_deliveries',
  messageCounters: 'platform_message_counters',
  // Campagnes promotionnelles (distinctes des messages de service).
  campaigns: 'platform_campaigns',
  campaignDeliveries: 'platform_campaign_deliveries',
});

export type GrantStatus = 'active' | 'revoked';

export interface PlatformAdminGrantDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: GrantStatus;
  grantedAt: Date;
  grantedBy: string;
  grantReason: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
  /**
   * Capacités plateforme (`platform-admin-capabilities.ts`). Absent
   * (autorisations antérieures) : lecture seule.
   */
  capabilities?: PlatformCapability[];
  updatedAt: Date;
}

/**
 * Un document par utilisateur. `active` = facteur en service ; `pending` =
 * secret en cours d'enrôlement ou de remplacement, lié à UNE session.
 * `version` augmente à chaque activation : une session vérifiée avec une
 * version antérieure n'est plus valable. `lastUsedStep` refuse le rejeu.
 */
export interface PlatformAdminFactorDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  active: EncryptedTotpSecret | null;
  activatedAt: Date | null;
  version: number;
  lastUsedStep: number | null;
  recoveryBatch: string | null;
  pending: EncryptedTotpSecret | null;
  pendingSessionId: Types.ObjectId | null;
  pendingCreatedAt: Date | null;
  updatedAt: Date;
}

export interface PlatformAdminRecoveryCodeDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  batch: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

export type SessionStage = 'password' | 'mfa';

export interface PlatformAdminSessionDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  userId: Types.ObjectId;
  stage: SessionStage;
  /** `User.authVersion` à l'ouverture : un changement la rend caduque. */
  authVersion: number;
  createdAt: Date;
  passwordVerifiedAt: Date;
  mfaVerifiedAt: Date | null;
  factorVersion: number | null;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  /** Nombre de challenges de connexion émis (plafond par session). */
  challengeCount: number;
  revokedAt: Date | null;
  revokeReason: string | null;
}

export type ChallengePurpose = 'login' | 'enroll' | 'replace' | 'step_up';

export interface PlatformAdminChallengeDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: ChallengePurpose;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  /**
   * Vérification renforcée LIÉE à une action (`step_up` seulement) :
   * action, organisation et empreinte du contenu confirmé. Absent : preuve
   * des opérations de sécurité du compte (codes, facteur) uniquement.
   */
  boundAction?: PlatformAdminActionKind | null;
  boundTargetId?: string | null;
  boundContentHash?: string | null;
}

export type PlatformAdminActionKind =
  | 'organization_suspend'
  | 'organization_reactivate'
  | 'subscription_extend'
  | 'organization_message'
  | 'organization_message_retry'
  | 'campaign_launch';

export type MessageChannel = 'in_app' | 'email';
export const MESSAGE_CHANNELS: readonly MessageChannel[] = Object.freeze([
  'in_app',
  'email',
]);

/**
 * Message de service FIGÉ à la validation : contenu saisi (texte brut),
 * canaux et destinataires exacts (dédupliqués). Seul stockage du contenu :
 * ni l'audit, ni l'opération, ni les journaux ne le recopient.
 */
export interface PlatformMessageDoc {
  _id: Types.ObjectId;
  operationId: string;
  organizationId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  title: string;
  body: string;
  channels: MessageChannel[];
  recipientUserIds: Types.ObjectId[];
  createdAt: Date;
  /**
   * Archivage administratif (masquage de l'historique principal). Absent ou
   * `null` = actif (messages antérieurs compris). Ne touche jamais aux
   * livraisons, notifications ni e-mails déjà envoyés.
   */
  archivedAt?: Date | null;
  archivedBy?: Types.ObjectId | null;
}

/**
 * - `pending` : à traiter (`nextAttemptAt`) ;
 * - `sending` : réservé par le traitement de fond (`lockedUntil`) ;
 * - `created` : notification interne créée dans le centre ;
 * - `accepted` : e-mail ACCEPTÉ par le prestataire (ni reçu, ni lu) ;
 * - `skipped` : destinataire devenu inéligible ou préférence désactivée ;
 * - `failed` : refus certain ou reprises épuisées sans incertitude ;
 * - `uncertain` : le prestataire a pu accepter l'e-mail sans que la réponse
 *   arrive (délai, réseau, 5xx) et plus aucune reprise sûre n'est possible.
 */
export type MessageDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'created'
  | 'accepted'
  | 'skipped'
  | 'failed'
  | 'uncertain';

/** Livraison d'UN message à UN destinataire par UN canal (unique). */
export interface PlatformMessageDeliveryDoc {
  _id: Types.ObjectId;
  messageId: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  channel: MessageChannel;
  status: MessageDeliveryStatus;
  attempts: number;
  /** Relances manuelles (bornées). */
  manualRetries: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  /** Premier envoi au prestataire (fenêtre de sa clé d'idempotence). */
  firstAttemptAt: Date | null;
  /** Première issue incertaine (l'e-mail a peut-être été accepté). */
  uncertainAt: Date | null;
  /**
   * E-mail : destinataire, langue et nom du commerce figés au premier envoi
   * (un renvoi avec la même clé d'idempotence doit être identique).
   */
  emailSnapshot: {
    to: string;
    locale: 'fr' | 'en';
    organizationName: string;
  } | null;
  /** Motif court (`membership_inactive`, `timeout`, `rejected_422`…). */
  reason: string | null;
  /** Notification du centre créée (canal `in_app`). */
  notificationId: Types.ObjectId | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Compteur touché dans la transaction d'envoi (`org:<id>`, `actor:<id>`) :
 * deux envois simultanés entrent en conflit d'écriture et l'un relit les
 * envois de l'autre avant d'appliquer les limites.
 */
export interface PlatformMessageCounterDoc {
  _id: string;
  lastAt: Date;
}

/** Ciblage d'une campagne : tous les commerces ou une sélection explicite. */
export type CampaignTargeting =
  { mode: 'all' } | { mode: 'selected'; organizationIds: Types.ObjectId[] };

/**
 * Campagne promotionnelle par e-mail. `draft` : sujet, texte et ciblage
 * modifiables (`revision` incrémentée à chaque modification). `launched` :
 * contenu et ciblage FIGÉS ; audience préparée par pages (`audience`),
 * jamais élargie après le lancement (`launchedAt` sert de borne).
 */
export interface PlatformCampaignDoc {
  _id: Types.ObjectId;
  status: 'draft' | 'launched';
  subject: string;
  body: string;
  targeting: CampaignTargeting;
  revision: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedBy: Types.ObjectId;
  updatedAt: Date;
  launchedAt: Date | null;
  launchedBy: Types.ObjectId | null;
  /** Identifiant d'opération du lancement (unique : aucun double lancement). */
  launchOperationId: string | null;
  audience: {
    /** `preparing` : constitution en cours ; `ready` : audience GELÉE. */
    status: 'none' | 'preparing' | 'ready';
    /** Curseur de constitution (dernier `_id` d'accord examiné). */
    cursor: string | null;
    total: number;
    /** Fin du bail de constitution : au-delà, close sans nouvelle évaluation. */
    leaseUntil?: Date | null;
    /** Gel de l'audience (aucun ajout ensuite). */
    frozenAt?: Date | null;
    /** Constitution interrompue puis close : audience partielle. */
    incomplete?: boolean;
  };
  archivedAt: Date | null;
  archivedBy: Types.ObjectId | null;
}

/** Livraison d'UNE campagne à UN utilisateur (unique : aucun doublon). */
export interface PlatformCampaignDeliveryDoc {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  userId: Types.ObjectId;
  status: Exclude<MessageDeliveryStatus, 'created'>;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  firstAttemptAt: Date | null;
  uncertainAt: Date | null;
  /**
   * Figé au premier envoi : adresse, son empreinte, langue et empreinte du
   * secret de désabonnement. Une reprise n'est envoyée qu'à cette adresse,
   * avec le même contenu et le même lien.
   */
  snapshot: {
    to: string;
    addressSha256: string;
    locale: 'fr' | 'en';
    unsubscribeKeyId: string;
  } | null;
  reason: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Opération administrative idempotente : `_id` = identifiant d'opération
 * fourni par l'interface. Écrite dans la MÊME transaction que l'action, la
 * consommation de la preuve renforcée et l'audit. Même identifiant et même
 * contenu → résultat existant ; contenu différent → refus.
 */
export interface PlatformAdminOperationDoc {
  _id: string;
  action: PlatformAdminActionKind;
  organizationId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  contentHash: string;
  createdAt: Date;
  /** Motif saisi (interne à la plateforme). */
  reason: string;
  /** Résultat rejouable (aucune donnée secrète). */
  result: Record<string, unknown>;
}

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditActorType = 'admin' | 'operator' | 'anonymous';

export const PLATFORM_ADMIN_AUDIT_ACTIONS = [
  'login_password',
  'mfa_verify',
  'mfa_recovery_code',
  'mfa_enroll_start',
  'mfa_enroll_confirm',
  'mfa_step_up',
  'mfa_factor_replace_start',
  'mfa_factor_replace_confirm',
  'recovery_codes_regenerate',
  'logout',
  'session_rejected',
  'access_grant',
  'access_revoke',
  'mfa_reset',
  'key_rotation',
  'organization_view',
  'payments_view',
  'audit_view',
  'capability_grant',
  'capability_revoke',
  'organization_suspend',
  'organization_reactivate',
  'subscription_extend',
  'organization_message',
  'organization_message_retry',
  'organization_message_archive',
  'organization_message_restore',
  'campaign_create',
  'campaign_update',
  'campaign_launch',
  'campaign_archive',
  'campaign_restore',
] as const;
export type PlatformAdminAuditAction =
  (typeof PLATFORM_ADMIN_AUDIT_ACTIONS)[number];

export interface PlatformAdminAuditDoc {
  _id: Types.ObjectId;
  at: Date;
  actorType: AuditActorType;
  actorUserId: Types.ObjectId | null;
  /** Opérateur de la commande hors interface (jamais un secret). */
  actorLabel: string | null;
  action: PlatformAdminAuditAction;
  outcome: AuditOutcome;
  targetType:
    'user' | 'organization' | 'session' | 'factor' | 'campaign' | null;
  targetId: string | null;
  /** Code court (motif de refus) ou motif opérateur, jamais une donnée secrète. */
  detail: string | null;
  sessionId: Types.ObjectId | null;
  /** Empreinte HMAC de l'origine réseau (jamais l'adresse en clair). */
  clientKeyHash: string | null;
  /** Capacité plateforme exercée ou modifiée. */
  capability: PlatformCapability | null;
  /** Identifiant d'opération idempotente (actions). */
  operationId: string | null;
  /** État avant / après (valeurs simples, jamais un secret). */
  before: AuditState | null;
  after: AuditState | null;
}

export type AuditState = Record<string, string | number | boolean | null>;

export function platformAdminCollections(connection: Connection) {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  return {
    grants: db.collection<PlatformAdminGrantDoc>(
      PLATFORM_ADMIN_COLLECTIONS.grants,
    ),
    factors: db.collection<PlatformAdminFactorDoc>(
      PLATFORM_ADMIN_COLLECTIONS.factors,
    ),
    recoveryCodes: db.collection<PlatformAdminRecoveryCodeDoc>(
      PLATFORM_ADMIN_COLLECTIONS.recoveryCodes,
    ),
    sessions: db.collection<PlatformAdminSessionDoc>(
      PLATFORM_ADMIN_COLLECTIONS.sessions,
    ),
    challenges: db.collection<PlatformAdminChallengeDoc>(
      PLATFORM_ADMIN_COLLECTIONS.challenges,
    ),
    audit: db.collection<PlatformAdminAuditDoc>(
      PLATFORM_ADMIN_COLLECTIONS.audit,
    ),
    operations: db.collection<PlatformAdminOperationDoc>(
      PLATFORM_ADMIN_COLLECTIONS.operations,
    ),
    messages: db.collection<PlatformMessageDoc>(
      PLATFORM_ADMIN_COLLECTIONS.messages,
    ),
    messageDeliveries: db.collection<PlatformMessageDeliveryDoc>(
      PLATFORM_ADMIN_COLLECTIONS.messageDeliveries,
    ),
    messageCounters: db.collection<PlatformMessageCounterDoc>(
      PLATFORM_ADMIN_COLLECTIONS.messageCounters,
    ),
    campaigns: db.collection<PlatformCampaignDoc>(
      PLATFORM_ADMIN_COLLECTIONS.campaigns,
    ),
    campaignDeliveries: db.collection<PlatformCampaignDeliveryDoc>(
      PLATFORM_ADMIN_COLLECTIONS.campaignDeliveries,
    ),
  };
}

export type PlatformAdminCollections = ReturnType<
  typeof platformAdminCollections
>;

export const MAX_AUDIT_DETAIL_LENGTH = 300;

export interface AuditEntryInput {
  actorType: AuditActorType;
  actorUserId?: Types.ObjectId | null;
  actorLabel?: string | null;
  action: PlatformAdminAuditAction;
  outcome: AuditOutcome;
  targetType?: PlatformAdminAuditDoc['targetType'];
  targetId?: string | null;
  detail?: string | null;
  sessionId?: Types.ObjectId | null;
  clientKeyHash?: string | null;
  capability?: PlatformCapability | null;
  operationId?: string | null;
  before?: AuditState | null;
  after?: AuditState | null;
}

/** Ajout seul : aucune fonction de modification ou de suppression. */
export function auditDocument(
  input: AuditEntryInput,
  at: Date,
): Omit<PlatformAdminAuditDoc, '_id'> {
  return {
    at,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    actorLabel: input.actorLabel?.slice(0, 100) ?? null,
    action: input.action,
    outcome: input.outcome,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    detail: input.detail?.slice(0, MAX_AUDIT_DETAIL_LENGTH) ?? null,
    sessionId: input.sessionId ?? null,
    clientKeyHash: input.clientKeyHash ?? null,
    capability: input.capability ?? null,
    operationId: input.operationId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
  };
}
