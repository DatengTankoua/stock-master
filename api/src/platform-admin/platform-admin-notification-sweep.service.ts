import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  TERM_MONTHS,
  isSubscriptionTerm,
} from '../subscriptions/subscription-terms';
import {
  PAYMENT_CONFIRMATION_DELAY_MS,
  paymentConfirmationDelayed,
  type DelayFacts,
} from '../subscriptions/payments/payment-confirmation-delay';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import {
  PlatformAdminNotificationsService,
  type NotificationEvent,
} from './platform-admin-notifications.service';
import {
  campaignAudienceIsPartial,
  campaignIsCompleted,
  finalCounts,
  notificationKeys,
  organizationNameParam,
  paymentIsConfirmed,
  paymentNeedsIntervention,
  type CampaignDeliveryCounts,
} from './platform-admin-notifications';
import type { PlatformCampaignDoc } from './platform-admin-store';

/** Passe de collecte (processus HTTP uniquement, comme les autres fonds). */
export const NOTIFICATION_SWEEP_INTERVAL_MS = 30_000;
/**
 * Recouvrement relu à chaque passe : un document horodaté AVANT la fin de
 * sa transaction (création d'organisation, confirmation de paiement) peut
 * devenir visible après une passe ; MongoDB borne une transaction à 60 s.
 */
export const NOTIFICATION_SWEEP_OVERLAP_MS = 10 * 60_000;
/**
 * Rattrapage maximal après une interruption (version retirée puis remise) :
 * au-delà, les événements anciens ne sont plus signalés.
 */
export const NOTIFICATION_MAX_CATCH_UP_MS = 7 * 24 * 3_600_000;
const PAGE = 200;
const MAX_PAGES_PER_SOURCE = 10;
const ACTIVATION = 'activation';
/**
 * Point d'activation PROPRE aux retards SasPay (première passe de la version
 * qui les signale) : un paiement dont le seuil de 24 h était déjà franchi
 * avant n'est pas signalé (pas d'alerte rétroactive en masse au déploiement).
 */
const DELAYED_ACTIVATION = 'payments_confirmation_delayed_activation';

interface SourceDoc {
  _id: unknown;
  [field: string]: unknown;
}

interface Source {
  id: string;
  collection: string;
  /** Champ daté (et monotone à l'écriture) qui fait avancer le curseur. */
  field: string;
  filter: Record<string, unknown>;
  projection: Record<string, 1>;
  toEvents(docs: SourceDoc[]): Promise<NotificationEvent[]>;
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const hex = (value: unknown): string =>
  value instanceof Types.ObjectId ? value.toHexString() : String(value);

/**
 * Collecte DURABLE des événements : chaque passe relit l'état PERSISTANT
 * des collections métier (jamais un signal en mémoire) et enregistre les
 * notifications manquantes par `eventKey` unique.
 *
 * - Seul l'état validé est lu : une inscription ou une confirmation dont
 *   la transaction est annulée n'existe pas, donc ne produit rien.
 * - Action réussie puis processus arrêté : la passe suivante la retrouve
 *   (curseur persistant, recouvrement) ; aucune notification perdue tant
 *   que l'interruption dure moins que `NOTIFICATION_MAX_CATCH_UP_MS`.
 * - Rejeu de webhook, rapprochement, deux passes concurrentes : même clé,
 *   même document (upsert `$setOnInsert`).
 * - Aucune notification rétroactive : rien d'antérieur au point
 *   d'ACTIVATION (première passe de cette version) n'est examiné.
 *
 * Aucun appel externe, aucun e-mail, aucun push.
 */
@Injectable()
export class PlatformAdminNotificationSweep implements OnApplicationShutdown {
  private readonly logger = new Logger('PlatformAdminNotifications');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private intervalMs = NOTIFICATION_SWEEP_INTERVAL_MS;

  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly notifications: PlatformAdminNotificationsService,
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

  start(intervalMs: number = NOTIFICATION_SWEEP_INTERVAL_MS): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.intervalMs = intervalMs;
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
    this.running = this.runOnce()
      .catch(() =>
        this.logger.warn('Passe de collecte des notifications interrompue.'),
      )
      .finally(() => {
        this.running = null;
        if (!this.stopped) this.schedule(this.intervalMs);
      });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  // ─── Passe ──────────────────────────────────────────────────────────────

  /** Une passe complète ; renvoie le nombre de notifications créées. */
  async runOnce(): Promise<{ created: number }> {
    // Espace fermé ou index requis absents : rien n'est collecté (le point
    // d'activation n'est posé qu'à la première passe effective).
    if (!this.runtime.config.enabled) return { created: 0 };
    if (!(await this.notifications.ready())) return { created: 0 };
    const now = this.runtime.clock();
    const activation = await this.cursor(ACTIVATION, now);
    let created = 0;
    for (const source of this.sources()) {
      created += await this.sweepSource(source, activation, now);
    }
    created += await this.sweepCampaigns(activation, now);
    created += await this.sweepDelayedPayments(now);
    return { created };
  }

  /** Curseur persistant (créé à `initial` s'il n'existe pas). */
  private async cursor(id: string, initial: Date): Promise<Date> {
    const doc = await this.db.notificationCursors.findOneAndUpdate(
      { _id: id },
      { $setOnInsert: { at: initial, updatedAt: initial } },
      { upsert: true, returnDocument: 'after' },
    );
    return doc!.at;
  }

  private async sweepSource(
    source: Source,
    activation: Date,
    now: Date,
  ): Promise<number> {
    const cursor = await this.cursor(source.id, activation);
    const lower = new Date(
      Math.max(
        cursor.getTime() - NOTIFICATION_SWEEP_OVERLAP_MS,
        activation.getTime(),
        now.getTime() - NOTIFICATION_MAX_CATCH_UP_MS,
      ),
    );
    let after: { at: Date; id: unknown } | null = null;
    let maxSeen = cursor;
    let created = 0;
    for (let page = 0; page < MAX_PAGES_PER_SOURCE; page += 1) {
      const range = after
        ? {
            $or: [
              { [source.field]: { $gt: after.at } },
              { [source.field]: after.at, _id: { $gt: after.id } },
            ],
          }
        : { [source.field]: { $gte: lower } };
      const docs = (await this.collection(source.collection)
        .find({ ...source.filter, ...range } as never, {
          projection: { ...source.projection, [source.field]: 1 },
        })
        .sort({ [source.field]: 1, _id: 1 })
        .limit(PAGE)
        .toArray()) as unknown as SourceDoc[];
      if (docs.length === 0) break;
      created += await this.notifications.record(await source.toEvents(docs));
      const last = docs[docs.length - 1];
      const at = last[source.field] as Date;
      after = { at, id: last._id };
      if (at > maxSeen) maxSeen = at;
      if (docs.length < PAGE) break;
    }
    if (maxSeen > cursor) {
      await this.db.notificationCursors.updateOne(
        { _id: source.id },
        { $max: { at: maxSeen }, $set: { updatedAt: now } },
      );
    }
    return created;
  }

  private async organizationNames(
    ids: unknown[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.map(hex))]
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (unique.length === 0) return new Map();
    const rows = await this.collection('organizations')
      .find({ _id: { $in: unique } }, { projection: { name: 1 } })
      .toArray();
    return new Map(rows.map((r) => [hex(r._id), String(r.name ?? '')]));
  }

  // ─── Sources datées ─────────────────────────────────────────────────────

  private sources(): Source[] {
    return [
      {
        // A. Organisation créée (transaction d'inscription validée).
        id: 'organizations',
        collection: 'organizations',
        field: 'createdAt',
        filter: {},
        projection: { name: 1 },
        toEvents: (docs) =>
          Promise.resolve(
            docs.map((org) => ({
              eventKey: notificationKeys.organizationCreated(hex(org._id)),
              type: 'organization_created' as const,
              occurredAt: org.createdAt as Date,
              target: {
                kind: 'organization' as const,
                id: hex(org._id),
                organizationId: hex(org._id),
              },
              params: { organizationName: organizationNameParam(org.name) },
            })),
          ),
      },
      {
        // B. Paiement confirmé : période attribuée dans la même transaction.
        id: 'payments_confirmed',
        collection: 'subscription_payments',
        field: 'confirmedAt',
        filter: { status: 'succeeded', periodId: { $ne: null } },
        projection: {
          organizationId: 1,
          amount: 1,
          currency: 1,
          term: 1,
          status: 1,
          periodId: 1,
        },
        toEvents: async (docs) => {
          const names = await this.organizationNames(
            docs.map((d) => d.organizationId),
          );
          return docs
            .filter((p) =>
              paymentIsConfirmed({
                status: p.status,
                periodId: p.periodId,
                confirmedAt: p.confirmedAt,
              }),
            )
            .map((p) => this.paymentEvent(p, names, 'payment_confirmed'));
        },
      },
      {
        // C. Paiement à examiner (`review`) : traitement opérateur.
        id: 'payments_review',
        collection: 'subscription_payments',
        field: 'updatedAt',
        filter: { status: 'review', refundedAt: null },
        projection: {
          organizationId: 1,
          amount: 1,
          currency: 1,
          term: 1,
          status: 1,
          incidentCode: 1,
          refundedAt: 1,
        },
        toEvents: async (docs) => {
          const names = await this.organizationNames(
            docs.map((d) => d.organizationId),
          );
          return docs
            .filter((p) =>
              paymentNeedsIntervention({
                status: p.status,
                refundedAt: p.refundedAt,
              }),
            )
            .map((p) => this.paymentEvent(p, names, 'payment_review'));
        },
      },
      {
        // D. Demande d'assistance enregistrée (registre minimal : ni sujet
        // ni message n'y sont conservés, rien n'est recopié ici).
        id: 'support_requests',
        collection: 'support_requests',
        field: 'createdAt',
        filter: {},
        projection: {
          reference: 1,
          organizationId: 1,
          category: 1,
          'context.organizationName': 1,
        },
        toEvents: (docs) =>
          Promise.resolve(
            docs.map((r) => {
              const organizationId = hex(r.organizationId);
              const context = r.context as
                { organizationName?: unknown } | undefined;
              return {
                eventKey: notificationKeys.supportRequest(String(r._id)),
                type: 'support_request' as const,
                occurredAt: r.createdAt as Date,
                // Aucune consultation des demandes dans l'administration :
                // la cible est la fiche du commerce (droits existants).
                target: {
                  kind: 'organization' as const,
                  id: organizationId,
                  organizationId,
                },
                params: {
                  organizationName: organizationNameParam(
                    context?.organizationName,
                  ),
                  reference: text(r.reference, ''),
                  supportCategory: text(r.category, 'other'),
                },
              };
            }),
          ),
      },
    ];
  }

  private paymentEvent(
    p: SourceDoc,
    names: Map<string, string>,
    type: 'payment_confirmed' | 'payment_review',
  ): NotificationEvent {
    const paymentId = hex(p._id);
    const organizationId = hex(p.organizationId);
    const term = isSubscriptionTerm(p.term) ? p.term : null;
    const incident = typeof p.incidentCode === 'string' ? p.incidentCode : null;
    return {
      eventKey:
        type === 'payment_confirmed'
          ? notificationKeys.paymentConfirmed(paymentId)
          : notificationKeys.paymentReview(paymentId, incident),
      type,
      occurredAt: (type === 'payment_confirmed'
        ? p.confirmedAt
        : p.updatedAt) as Date,
      target: { kind: 'payment', id: paymentId, organizationId },
      params: {
        organizationName: organizationNameParam(names.get(organizationId)),
        amount: typeof p.amount === 'number' ? p.amount : 0,
        currency: typeof p.currency === 'string' ? p.currency : 'XAF',
        ...(term ? { term, months: TERM_MONTHS[term] } : {}),
        ...(type === 'payment_review' ? { incidentCode: incident } : {}),
      },
    };
  }

  // ─── F. Paiements SasPay non confirmés après 24 h ────────────────────────

  /**
   * Seuil atteint SANS AUCUNE écriture du paiement : aucun curseur sur
   * `updatedAt`. Comme les campagnes, chaque passe relit l'ÉTAT : paiements
   * SasPay ouverts non résolus dont `createdAt` (immuable) est antérieur à
   * `now - 24 h`, et dont le seuil a été franchi depuis l'activation de cette
   * source. Ceux déjà signalés (clé `payment_confirmation_delayed:<id>`)
   * sont écartés. Au plus un paiement ouvert par organisation (index
   * unique) : la liste relue reste bornée par le nombre de commerces.
   *
   * Aucun changement d'état du paiement : l'alerte informe seulement.
   */
  private async sweepDelayedPayments(now: Date): Promise<number> {
    const activation = await this.cursor(DELAYED_ACTIVATION, now);
    const range = {
      $gte: new Date(activation.getTime() - PAYMENT_CONFIRMATION_DELAY_MS),
      $lte: new Date(now.getTime() - PAYMENT_CONFIRMATION_DELAY_MS),
    };
    if (range.$gte > range.$lte) return 0;
    let after: { at: Date; id: unknown } | null = null;
    let created = 0;
    for (let page = 0; page < MAX_PAGES_PER_SOURCE; page += 1) {
      const docs = (await this.collection('subscription_payments')
        .find(
          {
            provider: 'saspay',
            open: true,
            status: { $in: ['initiating', 'pending', 'uncertain'] },
            ...(after
              ? {
                  $or: [
                    { createdAt: { $gt: after.at, $lte: range.$lte } },
                    { createdAt: after.at, _id: { $gt: after.id } },
                  ],
                }
              : { createdAt: range }),
          } as never,
          {
            projection: {
              organizationId: 1,
              amount: 1,
              currency: 1,
              term: 1,
              provider: 1,
              status: 1,
              open: 1,
              createdAt: 1,
              collectedAt: 1,
              refundedAt: 1,
              periodId: 1,
              merchantReference: 1,
              providerReference: 1,
              providerTransactionId: 1,
              providerCheckoutExpiresAt: 1,
              incidentCode: 1,
            },
          },
        )
        .sort({ createdAt: 1, _id: 1 })
        .limit(PAGE)
        .toArray()) as unknown as SourceDoc[];
      if (docs.length === 0) break;
      const keys = docs.map((p) =>
        notificationKeys.paymentConfirmationDelayed(hex(p._id)),
      );
      const done = new Set(
        (
          await this.db.notifications
            .find({ eventKey: { $in: keys } }, { projection: { eventKey: 1 } })
            .toArray()
        ).map((n) => n.eventKey),
      );
      const due = docs.filter(
        (p, i) =>
          !done.has(keys[i]) &&
          paymentConfirmationDelayed(p as DelayFacts, now),
      );
      if (due.length > 0) {
        const names = await this.organizationNames(
          due.map((d) => d.organizationId),
        );
        created += await this.notifications.record(
          due.map((p) => this.delayedPaymentEvent(p, names)),
        );
      }
      const last = docs[docs.length - 1];
      after = { at: last.createdAt as Date, id: last._id };
      if (docs.length < PAGE) break;
    }
    return created;
  }

  private delayedPaymentEvent(
    p: SourceDoc,
    names: Map<string, string>,
  ): NotificationEvent {
    const paymentId = hex(p._id);
    const organizationId = hex(p.organizationId);
    const term = isSubscriptionTerm(p.term) ? p.term : null;
    const startedAt = p.createdAt as Date;
    return {
      eventKey: notificationKeys.paymentConfirmationDelayed(paymentId),
      type: 'payment_confirmation_delayed',
      // Instant où le seuil a été franchi (jamais la date de la passe).
      occurredAt: new Date(startedAt.getTime() + PAYMENT_CONFIRMATION_DELAY_MS),
      target: { kind: 'payment', id: paymentId, organizationId },
      params: {
        organizationName: organizationNameParam(names.get(organizationId)),
        amount: typeof p.amount === 'number' ? p.amount : 0,
        currency: typeof p.currency === 'string' ? p.currency : 'XAF',
        ...(term ? { term, months: TERM_MONTHS[term] } : {}),
        reference: text(p.merchantReference, ''),
        transactionReference:
          typeof p.providerTransactionId === 'string'
            ? p.providerTransactionId
            : null,
        startedAt: startedAt.toISOString(),
        // Création non confirmée (session inconnue) : `initiating`, ou
        // reprise en `initiation_uncertain` par le rapprochement.
        incidentCode:
          p.status === 'initiating' && typeof p.providerReference !== 'string'
            ? 'initiation_uncertain'
            : typeof p.incidentCode === 'string'
              ? p.incidentCode
              : null,
      },
    };
  }

  // ─── E. Campagnes ───────────────────────────────────────────────────────

  /**
   * Campagnes lancées depuis l'activation et pas encore conclues : audience
   * close partielle (une fois), puis fin du traitement (une fois, résumé
   * figé). Rien pendant la constitution ni tant qu'une livraison est à
   * traiter (interrupteur d'envoi coupé compris).
   */
  private async sweepCampaigns(activation: Date, now: Date): Promise<number> {
    const launched = await this.db.campaigns
      .find(
        { status: 'launched', launchedAt: { $gte: activation } },
        { projection: { status: 1, audience: 1, launchedAt: 1 } },
      )
      .sort({ launchedAt: 1 })
      .toArray();
    if (launched.length === 0) return 0;
    const done = new Set(
      (
        await this.db.notifications
          .find(
            {
              eventKey: {
                $in: launched.map((c) =>
                  notificationKeys.campaignCompleted(c._id.toHexString()),
                ),
              },
            },
            { projection: { eventKey: 1 } },
          )
          .toArray()
      ).map((n) => n.eventKey),
    );
    const pending = launched.filter(
      (c) => !done.has(notificationKeys.campaignCompleted(c._id.toHexString())),
    );
    const events: NotificationEvent[] = [];
    for (const campaign of pending) {
      const id = campaign._id.toHexString();
      const target = { kind: 'campaign' as const, id, organizationId: null };
      if (campaignAudienceIsPartial(campaign)) {
        events.push({
          eventKey: notificationKeys.campaignAudiencePartial(id),
          type: 'campaign_audience_partial',
          occurredAt: campaign.audience.frozenAt ?? now,
          target,
          params: { audienceTotal: campaign.audience.total },
        });
      }
      if (campaign.audience.status !== 'ready') continue;
      const counts = await this.campaignCounts(campaign);
      if (campaignIsCompleted(campaign, counts, now)) {
        events.push({
          eventKey: notificationKeys.campaignCompleted(id),
          type: 'campaign_completed',
          occurredAt: now,
          target,
          params: {
            audienceTotal: campaign.audience.total,
            results: finalCounts(counts),
          },
        });
      }
    }
    return this.notifications.record(events);
  }

  private async campaignCounts(
    campaign: Pick<PlatformCampaignDoc, '_id'>,
  ): Promise<CampaignDeliveryCounts> {
    const counts: CampaignDeliveryCounts = {
      pending: 0,
      sending: 0,
      accepted: 0,
      skipped: 0,
      failed: 0,
      uncertain: 0,
    };
    const groups = await this.db.campaignDeliveries
      .aggregate<{ _id: string; n: number }>([
        { $match: { campaignId: campaign._id } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      .toArray();
    for (const g of groups) {
      if (g._id in counts) counts[g._id as keyof CampaignDeliveryCounts] = g.n;
    }
    return counts;
  }
}
