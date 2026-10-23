import type { Connection, Types } from 'mongoose';
import type { EncryptedTotpSecret } from './totp-secret-cipher';

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
  targetType: 'user' | 'organization' | 'session' | 'factor' | null;
  targetId: string | null;
  /** Code court (motif de refus) ou motif opérateur, jamais une donnée secrète. */
  detail: string | null;
  sessionId: Types.ObjectId | null;
  /** Empreinte HMAC de l'origine réseau (jamais l'adresse en clair). */
  clientKeyHash: string | null;
}

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
  };
}
