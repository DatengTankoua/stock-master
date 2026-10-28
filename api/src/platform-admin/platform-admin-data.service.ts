import { Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { StorageQuotaService } from '../storage-quota/storage-quota.service';
import { PRODUCT_CAPACITY } from '../products/product-capacity';
import {
  productBatchesEnabledFor,
  productBatchesScope,
} from '../products/batches/product-batches-config';
import {
  expiryAlertsEnabledFor,
  expiryAlertsScope,
} from '../products/expiry/expiry-alerts-config';
import type { OrganizationScope } from '../common/organization-scope';
import { SUBSCRIPTION_PERIODS_COLLECTION } from '../subscriptions/schemas/subscription-period.schema';
import { SUBSCRIPTION_PAYMENTS_COLLECTION } from '../subscriptions/payments/schemas/subscription-payment.schema';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import type {
  AdminAuditQuery,
  AdminOrganizationsQuery,
  AdminPaymentsQuery,
  OrganizationSubscriptionFilter,
} from './dto/platform-admin.dto';
import { PlatformAdminErrorCode } from './platform-admin-errors';

/** Portée d'une fonction activée (jamais la liste ni la valeur brute). */
function featureScope(
  enabled: boolean,
  scope: OrganizationScope,
): 'all' | 'selected' | null {
  if (!enabled) return null;
  return scope.kind === 'all' ? 'all' : 'selected';
}

/**
 * Données administratives en LECTURE SEULE. Chaque réponse est une
 * projection explicite (jamais un document complet) ; pages de taille
 * fixe, recherche et filtres bornés, `maxTimeMS` sur chaque agrégation.
 *
 * Jamais exposés : catalogues, ventes, marges, mots de passe, jetons,
 * secrets MFA, clés de stockage, URL signées, URL de paiement, téléphone du
 * payeur, contenu des notifications du prestataire.
 *
 * Classement commercial d'une organisation à l'heure serveur (mêmes règles
 * que `computeSubscriptionState`, période = `[startsAt, endsAt)`) :
 * - `paid` : la période en cours est un abonnement issu d'un paiement ;
 * - `manual` : abonnement en cours attribué manuellement (commande
 *   opérateur), pas forcément payé ;
 * - `trial` : essai gratuit en cours ;
 * - `scheduled` : aucune période en cours, une période future ;
 * - `expired` : des périodes, toutes terminées ;
 * - `none` : aucune période.
 */
export const ADMIN_PAGE_SIZE = 20;
const MAX_TIME_MS = 5_000;
const DAY_MS = 86_400_000;

type SubscriptionClass = OrganizationSubscriptionFilter;

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Étapes communes : périodes de l'organisation → classe commerciale. */
function subscriptionStages(now: Date): Record<string, unknown>[] {
  const current = {
    $filter: {
      input: '$periods',
      cond: {
        $and: [
          { $lte: ['$$this.startsAt', now] },
          { $gt: ['$$this.endsAt', now] },
        ],
      },
    },
  };
  const has = (input: unknown, cond: unknown) => ({
    $gt: [{ $size: { $filter: { input, cond } } }, 0],
  });
  return [
    {
      $lookup: {
        from: SUBSCRIPTION_PERIODS_COLLECTION,
        localField: '_id',
        foreignField: 'organizationId',
        as: 'periods',
        pipeline: [
          {
            $project: {
              _id: 0,
              kind: 1,
              source: 1,
              term: 1,
              startsAt: 1,
              endsAt: 1,
            },
          },
        ],
      },
    },
    { $addFields: { currentPeriods: current } },
    {
      $addFields: {
        subscriptionClass: {
          $switch: {
            branches: [
              {
                case: has('$currentPeriods', {
                  $and: [
                    { $eq: ['$$this.kind', 'subscription'] },
                    { $eq: ['$$this.source', 'payment'] },
                  ],
                }),
                then: 'paid',
              },
              {
                case: has('$currentPeriods', {
                  $and: [
                    { $eq: ['$$this.kind', 'subscription'] },
                    { $eq: ['$$this.source', 'offered'] },
                  ],
                }),
                then: 'offered',
              },
              {
                case: has('$currentPeriods', {
                  $eq: ['$$this.kind', 'subscription'],
                }),
                then: 'manual',
              },
              {
                case: { $gt: [{ $size: '$currentPeriods' }, 0] },
                then: 'trial',
              },
              {
                case: has('$periods', { $gt: ['$$this.startsAt', now] }),
                then: 'scheduled',
              },
              { case: { $gt: [{ $size: '$periods' }, 0] }, then: 'expired' },
            ],
            default: 'none',
          },
        },
        coverageEndsAt: { $max: '$periods.endsAt' },
      },
    },
  ];
}

@Injectable()
export class PlatformAdminDataService {
  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly storageQuota: StorageQuotaService,
  ) {}

  private collection(name: string) {
    const db = this.runtime.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    return db.collection(name);
  }

  /**
   * Vue d'ensemble. Définitions :
   * - `organizations.total` : organisations inscrites (toutes, suspendues
   *   comprises) ; `suspended` : statut administratif suspendu ;
   * - `subscriptions.*` : nombre d'organisations par classe commerciale
   *   (voir l'en-tête du fichier) — un abonnement valide n'est PAS une
   *   activité récente ;
   * - `registrations.last7Days/last30Days` : organisations créées dans les
   *   7/30 derniers jours (date d'inscription, pas d'activité) ;
   * - `payments.collected30Days` : encaissements d'abonnements de Stock
   *   Master confirmés (`succeeded`) dans les 30 derniers jours, hors
   *   remboursement signalé ; ce ne sont PAS les ventes des commerces ;
   * - `payments.toReview` : paiements en examen ou incertains.
   */
  async overview() {
    const now = this.runtime.clock();
    const organizations = this.collection('organizations');
    const since7 = new Date(now.getTime() - 7 * DAY_MS);
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const [
      total,
      suspended,
      last7Days,
      last30Days,
      classes,
      collected,
      toReview,
    ] = await Promise.all([
      organizations.countDocuments({}, { maxTimeMS: MAX_TIME_MS }),
      organizations.countDocuments(
        { status: 'suspended' },
        { maxTimeMS: MAX_TIME_MS },
      ),
      organizations.countDocuments(
        { createdAt: { $gte: since7 } },
        { maxTimeMS: MAX_TIME_MS },
      ),
      organizations.countDocuments(
        { createdAt: { $gte: since30 } },
        { maxTimeMS: MAX_TIME_MS },
      ),
      organizations
        .aggregate<{ _id: SubscriptionClass; count: number }>(
          [
            { $project: { _id: 1 } },
            ...subscriptionStages(now),
            { $group: { _id: '$subscriptionClass', count: { $sum: 1 } } },
          ],
          { maxTimeMS: MAX_TIME_MS },
        )
        .toArray(),
      this.collection(SUBSCRIPTION_PAYMENTS_COLLECTION)
        .aggregate<{ count: number; amount: number }>(
          [
            {
              $match: {
                status: 'succeeded',
                refundedAt: null,
                confirmedAt: { $gte: since30, $lte: now },
              },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
              },
            },
          ],
          { maxTimeMS: MAX_TIME_MS },
        )
        .toArray(),
      this.collection(SUBSCRIPTION_PAYMENTS_COLLECTION).countDocuments(
        { status: { $in: ['review', 'uncertain'] } },
        { maxTimeMS: MAX_TIME_MS },
      ),
    ]);
    const byClass = Object.fromEntries(classes.map((c) => [c._id, c.count]));
    return {
      generatedAt: now,
      organizations: { total, suspended },
      subscriptions: {
        trial: byClass.trial ?? 0,
        paid: byClass.paid ?? 0,
        offered: byClass.offered ?? 0,
        manual: byClass.manual ?? 0,
        scheduled: byClass.scheduled ?? 0,
        expired: byClass.expired ?? 0,
        none: byClass.none ?? 0,
      },
      registrations: { last7Days, last30Days },
      payments: {
        collected30Days: {
          count: collected[0]?.count ?? 0,
          amount: collected[0]?.amount ?? 0,
          currency: 'XAF',
        },
        toReview,
      },
    };
  }

  async organizations(query: AdminOrganizationsQuery) {
    const now = this.runtime.clock();
    const page = query.page ?? 1;
    const match: Record<string, unknown> = {};
    if (query.status) match.status = query.status;
    if (query.q) {
      const pattern = new RegExp(escapeRegex(query.q), 'i');
      match.$or = [
        { name: pattern },
        { slug: pattern },
        ...(/^[0-9a-f]{24}$/i.test(query.q)
          ? [{ _id: new Types.ObjectId(query.q) }]
          : []),
      ];
    }
    const [result] = await this.collection('organizations')
      .aggregate<{
        items: Array<{
          _id: Types.ObjectId;
          name: string;
          slug: string;
          status: string;
          createdAt: Date;
          subscriptionClass: SubscriptionClass;
          coverageEndsAt: Date | null;
        }>;
        total: Array<{ count: number }>;
      }>(
        [
          { $match: match },
          { $sort: { createdAt: -1, _id: -1 } },
          { $project: { name: 1, slug: 1, status: 1, createdAt: 1 } },
          ...subscriptionStages(now),
          ...(query.subscription
            ? [{ $match: { subscriptionClass: query.subscription } }]
            : []),
          {
            $facet: {
              items: [
                { $skip: (page - 1) * ADMIN_PAGE_SIZE },
                { $limit: ADMIN_PAGE_SIZE },
                {
                  $project: {
                    name: 1,
                    slug: 1,
                    status: 1,
                    createdAt: 1,
                    subscriptionClass: 1,
                    coverageEndsAt: 1,
                  },
                },
              ],
              total: [{ $count: 'count' }],
            },
          },
        ],
        { maxTimeMS: MAX_TIME_MS },
      )
      .toArray();
    const items = result?.items ?? [];
    const members = await this.activeMemberCounts(items.map((o) => o._id));
    return {
      page,
      pageSize: ADMIN_PAGE_SIZE,
      total: result?.total[0]?.count ?? 0,
      items: items.map((o) => ({
        id: o._id.toHexString(),
        name: o.name,
        slug: o.slug,
        status: o.status,
        createdAt: o.createdAt,
        subscription: o.subscriptionClass,
        coverageEndsAt: o.coverageEndsAt ?? null,
        activeMembers: members.get(o._id.toHexString()) ?? 0,
      })),
    };
  }

  async organization(organizationId: string) {
    if (!/^[0-9a-f]{24}$/.test(organizationId)) throw this.notFound();
    const id = new Types.ObjectId(organizationId);
    const now = this.runtime.clock();
    const [org] = await this.collection('organizations')
      .aggregate<{
        _id: Types.ObjectId;
        name: string;
        slug: string;
        status: string;
        currency: string;
        createdAt: Date;
        suspension?: {
          suspendedAt: Date;
          suspendedBy: Types.ObjectId;
          internalReason: string;
          clientMessage: string;
        } | null;
        subscriptionClass: SubscriptionClass;
        coverageEndsAt: Date | null;
        periods: Array<{
          kind: string;
          source: string;
          term: string | null;
          startsAt: Date;
          endsAt: Date;
        }>;
      }>(
        [
          { $match: { _id: id } },
          {
            $project: {
              name: 1,
              slug: 1,
              status: 1,
              currency: 1,
              createdAt: 1,
              suspension: 1,
            },
          },
          ...subscriptionStages(now),
        ],
        { maxTimeMS: MAX_TIME_MS },
      )
      .toArray();
    if (!org) throw this.notFound();

    const memberships = this.collection('organizationmemberships');
    const [roles, ownerMembership, products, trashed, storage, payments] =
      await Promise.all([
        memberships
          .aggregate<{ _id: string; count: number }>(
            [
              { $match: { organizationId: id, status: 'active' } },
              { $group: { _id: '$role', count: { $sum: 1 } } },
            ],
            { maxTimeMS: MAX_TIME_MS },
          )
          .toArray(),
        memberships.findOne(
          { organizationId: id, role: 'owner', status: 'active' },
          { projection: { userId: 1 } },
        ),
        this.collection('products').countDocuments(
          { organizationId: id },
          { maxTimeMS: MAX_TIME_MS },
        ),
        this.collection('products').countDocuments(
          { organizationId: id, deletedAt: { $ne: null } },
          { maxTimeMS: MAX_TIME_MS },
        ),
        this.storageQuota.usage(organizationId).catch(() => null),
        this.paymentRows({ organizationId: id }, 1, 10),
      ]);
    const owner = ownerMembership
      ? await this.collection('users').findOne(
          { _id: ownerMembership.userId },
          { projection: { name: 1, email: 1, emailVerifiedAt: 1 } },
        )
      : null;
    const roleCount = Object.fromEntries(roles.map((r) => [r._id, r.count]));
    const suspendedBy = org.suspension?.suspendedBy
      ? await this.collection('users').findOne(
          { _id: org.suspension.suspendedBy },
          { projection: { email: 1 } },
        )
      : null;
    return {
      id: org._id.toHexString(),
      name: org.name,
      slug: org.slug,
      status: org.status,
      // Suspension : motif INTERNE et message au commerce, champs séparés.
      suspension:
        org.status === 'suspended'
          ? {
              suspendedAt: org.suspension?.suspendedAt ?? null,
              suspendedBy: suspendedBy ? String(suspendedBy.email) : null,
              internalReason: org.suspension?.internalReason ?? null,
              clientMessage: org.suspension?.clientMessage ?? null,
            }
          : null,
      currency: org.currency,
      createdAt: org.createdAt,
      owner: owner
        ? {
            name: String(owner.name),
            email: String(owner.email),
            emailVerified: Boolean(owner.emailVerifiedAt),
          }
        : null,
      members: {
        owner: roleCount.owner ?? 0,
        admin: roleCount.admin ?? 0,
        seller: roleCount.seller ?? 0,
        total: roles.reduce((sum, r) => sum + r.count, 0),
      },
      quotas: {
        products: { used: products, trashed, limit: PRODUCT_CAPACITY },
        storage: storage
          ? {
              usedBytes: storage.usedBytes,
              reservedBytes: storage.reservedBytes,
              limitBytes: storage.limitBytes,
              enforced: storage.enforced,
            }
          : null,
      },
      subscription: {
        class: org.subscriptionClass,
        coverageEndsAt: org.coverageEndsAt ?? null,
        periods: [...org.periods]
          .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
          .slice(0, 24)
          .map((p) => ({
            kind: p.kind,
            source: p.source,
            term: p.term ?? null,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            current: p.startsAt <= now && now < p.endsAt,
          })),
      },
      features: {
        productBatches: productBatchesEnabledFor(organizationId),
        expiryAlerts: expiryAlertsEnabledFor(organizationId),
      },
      // Portée de l'activation pour CE commerce : `all` (tous les commerces),
      // `selected` (commerces choisis), `null` (désactivée). Ni identifiant ni
      // valeur de variable d'environnement.
      featureScopes: {
        productBatches: featureScope(
          productBatchesEnabledFor(organizationId),
          productBatchesScope(),
        ),
        expiryAlerts: featureScope(
          expiryAlertsEnabledFor(organizationId),
          expiryAlertsScope(),
        ),
      },
      recentPayments: payments.items,
    };
  }

  async payments(query: AdminPaymentsQuery) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.organizationId) {
      filter.organizationId = new Types.ObjectId(query.organizationId);
    }
    return this.paymentRows(filter, query.page ?? 1, ADMIN_PAGE_SIZE);
  }

  async audit(query: AdminAuditQuery) {
    const page = query.page ?? 1;
    const filter: Record<string, unknown> = {};
    if (query.action) filter.action = query.action;
    if (query.outcome) filter.outcome = query.outcome;
    const audit = this.runtime.collections().audit;
    const [rows, total] = await Promise.all([
      audit
        .find(filter, {
          projection: {
            at: 1,
            actorType: 1,
            actorUserId: 1,
            actorLabel: 1,
            action: 1,
            outcome: 1,
            targetType: 1,
            targetId: 1,
            detail: 1,
          },
          maxTimeMS: MAX_TIME_MS,
        })
        .sort({ at: -1, _id: -1 })
        .skip((page - 1) * ADMIN_PAGE_SIZE)
        .limit(ADMIN_PAGE_SIZE)
        .toArray(),
      audit.countDocuments(filter, { maxTimeMS: MAX_TIME_MS }),
    ]);
    const actorIds = [
      ...new Set(
        rows
          .map((r) => r.actorUserId?.toHexString())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const actors = actorIds.length
      ? await this.collection('users')
          .find(
            { _id: { $in: actorIds.map((id) => new Types.ObjectId(id)) } },
            { projection: { name: 1, email: 1 } },
          )
          .toArray()
      : [];
    const actorById = new Map(
      actors.map((a) => [
        String(a._id),
        { name: String(a.name), email: String(a.email) },
      ]),
    );
    return {
      page,
      pageSize: ADMIN_PAGE_SIZE,
      total,
      items: rows.map((r) => ({
        id: r._id.toHexString(),
        at: r.at,
        actorType: r.actorType,
        actor: r.actorUserId
          ? (actorById.get(r.actorUserId.toHexString()) ?? null)
          : null,
        actorLabel: r.actorLabel,
        action: r.action,
        outcome: r.outcome,
        targetType: r.targetType,
        targetId: r.targetId,
        detail: r.detail,
      })),
    };
  }

  // ─── Interne ──────────────────────────────────────────────────────────

  private notFound() {
    return new NotFoundException({
      code: PlatformAdminErrorCode.NOT_FOUND,
      message: 'Introuvable.',
    });
  }

  private async activeMemberCounts(
    ids: Types.ObjectId[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const counts = await this.collection('organizationmemberships')
      .aggregate<{ _id: Types.ObjectId; count: number }>(
        [
          { $match: { organizationId: { $in: ids }, status: 'active' } },
          { $group: { _id: '$organizationId', count: { $sum: 1 } } },
        ],
        { maxTimeMS: MAX_TIME_MS },
      )
      .toArray();
    return new Map(counts.map((c) => [c._id.toHexString(), c.count]));
  }

  /** Paiements : projection explicite, sans URL, téléphone ni webhook. */
  private async paymentRows(
    filter: Record<string, unknown>,
    page: number,
    pageSize: number,
  ) {
    const payments = this.collection(SUBSCRIPTION_PAYMENTS_COLLECTION);
    const [rows, total] = await Promise.all([
      payments
        .find(filter, {
          projection: {
            organizationId: 1,
            term: 1,
            amount: 1,
            currency: 1,
            provider: 1,
            providerReference: 1,
            merchantReference: 1,
            status: 1,
            incidentCode: 1,
            periodId: 1,
            createdAt: 1,
            confirmedAt: 1,
            failedAt: 1,
            refundedAt: 1,
          },
          maxTimeMS: MAX_TIME_MS,
        })
        .sort({ _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      payments.countDocuments(filter, { maxTimeMS: MAX_TIME_MS }),
    ]);
    const orgIds = [...new Set(rows.map((r) => String(r.organizationId)))];
    const periodIds = rows
      .map((r) => r.periodId as Types.ObjectId | null)
      .filter((id): id is Types.ObjectId => Boolean(id));
    const [orgs, periods] = await Promise.all([
      orgIds.length
        ? this.collection('organizations')
            .find(
              { _id: { $in: orgIds.map((id) => new Types.ObjectId(id)) } },
              { projection: { name: 1 } },
            )
            .toArray()
        : [],
      periodIds.length
        ? this.collection(SUBSCRIPTION_PERIODS_COLLECTION)
            .find(
              { _id: { $in: periodIds } },
              { projection: { startsAt: 1, endsAt: 1 } },
            )
            .toArray()
        : [],
    ]);
    const orgName = new Map<string, string>(
      (orgs as Array<{ _id: unknown; name?: unknown }>).map(
        (o) => [String(o._id), String(o.name)] as const,
      ),
    );
    const periodById = new Map(
      (periods as Array<{ _id: unknown; startsAt: Date; endsAt: Date }>).map(
        (p) => [String(p._id), p] as const,
      ),
    );
    return {
      page,
      pageSize,
      total,
      items: rows.map((r) => {
        const period = r.periodId ? periodById.get(String(r.periodId)) : null;
        return {
          id: String(r._id),
          organization: {
            id: String(r.organizationId),
            name: orgName.get(String(r.organizationId)) ?? null,
          },
          term: r.term as string,
          amount: r.amount as number,
          currency: r.currency as string,
          provider: r.provider as string,
          providerReference: (r.providerReference as string | null) ?? null,
          merchantReference: r.merchantReference as string,
          status: r.status as string,
          incidentCode: (r.incidentCode as string | null) ?? null,
          createdAt: (r.createdAt as Date | undefined) ?? null,
          confirmedAt: (r.confirmedAt as Date | null) ?? null,
          failedAt: (r.failedAt as Date | null) ?? null,
          refundedAt: (r.refundedAt as Date | null) ?? null,
          period: period
            ? { startsAt: period.startsAt, endsAt: period.endsAt }
            : null,
        };
      }),
    };
  }
}
