import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  EMAIL_SENDER,
  type EmailSender,
} from '../email-verification/email-sender';
import { NotificationCenterService } from '../notifications/notification-center.service';
import { PushOutboxService } from '../push/push-outbox.service';
import { PushRuntime } from '../push/push-runtime';
import { PushCategory } from '../push/schemas/push-category';
import { recipientLocale } from '../common/i18n/locale';
import { MembershipStatus } from '../organizations/permissions';
import { SUPPORT_RECIPIENT } from '../support/support-constants';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import type {
  MessageDeliveryStatus,
  PlatformMessageDeliveryDoc,
  PlatformMessageDoc,
} from './platform-admin-store';
import { buildPlatformMessageEmail } from './platform-message-email';
import {
  MESSAGE_DELIVERY_BATCH,
  MESSAGE_MAX_ATTEMPTS,
  MESSAGE_POLL_INTERVAL_MS,
  MESSAGE_SEND_LOCK_MS,
  MESSAGE_UNCERTAIN_RETRY_WINDOW_MS,
  classifyEmailFailure,
  messageEmailIdempotencyKey,
  messageEventKey,
  retryDelayMs,
} from './platform-message-policy';

export interface MessageRunSummary {
  created: number;
  accepted: number;
  skipped: number;
  failed: number;
  uncertain: number;
  retried: number;
}

type Eligibility =
  | {
      ok: true;
      user: { email: string; locale?: unknown };
      organizationName: string;
    }
  | { ok: false; reason: string };

/**
 * Traitement de fond des messages de service (mono-instance, comme le
 * dispatcher des notifications). Démarré UNIQUEMENT par le démarrage HTTP ;
 * les CLI et les tests chargent le module sans rien démarrer.
 *
 * Pour chaque livraison (message × destinataire × canal) :
 * 1. réservation conditionnelle (`pending` échue, ou `sending` dont le
 *    verrou a expiré) : un seul traitement à la fois par livraison ;
 * 2. revalidation : appartenance active, compte présent et vérifié ;
 * 3. canal `in_app` : préférence du centre, notification du centre (upsert
 *    `{eventKey, userId}`), puis travail push du seul destinataire (le
 *    dispatcher applique les préférences de chaque appareil) ;
 * 4. canal `email` : destinataire, langue et nom du commerce figés au premier
 *    envoi, clé d'idempotence du prestataire constante ; un résultat
 *    inconnu n'est renvoyé qu'avec cette clé et dans sa fenêtre.
 *
 * Journal : identifiants et motifs courts seuls (jamais le titre, le texte,
 * l'adresse ni la réponse du prestataire).
 */
@Injectable()
export class PlatformMessageDeliveryService implements OnApplicationShutdown {
  private readonly logger = new Logger('PlatformMessages');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  /** Arrêt demandé : vérifié entre deux livraisons d'une passe. */
  private halting = false;
  private intervalMs = MESSAGE_POLL_INTERVAL_MS;
  private passChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly pushRuntime: PushRuntime,
    private readonly center: NotificationCenterService,
    private readonly outbox: PushOutboxService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  private get db() {
    return this.runtime.collections();
  }

  private collection(name: string) {
    const db = this.runtime.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    return db.collection(name);
  }

  // ─── Boucle (démarrage HTTP uniquement) ─────────────────────────────────

  start(intervalMs: number = MESSAGE_POLL_INTERVAL_MS): void {
    if (!this.pushRuntime.active || !this.stopped) return;
    this.stopped = false;
    this.halting = false;
    this.intervalMs = intervalMs;
    this.schedule(0);
  }

  /** Traitement immédiat après un envoi validé (sans attendre l'intervalle). */
  kick(): void {
    if (this.stopped || this.running) return;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped) return;
    this.timer = null;
    let more = false;
    this.running = this.runOnce()
      .then((summary) => {
        more = summary.more;
      })
      .catch(() => this.logger.warn('Passe des messages interrompue.'))
      .finally(() => {
        this.running = null;
        if (!this.stopped) this.schedule(more ? 100 : this.intervalMs);
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.halting = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    await this.passChain;
    this.halting = false;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Une passe ; appels sérialisés (jamais deux passes superposées). */
  runOnce(): Promise<MessageRunSummary & { more: boolean }> {
    const pass = this.passChain.then(() => this.pass());
    this.passChain = pass.catch(() => undefined);
    return pass;
  }

  private async pass(): Promise<MessageRunSummary & { more: boolean }> {
    const summary: MessageRunSummary = {
      created: 0,
      accepted: 0,
      skipped: 0,
      failed: 0,
      uncertain: 0,
      retried: 0,
    };
    const now = this.runtime.clock();
    const due = await this.db.messageDeliveries
      .find(
        {
          $or: [
            { status: 'pending', nextAttemptAt: { $lte: now } },
            // Traitement interrompu (crash) : repris après le verrou.
            { status: 'sending', lockedUntil: { $lte: now } },
          ],
        },
        { projection: { _id: 1 } },
      )
      .sort({ nextAttemptAt: 1 })
      .limit(MESSAGE_DELIVERY_BATCH)
      .toArray();
    for (const { _id } of due) {
      if (this.halting) break;
      const status = await this.processOne(_id);
      if (status === 'pending') summary.retried += 1;
      else if (status) summary[status] += 1;
    }
    return { ...summary, more: due.length === MESSAGE_DELIVERY_BATCH };
  }

  // ─── Une livraison ──────────────────────────────────────────────────────

  private async processOne(
    deliveryId: Types.ObjectId,
  ): Promise<Exclude<MessageDeliveryStatus, 'sending'> | null> {
    const now = this.runtime.clock();
    const lockedUntil = new Date(now.getTime() + MESSAGE_SEND_LOCK_MS);
    // Réservation conditionnelle : un seul traitement par livraison.
    const before = await this.db.messageDeliveries.findOneAndUpdate(
      {
        _id: deliveryId,
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'sending', lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { status: 'sending', lockedUntil, updatedAt: now },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'before' },
    );
    if (!before) return null;
    const delivery: PlatformMessageDeliveryDoc = {
      ...before,
      status: 'sending',
      lockedUntil,
      attempts: before.attempts + 1,
    };
    // Envoi précédent interrompu APRÈS l'appel au prestataire : il a pu
    // accepter l'e-mail. Résultat inconnu.
    const interrupted =
      before.status === 'sending' &&
      delivery.channel === 'email' &&
      before.firstAttemptAt !== null;
    const uncertainAt = delivery.uncertainAt ?? (interrupted ? now : null);

    const message = await this.db.messages.findOne({
      _id: delivery.messageId,
      organizationId: delivery.organizationId,
    });
    if (!message) {
      // Une tentative incertaine n'est jamais requalifiée en échec.
      return this.finish(
        delivery,
        uncertainAt ? 'uncertain' : 'failed',
        'message_missing',
        now,
        { uncertainAt },
      );
    }
    // Passe à `true` juste avant l'appel au prestataire.
    const attempt = { called: false };
    try {
      return delivery.channel === 'in_app'
        ? await this.deliverInApp(delivery, message, now)
        : await this.deliverEmail(delivery, message, uncertainAt, now, attempt);
    } catch {
      // Erreur interne (base, notification) : reprise bornée. Après un appel
      // au prestataire (écriture du succès en échec, par exemple), l'e-mail
      // a pu être accepté : résultat incertain, fenêtre conservée.
      return this.reschedule(
        delivery,
        'internal_error',
        uncertainAt ?? (attempt.called ? now : null),
        now,
        delivery.firstAttemptAt
          ? delivery.firstAttemptAt.getTime() +
              MESSAGE_UNCERTAIN_RETRY_WINDOW_MS
          : attempt.called
            ? now.getTime() + MESSAGE_UNCERTAIN_RETRY_WINDOW_MS
            : Number.POSITIVE_INFINITY,
      );
    }
  }

  private async deliverInApp(
    delivery: PlatformMessageDeliveryDoc,
    message: PlatformMessageDoc,
    now: Date,
  ) {
    const eligibility = await this.eligibility(delivery);
    if (!eligibility.ok) {
      return this.finish(delivery, 'skipped', eligibility.reason, now);
    }
    // Préférence du CENTRE (une catégorie désactivée n'est jamais créée).
    const enabled = await this.center.inAppEnabled(
      delivery.organizationId,
      [delivery.userId],
      PushCategory.PLATFORM_MESSAGE,
    );
    if (enabled.length === 0) {
      return this.finish(delivery, 'skipped', 'preference_off', now);
    }
    const eventKey = messageEventKey(
      message._id.toHexString(),
      delivery.userId.toHexString(),
    );
    const { notificationId } = await this.center.createPlatformMessage({
      organizationId: delivery.organizationId,
      userId: delivery.userId,
      messageId: message._id,
      eventKey,
      eventAt: message.createdAt,
    });
    // Push : travail du seul destinataire ; appareils, préférences push,
    // session et droits revérifiés par le dispatcher avant chaque envoi.
    await this.outbox.platformMessage({
      organizationId: delivery.organizationId,
      userId: delivery.userId,
      messageId: message._id,
      notificationId,
      eventKey,
    });
    return this.finish(delivery, 'created', null, now, { notificationId });
  }

  private async deliverEmail(
    delivery: PlatformMessageDeliveryDoc,
    message: PlatformMessageDoc,
    uncertainAt: Date | null,
    now: Date,
    attempt: { called: boolean },
  ) {
    const final = (status: 'failed' | 'skipped', reason: string) =>
      this.finish(delivery, uncertainAt ? 'uncertain' : status, reason, now, {
        uncertainAt,
      });
    const eligibility = await this.eligibility(delivery);
    if (!eligibility.ok) return final('skipped', eligibility.reason);
    if (
      uncertainAt &&
      delivery.firstAttemptAt &&
      now.getTime() - delivery.firstAttemptAt.getTime() >
        MESSAGE_UNCERTAIN_RETRY_WINDOW_MS
    ) {
      return this.finish(delivery, 'uncertain', 'retry_window_expired', now, {
        uncertainAt,
      });
    }
    if (!this.sender.isConfigured()) {
      return final('failed', 'email_not_configured');
    }
    // Figés au premier envoi : un renvoi (même clé) doit être identique.
    const snapshot = delivery.emailSnapshot ?? {
      to: eligibility.user.email,
      locale: recipientLocale(eligibility.user.locale),
      organizationName: eligibility.organizationName,
    };
    const firstAttemptAt = delivery.firstAttemptAt ?? now;
    const saved = await this.db.messageDeliveries.updateOne(
      {
        _id: delivery._id,
        status: 'sending',
        lockedUntil: delivery.lockedUntil,
      },
      { $set: { emailSnapshot: snapshot, firstAttemptAt, uncertainAt } },
    );
    if (saved.matchedCount === 0) return null;
    const email = buildPlatformMessageEmail({
      title: message.title,
      body: message.body,
      organizationName: snapshot.organizationName,
      supportAddress: SUPPORT_RECIPIENT,
      locale: snapshot.locale,
    });
    attempt.called = true;
    try {
      await this.sender.send({
        to: snapshot.to,
        replyTo: SUPPORT_RECIPIENT,
        subject: email.subject,
        text: email.text,
        html: email.html,
        idempotencyKey: messageEmailIdempotencyKey(
          message._id.toHexString(),
          delivery.userId.toHexString(),
        ),
      });
    } catch (error) {
      const { outcome, reason } = classifyEmailFailure(error);
      this.logger.warn(
        `Livraison ${delivery._id.toHexString()} (e-mail) non confirmée : ${reason}.`,
      );
      if (outcome === 'failed') return final('failed', reason);
      const nextUncertainAt =
        outcome === 'unknown' ? (uncertainAt ?? now) : uncertainAt;
      const windowEnds =
        firstAttemptAt.getTime() + MESSAGE_UNCERTAIN_RETRY_WINDOW_MS;
      return this.reschedule(
        delivery,
        reason,
        nextUncertainAt,
        now,
        windowEnds,
      );
    }
    return this.finish(delivery, 'accepted', null, now, { uncertainAt });
  }

  /**
   * Destinataire encore éligible : appartenance ACTIVE à l'organisation du
   * message, compte présent et vérifié (sinon il ne peut pas se connecter).
   */
  private async eligibility(
    delivery: PlatformMessageDeliveryDoc,
  ): Promise<Eligibility> {
    const [membership, user, organization] = await Promise.all([
      this.collection('organizationmemberships').findOne(
        {
          organizationId: delivery.organizationId,
          userId: delivery.userId,
          status: MembershipStatus.ACTIVE,
        },
        { projection: { _id: 1 } },
      ),
      this.collection('users').findOne(
        { _id: delivery.userId },
        { projection: { email: 1, locale: 1, emailVerifiedAt: 1 } },
      ),
      this.collection('organizations').findOne(
        { _id: delivery.organizationId },
        { projection: { name: 1 } },
      ),
    ]);
    if (!user) return { ok: false, reason: 'account_missing' };
    if (!user.emailVerifiedAt) return { ok: false, reason: 'account_inactive' };
    if (!membership) return { ok: false, reason: 'membership_inactive' };
    if (!organization) return { ok: false, reason: 'organization_missing' };
    return {
      ok: true,
      user: { email: String(user.email), locale: user.locale },
      organizationName: String(organization.name),
    };
  }

  /** Nouvelle tentative différée, ou fin si les reprises sont épuisées. */
  private reschedule(
    delivery: PlatformMessageDeliveryDoc,
    reason: string,
    uncertainAt: Date | null,
    now: Date,
    windowEndsAt: number = Number.POSITIVE_INFINITY,
  ) {
    const nextAttemptAt = new Date(
      now.getTime() + retryDelayMs(delivery.attempts),
    );
    if (
      delivery.attempts >= MESSAGE_MAX_ATTEMPTS ||
      (uncertainAt !== null && nextAttemptAt.getTime() > windowEndsAt)
    ) {
      return this.finish(
        delivery,
        uncertainAt ? 'uncertain' : 'failed',
        reason,
        now,
        { uncertainAt },
      );
    }
    return this.write(delivery, 'pending', reason, {
      nextAttemptAt,
      uncertainAt,
      updatedAt: now,
    });
  }

  private finish(
    delivery: PlatformMessageDeliveryDoc,
    status: Exclude<MessageDeliveryStatus, 'pending' | 'sending'>,
    reason: string | null,
    now: Date,
    extra: Partial<
      Pick<PlatformMessageDeliveryDoc, 'notificationId' | 'uncertainAt'>
    > = {},
  ) {
    return this.write(delivery, status, reason, {
      ...extra,
      completedAt: now,
      updatedAt: now,
    });
  }

  /** Écriture conditionnée à NOTRE réservation (jamais celle d'un autre). */
  private async write(
    delivery: PlatformMessageDeliveryDoc,
    status: Exclude<MessageDeliveryStatus, 'sending'>,
    reason: string | null,
    fields: Partial<PlatformMessageDeliveryDoc>,
  ): Promise<Exclude<MessageDeliveryStatus, 'sending'> | null> {
    const result = await this.db.messageDeliveries.updateOne(
      {
        _id: delivery._id,
        status: 'sending',
        lockedUntil: delivery.lockedUntil,
      },
      { $set: { ...fields, status, reason, lockedUntil: null } },
    );
    return result.matchedCount === 1 ? status : null;
  }
}
