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
import { recipientLocale } from '../common/i18n/locale';
import {
  MembershipStatus,
  OrganizationStatus,
} from '../organizations/permissions';
import {
  MarketingConsentService,
  addressFingerprint,
} from '../marketing-consent/marketing-consent.service';
import {
  deriveUnsubscribeToken,
  unsubscribeLinks,
  unsubscribeTokenHash,
} from '../marketing-consent/marketing-unsubscribe';
import { MARKETING_CONSENTS_COLLECTION } from '../marketing-consent/schemas/marketing-consent.schema';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import type {
  CampaignTargeting,
  PlatformCampaignDeliveryDoc,
  PlatformCampaignDoc,
} from './platform-admin-store';
import {
  MESSAGE_MAX_ATTEMPTS,
  MESSAGE_SEND_LOCK_MS,
  MESSAGE_UNCERTAIN_RETRY_WINDOW_MS,
  classifyEmailFailure,
  retryDelayMs,
} from './platform-message-policy';
import {
  CAMPAIGN_AUDIENCE_PAGE,
  CAMPAIGN_DELIVERY_BATCH,
  CAMPAIGN_POLL_INTERVAL_MS,
  CAMPAIGN_SEND_INTERVAL_MS,
  campaignEmailIdempotencyKey,
  campaignSendConfig,
  isMarketingEmailsEnabled,
  type CampaignSendConfig,
} from './platform-campaign-policy';
import { buildCampaignEmail } from './platform-campaign-email';

type DeliveryStatus = PlatformCampaignDeliveryDoc['status'];
type Final = Exclude<DeliveryStatus, 'pending' | 'sending'>;

/** Pause entre deux appels au prestataire ; remplacée par les tests. */
export const CAMPAIGN_SLEEP = Symbol('CAMPAIGN_SLEEP');
export type CampaignSleep = (ms: number) => Promise<void>;

/**
 * Traitement de fond des campagnes (mono-instance), séparé de celui des
 * messages de service : une campagne ne bloque jamais leurs envois.
 *
 * 1. Audience : constituée progressivement à partir du lancement (pages
 *    bornées, éligibilité évaluée au moment de chaque page), puis figée ;
 *    une livraison par utilisateur (index unique : membre de plusieurs
 *    commerces = une seule livraison). Le traitement de fond ne la
 *    complète jamais : il close seulement une constitution interrompue.
 * 2. Livraisons (seulement si `MARKETING_EMAILS_ENABLED=true` et la
 *    configuration complète) : réservation conditionnelle et verrou,
 *    éligibilité RELUE juste avant chaque tentative
 *    (`MarketingConsentService.emailEligibility` + ciblage), adresse figée au
 *    premier envoi (jamais une autre ensuite), première tentative persistée
 *    AVANT l'appel, clé d'idempotence stable liée à l'adresse, renvoi d'un
 *    résultat incertain seulement avec la même clé et dans la fenêtre du
 *    prestataire, débit borné.
 *
 * Journal : identifiants et motifs courts seuls (jamais d'adresse, de
 * contenu, de jeton ni de réponse du prestataire).
 */
@Injectable()
export class PlatformCampaignDeliveryService implements OnApplicationShutdown {
  private readonly logger = new Logger('PlatformCampaigns');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private halting = false;
  private intervalMs = CAMPAIGN_POLL_INTERVAL_MS;
  private passChain: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    private readonly runtime: PlatformAdminRuntime,
    private readonly consent: MarketingConsentService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(CAMPAIGN_SLEEP) private readonly sleep: CampaignSleep,
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

  start(intervalMs: number = CAMPAIGN_POLL_INTERVAL_MS): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halting = false;
    this.intervalMs = intervalMs;
    this.schedule(0);
  }

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
      .catch(() => this.logger.warn('Passe des campagnes interrompue.'))
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
  runOnce(): Promise<{ prepared: number; processed: number; more: boolean }> {
    const pass = this.passChain.then(() => this.pass());
    this.passChain = pass.catch(() => undefined);
    return pass;
  }

  private async pass() {
    // Aucune évaluation d'audience ici : seulement la clôture des
    // constitutions interrompues.
    const prepared = await this.closeExpiredConstitutions();
    // Interrupteur et configuration relus à CHAQUE passe.
    const config = campaignSendConfig();
    if (!isMarketingEmailsEnabled() || !config || !this.sender.isConfigured()) {
      return { prepared, processed: 0, more: prepared > 0 };
    }
    const now = this.runtime.clock();
    const due = await this.db.campaignDeliveries
      .find(
        {
          $or: [
            { status: 'pending', nextAttemptAt: { $lte: now } },
            { status: 'sending', lockedUntil: { $lte: now } },
          ],
        },
        { projection: { _id: 1 } },
      )
      .sort({ nextAttemptAt: 1 })
      .limit(CAMPAIGN_DELIVERY_BATCH)
      .toArray();
    let processed = 0;
    for (const { _id } of due) {
      if (this.halting || !isMarketingEmailsEnabled()) break;
      if ((await this.processOne(_id, config)) !== null) processed += 1;
    }
    return {
      prepared,
      processed,
      more: prepared > 0 || due.length === CAMPAIGN_DELIVERY_BATCH,
    };
  }

  // ─── Audience ───────────────────────────────────────────────────────────
  //
  // 1. CONSTITUTION, progressive à partir du lancement (`constituteAudience`,
  //    appelée par la requête de lancement juste après sa transaction) :
  //    accords parcourus par pages bornées ; pour chacun, l'éligibilité
  //    COURANTE est évaluée au moment où sa page est examinée (accord pour l'adresse actuelle, adresse vérifiée, membre
  //    actif d'un commerce actif ciblé). Les dates (`changedAt`,
  //    `createdAt` ≤ lancement) ne sont que des bornes complémentaires,
  //    jamais un instantané d'éligibilité.
  // 2. GEL : dès la dernière page, l'audience est close (`frozenAt`). Si la
  //    constitution est interrompue, le traitement de fond la close à
  //    l'expiration de son bail SANS évaluer personne de plus
  //    (`incomplete`) : aucune évaluation tardive, personne n'est ajouté
  //    après le lancement.
  // 3. REVÉRIFICATION avant chaque envoi (`deliver`) : un membre de
  //    l'audience devenu inéligible est ignoré.

  /**
   * Constitution complète, page par page (aucune transaction globale,
   * aucun chargement intégral). S'arrête à l'expiration du bail. Rejouable
   * sans doublon (index unique `{campaignId, userId}`).
   */
  async constituteAudience(campaignId: Types.ObjectId): Promise<void> {
    for (;;) {
      const campaign = await this.db.campaigns.findOne({
        _id: campaignId,
        status: 'launched',
        'audience.status': 'preparing',
      });
      if (!campaign) return;
      if (
        campaign.audience.leaseUntil &&
        campaign.audience.leaseUntil.getTime() <= this.runtime.clock().getTime()
      ) {
        await this.closeAudience(campaign._id, true);
        return;
      }
      await this.prepareStep(campaign);
    }
  }

  /**
   * Constitutions interrompues (bail expiré) : closes telles quelles,
   * marquées incomplètes. Aucune nouvelle évaluation.
   */
  async closeExpiredConstitutions(): Promise<number> {
    const result = await this.db.campaigns.updateMany(
      {
        status: 'launched',
        'audience.status': 'preparing',
        'audience.leaseUntil': { $lte: this.runtime.clock() },
      },
      {
        $set: {
          'audience.status': 'ready',
          'audience.frozenAt': this.runtime.clock(),
          'audience.incomplete': true,
        },
      },
    );
    return result.modifiedCount;
  }

  private async closeAudience(
    campaignId: Types.ObjectId,
    incomplete: boolean,
  ): Promise<void> {
    await this.db.campaigns.updateOne(
      { _id: campaignId, 'audience.status': 'preparing' },
      {
        $set: {
          'audience.status': 'ready',
          'audience.frozenAt': this.runtime.clock(),
          'audience.incomplete': incomplete,
        },
      },
    );
  }

  private async prepareStep(campaign: PlatformCampaignDoc): Promise<void> {
    const launchedAt = campaign.launchedAt!;
    const page = (await this.collection(MARKETING_CONSENTS_COLLECTION)
      .find(
        {
          granted: true,
          changedAt: { $lte: launchedAt },
          ...(campaign.audience.cursor
            ? { _id: { $gt: campaign.audience.cursor } }
            : {}),
        } as never,
        { projection: { userId: 1, addressSha256: 1 } },
      )
      .sort({ _id: 1 })
      .limit(CAMPAIGN_AUDIENCE_PAGE)
      .toArray()) as unknown as Array<{
      _id: string;
      userId: Types.ObjectId;
      addressSha256: string;
    }>;
    const now = this.runtime.clock();
    const rows: PlatformCampaignDeliveryDoc[] = [];
    for (const state of page) {
      if (
        await this.isInAudience(
          state.userId,
          state.addressSha256,
          campaign.targeting,
          launchedAt,
        )
      ) {
        rows.push({
          _id: new Types.ObjectId(),
          campaignId: campaign._id,
          userId: state.userId,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          lockedUntil: null,
          firstAttemptAt: null,
          uncertainAt: null,
          snapshot: null,
          reason: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const last = page.length > 0 ? page[page.length - 1]._id : null;
    const done = page.length < CAMPAIGN_AUDIENCE_PAGE;
    await this.commitPage(campaign, rows, last, done);
  }

  /**
   * Validation ATOMIQUE d'une page (transaction courte, jamais sur toute
   * l'audience) :
   *
   * 1. écriture conditionnelle RÉELLE sur le document campagne : audience
   *    encore `preparing`, curseur attendu (identité de l'étape : une seule
   *    validation par position), bail non expiré. C'est le document que
   *    modifient les deux clôtures (`closeAudience`,
   *    `closeExpiredConstitutions`) : une clôture concurrente provoque un
   *    conflit d'écriture, et la page relue après elle ne correspond plus ;
   * 2. insertion des livraisons de la page, dans la même transaction.
   *
   * Clôture gagnante : rien n'est écrit (ni livraison, ni curseur), et rien
   * ne rouvre l'audience (aucune écriture ne repasse à `preparing`). Page
   * gagnante : livraisons, curseur et total validés ensemble, puis vus par
   * la clôture suivante. Vrai si la page a été validée.
   */
  private async commitPage(
    campaign: PlatformCampaignDoc,
    rows: PlatformCampaignDeliveryDoc[],
    last: string | null,
    done: boolean,
  ): Promise<boolean> {
    const session = await this.runtime.connection.startSession();
    let committed = false;
    try {
      await session.withTransaction(async () => {
        committed = false;
        const now = this.runtime.clock();
        // Livraison déjà présente (étape d'une version antérieure, non
        // transactionnelle, interrompue) : jamais dupliquée.
        const existing =
          rows.length > 0
            ? await this.db.campaignDeliveries
                .find(
                  {
                    campaignId: campaign._id,
                    userId: { $in: rows.map((r) => r.userId) },
                  },
                  { projection: { userId: 1 }, session },
                )
                .toArray()
            : [];
        const present = new Set(existing.map((d) => d.userId.toHexString()));
        const fresh = rows.filter((r) => !present.has(r.userId.toHexString()));
        const claimed = await this.db.campaigns.updateOne(
          {
            _id: campaign._id,
            status: 'launched',
            'audience.status': 'preparing',
            'audience.cursor': campaign.audience.cursor,
            // Bail non expiré (absent : campagne antérieure au bail).
            'audience.leaseUntil': { $not: { $lte: now } },
          },
          {
            $set: {
              'audience.cursor': last ?? campaign.audience.cursor,
              // Toujours une modification réelle (conflit garanti).
              'audience.lastPageAt': now,
              // Dernière page : audience GELÉE.
              ...(done
                ? {
                    'audience.status': 'ready',
                    'audience.frozenAt': now,
                    'audience.incomplete': false,
                  }
                : {}),
            },
            $inc: { 'audience.total': fresh.length },
          },
          { session },
        );
        // Clôture, autre étape ou bail expiré : la page est abandonnée.
        if (claimed.matchedCount !== 1) return;
        if (fresh.length > 0) {
          await this.db.campaignDeliveries.insertMany(fresh, { session });
        }
        committed = true;
      });
    } finally {
      await session.endSession();
    }
    return committed;
  }

  /**
   * Utilisateur dans le ciblage : compte vérifié, accord donné pour son
   * adresse ACTUELLE, membre actif d'un commerce actif ciblé (appartenance
   * antérieure à `before` quand il est donné).
   */
  async isInAudience(
    userId: Types.ObjectId,
    consentAddressSha256: string,
    targeting: CampaignTargeting,
    before: Date | null,
  ): Promise<boolean> {
    const user = await this.collection('users').findOne(
      { _id: userId },
      { projection: { email: 1, emailVerifiedAt: 1 } },
    );
    if (!user || !user.emailVerifiedAt) return false;
    if (addressFingerprint(String(user.email)) !== consentAddressSha256) {
      return false;
    }
    return this.inTargetedOrganization(userId, targeting, before);
  }

  private async inTargetedOrganization(
    userId: Types.ObjectId,
    targeting: CampaignTargeting,
    before: Date | null,
  ): Promise<boolean> {
    const memberships = await this.collection('organizationmemberships')
      .find(
        {
          userId,
          status: MembershipStatus.ACTIVE,
          ...(targeting.mode === 'selected'
            ? { organizationId: { $in: targeting.organizationIds } }
            : {}),
          // Appartenance antérieure au lancement (documents anciens sans
          // date : acceptés, ils précèdent forcément le lancement).
          ...(before
            ? {
                $or: [
                  { createdAt: { $lte: before } },
                  { createdAt: { $exists: false } },
                ],
              }
            : {}),
        },
        { projection: { organizationId: 1 } },
      )
      .toArray();
    if (memberships.length === 0) return false;
    const active = await this.collection('organizations').countDocuments({
      _id: { $in: memberships.map((m) => m.organizationId as Types.ObjectId) },
      status: OrganizationStatus.ACTIVE,
    });
    return active > 0;
  }

  // ─── Une livraison ──────────────────────────────────────────────────────

  private async processOne(
    deliveryId: Types.ObjectId,
    config: CampaignSendConfig,
  ): Promise<Exclude<DeliveryStatus, 'sending'> | null> {
    const now = this.runtime.clock();
    const lockedUntil = new Date(now.getTime() + MESSAGE_SEND_LOCK_MS);
    const before = await this.db.campaignDeliveries.findOneAndUpdate(
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
    const delivery: PlatformCampaignDeliveryDoc = {
      ...before,
      status: 'sending',
      lockedUntil,
      attempts: before.attempts + 1,
    };
    // Traitement interrompu APRÈS l'appel : le prestataire a pu accepter.
    const interrupted =
      before.status === 'sending' && before.firstAttemptAt !== null;
    const uncertainAt = delivery.uncertainAt ?? (interrupted ? now : null);
    const attempt = { called: false };
    try {
      return await this.deliver(delivery, uncertainAt, now, config, attempt);
    } catch {
      // Erreur interne : reprise bornée. Après un appel au prestataire,
      // l'e-mail a pu être accepté : incertitude et fenêtre conservées.
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

  private async deliver(
    delivery: PlatformCampaignDeliveryDoc,
    uncertainAt: Date | null,
    now: Date,
    config: CampaignSendConfig,
    attempt: { called: boolean },
  ) {
    // Une incertitude n'est jamais requalifiée en échec ou en « ignoré ».
    const final = (status: 'failed' | 'skipped', reason: string) =>
      this.finish(delivery, uncertainAt ? 'uncertain' : status, reason, now, {
        uncertainAt,
      });
    const campaign = await this.db.campaigns.findOne({
      _id: delivery.campaignId,
      status: 'launched',
    });
    if (!campaign) return final('failed', 'campaign_missing');

    // Éligibilité RELUE juste avant la tentative : accord actuel pour
    // l'adresse actuelle, adresse vérifiée, commerce actif ; puis ciblage.
    const userId = delivery.userId.toHexString();
    const eligibility = await this.consent.emailEligibility(userId);
    if (!eligibility.eligible) {
      return final('skipped', eligibility.reasons[0] ?? 'ineligible');
    }
    if (
      !(await this.inTargetedOrganization(
        delivery.userId,
        campaign.targeting,
        campaign.launchedAt,
      ))
    ) {
      return final('skipped', 'not_targeted');
    }
    const user = await this.collection('users').findOne(
      { _id: delivery.userId },
      { projection: { email: 1, locale: 1 } },
    );
    if (!user) return final('skipped', 'account_missing');
    const address = addressFingerprint(String(user.email));
    // Jamais une autre adresse que celle figée au premier envoi.
    if (delivery.snapshot && delivery.snapshot.addressSha256 !== address) {
      return final('skipped', 'address_changed');
    }
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
    // Secret changé depuis le premier envoi : le lien (donc le contenu)
    // différerait ; aucune reprise.
    if (
      delivery.snapshot &&
      delivery.snapshot.unsubscribeKeyId !== config.unsubscribeKey.keyId
    ) {
      return final('failed', 'unsubscribe_key_changed');
    }
    const snapshot = delivery.snapshot ?? {
      to: String(user.email),
      addressSha256: address,
      locale: recipientLocale(user.locale),
      unsubscribeKeyId: config.unsubscribeKey.keyId,
    };
    const firstAttemptAt = delivery.firstAttemptAt ?? now;
    // Persisté AVANT l'appel : destinataire figé, début de fenêtre.
    const saved = await this.db.campaignDeliveries.updateOne(
      {
        _id: delivery._id,
        status: 'sending',
        lockedUntil: delivery.lockedUntil,
      },
      { $set: { snapshot, firstAttemptAt, uncertainAt } },
    );
    if (saved.matchedCount === 0) return null;
    const token = deriveUnsubscribeToken(
      config.unsubscribeKey,
      delivery._id.toHexString(),
      snapshot.addressSha256,
    );
    // Haché enregistré AVANT l'envoi : le lien fonctionne dès réception.
    await this.consent.registerUnsubscribeToken({
      tokenHash: unsubscribeTokenHash(token),
      userId: delivery.userId,
      addressSha256: snapshot.addressSha256,
      locale: snapshot.locale,
      campaignId: campaign._id,
      deliveryId: delivery._id,
      now,
    });
    const links = unsubscribeLinks(config.appOrigin, token);
    const email = buildCampaignEmail({
      subject: campaign.subject,
      body: campaign.body,
      locale: snapshot.locale,
      unsubscribeUrl: links.page,
    });
    await this.pace();
    // Interrupteur relu au dernier moment : arrêté → aucun appel.
    if (!isMarketingEmailsEnabled()) {
      // Pause : la réservation ne compte pas comme une tentative.
      return this.write(delivery, 'pending', 'paused', {
        attempts: delivery.attempts - 1,
        nextAttemptAt: now,
        updatedAt: now,
      });
    }
    attempt.called = true;
    try {
      await this.sender.send({
        to: snapshot.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: {
          'List-Unsubscribe': `<${links.oneClick}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        idempotencyKey: campaignEmailIdempotencyKey(
          campaign._id.toHexString(),
          delivery._id.toHexString(),
          snapshot.addressSha256,
        ),
      });
    } catch (error) {
      const { outcome, reason } = classifyEmailFailure(error);
      this.logger.warn(
        `Livraison de campagne ${delivery._id.toHexString()} non confirmée : ${reason}.`,
      );
      if (outcome === 'failed') return final('failed', reason);
      return this.reschedule(
        delivery,
        reason,
        outcome === 'unknown' ? (uncertainAt ?? now) : uncertainAt,
        now,
        firstAttemptAt.getTime() + MESSAGE_UNCERTAIN_RETRY_WINDOW_MS,
      );
    }
    return this.finish(delivery, 'accepted', null, now, { uncertainAt });
  }

  /** Débit borné : intervalle minimal entre deux appels au prestataire. */
  private async pace(): Promise<void> {
    const wait = this.lastCallAt + CAMPAIGN_SEND_INTERVAL_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = Date.now();
  }

  private reschedule(
    delivery: PlatformCampaignDeliveryDoc,
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
    delivery: PlatformCampaignDeliveryDoc,
    status: Final,
    reason: string | null,
    now: Date,
    extra: Partial<Pick<PlatformCampaignDeliveryDoc, 'uncertainAt'>> = {},
  ) {
    return this.write(delivery, status, reason, {
      ...extra,
      completedAt: now,
      updatedAt: now,
    });
  }

  /** Écriture conditionnée à NOTRE réservation (jamais celle d'un autre). */
  private async write(
    delivery: PlatformCampaignDeliveryDoc,
    status: Exclude<DeliveryStatus, 'sending'>,
    reason: string | null,
    fields: Partial<PlatformCampaignDeliveryDoc>,
  ): Promise<Exclude<DeliveryStatus, 'sending'> | null> {
    const result = await this.db.campaignDeliveries.updateOne(
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
