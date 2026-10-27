import { Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import {
  PlatformAdminService,
  type PlatformAdminRequestContext,
} from './platform-admin.service';
import {
  CHANNEL_CAPABILITY,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_MAX_RECIPIENTS,
  MESSAGE_TITLE_MAX_LENGTH,
  actionContentHash,
  auditCapability,
  intentCapabilities,
  type MessageIntent,
  type MessageRetryIntent,
} from './platform-admin-action-intent';
import type {
  PlatformAdminChallengeDoc,
  PlatformAdminOperationDoc,
  PlatformMessageDeliveryDoc,
} from './platform-admin-store';
import {
  PlatformAdminErrorCode,
  adminCapabilityRequired,
  adminMessageNotRetryable,
  adminMessageRateLimited,
  adminMessageRecipientsChanged,
  adminMessageRetryWindowExpired,
  adminOperationConflict,
  adminStepUpRequired,
} from './platform-admin-errors';
import {
  MESSAGE_ACTOR_LIMIT,
  MESSAGE_HISTORY_PAGE_SIZE,
  MESSAGE_MANUAL_RETRY_MAX,
  MESSAGE_ORGANIZATION_LIMIT,
  MESSAGE_UNCERTAIN_RETRY_WINDOW_MS,
} from './platform-message-policy';
import { PlatformMessageDeliveryService } from './platform-message-delivery.service';
import { MembershipStatus } from '../organizations/permissions';

type MongoSession = Awaited<ReturnType<Connection['startSession']>>;
type MessageAction = MessageIntent | MessageRetryIntent;

/** Rejet décidé dans la transaction (annulée). */
class MessageRejected extends Error {
  constructor(
    readonly reason:
      | 'step_up'
      | 'rate_limited'
      | 'recipients'
      | 'not_found'
      | 'not_retryable'
      | 'retry_window',
    readonly retryAfterSeconds = 60,
  ) {
    super(reason);
  }
}

const DUPLICATE_KEY = 11000;
/** Membres listés pour la sélection (organisations de petite taille). */
const RECIPIENT_LIST_MAX = 500;

export interface MessageOutcome {
  operationId: string;
  action: MessageAction['action'];
  /** `true` : opération déjà validée, résultat existant (aucun envoi). */
  replayed: boolean;
  result: Record<string, unknown>;
}

/**
 * Livraison relançable : échec ou résultat incertain, relances manuelles
 * non épuisées ; après une incertitude, seulement dans la fenêtre de la
 * clé d'idempotence du prestataire (sinon risque de doublon).
 */
export function retryState(
  delivery: Pick<
    PlatformMessageDeliveryDoc,
    'status' | 'manualRetries' | 'uncertainAt' | 'firstAttemptAt'
  >,
  now: Date,
): 'retryable' | 'not_retryable' | 'window_expired' {
  if (delivery.status !== 'failed' && delivery.status !== 'uncertain') {
    return 'not_retryable';
  }
  if ((delivery.manualRetries ?? 0) >= MESSAGE_MANUAL_RETRY_MAX) {
    return 'not_retryable';
  }
  if (
    delivery.uncertainAt &&
    (!delivery.firstAttemptAt ||
      now.getTime() - delivery.firstAttemptAt.getTime() >
        MESSAGE_UNCERTAIN_RETRY_WINDOW_MS)
  ) {
    return 'window_expired';
  }
  return 'retryable';
}

/**
 * Messages de service de l'administration de la plateforme vers les
 * membres d'UNE organisation (support, assistance ; jamais de campagne).
 *
 * Envoi : capacités du ou des canaux, idempotence (même identifiant et même
 * contenu → résultat existant, sans nouvel envoi ; autre contenu → 409),
 * preuve renforcée liée au contenu exact, puis UNE transaction : preuve
 * consommée, limites appliquées, destinataires revérifiés, message figé,
 * livraisons (destinataire × canal), opération, audit. Les envois externes
 * ont lieu APRÈS validation, dans le traitement de fond.
 */
@Injectable()
export class PlatformAdminCommunicationsService {
  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly admin: PlatformAdminService,
    private readonly deliveries: PlatformMessageDeliveryService,
  ) {}

  private get db() {
    return this.runtime.collections();
  }

  private collection(name: string) {
    const db = this.runtime.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    return db.collection(name);
  }

  // ─── Préparation : membres actifs et limites ──────────────────────────────

  /** Membres actifs sélectionnables (une communication au moins exigée). */
  async recipients(
    context: PlatformAdminRequestContext,
    organizationId: string,
  ) {
    const channels = (['in_app', 'email'] as const).filter((c) =>
      context.capabilities?.has(CHANNEL_CAPABILITY[c]),
    );
    if (channels.length === 0) throw adminCapabilityRequired();
    const organization = await this.requireOrganization(organizationId);
    const oid = new Types.ObjectId(organizationId);
    const memberships = await this.collection('organizationmemberships')
      .find(
        { organizationId: oid, status: MembershipStatus.ACTIVE },
        { projection: { userId: 1, role: 1 } },
      )
      .limit(RECIPIENT_LIST_MAX)
      .toArray();
    const users = await this.collection('users')
      .find(
        { _id: { $in: memberships.map((m) => m.userId as Types.ObjectId) } },
        { projection: { name: 1, email: 1, emailVerifiedAt: 1 } },
      )
      .toArray();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const rank: Record<string, number> = { owner: 0, admin: 1, seller: 2 };
    const members = memberships
      .map((m) => {
        const user = byId.get(String(m.userId));
        return user
          ? {
              userId: String(m.userId),
              name: String(user.name),
              email: String(user.email),
              role: String(m.role),
              // Compte non vérifié : aucune connexion possible, non joignable.
              eligible: Boolean(user.emailVerifiedAt),
            }
          : null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort(
        (a, b) =>
          (rank[a.role] ?? 9) - (rank[b.role] ?? 9) ||
          a.name.localeCompare(b.name),
      );
    const now = this.runtime.clock();
    const [organizationUsed, actorUsed] = await Promise.all([
      this.countSince(
        { organizationId: oid },
        now,
        MESSAGE_ORGANIZATION_LIMIT.windowMs,
      ),
      this.countSince(
        { actorUserId: context.user!._id },
        now,
        MESSAGE_ACTOR_LIMIT.windowMs,
      ),
    ]);
    return {
      organization: {
        id: organizationId,
        name: organization.name,
        status: organization.status,
      },
      channels,
      members,
      limits: {
        maxRecipients: MESSAGE_MAX_RECIPIENTS,
        titleMaxLength: MESSAGE_TITLE_MAX_LENGTH,
        bodyMaxLength: MESSAGE_BODY_MAX_LENGTH,
        organization: {
          max: MESSAGE_ORGANIZATION_LIMIT.max,
          windowHours: MESSAGE_ORGANIZATION_LIMIT.windowMs / 3_600_000,
          used: organizationUsed,
        },
        actor: {
          max: MESSAGE_ACTOR_LIMIT.max,
          windowHours: MESSAGE_ACTOR_LIMIT.windowMs / 3_600_000,
          used: actorUsed,
        },
      },
    };
  }

  // ─── Envoi ──────────────────────────────────────────────────────────────

  async send(
    context: PlatformAdminRequestContext,
    intent: MessageIntent,
    stepUpToken: string,
  ): Promise<MessageOutcome> {
    return this.execute(context, intent, stepUpToken, (txn, hash) =>
      this.recordMessage(context, intent, hash, txn),
    );
  }

  async retry(
    context: PlatformAdminRequestContext,
    intent: MessageRetryIntent,
    stepUpToken: string,
  ): Promise<MessageOutcome> {
    return this.execute(context, intent, stepUpToken, (txn, hash) =>
      this.recordRetry(context, intent, hash, txn),
    );
  }

  private async execute(
    context: PlatformAdminRequestContext,
    intent: MessageAction,
    stepUpToken: string,
    work: (txn: MongoSession, contentHash: string) => Promise<MessageOutcome>,
  ): Promise<MessageOutcome> {
    try {
      for (const capability of intentCapabilities(intent)) {
        this.admin.requireCapability(context, capability);
      }
    } catch (error) {
      await this.deny(context, intent, 'capability');
      throw error;
    }
    const contentHash = actionContentHash(intent);
    // Rejeu (réponse perdue, double clic) AVANT toute preuve : résultat
    // existant, jamais un second envoi.
    const existing = await this.db.operations.findOne({
      _id: intent.operationId,
    });
    if (existing) return this.replay(existing, intent, contentHash);

    await this.requireOrganization(intent.organizationId);
    let stepUp: PlatformAdminChallengeDoc;
    try {
      stepUp = await this.admin.findBoundStepUp(context, stepUpToken, intent);
    } catch (error) {
      // Requête identique validée entre-temps (double clic) : son résultat.
      const committed = await this.db.operations.findOne({
        _id: intent.operationId,
      });
      if (committed) return this.replay(committed, intent, contentHash);
      await this.deny(context, intent, 'step_up');
      throw error;
    }
    let outcome: MessageOutcome;
    try {
      outcome = await this.inTransaction(async (txn) => {
        if (
          !(await this.admin.consumeStepUpIn(stepUp, this.runtime.clock(), txn))
        ) {
          throw new MessageRejected('step_up');
        }
        return work(txn, contentHash);
      });
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
    this.deliveries.kick();
    return outcome;
  }

  private async recordMessage(
    context: PlatformAdminRequestContext,
    intent: MessageIntent,
    contentHash: string,
    txn: MongoSession,
  ): Promise<MessageOutcome> {
    const now = this.runtime.clock();
    const actorUserId = context.user!._id;
    const organizationId = new Types.ObjectId(intent.organizationId);
    await this.enforceLimits(organizationId, actorUserId, now, txn);

    // Destinataires revérifiés : membres ACTIFS de CETTE organisation,
    // comptes présents et vérifiés. Un identifiant falsifié ou devenu
    // inéligible refuse tout l'envoi (jamais une sélection tronquée).
    const recipientIds = intent.recipientUserIds.map(
      (id) => new Types.ObjectId(id),
    );
    const [memberships, users] = await Promise.all([
      this.collection('organizationmemberships').countDocuments(
        {
          organizationId,
          userId: { $in: recipientIds },
          status: MembershipStatus.ACTIVE,
        },
        { session: txn },
      ),
      this.collection('users').countDocuments(
        { _id: { $in: recipientIds }, emailVerifiedAt: { $ne: null } },
        { session: txn },
      ),
    ]);
    if (memberships !== recipientIds.length || users !== recipientIds.length) {
      throw new MessageRejected('recipients');
    }

    const messageId = new Types.ObjectId();
    await this.db.messages.insertOne(
      {
        _id: messageId,
        operationId: intent.operationId,
        organizationId,
        actorUserId,
        title: intent.title,
        body: intent.body,
        channels: intent.channels,
        recipientUserIds: recipientIds,
        createdAt: now,
      },
      { session: txn },
    );
    await this.db.messageDeliveries.insertMany(
      recipientIds.flatMap((userId) =>
        intent.channels.map((channel) => ({
          _id: new Types.ObjectId(),
          messageId,
          organizationId,
          userId,
          channel,
          status: 'pending' as const,
          attempts: 0,
          manualRetries: 0,
          nextAttemptAt: now,
          lockedUntil: null,
          firstAttemptAt: null,
          uncertainAt: null,
          emailSnapshot: null,
          reason: null,
          notificationId: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      { session: txn },
    );
    const result = {
      messageId: messageId.toHexString(),
      recipients: recipientIds.length,
      channels: intent.channels,
      deliveries: recipientIds.length * intent.channels.length,
    };
    await this.record(txn, context, intent, contentHash, result, now, {
      messageId: result.messageId,
      recipients: result.recipients,
      channels: intent.channels.join(','),
    });
    return {
      operationId: intent.operationId,
      action: intent.action,
      replayed: false,
      result,
    };
  }

  private async recordRetry(
    context: PlatformAdminRequestContext,
    intent: MessageRetryIntent,
    contentHash: string,
    txn: MongoSession,
  ): Promise<MessageOutcome> {
    const now = this.runtime.clock();
    const organizationId = new Types.ObjectId(intent.organizationId);
    const messageId = new Types.ObjectId(intent.messageId);
    const message = await this.db.messages.findOne(
      { _id: messageId, organizationId },
      { session: txn, projection: { _id: 1 } },
    );
    if (!message) throw new MessageRejected('not_found');
    const ids = intent.deliveryIds.map((id) => new Types.ObjectId(id));
    const rows = await this.db.messageDeliveries
      .find(
        {
          _id: { $in: ids },
          messageId,
          organizationId,
          channel: intent.channel,
        },
        { session: txn },
      )
      .toArray();
    if (rows.length !== ids.length) throw new MessageRejected('not_found');
    for (const row of rows) {
      const state = retryState(row, now);
      if (state === 'window_expired') {
        throw new MessageRejected('retry_window');
      }
      if (state !== 'retryable') throw new MessageRejected('not_retryable');
    }
    // Seules les livraisons désignées repartent ; les canaux et
    // destinataires déjà servis ne sont jamais renvoyés.
    for (const row of rows) {
      const updated = await this.db.messageDeliveries.updateOne(
        { _id: row._id, status: row.status, manualRetries: row.manualRetries },
        {
          $set: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lockedUntil: null,
            completedAt: null,
            updatedAt: now,
          },
          $inc: { manualRetries: 1 },
        },
        { session: txn },
      );
      if (updated.matchedCount !== 1) {
        throw new MessageRejected('not_retryable');
      }
    }
    const result = {
      messageId: intent.messageId,
      channel: intent.channel,
      retried: rows.length,
    };
    await this.record(txn, context, intent, contentHash, result, now, {
      messageId: intent.messageId,
      channel: intent.channel,
      deliveries: rows.length,
    });
    return {
      operationId: intent.operationId,
      action: intent.action,
      replayed: false,
      result,
    };
  }

  /**
   * Limites de fréquence, relues DANS la transaction après l'écriture d'un
   * compteur propre à l'organisation et à l'administrateur : deux envois
   * simultanés entrent en conflit d'écriture, la transaction rejouée relit
   * les messages de l'autre.
   */
  private async enforceLimits(
    organizationId: Types.ObjectId,
    actorUserId: Types.ObjectId,
    now: Date,
    txn: MongoSession,
  ): Promise<void> {
    for (const key of [
      `org:${organizationId.toHexString()}`,
      `actor:${actorUserId.toHexString()}`,
    ]) {
      await this.db.messageCounters.updateOne(
        { _id: key },
        { $set: { lastAt: now } },
        { upsert: true, session: txn },
      );
    }
    const checks = [
      { filter: { organizationId }, limit: MESSAGE_ORGANIZATION_LIMIT },
      { filter: { actorUserId }, limit: MESSAGE_ACTOR_LIMIT },
    ];
    for (const { filter, limit } of checks) {
      const since = new Date(now.getTime() - limit.windowMs);
      const recent = await this.db.messages
        .find(
          { ...filter, createdAt: { $gt: since } },
          { session: txn, projection: { createdAt: 1 } },
        )
        .sort({ createdAt: -1 })
        .limit(limit.max)
        .toArray();
      if (recent.length >= limit.max) {
        const oldest = recent[recent.length - 1].createdAt.getTime();
        const wait = Math.ceil(
          (oldest + limit.windowMs - now.getTime()) / 1000,
        );
        throw new MessageRejected('rate_limited', Math.max(1, wait));
      }
    }
  }

  private async countSince(
    filter: Record<string, unknown>,
    now: Date,
    windowMs: number,
  ): Promise<number> {
    return this.db.messages.countDocuments({
      ...filter,
      createdAt: { $gt: new Date(now.getTime() - windowMs) },
    });
  }

  /** Opération idempotente + audit (sans titre ni texte du message). */
  private async record(
    txn: MongoSession,
    context: PlatformAdminRequestContext,
    intent: MessageAction,
    contentHash: string,
    result: Record<string, unknown>,
    now: Date,
    after: Record<string, string | number>,
  ): Promise<void> {
    await this.db.operations.insertOne(
      {
        _id: intent.operationId,
        action: intent.action,
        organizationId: new Types.ObjectId(intent.organizationId),
        actorUserId: context.user!._id,
        contentHash,
        createdAt: now,
        // Aucun motif libre : le contenu reste dans `platform_messages`.
        reason: '',
        result,
      },
      { session: txn },
    );
    await this.admin.auditInTransaction(txn, {
      actorType: 'admin',
      actorUserId: context.user!._id,
      action: intent.action,
      outcome: 'success',
      capability: auditCapability(intent),
      targetType: 'organization',
      targetId: intent.organizationId,
      operationId: intent.operationId,
      detail:
        intent.action === 'organization_message'
          ? `channels:${intent.channels.join('+')}`
          : `channel:${intent.channel}`,
      before: null,
      after,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  private replay(
    existing: PlatformAdminOperationDoc,
    intent: MessageAction,
    contentHash: string,
  ): MessageOutcome {
    if (
      existing.contentHash !== contentHash ||
      existing.action !== intent.action ||
      existing.organizationId.toHexString() !== intent.organizationId
    ) {
      throw adminOperationConflict();
    }
    return {
      operationId: existing._id,
      action: intent.action,
      replayed: true,
      result: existing.result,
    };
  }

  /** Erreur de transaction → réponse HTTP ; validation concurrente → rejeu. */
  private async translate(
    error: unknown,
    context: PlatformAdminRequestContext,
    intent: MessageAction,
    contentHash: string,
  ): Promise<{ replay: MessageOutcome } | { error: unknown }> {
    const duplicate =
      (error as { code?: unknown }).code === DUPLICATE_KEY &&
      /platform_admin_operations|platform_messages/.test(
        String((error as Error).message),
      );
    if (
      duplicate ||
      (error instanceof MessageRejected && error.reason === 'step_up')
    ) {
      // Même opération validée par une requête concurrente (qui a pu
      // consommer la preuve) : son résultat, jamais un second envoi.
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
    if (!(error instanceof MessageRejected)) return { error };
    await this.deny(context, intent, error.reason);
    switch (error.reason) {
      case 'step_up':
        return { error: adminStepUpRequired() };
      case 'rate_limited':
        return { error: adminMessageRateLimited(error.retryAfterSeconds) };
      case 'recipients':
        return { error: adminMessageRecipientsChanged() };
      case 'not_found':
        return { error: this.notFound() };
      case 'retry_window':
        return { error: adminMessageRetryWindowExpired() };
      case 'not_retryable':
        return { error: adminMessageNotRetryable() };
    }
  }

  private async deny(
    context: PlatformAdminRequestContext,
    intent: MessageAction,
    reason: string,
  ): Promise<void> {
    await this.admin.auditOutside({
      actorType: 'admin',
      actorUserId: context.user?._id ?? null,
      action: intent.action,
      outcome: 'denied',
      capability: auditCapability(intent),
      targetType: 'organization',
      targetId: intent.organizationId,
      operationId: intent.operationId,
      detail: reason,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  // ─── Historique ─────────────────────────────────────────────────────────

  /**
   * Messages de l'organisation, plus récents d'abord (pages de 10) :
   * auteur, date, contenu, destinataires et canaux, résultat par
   * destinataire et canal. « accepted » = accepté par le prestataire, jamais
   * une réception ou une lecture confirmée.
   */
  async history(organizationId: string, page = 1) {
    await this.requireOrganization(organizationId);
    const oid = new Types.ObjectId(organizationId);
    const now = this.runtime.clock();
    const [total, rows] = await Promise.all([
      this.db.messages.countDocuments({ organizationId: oid }),
      this.db.messages
        .find({ organizationId: oid })
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * MESSAGE_HISTORY_PAGE_SIZE)
        .limit(MESSAGE_HISTORY_PAGE_SIZE)
        .toArray(),
    ]);
    const deliveries = rows.length
      ? await this.db.messageDeliveries
          .find(
            { messageId: { $in: rows.map((r) => r._id) } },
            { projection: { emailSnapshot: 0 } },
          )
          .toArray()
      : [];
    const userIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.actorUserId.toHexString());
      for (const id of r.recipientUserIds) userIds.add(id.toHexString());
    }
    const users = userIds.size
      ? await this.collection('users')
          .find(
            { _id: { $in: [...userIds].map((id) => new Types.ObjectId(id)) } },
            { projection: { name: 1, email: 1 } },
          )
          .toArray()
      : [];
    const person = new Map(
      users.map((u) => [
        String(u._id),
        { name: String(u.name), email: String(u.email) },
      ]),
    );
    return {
      page,
      pageSize: MESSAGE_HISTORY_PAGE_SIZE,
      total,
      items: rows.map((r) => ({
        id: r._id.toHexString(),
        operationId: r.operationId,
        at: r.createdAt,
        actor: person.get(r.actorUserId.toHexString())?.email ?? null,
        title: r.title,
        body: r.body,
        channels: r.channels,
        recipients: r.recipientUserIds.map((id) => ({
          userId: id.toHexString(),
          name: person.get(id.toHexString())?.name ?? null,
          email: person.get(id.toHexString())?.email ?? null,
        })),
        deliveries: deliveries
          .filter((d) => d.messageId.equals(r._id))
          .map((d) => {
            const state = retryState(d, now);
            return {
              id: d._id.toHexString(),
              userId: d.userId.toHexString(),
              channel: d.channel,
              status: d.status,
              reason: d.reason,
              attempts: d.attempts,
              manualRetries: d.manualRetries,
              updatedAt: d.updatedAt,
              completedAt: d.completedAt,
              uncertain: d.uncertainAt !== null,
              retryable: state === 'retryable',
              retryWindowExpired: state === 'window_expired',
            };
          }),
      })),
    };
  }

  private notFound() {
    return new NotFoundException({
      code: PlatformAdminErrorCode.NOT_FOUND,
      message: 'Introuvable.',
    });
  }

  private async requireOrganization(organizationId: string) {
    const organization = /^[0-9a-f]{24}$/.test(organizationId)
      ? await this.collection('organizations').findOne(
          { _id: new Types.ObjectId(organizationId) },
          { projection: { name: 1, status: 1 } },
        )
      : null;
    if (!organization) throw this.notFound();
    return {
      name: String(organization.name),
      status: String(organization.status),
    };
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
