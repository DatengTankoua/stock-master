import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import {
  PlatformAdminService,
  type PlatformAdminRequestContext,
} from './platform-admin.service';
import {
  CAMPAIGN_BODY_MAX_LENGTH,
  CAMPAIGN_SUBJECT_MAX_LENGTH,
  actionContentHash,
  campaignTargeting,
  messageText,
  type CampaignLaunchIntent,
} from './platform-admin-action-intent';
import type {
  AuditEntryInput,
  CampaignTargeting,
  PlatformAdminChallengeDoc,
  PlatformCampaignDoc,
} from './platform-admin-store';
import {
  PlatformAdminErrorCode,
  adminOperationConflict,
  adminStateChanged,
  adminStepUpRequired,
} from './platform-admin-errors';
import {
  CAMPAIGN_CONSTITUTION_LEASE_MS,
  CAMPAIGN_PAGE_SIZE,
  CAMPAIGN_RESULTS_PAGE_SIZE,
  campaignSendConfig,
  isMarketingEmailsEnabled,
} from './platform-campaign-policy';
import { buildCampaignEmail } from './platform-campaign-email';
import { PlatformCampaignDeliveryService } from './platform-campaign-delivery.service';
import { MARKETING_CONSENTS_COLLECTION } from '../marketing-consent/schemas/marketing-consent.schema';

type MongoSession = Awaited<ReturnType<Connection['startSession']>>;

const DUPLICATE_KEY = 11000;

export type CampaignListFilter = 'active' | 'archived' | 'all';

export interface CampaignDraftInput {
  subject: unknown;
  body: unknown;
  targeting: unknown;
}

/** Statuts d'une livraison, affichés tels quels (jamais « reçu »). */
const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'accepted',
  'skipped',
  'failed',
  'uncertain',
] as const;

/**
 * Campagnes promotionnelles par e-mail, DISTINCTES des messages de service :
 * autres collections, autres routes, autres capacités, autre traitement de
 * fond. Destinataires : uniquement des utilisateurs ayant donné leur accord
 * (aucune adresse libre, aucun accord donné par l'administrateur).
 *
 * - Brouillon : `platform.campaigns.manage`, révision incrémentée à chaque
 *   modification.
 * - Lancement : `platform.campaigns.send` + preuve renforcée liée à la
 *   campagne, à la révision, au sujet, au texte et au ciblage exacts ;
 *   identifiant d'opération unique (aucun double lancement). Le contenu et
 *   le ciblage sont alors figés.
 * - Consultation : `platform.read` (aucune adresse de destinataire exposée).
 */
@Injectable()
export class PlatformCampaignsService {
  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly admin: PlatformAdminService,
    private readonly deliveries: PlatformCampaignDeliveryService,
  ) {}

  private get db() {
    return this.runtime.collections();
  }

  private collection(name: string) {
    const db = this.runtime.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    return db.collection(name);
  }

  // ─── Brouillons ─────────────────────────────────────────────────────────

  async create(
    context: PlatformAdminRequestContext,
    input: CampaignDraftInput,
  ) {
    await this.require(context, 'platform.campaigns.manage', 'campaign_create');
    const draft = await this.validDraft(input);
    const now = this.runtime.clock();
    const actor = context.user!._id;
    const doc: PlatformCampaignDoc = {
      _id: new Types.ObjectId(),
      status: 'draft',
      ...draft,
      revision: 1,
      createdBy: actor,
      createdAt: now,
      updatedBy: actor,
      updatedAt: now,
      launchedAt: null,
      launchedBy: null,
      launchOperationId: null,
      audience: { status: 'none', cursor: null, total: 0 },
      archivedAt: null,
      archivedBy: null,
    };
    await this.inTransaction(async (txn) => {
      await this.db.campaigns.insertOne(doc, { session: txn });
      await this.admin.auditInTransaction(
        txn,
        this.auditEntry(context, 'campaign_create', doc._id, {
          revision: 1,
          targeting: this.targetingLabel(doc.targeting),
        }),
      );
    });
    return this.detail(doc._id.toHexString());
  }

  /**
   * Modification d'un BROUILLON à la révision attendue (sinon 409 : un
   * autre onglet ou administrateur l'a changé). Toute modification change
   * le contenu lié : une confirmation antérieure ne vaut plus.
   */
  async update(
    context: PlatformAdminRequestContext,
    campaignId: string,
    revision: number,
    input: CampaignDraftInput,
  ) {
    await this.require(context, 'platform.campaigns.manage', 'campaign_update');
    const id = this.objectId(campaignId);
    const draft = await this.validDraft(input);
    const now = this.runtime.clock();
    await this.inTransaction(async (txn) => {
      const updated = await this.db.campaigns.updateOne(
        { _id: id, status: 'draft', revision },
        {
          $set: { ...draft, updatedBy: context.user!._id, updatedAt: now },
          $inc: { revision: 1 },
        },
        { session: txn },
      );
      if (updated.matchedCount !== 1) {
        await this.requireCampaign(id);
        throw this.notEditable();
      }
      await this.admin.auditInTransaction(
        txn,
        this.auditEntry(context, 'campaign_update', id, {
          revision: revision + 1,
          targeting: this.targetingLabel(draft.targeting),
        }),
      );
    });
    return this.detail(campaignId);
  }

  // ─── Consultation ───────────────────────────────────────────────────────

  async list(filter: CampaignListFilter = 'active', page = 1) {
    const query =
      filter === 'active'
        ? { archivedAt: null }
        : filter === 'archived'
          ? { archivedAt: { $ne: null } }
          : {};
    const [active, archived, rows] = await Promise.all([
      this.db.campaigns.countDocuments({ archivedAt: null }),
      this.db.campaigns.countDocuments({ archivedAt: { $ne: null } }),
      this.db.campaigns
        .find(query, { projection: { body: 0 } })
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * CAMPAIGN_PAGE_SIZE)
        .limit(CAMPAIGN_PAGE_SIZE)
        .toArray(),
    ]);
    const counts = await this.countsByCampaign(rows.map((r) => r._id));
    return {
      page,
      pageSize: CAMPAIGN_PAGE_SIZE,
      total:
        filter === 'active'
          ? active
          : filter === 'archived'
            ? archived
            : active + archived,
      filter,
      counts: { active, archived },
      items: rows.map((r) => ({
        id: r._id.toHexString(),
        subject: r.subject,
        status: r.status,
        targeting: this.targetingView(r.targeting),
        createdAt: r.createdAt,
        launchedAt: r.launchedAt,
        archivedAt: r.archivedAt,
        audience: r.audience,
        results: counts.get(r._id.toHexString()) ?? this.emptyCounts(),
      })),
    };
  }

  async detail(campaignId: string) {
    const campaign = await this.requireCampaign(this.objectId(campaignId));
    const people = await this.emails([
      campaign.createdBy,
      campaign.updatedBy,
      ...(campaign.launchedBy ? [campaign.launchedBy] : []),
      ...(campaign.archivedBy ? [campaign.archivedBy] : []),
    ]);
    const organizations =
      campaign.targeting.mode === 'selected'
        ? await this.collection('organizations')
            .find(
              { _id: { $in: campaign.targeting.organizationIds } },
              { projection: { name: 1, status: 1 } },
            )
            .toArray()
        : [];
    const counts = await this.countsByCampaign([campaign._id]);
    return {
      id: campaign._id.toHexString(),
      status: campaign.status,
      subject: campaign.subject,
      body: campaign.body,
      revision: campaign.revision,
      targeting: this.targetingView(campaign.targeting),
      organizations: organizations.map((o) => ({
        id: String(o._id),
        name: String(o.name),
        status: String(o.status),
      })),
      createdAt: campaign.createdAt,
      createdBy: people.get(campaign.createdBy.toHexString()) ?? null,
      updatedAt: campaign.updatedAt,
      launchedAt: campaign.launchedAt,
      launchedBy: campaign.launchedBy
        ? (people.get(campaign.launchedBy.toHexString()) ?? null)
        : null,
      archivedAt: campaign.archivedAt,
      archivedBy: campaign.archivedBy
        ? (people.get(campaign.archivedBy.toHexString()) ?? null)
        : null,
      audience: campaign.audience,
      results: counts.get(campaign._id.toHexString()) ?? this.emptyCounts(),
      sending: {
        enabled: isMarketingEmailsEnabled(),
        configured: campaignSendConfig() !== null,
      },
    };
  }

  /** E-mail tel qu'il partira (lien de désabonnement d'exemple). */
  async preview(campaignId: string, locale: 'fr' | 'en') {
    const campaign = await this.requireCampaign(this.objectId(campaignId));
    const origin = campaignSendConfig()?.appOrigin ?? 'https://…';
    return buildCampaignEmail({
      subject: campaign.subject,
      body: campaign.body,
      locale,
      unsubscribeUrl: `${origin}/auth/unsubscribe?token=…`,
    });
  }

  /**
   * ESTIMATION du nombre de destinataires à cet instant (accord actuel pour
   * l'adresse actuelle, adresse vérifiée, membre actif d'un commerce actif
   * ciblé ; un utilisateur compté une fois). Ce n'est PAS une autorisation :
   * l'audience est constituée progressivement à partir du lancement, puis
   * figée, et chaque envoi revérifie.
   */
  async estimate(campaignId: string) {
    const campaign = await this.requireCampaign(this.objectId(campaignId));
    let count = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.consentPage(cursor, null);
      if (page.length === 0) break;
      for (const state of page) {
        if (
          await this.deliveries.isInAudience(
            state.userId,
            state.addressSha256,
            campaign.targeting,
            null,
          )
        ) {
          count += 1;
        }
      }
      cursor = page[page.length - 1]._id;
    }
    return { estimated: count, at: this.runtime.clock() };
  }

  async results(campaignId: string, page = 1) {
    const campaign = await this.requireCampaign(this.objectId(campaignId));
    const [total, rows] = await Promise.all([
      this.db.campaignDeliveries.countDocuments({ campaignId: campaign._id }),
      this.db.campaignDeliveries
        .find(
          { campaignId: campaign._id },
          // Aucune adresse ni identité exposée : statut et dates seulement.
          {
            projection: {
              status: 1,
              reason: 1,
              attempts: 1,
              updatedAt: 1,
              completedAt: 1,
              uncertainAt: 1,
            },
          },
        )
        .sort({ _id: 1 })
        .skip((page - 1) * CAMPAIGN_RESULTS_PAGE_SIZE)
        .limit(CAMPAIGN_RESULTS_PAGE_SIZE)
        .toArray(),
    ]);
    return {
      page,
      pageSize: CAMPAIGN_RESULTS_PAGE_SIZE,
      total,
      items: rows.map((d) => ({
        id: d._id.toHexString(),
        status: d.status,
        reason: d.reason,
        attempts: d.attempts,
        uncertain: d.uncertainAt !== null,
        updatedAt: d.updatedAt,
        completedAt: d.completedAt,
      })),
    };
  }

  // ─── Lancement ──────────────────────────────────────────────────────────

  async launch(
    context: PlatformAdminRequestContext,
    intent: CampaignLaunchIntent,
    stepUpToken: string,
  ) {
    await this.require(context, 'platform.campaigns.send', 'campaign_launch');
    const id = this.objectId(intent.campaignId);
    // Rejeu (réponse perdue) AVANT toute preuve : résultat existant.
    const replayed = await this.replay(intent);
    if (replayed) return replayed;
    await this.requireCampaign(id);
    let stepUp: PlatformAdminChallengeDoc;
    try {
      stepUp = await this.admin.findBoundStepUp(context, stepUpToken, intent);
    } catch (error) {
      const committed = await this.replay(intent);
      if (committed) return committed;
      await this.deny(context, 'campaign_launch', id, 'step_up');
      throw error;
    }
    const now = this.runtime.clock();
    try {
      await this.inTransaction(async (txn) => {
        if (!(await this.admin.consumeStepUpIn(stepUp, now, txn))) {
          throw adminStepUpRequired();
        }
        const campaign = await this.db.campaigns.findOne(
          { _id: id },
          { session: txn },
        );
        if (!campaign || !this.matchesIntent(campaign, intent)) {
          throw adminStateChanged();
        }
        if (campaign.targeting.mode === 'selected') {
          const found = await this.collection('organizations').countDocuments(
            { _id: { $in: campaign.targeting.organizationIds } },
            { session: txn },
          );
          if (found !== campaign.targeting.organizationIds.length) {
            throw adminStateChanged();
          }
        }
        const launched = await this.db.campaigns.updateOne(
          { _id: id, status: 'draft', revision: intent.revision },
          {
            $set: {
              status: 'launched',
              launchedAt: now,
              launchedBy: context.user!._id,
              launchOperationId: intent.operationId,
              audience: {
                status: 'preparing',
                cursor: null,
                total: 0,
                leaseUntil: new Date(
                  now.getTime() + CAMPAIGN_CONSTITUTION_LEASE_MS,
                ),
                frozenAt: null,
                incomplete: false,
              },
            },
          },
          { session: txn },
        );
        if (launched.matchedCount !== 1) throw adminStateChanged();
        await this.admin.auditInTransaction(txn, {
          ...this.auditEntry(context, 'campaign_launch', id, {
            revision: intent.revision,
            targeting: this.targetingLabel(campaign.targeting),
            contentHash: actionContentHash(intent).slice(0, 16),
          }),
          capability: 'platform.campaigns.send',
          operationId: intent.operationId,
        });
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === DUPLICATE_KEY) {
        const committed = await this.replay(intent);
        if (committed) return committed;
        throw adminOperationConflict();
      }
      if (
        (error as { response?: { code?: string } }).response?.code ===
        PlatformAdminErrorCode.STEP_UP_REQUIRED
      ) {
        const committed = await this.replay(intent);
        if (committed) return committed;
      }
      await this.deny(context, 'campaign_launch', id, 'state_changed');
      throw error;
    }
    // Constitution de l'audience À CET INSTANT, page par page, puis gel.
    // Une interruption laisse l'audience partielle, close à l'expiration
    // du bail (jamais complétée plus tard).
    try {
      await this.deliveries.constituteAudience(id);
    } catch {
      // Lancement validé : l'état de l'audience est visible dans le suivi.
    }
    this.deliveries.kick();
    return {
      operationId: intent.operationId,
      campaignId: intent.campaignId,
      replayed: false,
      launchedAt: now,
    };
  }

  /** Même identifiant d'opération : même campagne et même contenu exigés. */
  private async replay(intent: CampaignLaunchIntent) {
    const existing = await this.db.campaigns.findOne({
      launchOperationId: intent.operationId,
    });
    if (!existing) return null;
    if (
      existing._id.toHexString() !== intent.campaignId ||
      existing.revision !== intent.revision ||
      !this.matchesIntent(existing, intent)
    ) {
      throw adminOperationConflict();
    }
    return {
      operationId: intent.operationId,
      campaignId: intent.campaignId,
      replayed: true,
      launchedAt: existing.launchedAt,
    };
  }

  private matchesIntent(
    campaign: PlatformCampaignDoc,
    intent: CampaignLaunchIntent,
  ): boolean {
    const targeting = this.targetingView(campaign.targeting);
    return (
      campaign.revision === intent.revision &&
      campaign.subject === intent.subject &&
      campaign.body === intent.body &&
      JSON.stringify(targeting) === JSON.stringify(intent.targeting)
    );
  }

  // ─── Archivage ──────────────────────────────────────────────────────────

  /**
   * Archivage réversible : masque la campagne de la liste principale. Ne
   * supprime ni livraison, ni preuve, ni audit, et n'arrête aucune
   * livraison. Idempotent (audit seulement si l'état change).
   */
  async setArchived(
    context: PlatformAdminRequestContext,
    campaignId: string,
    archived: boolean,
  ) {
    const action = archived ? 'campaign_archive' : 'campaign_restore';
    await this.require(context, 'platform.campaigns.manage', action);
    const id = this.objectId(campaignId);
    await this.requireCampaign(id);
    const now = this.runtime.clock();
    let changed = false;
    await this.inTransaction(async (txn) => {
      const updated = await this.db.campaigns.updateOne(
        { _id: id, archivedAt: archived ? null : { $ne: null } },
        {
          $set: archived
            ? { archivedAt: now, archivedBy: context.user!._id }
            : { archivedAt: null, archivedBy: null },
        },
        { session: txn },
      );
      changed = updated.modifiedCount === 1;
      if (changed) {
        await this.admin.auditInTransaction(
          txn,
          this.auditEntry(context, action, id, {}),
        );
      }
    });
    return { archived, changed };
  }

  // ─── Outils ─────────────────────────────────────────────────────────────

  private async validDraft(input: CampaignDraftInput): Promise<{
    subject: string;
    body: string;
    targeting: CampaignTargeting;
  }> {
    const subject = messageText(
      input.subject,
      'subject',
      CAMPAIGN_SUBJECT_MAX_LENGTH,
    );
    const body = messageText(input.body, 'body', CAMPAIGN_BODY_MAX_LENGTH);
    const canonical = campaignTargeting(input.targeting);
    if (canonical.mode === 'all') {
      return { subject, body, targeting: { mode: 'all' } };
    }
    const ids = canonical.organizationIds.map((o) => new Types.ObjectId(o));
    const found = await this.collection('organizations').countDocuments({
      _id: { $in: ids },
    });
    if (found !== ids.length) throw this.notFound();
    return {
      subject,
      body,
      targeting: { mode: 'selected', organizationIds: ids },
    };
  }

  private targetingView(
    targeting: CampaignTargeting,
  ): CampaignLaunchIntent['targeting'] {
    return targeting.mode === 'all'
      ? { mode: 'all' }
      : {
          mode: 'selected',
          organizationIds: targeting.organizationIds
            .map((o) => o.toHexString())
            .sort(),
        };
  }

  private targetingLabel(targeting: CampaignTargeting): string {
    return targeting.mode === 'all'
      ? 'all'
      : `selected:${targeting.organizationIds.length}`;
  }

  /** Accords en vigueur, par pages, triés par `_id` (après `cursor`). */
  async consentPage(cursor: string | null, before: Date | null) {
    return this.collection(MARKETING_CONSENTS_COLLECTION)
      .find(
        {
          granted: true,
          ...(cursor ? { _id: { $gt: cursor } } : {}),
          ...(before ? { changedAt: { $lte: before } } : {}),
        } as never,
        { projection: { userId: 1, addressSha256: 1 } },
      )
      .sort({ _id: 1 })
      .limit(200)
      .toArray() as unknown as Promise<
      Array<{ _id: string; userId: Types.ObjectId; addressSha256: string }>
    >;
  }

  private emptyCounts() {
    return Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as Record<
      (typeof DELIVERY_STATUSES)[number],
      number
    >;
  }

  private async countsByCampaign(ids: Types.ObjectId[]) {
    const out = new Map<
      string,
      ReturnType<PlatformCampaignsService['emptyCounts']>
    >();
    if (ids.length === 0) return out;
    const grouped = await this.db.campaignDeliveries
      .aggregate<{ _id: { c: Types.ObjectId; s: string }; n: number }>([
        { $match: { campaignId: { $in: ids } } },
        { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } },
      ])
      .toArray();
    for (const g of grouped) {
      const key = g._id.c.toHexString();
      const counts = out.get(key) ?? this.emptyCounts();
      if (g._id.s in counts) {
        counts[g._id.s as keyof typeof counts] = g.n;
      }
      out.set(key, counts);
    }
    return out;
  }

  private async emails(ids: Types.ObjectId[]) {
    const users = await this.collection('users')
      .find({ _id: { $in: ids } }, { projection: { email: 1 } })
      .toArray();
    return new Map(users.map((u) => [String(u._id), String(u.email)]));
  }

  private async require(
    context: PlatformAdminRequestContext,
    capability: 'platform.campaigns.manage' | 'platform.campaigns.send',
    action: AuditEntryInput['action'],
  ) {
    try {
      this.admin.requireCapability(context, capability);
    } catch (error) {
      await this.admin.auditOutside({
        actorType: 'admin',
        actorUserId: context.user?._id ?? null,
        action,
        outcome: 'denied',
        capability,
        targetType: 'campaign',
        detail: 'capability',
        sessionId: context.session?._id ?? null,
        clientKeyHash: context.clientKeyHash,
      });
      throw error;
    }
  }

  private async deny(
    context: PlatformAdminRequestContext,
    action: AuditEntryInput['action'],
    campaignId: Types.ObjectId,
    detail: string,
  ) {
    await this.admin.auditOutside({
      actorType: 'admin',
      actorUserId: context.user?._id ?? null,
      action,
      outcome: 'denied',
      capability: 'platform.campaigns.send',
      targetType: 'campaign',
      targetId: campaignId.toHexString(),
      detail,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    });
  }

  /** Audit sans sujet ni texte de la campagne. */
  private auditEntry(
    context: PlatformAdminRequestContext,
    action: AuditEntryInput['action'],
    campaignId: Types.ObjectId,
    after: Record<string, string | number>,
  ): AuditEntryInput {
    return {
      actorType: 'admin',
      actorUserId: context.user!._id,
      action,
      outcome: 'success',
      capability:
        action === 'campaign_launch'
          ? 'platform.campaigns.send'
          : 'platform.campaigns.manage',
      targetType: 'campaign',
      targetId: campaignId.toHexString(),
      before: null,
      after,
      sessionId: context.session?._id ?? null,
      clientKeyHash: context.clientKeyHash,
    };
  }

  private objectId(id: string): Types.ObjectId {
    if (!/^[0-9a-f]{24}$/.test(id)) throw this.notFound();
    return new Types.ObjectId(id);
  }

  private async requireCampaign(id: Types.ObjectId) {
    const campaign = await this.db.campaigns.findOne({ _id: id });
    if (!campaign) throw this.notFound();
    return campaign;
  }

  private notFound() {
    return new NotFoundException({
      code: PlatformAdminErrorCode.NOT_FOUND,
      message: 'Introuvable.',
    });
  }

  private notEditable() {
    return new ConflictException({
      code: PlatformAdminErrorCode.CAMPAIGN_NOT_EDITABLE,
      message:
        'Campagne déjà lancée ou modifiée entre-temps : rechargez-la avant de continuer.',
    });
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
