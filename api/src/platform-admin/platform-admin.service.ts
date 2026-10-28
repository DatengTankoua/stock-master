import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { currentSessionVersion } from '../auth/session-version';
import { PersistentRateLimiter } from '../common/rate-limit/persistent-rate-limiter.service';
import type { FixedWindowPolicy } from '../common/rate-limit/anti-abuse-config';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import {
  auditDocument,
  type AuditEntryInput,
  type ChallengePurpose,
  type PlatformAdminChallengeDoc,
  type PlatformAdminFactorDoc,
  type PlatformAdminSessionDoc,
} from './platform-admin-store';
import {
  adminCapabilityRequired,
  adminAccessDenied,
  adminAlreadyEnrolled,
  adminChallengeInvalid,
  adminCodeInvalid,
  adminEnrollmentRequired,
  adminMfaRequired,
  adminRateLimited,
  adminSessionExpired,
  adminStepUpRequired,
  adminUnavailable,
} from './platform-admin-errors';
import {
  constantTimeEquals,
  generateRecoveryCodes,
  hashOpaqueToken,
  hashRecoveryCode,
  newOpaqueToken,
  normalizeRecoveryCode,
  OPAQUE_TOKEN_PATTERN,
} from './platform-admin-tokens';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  type EncryptedTotpSecret,
} from './totp-secret-cipher';
import {
  effectiveCapabilities,
  type PlatformCapability,
} from './platform-admin-capabilities';
import {
  actionContentHash,
  auditCapability,
  intentCapabilities,
  intentTarget,
  type ActionIntent,
} from './platform-admin-action-intent';
import { generateTotpSecret, totpProvisioning, verifyTotpCode } from './totp';

/**
 * Durées (documentées dans docs/architecture/platform-admin-mfa.md) :
 * - session avant second facteur : 10 min, non prolongée ;
 * - session vérifiée : 30 min d'inactivité, 8 h au plus après la
 *   validation du second facteur ;
 * - challenge : 5 min, 5 essais, usage unique ;
 * - vérification renforcée (mot de passe + second facteur) : 5 min, usage
 *   unique, pour changer de facteur ou renouveler les codes.
 */
export const PRE_MFA_SESSION_SECONDS = 600;
export const SESSION_IDLE_SECONDS = 1_800;
export const SESSION_ABSOLUTE_SECONDS = 8 * 3_600;
export const CHALLENGE_SECONDS = 300;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const MAX_LOGIN_CHALLENGES_PER_SESSION = 10;
const SESSION_TOUCH_INTERVAL_MS = 60_000;

const FIFTEEN_MINUTES = 15 * 60_000;
/** Connexions administratives par origine réseau (succès non comptés). */
export const ADMIN_LOGIN_IP_POLICY: FixedWindowPolicy = {
  scope: 'platform-admin-login-ip',
  limit: 20,
  windowMs: FIFTEEN_MINUTES,
};
/** Échecs du second facteur par compte. */
export const ADMIN_MFA_ACCOUNT_POLICY: FixedWindowPolicy = {
  scope: 'platform-admin-mfa-account',
  limit: 5,
  windowMs: FIFTEEN_MINUTES,
};
/** Échecs du second facteur par origine réseau (IP ou /64). */
export const ADMIN_MFA_IP_POLICY: FixedWindowPolicy = {
  scope: 'platform-admin-mfa-ip',
  limit: 20,
  windowMs: FIFTEEN_MINUTES,
};

/**
 * Appel sans le secret du BFF, ou espace fermé : la garde répond comme pour
 * une route inexistante (aucune information sur l'administration).
 */
export class PlatformAdminHiddenRoute extends Error {}

/** Requête relayée sans adresse de confiance (voir le BFF). */
export const UNATTRIBUTED_CLIENT = 'unattributed';

export type AccessLevel = 'login' | 'session' | 'pre-mfa' | 'mfa';

export interface PlatformAdminRequestContext {
  clientKey: string;
  clientKeyHash: string;
  session?: PlatformAdminSessionDoc;
  user?: { _id: Types.ObjectId; name: string; email: string };
  factor?: PlatformAdminFactorDoc | null;
  /** Capacités de l'autorisation ACTIVE, relues à chaque requête. */
  capabilities?: ReadonlySet<PlatformCapability>;
}

export interface AuthenticationInput {
  proxySecret: string | undefined;
  sessionToken: string | undefined;
  clientKey: string;
}

export interface SecondFactorInput {
  code?: string;
  recoveryCode?: string;
}

type MongoSession = Awaited<ReturnType<Connection['startSession']>>;

/** Rejet décidé dans une transaction (annulée, jamais rejouée). */
class CommitRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface SessionIssue {
  token: string;
}

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger('PlatformAdmin');

  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly rateLimiter: PersistentRateLimiter,
  ) {}

  private get db() {
    return this.runtime.collections();
  }

  private now(): Date {
    return this.runtime.clock();
  }

  private keyring() {
    const config = this.runtime.config;
    if (!config.enabled) throw adminUnavailable();
    return config.keyring;
  }

  clientKeyHash(clientKey: string): string {
    return this.rateLimiter.keyFor('platform-admin-client', clientKey);
  }

  // ─── Authentification de chaque requête ──────────────────────────────

  async authenticate(
    level: AccessLevel,
    input: AuthenticationInput,
  ): Promise<PlatformAdminRequestContext> {
    // Sans le secret du BFF (ou espace fermé) : la route n'existe pas pour
    // l'appelant (404 identique à une route inconnue). Seul le BFF apprend
    // ensuite si l'espace est ouvert (503).
    const config = this.runtime.config;
    if (
      !config.enabled ||
      !input.proxySecret ||
      !constantTimeEquals(input.proxySecret, config.proxySecret)
    ) {
      throw new PlatformAdminHiddenRoute();
    }
    if (!(await this.runtime.isOpen())) throw adminUnavailable();
    const context: PlatformAdminRequestContext = {
      clientKey: input.clientKey,
      clientKeyHash: this.clientKeyHash(input.clientKey),
    };
    if (level === 'login') return context;

    const token = input.sessionToken;
    if (!token || !OPAQUE_TOKEN_PATTERN.test(token))
      throw adminSessionExpired();
    const now = this.now();
    const session = await this.db.sessions.findOne({
      tokenHash: hashOpaqueToken(token),
    });
    if (
      !session ||
      session.revokedAt ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      throw adminSessionExpired();
    }

    // Identité relue à chaque requête : compte présent, adresse vérifiée,
    // version de session inchangée (réinitialisation du mot de passe…).
    const user = await this.usersService.findByIdForAuth(
      session.userId.toHexString(),
    );
    if (
      !user ||
      !user.emailVerifiedAt ||
      currentSessionVersion(user) !== session.authVersion
    ) {
      await this.revokeSession(session, 'account_changed', context);
      throw adminSessionExpired();
    }
    // Autorisation plateforme relue à chaque requête : une révocation
    // ferme immédiatement l'accès, même avec une session encore valable.
    const grant = await this.db.grants.findOne({
      userId: session.userId,
      status: 'active',
    });
    if (!grant) {
      await this.revokeSession(session, 'access_revoked', context);
      throw adminSessionExpired();
    }
    const factor = await this.db.factors.findOne({ userId: session.userId });
    context.capabilities = effectiveCapabilities(grant);

    if (level === 'pre-mfa' && session.stage !== 'password') {
      throw adminAlreadyEnrolled();
    }
    if (level === 'mfa') {
      if (session.stage !== 'mfa') throw adminMfaRequired();
      // Facteur remplacé ou réinitialisé depuis la vérification : caduque.
      if (!factor?.active || factor.version !== session.factorVersion) {
        await this.revokeSession(session, 'factor_changed', context);
        throw adminSessionExpired();
      }
    }

    if (
      session.stage === 'mfa' &&
      now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS
    ) {
      const idle = new Date(
        Math.min(
          now.getTime() + SESSION_IDLE_SECONDS * 1000,
          session.absoluteExpiresAt.getTime(),
        ),
      );
      await this.db.sessions.updateOne(
        { _id: session._id, revokedAt: null },
        { $set: { lastSeenAt: now, idleExpiresAt: idle } },
      );
      session.lastSeenAt = now;
      session.idleExpiresAt = idle;
    }

    context.session = session;
    context.user = { _id: user._id, name: user.name, email: user.email };
    context.factor = factor;
    return context;
  }

  // ─── Connexion : mot de passe ─────────────────────────────────────────

  async login(
    input: { email: string; password: string; challengeToken?: string },
    context: PlatformAdminRequestContext,
  ): Promise<{
    session: SessionIssue;
    stage: 'enroll' | 'verify';
    challenge?: { token: string; expiresAt: Date };
  }> {
    const ipAttempt = await this.consumeNetwork(ADMIN_LOGIN_IP_POLICY, context);
    if (!ipAttempt.allowed) {
      await this.audit({
        actorType: 'anonymous',
        action: 'login_password',
        outcome: 'denied',
        detail: 'rate_limited',
        clientKeyHash: context.clientKeyHash,
      });
      throw adminRateLimited(ipAttempt.retryAfterSeconds);
    }
    let user;
    try {
      // Mêmes vérifications et MÊMES compteurs par compte que la connexion
      // d'un commerce (plafond persistant, défi anti-robot, adresse vérifiée).
      user = await this.authService.verifyCredentials(
        input.email,
        input.password,
        { challengeToken: input.challengeToken, clientKey: context.clientKey },
      );
    } catch (error) {
      await this.audit({
        actorType: 'anonymous',
        action: 'login_password',
        outcome: 'failure',
        detail: 'credentials',
        clientKeyHash: context.clientKeyHash,
      });
      throw error;
    }
    await ipAttempt.release();

    const grant = await this.db.grants.findOne({
      userId: user._id,
      status: 'active',
    });
    if (!grant) {
      await this.audit({
        actorType: 'anonymous',
        actorUserId: user._id,
        action: 'login_password',
        outcome: 'denied',
        detail: 'no_platform_access',
        clientKeyHash: context.clientKeyHash,
      });
      throw adminAccessDenied();
    }

    const now = this.now();
    const token = newOpaqueToken();
    const expiresAt = new Date(now.getTime() + PRE_MFA_SESSION_SECONDS * 1000);
    const sessionId = new Types.ObjectId();
    await this.db.sessions.insertOne({
      _id: sessionId,
      tokenHash: hashOpaqueToken(token),
      userId: user._id,
      stage: 'password',
      authVersion: currentSessionVersion(user),
      createdAt: now,
      passwordVerifiedAt: now,
      mfaVerifiedAt: null,
      factorVersion: null,
      lastSeenAt: now,
      idleExpiresAt: expiresAt,
      absoluteExpiresAt: expiresAt,
      challengeCount: 0,
      revokedAt: null,
      revokeReason: null,
    });
    const factor = await this.db.factors.findOne({ userId: user._id });
    await this.audit({
      actorType: 'admin',
      actorUserId: user._id,
      action: 'login_password',
      outcome: 'success',
      detail: factor?.active ? 'verify' : 'enroll',
      sessionId,
      clientKeyHash: context.clientKeyHash,
    });
    if (!factor?.active) {
      return { session: { token }, stage: 'enroll' };
    }
    const challenge = await this.createChallenge(
      sessionId,
      user._id,
      'login',
      now,
    );
    await this.db.sessions.updateOne(
      { _id: sessionId },
      { $inc: { challengeCount: 1 } },
    );
    return { session: { token }, stage: 'verify', challenge };
  }

  /** Nouveau challenge de connexion (le précédent a expiré ou est épuisé). */
  async newLoginChallenge(
    context: PlatformAdminRequestContext,
  ): Promise<{ token: string; expiresAt: Date }> {
    const { session } = this.requireSession(context);
    if (!context.factor?.active) throw adminEnrollmentRequired();
    const counted = await this.db.sessions.updateOne(
      {
        _id: session._id,
        revokedAt: null,
        challengeCount: { $lt: MAX_LOGIN_CHALLENGES_PER_SESSION },
      },
      { $inc: { challengeCount: 1 } },
    );
    if (counted.matchedCount === 0) {
      // Plafond par session atteint : nouvelle connexion par mot de passe.
      await this.revokeSession(session, 'challenge_limit', context);
      throw adminSessionExpired();
    }
    return this.createChallenge(
      session._id,
      session.userId,
      'login',
      this.now(),
    );
  }

  async status(context: PlatformAdminRequestContext) {
    const { session, user } = this.requireSession(context);
    const stage =
      session.stage === 'mfa'
        ? 'ready'
        : context.factor?.active
          ? 'verify'
          : 'enroll';
    return {
      stage,
      user: { name: user.name, email: user.email },
      session: {
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
      ...(stage === 'ready'
        ? {
            recoveryCodesRemaining: await this.remainingRecoveryCodes(context),
            capabilities: [...(context.capabilities ?? [])].sort(),
          }
        : {}),
    };
  }

  // ─── Enrôlement initial ───────────────────────────────────────────────

  async startEnrollment(context: PlatformAdminRequestContext) {
    const { session, user } = this.requireSession(context);
    if (context.factor?.active) throw adminAlreadyEnrolled();
    const now = this.now();
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(
      secret,
      user._id.toHexString(),
      this.keyring(),
    );
    try {
      await this.db.factors.updateOne(
        { userId: user._id, active: null },
        {
          $set: {
            pending: encrypted,
            pendingSessionId: session._id,
            pendingCreatedAt: now,
            updatedAt: now,
          },
          $setOnInsert: {
            activatedAt: null,
            version: 0,
            lastUsedStep: null,
            recoveryBatch: null,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // Facteur activé entre-temps (index unique `userId`).
      if ((error as { code?: unknown }).code === 11000) {
        throw adminAlreadyEnrolled();
      }
      throw error;
    }
    const challenge = await this.createChallenge(
      session._id,
      user._id,
      'enroll',
      now,
    );
    await this.audit({
      actorType: 'admin',
      actorUserId: user._id,
      action: 'mfa_enroll_start',
      outcome: 'success',
      sessionId: session._id,
      clientKeyHash: context.clientKeyHash,
    });
    return {
      ...totpProvisioning(secret, user.email),
      challenge,
    };
  }

  async confirmEnrollment(
    context: PlatformAdminRequestContext,
    input: { challengeToken: string; code: string },
  ) {
    return this.confirmNewFactor(context, input, 'enroll');
  }

  // ─── Second facteur à la connexion ────────────────────────────────────

  async verifyLogin(
    context: PlatformAdminRequestContext,
    input: { challengeToken: string } & SecondFactorInput,
  ): Promise<{ session: SessionIssue; recoveryCodesRemaining: number }> {
    const { session, user } = this.requireSession(context);
    const factor = context.factor;
    if (!factor?.active) throw adminEnrollmentRequired();
    const usesRecovery = Boolean(input.recoveryCode);
    const action = usesRecovery ? 'mfa_recovery_code' : 'mfa_verify';
    const limits = await this.consumeMfaAttempt(context, user._id, action);
    const challenge = await this.claimChallenge(
      context,
      input.challengeToken,
      'login',
      action,
    );
    const proof = this.checkSecondFactor(factor, user._id, input);

    const now = this.now();
    const token = newOpaqueToken();
    try {
      await this.inTransaction(async (txn) => {
        await this.applySecondFactor(factor, user._id, proof, now, txn);
        await this.consumeChallenge(challenge, now, txn);
        const upgraded = await this.db.sessions.updateOne(
          { _id: session._id, stage: 'password', revokedAt: null },
          {
            $set: {
              tokenHash: hashOpaqueToken(token),
              stage: 'mfa',
              mfaVerifiedAt: now,
              factorVersion: factor.version,
              lastSeenAt: now,
              idleExpiresAt: new Date(
                now.getTime() + SESSION_IDLE_SECONDS * 1000,
              ),
              absoluteExpiresAt: new Date(
                now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000,
              ),
            },
          },
          { session: txn },
        );
        if (upgraded.matchedCount === 0) throw new CommitRejected('session');
        await this.auditIn(txn, {
          actorType: 'admin',
          actorUserId: user._id,
          action,
          outcome: 'success',
          sessionId: session._id,
          clientKeyHash: context.clientKeyHash,
        });
      });
    } catch (error) {
      throw await this.factorFailure(error, context, user._id, action);
    }
    await limits.release();
    return {
      session: { token },
      recoveryCodesRemaining: await this.remainingRecoveryCodes(context),
    };
  }

  // ─── Vérification renforcée, codes, changement de facteur ─────────────

  /**
   * Mot de passe récent + second facteur actuel → jeton à usage unique,
   * 5 min. Avec `intent` : preuve LIÉE à cette action, cette organisation et
   * ce contenu exact (empreinte), exigeant la capacité correspondante ; sans
   * `intent` : preuve des seules opérations de sécurité du compte.
   */
  async stepUp(
    context: PlatformAdminRequestContext,
    input: { password: string } & SecondFactorInput,
    intent: ActionIntent | null = null,
  ): Promise<{ stepUpToken: string; expiresAt: Date }> {
    const { session, user } = this.requireSession(context);
    const factor = context.factor;
    if (!factor?.active) throw adminEnrollmentRequired();
    if (intent) {
      for (const capability of intentCapabilities(intent)) {
        this.requireCapability(context, capability);
      }
    }
    const limits = await this.consumeMfaAttempt(
      context,
      user._id,
      'mfa_step_up',
    );
    try {
      await this.authService.verifyCredentials(user.email, input.password, {
        clientKey: context.clientKey,
      });
    } catch (error) {
      await this.audit({
        actorType: 'admin',
        actorUserId: user._id,
        action: 'mfa_step_up',
        outcome: 'failure',
        detail: 'credentials',
        sessionId: session._id,
        clientKeyHash: context.clientKeyHash,
      });
      throw error;
    }
    const proof = this.checkSecondFactor(factor, user._id, input);
    const now = this.now();
    const token = newOpaqueToken();
    const expiresAt = new Date(now.getTime() + CHALLENGE_SECONDS * 1000);
    try {
      await this.inTransaction(async (txn) => {
        await this.applySecondFactor(factor, user._id, proof, now, txn);
        await this.db.challenges.insertOne(
          {
            _id: new Types.ObjectId(),
            tokenHash: hashOpaqueToken(token),
            sessionId: session._id,
            userId: user._id,
            purpose: 'step_up',
            createdAt: now,
            expiresAt,
            consumedAt: null,
            attempts: 0,
            boundAction: intent?.action ?? null,
            boundTargetId: intent ? intentTarget(intent).id : null,
            boundContentHash: intent ? actionContentHash(intent) : null,
          },
          { session: txn },
        );
        await this.auditIn(txn, {
          actorType: 'admin',
          actorUserId: user._id,
          action: 'mfa_step_up',
          outcome: 'success',
          detail: intent ? `${proof.kind} | ${intent.action}` : proof.kind,
          ...(intent
            ? {
                targetType: intentTarget(intent).type,
                targetId: intentTarget(intent).id,
                operationId: intent.operationId,
                capability: auditCapability(intent),
              }
            : {}),
          sessionId: session._id,
          clientKeyHash: context.clientKeyHash,
        });
      });
    } catch (error) {
      throw await this.factorFailure(error, context, user._id, 'mfa_step_up');
    }
    await limits.release();
    return { stepUpToken: token, expiresAt };
  }

  async regenerateRecoveryCodes(
    context: PlatformAdminRequestContext,
    input: { stepUpToken: string },
  ): Promise<{ recoveryCodes: string[] }> {
    const { session, user } = this.requireSession(context);
    const stepUp = await this.findStepUp(context, input.stepUpToken);
    const now = this.now();
    const batch = new Types.ObjectId().toHexString();
    const codes = generateRecoveryCodes();
    try {
      await this.inTransaction(async (txn) => {
        await this.consumeChallenge(stepUp, now, txn);
        const updated = await this.db.factors.updateOne(
          { userId: user._id, active: { $ne: null } },
          { $set: { recoveryBatch: batch, updatedAt: now } },
          { session: txn },
        );
        if (updated.matchedCount === 0) throw new CommitRejected('factor');
        await this.replaceRecoveryCodes(user._id, batch, codes, now, txn);
        await this.revokeOtherSessions(
          user._id,
          session._id,
          'recovery_codes_regenerated',
          now,
          txn,
        );
        await this.auditIn(txn, {
          actorType: 'admin',
          actorUserId: user._id,
          action: 'recovery_codes_regenerate',
          outcome: 'success',
          sessionId: session._id,
          clientKeyHash: context.clientKeyHash,
        });
      });
    } catch (error) {
      if (error instanceof CommitRejected) throw adminStepUpRequired();
      throw error;
    }
    return { recoveryCodes: codes };
  }

  async startFactorReplacement(
    context: PlatformAdminRequestContext,
    input: { stepUpToken: string },
  ) {
    const { session, user } = this.requireSession(context);
    const stepUp = await this.findStepUp(context, input.stepUpToken);
    const now = this.now();
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(
      secret,
      user._id.toHexString(),
      this.keyring(),
    );
    let challenge!: { token: string; expiresAt: Date };
    try {
      await this.inTransaction(async (txn) => {
        await this.consumeChallenge(stepUp, now, txn);
        const updated = await this.db.factors.updateOne(
          { userId: user._id, active: { $ne: null } },
          {
            $set: {
              pending: encrypted,
              pendingSessionId: session._id,
              pendingCreatedAt: now,
              updatedAt: now,
            },
          },
          { session: txn },
        );
        if (updated.matchedCount === 0) throw new CommitRejected('factor');
        challenge = await this.createChallenge(
          session._id,
          user._id,
          'replace',
          now,
          txn,
        );
        await this.auditIn(txn, {
          actorType: 'admin',
          actorUserId: user._id,
          action: 'mfa_factor_replace_start',
          outcome: 'success',
          sessionId: session._id,
          clientKeyHash: context.clientKeyHash,
        });
      });
    } catch (error) {
      if (error instanceof CommitRejected) throw adminStepUpRequired();
      throw error;
    }
    return { ...totpProvisioning(secret, user.email), challenge };
  }

  async confirmFactorReplacement(
    context: PlatformAdminRequestContext,
    input: { challengeToken: string; code: string },
  ) {
    return this.confirmNewFactor(context, input, 'replace');
  }

  async logout(context: PlatformAdminRequestContext): Promise<void> {
    const { session, user } = this.requireSession(context);
    await this.db.sessions.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { revokedAt: this.now(), revokeReason: 'logout' } },
    );
    await this.audit({
      actorType: 'admin',
      actorUserId: user._id,
      action: 'logout',
      outcome: 'success',
      sessionId: session._id,
      clientKeyHash: context.clientKeyHash,
    });
  }

  /** Consultation sensible (aucune donnée consultée n'est copiée). */
  async recordConsultation(
    context: PlatformAdminRequestContext,
    action: 'organization_view' | 'payments_view' | 'audit_view',
    targetId: string | null = null,
  ): Promise<void> {
    await this.audit({
      actorType: 'admin',
      actorUserId: context.user?._id ?? null,
      action,
      outcome: 'success',
      targetType: targetId ? 'organization' : null,
      targetId,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  // ─── Interne ──────────────────────────────────────────────────────────

  private requireSession(context: PlatformAdminRequestContext) {
    if (!context.session || !context.user) throw adminSessionExpired();
    return { session: context.session, user: context.user };
  }

  /**
   * Nouveau facteur (enrôlement initial ou remplacement) : premier code
   * valide exigé, puis, en une transaction : activation, nouveaux codes de
   * récupération, challenge consommé, session courante renouvelée,
   * autres sessions administratives révoquées, audit.
   */
  private async confirmNewFactor(
    context: PlatformAdminRequestContext,
    input: { challengeToken: string; code: string },
    purpose: 'enroll' | 'replace',
  ): Promise<{ session: SessionIssue; recoveryCodes: string[] }> {
    const { session, user } = this.requireSession(context);
    const action =
      purpose === 'enroll'
        ? 'mfa_enroll_confirm'
        : 'mfa_factor_replace_confirm';
    const limits = await this.consumeMfaAttempt(context, user._id, action);
    const challenge = await this.claimChallenge(
      context,
      input.challengeToken,
      purpose,
      action,
    );
    const factor = await this.db.factors.findOne({ userId: user._id });
    if (
      !factor?.pending ||
      !factor.pendingSessionId?.equals(session._id) ||
      (purpose === 'enroll' ? factor.active !== null : factor.active === null)
    ) {
      throw adminChallengeInvalid();
    }
    const secret = this.decrypt(factor.pending, user._id);
    const now = this.now();
    const step = verifyTotpCode(secret, input.code, now);
    if (step === null) {
      await this.recordFactorFailure(context, user._id, action, 'code');
      throw adminCodeInvalid();
    }
    const token = newOpaqueToken();
    const batch = new Types.ObjectId().toHexString();
    const codes = generateRecoveryCodes();
    const version = factor.version + 1;
    try {
      await this.inTransaction(async (txn) => {
        await this.consumeChallenge(challenge, now, txn);
        const activated = await this.db.factors.updateOne(
          {
            _id: factor._id,
            version: factor.version,
            pendingSessionId: session._id,
            pending: { $ne: null },
          },
          {
            $set: {
              active: factor.pending,
              activatedAt: now,
              version,
              lastUsedStep: step,
              recoveryBatch: batch,
              pending: null,
              pendingSessionId: null,
              pendingCreatedAt: null,
              updatedAt: now,
            },
          },
          { session: txn },
        );
        if (activated.matchedCount === 0) throw new CommitRejected('factor');
        await this.replaceRecoveryCodes(user._id, batch, codes, now, txn);
        const renewed = await this.db.sessions.updateOne(
          { _id: session._id, revokedAt: null },
          {
            $set: {
              tokenHash: hashOpaqueToken(token),
              stage: 'mfa',
              mfaVerifiedAt: now,
              factorVersion: version,
              lastSeenAt: now,
              idleExpiresAt: new Date(
                now.getTime() + SESSION_IDLE_SECONDS * 1000,
              ),
              // Remplacement : l'échéance absolue n'est jamais repoussée.
              absoluteExpiresAt:
                purpose === 'enroll'
                  ? new Date(now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000)
                  : session.absoluteExpiresAt,
            },
          },
          { session: txn },
        );
        if (renewed.matchedCount === 0) throw new CommitRejected('session');
        await this.revokeOtherSessions(
          user._id,
          session._id,
          'factor_changed',
          now,
          txn,
        );
        await this.auditIn(txn, {
          actorType: 'admin',
          actorUserId: user._id,
          action,
          outcome: 'success',
          targetType: 'factor',
          targetId: String(version),
          sessionId: session._id,
          clientKeyHash: context.clientKeyHash,
        });
      });
    } catch (error) {
      throw await this.factorFailure(error, context, user._id, action);
    }
    await limits.release();
    return { session: { token }, recoveryCodes: codes };
  }

  private decrypt(encrypted: EncryptedTotpSecret, userId: Types.ObjectId) {
    try {
      return decryptTotpSecret(encrypted, userId.toHexString(), this.keyring());
    } catch {
      // Clé absente ou chiffré altéré : refus sans détail (journal serveur).
      this.logger.error('Secret TOTP illisible avec les clés chargées.');
      throw adminUnavailable();
    }
  }

  /** Vérification hors transaction (calcul) ; l'usage est appliqué ensuite. */
  private checkSecondFactor(
    factor: PlatformAdminFactorDoc,
    userId: Types.ObjectId,
    input: SecondFactorInput,
  ):
    | { kind: 'totp'; step: number }
    | { kind: 'recovery'; codeHash: string }
    | { kind: 'invalid' } {
    if (input.code && !input.recoveryCode) {
      const step = verifyTotpCode(
        this.decrypt(factor.active!, userId),
        input.code,
        this.now(),
      );
      return step === null ? { kind: 'invalid' } : { kind: 'totp', step };
    }
    if (input.recoveryCode && !input.code) {
      const normalized = normalizeRecoveryCode(input.recoveryCode);
      return normalized
        ? {
            kind: 'recovery',
            codeHash: hashRecoveryCode(userId.toHexString(), normalized),
          }
        : { kind: 'invalid' };
    }
    return { kind: 'invalid' };
  }

  /**
   * Usage atomique : pas TOTP strictement postérieur au dernier accepté
   * (rejeu refusé, y compris entre instances), ou code de récupération du
   * lot courant encore inutilisé. Dans la transaction de l'appelant.
   */
  private async applySecondFactor(
    factor: PlatformAdminFactorDoc,
    userId: Types.ObjectId,
    proof: ReturnType<PlatformAdminService['checkSecondFactor']>,
    now: Date,
    txn: MongoSession,
  ): Promise<void> {
    if (proof.kind === 'invalid') throw new CommitRejected('code');
    if (proof.kind === 'totp') {
      const used = await this.db.factors.updateOne(
        {
          _id: factor._id,
          version: factor.version,
          active: { $ne: null },
          $or: [{ lastUsedStep: null }, { lastUsedStep: { $lt: proof.step } }],
        },
        { $set: { lastUsedStep: proof.step, updatedAt: now } },
        { session: txn },
      );
      if (used.matchedCount === 0) throw new CommitRejected('replay');
      return;
    }
    const consumed = await this.db.recoveryCodes.updateOne(
      {
        userId,
        batch: factor.recoveryBatch ?? '',
        codeHash: proof.codeHash,
        usedAt: null,
      },
      { $set: { usedAt: now } },
      { session: txn },
    );
    if (consumed.matchedCount === 0) throw new CommitRejected('code');
  }

  /**
   * Plafond par origine réseau, seulement si le BFF a relayé une adresse
   * de confiance. Sinon (`UNATTRIBUTED_CLIENT`), aucun plafond par adresse :
   * l'adresse du BFF les partagerait entre tous les administrateurs (un
   * tiers pourrait bloquer la connexion de tous) ; les plafonds par compte
   * restent appliqués.
   */
  private async consumeNetwork(
    policy: FixedWindowPolicy,
    context: PlatformAdminRequestContext,
  ): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
    release(): Promise<void>;
  }> {
    if (context.clientKey === UNATTRIBUTED_CLIENT) {
      return { allowed: true, retryAfterSeconds: 1, release: async () => {} };
    }
    return this.rateLimiter.consume(policy, context.clientKey);
  }

  private async consumeMfaAttempt(
    context: PlatformAdminRequestContext,
    userId: Types.ObjectId,
    action: AuditEntryInput['action'],
  ) {
    const account = await this.rateLimiter.consume(
      ADMIN_MFA_ACCOUNT_POLICY,
      userId.toHexString(),
    );
    const network = await this.consumeNetwork(ADMIN_MFA_IP_POLICY, context);
    if (!account.allowed || !network.allowed) {
      await this.audit({
        actorType: 'admin',
        actorUserId: userId,
        action,
        outcome: 'denied',
        detail: 'rate_limited',
        sessionId: context.session?._id ?? null,
        clientKeyHash: context.clientKeyHash,
      });
      throw adminRateLimited(
        Math.max(
          account.allowed ? 1 : account.retryAfterSeconds,
          network.allowed ? 1 : network.retryAfterSeconds,
        ),
      );
    }
    return {
      release: async () => {
        await account.release();
        await network.release();
      },
    };
  }

  private async createChallenge(
    sessionId: Types.ObjectId,
    userId: Types.ObjectId,
    purpose: ChallengePurpose,
    now: Date,
    txn?: MongoSession,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = newOpaqueToken();
    const expiresAt = new Date(now.getTime() + CHALLENGE_SECONDS * 1000);
    await this.db.challenges.insertOne(
      {
        _id: new Types.ObjectId(),
        tokenHash: hashOpaqueToken(token),
        sessionId,
        userId,
        purpose,
        createdAt: now,
        expiresAt,
        consumedAt: null,
        attempts: 0,
      },
      txn ? { session: txn } : {},
    );
    return { token, expiresAt };
  }

  /**
   * Un essai de plus sur un challenge vivant de CETTE session, de CET
   * utilisateur et de CET usage (incrément atomique, plafonné).
   */
  private async claimChallenge(
    context: PlatformAdminRequestContext,
    token: string,
    purpose: ChallengePurpose,
    action: AuditEntryInput['action'],
  ): Promise<PlatformAdminChallengeDoc> {
    const { session, user } = this.requireSession(context);
    const claimed = OPAQUE_TOKEN_PATTERN.test(token)
      ? await this.db.challenges.findOneAndUpdate(
          {
            tokenHash: hashOpaqueToken(token),
            sessionId: session._id,
            userId: user._id,
            purpose,
            consumedAt: null,
            expiresAt: { $gt: this.now() },
            attempts: { $lt: CHALLENGE_MAX_ATTEMPTS },
          },
          { $inc: { attempts: 1 } },
          { returnDocument: 'after' },
        )
      : null;
    if (!claimed) {
      await this.recordFactorFailure(context, user._id, action, 'challenge');
      throw adminChallengeInvalid();
    }
    return claimed;
  }

  private async findStepUp(
    context: PlatformAdminRequestContext,
    token: string,
  ): Promise<PlatformAdminChallengeDoc> {
    const { session, user } = this.requireSession(context);
    const stepUp = OPAQUE_TOKEN_PATTERN.test(token)
      ? await this.db.challenges.findOne({
          tokenHash: hashOpaqueToken(token),
          sessionId: session._id,
          userId: user._id,
          purpose: 'step_up',
          // Preuve non liée à une action (champ absent ou nul) uniquement.
          boundAction: null,
          consumedAt: null,
          expiresAt: { $gt: this.now() },
        })
      : null;
    if (!stepUp) throw adminStepUpRequired();
    return stepUp;
  }

  /** 403 si la capacité plateforme manque (relue à chaque requête). */
  requireCapability(
    context: PlatformAdminRequestContext,
    capability: PlatformCapability,
  ): void {
    if (!context.capabilities?.has(capability)) {
      throw adminCapabilityRequired();
    }
  }

  /**
   * Preuve renforcée LIÉE à `intent` (même session, même utilisateur, même
   * action, même organisation, même empreinte de contenu), non consommée et
   * non expirée. Lecture seule : la consommation a lieu dans la transaction
   * de l'action (`consumeStepUpIn`).
   */
  async findBoundStepUp(
    context: PlatformAdminRequestContext,
    token: string,
    intent: ActionIntent,
  ): Promise<PlatformAdminChallengeDoc> {
    const { session, user } = this.requireSession(context);
    const stepUp = OPAQUE_TOKEN_PATTERN.test(token)
      ? await this.db.challenges.findOne({
          tokenHash: hashOpaqueToken(token),
          sessionId: session._id,
          userId: user._id,
          purpose: 'step_up',
          boundAction: intent.action,
          boundTargetId: intentTarget(intent).id,
          boundContentHash: actionContentHash(intent),
          consumedAt: null,
          expiresAt: { $gt: this.now() },
        })
      : null;
    if (!stepUp) throw adminStepUpRequired();
    return stepUp;
  }

  /** Consommation atomique dans la transaction de l'action. */
  async consumeStepUpIn(
    challenge: PlatformAdminChallengeDoc,
    now: Date,
    txn: MongoSession,
  ): Promise<boolean> {
    const consumed = await this.db.challenges.updateOne(
      { _id: challenge._id, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { session: txn },
    );
    return consumed.matchedCount === 1;
  }

  /** Audit dans la transaction de l'appelant (actions). */
  async auditInTransaction(
    txn: MongoSession,
    entry: AuditEntryInput,
  ): Promise<void> {
    await this.auditIn(txn, entry);
  }

  /** Audit hors transaction (refus, échecs). */
  async auditOutside(entry: AuditEntryInput): Promise<void> {
    await this.audit(entry);
  }

  private async consumeChallenge(
    challenge: PlatformAdminChallengeDoc,
    now: Date,
    txn: MongoSession,
  ): Promise<void> {
    const consumed = await this.db.challenges.updateOne(
      { _id: challenge._id, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { session: txn },
    );
    if (consumed.matchedCount === 0) throw new CommitRejected('challenge');
  }

  private async replaceRecoveryCodes(
    userId: Types.ObjectId,
    batch: string,
    codes: readonly string[],
    now: Date,
    txn: MongoSession,
  ): Promise<void> {
    await this.db.recoveryCodes.deleteMany({ userId }, { session: txn });
    await this.db.recoveryCodes.insertMany(
      codes.map((code) => ({
        _id: new Types.ObjectId(),
        userId,
        batch,
        codeHash: hashRecoveryCode(
          userId.toHexString(),
          normalizeRecoveryCode(code)!,
        ),
        usedAt: null,
        createdAt: now,
      })),
      { session: txn },
    );
  }

  private async revokeOtherSessions(
    userId: Types.ObjectId,
    keep: Types.ObjectId,
    reason: string,
    now: Date,
    txn: MongoSession,
  ): Promise<void> {
    await this.db.sessions.updateMany(
      { userId, _id: { $ne: keep }, revokedAt: null },
      { $set: { revokedAt: now, revokeReason: reason } },
      { session: txn },
    );
  }

  private async remainingRecoveryCodes(
    context: PlatformAdminRequestContext,
  ): Promise<number> {
    const factor =
      context.factor ??
      (context.user
        ? await this.db.factors.findOne({ userId: context.user._id })
        : null);
    if (!factor?.recoveryBatch || !context.user) return 0;
    return this.db.recoveryCodes.countDocuments({
      userId: context.user._id,
      batch: factor.recoveryBatch,
      usedAt: null,
    });
  }

  private async revokeSession(
    session: PlatformAdminSessionDoc,
    reason: string,
    context: PlatformAdminRequestContext,
  ): Promise<void> {
    const revoked = await this.db.sessions.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { revokedAt: this.now(), revokeReason: reason } },
    );
    if (revoked.modifiedCount > 0) {
      await this.audit({
        actorType: 'admin',
        actorUserId: session.userId,
        action: 'session_rejected',
        outcome: 'denied',
        detail: reason,
        sessionId: session._id,
        clientKeyHash: context.clientKeyHash,
      });
    }
  }

  /** Erreur d'une transaction de second facteur → refus HTTP + audit. */
  private async factorFailure(
    error: unknown,
    context: PlatformAdminRequestContext,
    userId: Types.ObjectId,
    action: AuditEntryInput['action'],
  ): Promise<unknown> {
    if (!(error instanceof CommitRejected)) return error;
    await this.recordFactorFailure(context, userId, action, error.reason);
    if (
      error.reason === 'challenge' ||
      error.reason === 'session' ||
      error.reason === 'factor'
    ) {
      return adminChallengeInvalid();
    }
    return adminCodeInvalid();
  }

  private async recordFactorFailure(
    context: PlatformAdminRequestContext,
    userId: Types.ObjectId,
    action: AuditEntryInput['action'],
    reason: string,
  ): Promise<void> {
    await this.audit({
      actorType: 'admin',
      actorUserId: userId,
      action,
      outcome: 'failure',
      detail: reason,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  private async inTransaction(
    work: (txn: MongoSession) => Promise<void>,
  ): Promise<void> {
    const txn = await this.runtime.connection.startSession();
    try {
      await txn.withTransaction(() => work(txn));
    } finally {
      await txn.endSession();
    }
  }

  private async auditIn(txn: MongoSession, entry: AuditEntryInput) {
    await this.db.audit.insertOne(
      { _id: new Types.ObjectId(), ...auditDocument(entry, this.now()) },
      { session: txn },
    );
  }

  /** Journal hors transaction (échecs, refus) : une erreur est signalée. */
  private async audit(entry: AuditEntryInput): Promise<void> {
    try {
      await this.db.audit.insertOne({
        _id: new Types.ObjectId(),
        ...auditDocument(entry, this.now()),
      });
    } catch {
      this.logger.error(
        `Audit non enregistré : ${entry.action}/${entry.outcome}`,
      );
    }
  }
}
