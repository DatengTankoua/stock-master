import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import {
  PlatformAdminService,
  type PlatformAdminRequestContext,
} from './platform-admin.service';
import {
  ACTION_CAPABILITY,
  actionContentHash,
  type ActionIntent,
} from './platform-admin-action-intent';
import type {
  AuditState,
  PlatformAdminOperationDoc,
} from './platform-admin-store';
import {
  adminExtensionRefused,
  adminOperationConflict,
  adminStateChanged,
  adminStepUpRequired,
  PlatformAdminErrorCode,
} from './platform-admin-errors';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from '../subscriptions/subscriptions.service';
import { SubscriptionSignalsService } from '../subscriptions/subscription-signals.service';
import { SocketRegistryService } from '../organizations/socket-registry.service';
import {
  OFFERED_EXTENSION_MAX_DAYS,
  OFFERED_EXTENSION_MIN_DAYS,
  SubscriptionSource,
} from '../subscriptions/subscription-terms';

type MongoSession = Awaited<ReturnType<Connection['startSession']>>;

/** Rejet décidé dans la transaction (annulée, jamais rejouée). */
class ActionRejected extends Error {
  constructor(readonly reason: 'step_up' | 'state') {
    super(reason);
  }
}

const DUPLICATE_KEY = 11000;
const ACTION_HISTORY_LIMIT = 20;

export interface ActionOutcome {
  operationId: string;
  action: ActionIntent['action'];
  /** `true` : opération déjà appliquée, résultat existant renvoyé. */
  replayed: boolean;
  result: Record<string, unknown>;
}

/**
 * Actions de l'administration de la plateforme : suspension, réactivation,
 * prolongation offerte. Pour chaque action :
 * 1. capacité plateforme exigée (relue à chaque requête) ;
 * 2. idempotence : identifiant d'opération connu → même contenu : résultat
 *    existant (sans nouvelle preuve, sans double effet) ; autre contenu :
 *    409 ;
 * 3. preuve renforcée liée à l'action, à l'organisation et au contenu ;
 * 4. UNE transaction : mutation, consommation de la preuve, opération,
 *    audit (acteur, capacité, organisation, motif, avant/après) ;
 * 5. effets hors base APRÈS validation, au mieux (sockets, signal temps
 *    réel) : leur échec n'annule jamais l'action.
 */
@Injectable()
export class PlatformAdminActionsService {
  private readonly logger = new Logger('PlatformAdminActions');

  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly admin: PlatformAdminService,
    private readonly subscriptions: SubscriptionsService,
    private readonly signals: SubscriptionSignalsService,
    private readonly sockets: SocketRegistryService,
  ) {}

  private get db() {
    return this.runtime.collections();
  }

  private organizations() {
    const db = this.runtime.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    return db.collection<{
      _id: Types.ObjectId;
      name: string;
      status: string;
      suspension?: unknown;
    }>('organizations');
  }

  // ─── Aperçu de la prolongation (lecture seule) ──────────────────────────

  async extensionPreview(
    context: PlatformAdminRequestContext,
    organizationId: string,
    days: number,
  ) {
    this.admin.requireCapability(context, 'platform.subscriptions.extend');
    const organization = await this.requireOrganization(organizationId);
    const { state, plan } = await this.subscriptions.previewOfferedExtension(
      organizationId,
      days,
    );
    return {
      organizationId,
      days,
      organizationStatus: organization.status,
      state: {
        state: state.state,
        currentPeriodKind: state.currentPeriod?.kind ?? null,
        coverageEndsAt: state.coverageEndsAt,
      },
      plan: plan.ok
        ? {
            ok: true as const,
            basis: plan.basis,
            previousCoverageEndsAt: plan.previousCoverageEndsAt,
            startsAt: plan.startsAt,
            endsAt: plan.endsAt,
            scheduledPeriods: plan.scheduledPeriods,
          }
        : { ok: false as const, refusal: plan.refusal },
    };
  }

  /** Historique des actions de l'organisation (plus récentes d'abord). */
  async history(organizationId: string) {
    const rows = await this.db.operations
      .find(
        { organizationId: new Types.ObjectId(organizationId) },
        {
          projection: {
            action: 1,
            actorUserId: 1,
            createdAt: 1,
            reason: 1,
            result: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(ACTION_HISTORY_LIMIT)
      .toArray();
    const actorIds = [...new Set(rows.map((r) => r.actorUserId.toHexString()))];
    const users = actorIds.length
      ? await this.runtime.connection
          .db!.collection('users')
          .find(
            { _id: { $in: actorIds.map((id) => new Types.ObjectId(id)) } },
            { projection: { email: 1 } },
          )
          .toArray()
      : [];
    const email = new Map(users.map((u) => [String(u._id), String(u.email)]));
    return rows.map((r) => ({
      operationId: r._id,
      action: r.action,
      at: r.createdAt,
      actor: email.get(r.actorUserId.toHexString()) ?? null,
      reason: r.reason,
      result: r.result,
    }));
  }

  // ─── Exécution ──────────────────────────────────────────────────────────

  async execute(
    context: PlatformAdminRequestContext,
    intent: ActionIntent,
    stepUpToken: string,
  ): Promise<ActionOutcome> {
    const capability = ACTION_CAPABILITY[intent.action];
    try {
      this.admin.requireCapability(context, capability);
    } catch (error) {
      await this.deny(context, intent, 'capability');
      throw error;
    }
    const contentHash = actionContentHash(intent);

    const existing = await this.db.operations.findOne({
      _id: intent.operationId,
    });
    if (existing) return this.replay(existing, intent, contentHash);

    await this.requireOrganization(intent.organizationId);
    let stepUp;
    try {
      stepUp = await this.admin.findBoundStepUp(context, stepUpToken, intent);
    } catch (error) {
      await this.deny(context, intent, 'step_up');
      throw error;
    }

    let outcome: ActionOutcome;
    try {
      outcome =
        intent.action === 'subscription_extend'
          ? await this.extend(context, intent, contentHash, stepUp)
          : await this.inTransaction((txn) =>
              this.changeStatus(context, intent, contentHash, stepUp, txn),
            );
    } catch (error) {
      const translated = await this.translate(
        error,
        context,
        intent,
        contentHash,
      );
      if ('replay' in translated) return translated.replay;
      throw translated.error;
    }
    await this.afterCommit(intent);
    return outcome;
  }

  private async changeStatus(
    context: PlatformAdminRequestContext,
    intent: Extract<
      ActionIntent,
      { action: 'organization_suspend' | 'organization_reactivate' }
    >,
    contentHash: string,
    stepUp: Parameters<PlatformAdminService['consumeStepUpIn']>[0],
    txn: MongoSession,
  ): Promise<ActionOutcome> {
    const now = this.runtime.clock();
    const actorUserId = context.user!._id;
    if (!(await this.admin.consumeStepUpIn(stepUp, now, txn))) {
      throw new ActionRejected('step_up');
    }
    const suspend = intent.action === 'organization_suspend';
    const before = await this.organizations().findOneAndUpdate(
      {
        _id: new Types.ObjectId(intent.organizationId),
        status: suspend ? 'active' : 'suspended',
      },
      suspend
        ? {
            $set: {
              status: 'suspended',
              suspension: {
                suspendedAt: now,
                suspendedBy: actorUserId,
                internalReason: intent.internalReason,
                clientMessage: intent.clientMessage,
                operationId: intent.operationId,
              },
              updatedAt: now,
            },
          }
        : { $set: { status: 'active', suspension: null, updatedAt: now } },
      {
        session: txn,
        returnDocument: 'before',
        projection: { status: 1, suspension: 1 },
      },
    );
    // Autre administrateur passé avant (déjà suspendu / déjà actif).
    if (!before) throw new ActionRejected('state');
    const previous = before.suspension as { suspendedAt?: Date } | null;
    const result: Record<string, unknown> = suspend
      ? { status: 'suspended', suspendedAt: now }
      : {
          status: 'active',
          reactivatedAt: now,
          previousSuspendedAt: previous?.suspendedAt ?? null,
        };
    const reason = suspend ? intent.internalReason : intent.reason;
    await this.record(txn, context, intent, contentHash, reason, result, now, {
      before: {
        status: before.status,
        ...(previous?.suspendedAt
          ? { suspendedAt: previous.suspendedAt.toISOString() }
          : {}),
      },
      after: { status: suspend ? 'suspended' : 'active' },
    });
    return {
      operationId: intent.operationId,
      action: intent.action,
      replayed: false,
      result,
    };
  }

  private async extend(
    context: PlatformAdminRequestContext,
    intent: Extract<ActionIntent, { action: 'subscription_extend' }>,
    contentHash: string,
    stepUp: Parameters<PlatformAdminService['consumeStepUpIn']>[0],
  ): Promise<ActionOutcome> {
    const actorEmail = context.user!.email;
    // Transaction des périodes d'abonnement : rejouée en entier si une
    // attribution concurrente (paiement confirmé, autre prolongation) prend
    // le même rang ; la couverture est alors relue et comparée à celle
    // confirmée (`COVERAGE_CHANGED`).
    return this.subscriptions.runInGrantTransaction(async (txn) => {
      const now = this.runtime.clock();
      if (!(await this.admin.consumeStepUpIn(stepUp, now, txn))) {
        throw new ActionRejected('step_up');
      }
      const granted = await this.subscriptions.grantOfferedExtensionInSession(
        {
          organizationId: new Types.ObjectId(intent.organizationId),
          days: intent.days,
          sourceReference: `offered:${intent.operationId}`,
          grantedBy: `platform-admin:${actorEmail}`.slice(0, 100),
          expectedCoverageEndsAt: intent.expectedCoverageEndsAt
            ? new Date(intent.expectedCoverageEndsAt)
            : null,
        },
        txn,
      );
      const result = {
        periodId: granted.periodId,
        source: SubscriptionSource.OFFERED,
        days: granted.days,
        startsAt: granted.startsAt,
        endsAt: granted.endsAt,
      };
      await this.record(
        txn,
        context,
        intent,
        contentHash,
        intent.reason,
        result,
        now,
        {
          before: { coverageEndsAt: intent.expectedCoverageEndsAt },
          after: {
            startsAt: granted.startsAt.toISOString(),
            endsAt: granted.endsAt.toISOString(),
            days: granted.days,
          },
        },
      );
      return {
        operationId: intent.operationId,
        action: intent.action,
        replayed: false,
        result,
      };
    });
  }

  /** Opération idempotente + audit, dans la transaction de l'action. */
  private async record(
    txn: MongoSession,
    context: PlatformAdminRequestContext,
    intent: ActionIntent,
    contentHash: string,
    reason: string,
    result: Record<string, unknown>,
    now: Date,
    states: { before: AuditState; after: AuditState },
  ): Promise<void> {
    await this.db.operations.insertOne(
      {
        _id: intent.operationId,
        action: intent.action,
        organizationId: new Types.ObjectId(intent.organizationId),
        actorUserId: context.user!._id,
        contentHash,
        createdAt: now,
        reason,
        result,
      },
      { session: txn },
    );
    await this.admin.auditInTransaction(txn, {
      actorType: 'admin',
      actorUserId: context.user!._id,
      action: intent.action,
      outcome: 'success',
      capability: ACTION_CAPABILITY[intent.action],
      targetType: 'organization',
      targetId: intent.organizationId,
      operationId: intent.operationId,
      detail: reason,
      before: states.before,
      after: states.after,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  private replay(
    existing: PlatformAdminOperationDoc,
    intent: ActionIntent,
    contentHash: string,
  ): ActionOutcome {
    if (
      existing.contentHash !== contentHash ||
      existing.action !== intent.action ||
      existing.organizationId.toHexString() !== intent.organizationId
    ) {
      throw adminOperationConflict();
    }
    return {
      operationId: existing._id,
      action: existing.action,
      replayed: true,
      result: existing.result,
    };
  }

  /** Erreur de transaction → réponse HTTP ; rejeu concurrent → résultat. */
  private async translate(
    error: unknown,
    context: PlatformAdminRequestContext,
    intent: ActionIntent,
    contentHash: string,
  ): Promise<{ replay: ActionOutcome } | { error: unknown }> {
    if (
      (error as { code?: unknown }).code === DUPLICATE_KEY &&
      /platform_admin_operations/.test(String((error as Error).message))
    ) {
      // Même identifiant validé par une requête concurrente.
      const existing = await this.db.operations.findOne({
        _id: intent.operationId,
      });
      if (existing) {
        try {
          return { replay: this.replay(existing, intent, contentHash) };
        } catch (conflict) {
          return { error: conflict };
        }
      }
    }
    if (error instanceof ActionRejected && error.reason === 'step_up') {
      // Même opération validée par une requête concurrente (qui a consommé
      // la preuve) : son résultat, jamais un second effet.
      const existing = await this.db.operations.findOne({
        _id: intent.operationId,
      });
      if (existing) {
        try {
          return { replay: this.replay(existing, intent, contentHash) };
        } catch (conflict) {
          return { error: conflict };
        }
      }
    }
    if (error instanceof ActionRejected) {
      await this.deny(context, intent, error.reason);
      return {
        error:
          error.reason === 'step_up'
            ? adminStepUpRequired()
            : adminStateChanged(),
      };
    }
    if (error instanceof SubscriptionGrantError) {
      await this.deny(context, intent, error.code);
      if (error.code === 'EXTENSION_REFUSED') {
        return { error: adminExtensionRefused(error.message) };
      }
      if (error.code === 'COVERAGE_CHANGED') {
        return { error: adminStateChanged() };
      }
      if (error.code === 'SUBSCRIPTION_REFERENCE_CONFLICT') {
        return { error: adminOperationConflict() };
      }
    }
    return { error };
  }

  private async afterCommit(intent: ActionIntent): Promise<void> {
    try {
      if (intent.action === 'organization_suspend') {
        this.sockets.disconnectOrganization(intent.organizationId);
      } else if (intent.action === 'subscription_extend') {
        await this.signals.subscriptionChanged(intent.organizationId);
      }
    } catch {
      this.logger.warn(`Effet différé non appliqué : ${intent.action}.`);
    }
  }

  private async deny(
    context: PlatformAdminRequestContext,
    intent: ActionIntent,
    reason: string,
  ): Promise<void> {
    await this.admin.auditOutside({
      actorType: 'admin',
      actorUserId: context.user?._id ?? null,
      action: intent.action,
      outcome: 'denied',
      capability: ACTION_CAPABILITY[intent.action],
      targetType: 'organization',
      targetId: intent.organizationId,
      operationId: intent.operationId,
      detail: reason,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  private async requireOrganization(organizationId: string) {
    const organization = /^[0-9a-f]{24}$/.test(organizationId)
      ? await this.organizations().findOne(
          { _id: new Types.ObjectId(organizationId) },
          { projection: { status: 1 } },
        )
      : null;
    if (!organization) {
      throw new NotFoundException({
        code: PlatformAdminErrorCode.NOT_FOUND,
        message: 'Introuvable.',
      });
    }
    return organization;
  }

  private async inTransaction<T>(
    work: (txn: MongoSession) => Promise<T>,
  ): Promise<T> {
    const txn = await this.runtime.connection.startSession();
    try {
      let result!: T;
      await txn.withTransaction(async () => {
        result = await work(txn);
      });
      return result;
    } finally {
      await txn.endSession();
    }
  }
}

export const EXTENSION_DAYS = {
  min: OFFERED_EXTENSION_MIN_DAYS,
  max: OFFERED_EXTENSION_MAX_DAYS,
};
