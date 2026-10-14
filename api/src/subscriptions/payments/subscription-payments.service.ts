import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from '../subscriptions.service';
import {
  SubscriptionSource,
  SubscriptionTerm,
  TERM_MONTHS,
} from '../subscription-terms';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from '../schemas/subscription-period.schema';
import {
  Organization,
  OrganizationDocument,
} from '../../organizations/schemas/organization.schema';
import {
  SUBSCRIPTION_PRICING_CURRENCY,
  SUBSCRIPTION_PRICING_VERSION,
  SubscriptionPricingError,
  getSubscriptionPrice,
  listSubscriptionPrices,
} from '../subscription-pricing';
import { SUBSCRIPTION_CLOCK } from '../subscription-clock';
import { SubscriptionSignalsService } from '../subscription-signals.service';
import { PushOutboxService } from '../../push/push-outbox.service';
import type { SubscriptionClock } from '../subscription-clock';
import {
  COLLECTED_CONFLICT_INCIDENTS,
  OPEN_PAYMENT_STATUSES,
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentIncident,
  SubscriptionPaymentStatus,
} from './schemas/subscription-payment.schema';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_CURRENCY,
  PAYMENT_PROVIDER,
  PaymentInitiationResult,
  PaymentProviderInconsistencyError,
  PaymentProviderUnavailableError,
  confirmationProviderFor,
} from './payment-provider';
import type {
  PaymentProvider,
  PaymentStatusLookup,
  ProviderPaymentStatus,
} from './payment-provider';
import {
  computePaymentRequestFingerprint,
  derivePaymentFingerprintKey,
  maskPayerPhone,
  merchantReferenceFor,
  normalizePayerPhone,
  paymentGrantReference,
} from './payment-request';
import { subscriptionPaymentDuplicateKeyIndex } from './subscription-payment-indexes';
import { paymentConcordanceMismatches } from './payment-concordance';
import type { MongooseSession } from '../subscriptions.service';
import {
  invalidPayerPhone,
  paymentAlreadyPending,
  paymentChangeUnavailable,
  paymentConfirmationPending,
  paymentNotFound,
  paymentOperationConflict,
  paymentRateLimited,
  paymentReceiptUnavailable,
  paymentServiceUnavailable,
  paymentStatusUnavailable,
} from './payment-errors';
import type { PaymentCallPermit } from './payment-call-budget';
import {
  PAYMENT_HISTORY_DEFAULT_LIMIT,
  PAYMENT_HISTORY_MAX_LIMIT,
} from './dto/subscription-payment.dto';

/**
 * Budget GLOBAL (ms) de la phase transactionnelle d'une confirmation :
 * reprises applicatives (≤ 5) ET reprises automatiques du driver comprises.
 */
export const PAYMENT_CONFIRMATION_BUDGET_MS = 30_000;

/**
 * 1-21B — Origine publique du web (`PUBLIC_APP_URL` validée) pour l'URL de
 * retour d'une page de paiement hébergée ; jamais une valeur du client.
 */
export const PAYMENT_RETURN_ORIGIN = Symbol('PAYMENT_RETURN_ORIGIN');

/**
 * Page du web où revient le payeur : un retour ne prouve RIEN (le web
 * demande seulement une vérification serveur).
 */
export const PAYMENT_RETURN_PATH = '/app/organization/subscription';

/** Contexte SERVEUR de la requête (jamais le corps). */
export interface PaymentRequestContext {
  organizationId: string;
  userId: string;
}

export interface CreatePaymentInput {
  term: string;
  /**
   * 1-21B — facultatif : exigé seulement par un prestataire qui pousse la
   * collecte sur le téléphone (`requiresPayerPhone`) ; ignoré sinon.
   */
  payerPhone?: string | null;
  clientOperationId: string;
  /**
   * 1-21B — compte AUTORISÉ du demandeur (lu par le contrôleur sur
   * l'utilisateur authentifié), transmis au seul prestataire qui l'exige.
   */
  payer?: { email: string; name: string };
}

/** 1-21B — moyen de paiement des NOUVELLES tentatives (jamais un secret). */
export interface PaymentCapabilities {
  available: boolean;
  method: 'hosted-checkout' | 'mobile-money' | null;
  /**
   * 1-21D — catalogue COURANT du serveur, en lecture seule : prix des
   * nouvelles tentatives (contrôle des tarifs réellement déployés). Jamais
   * une entrée : le montant d'un paiement reste fixé par la seule durée.
   */
  pricing: {
    version: number;
    currency: string;
    prices: { term: string; months: number; amount: number }[];
  };
}

/** Projection EXPLICITE exposée au propriétaire. */
export interface SubscriptionPaymentView {
  paymentId: string;
  reference: string;
  status: SubscriptionPaymentStatus;
  term: SubscriptionTerm;
  amount: number;
  currency: 'XAF';
  payerPhoneMasked: string | null;
  /**
   * 1-21B — page de paiement hébergée à rouvrir (paiement ouvert
   * seulement) ; aucun secret, aucune nouvelle session.
   */
  checkoutUrl: string | null;
  /**
   * 1-21E — fin de validité de la page hébergée (ISO), même après son
   * expiration ; `null` sans page hébergée.
   */
  checkoutExpiresAt: string | null;
  /**
   * 1-21E — durée de validité RESTANTE au moment de la réponse (ms), page
   * proposée seulement : le navigateur en déduit son échéance sans dépendre
   * de son horloge. `null` sans page proposée.
   */
  checkoutExpiresInMs: number | null;
  /** 1-21E — situation précise d'un paiement par page hébergée (voir type). */
  situation: PaymentSituation | null;
  /**
   * 1-21E — STATUT FINANCIER : encaissement confirmé par le prestataire,
   * distinct de l'attribution (`status: succeeded` = période attribuée).
   */
  collected: boolean;
  createdAt: string | null;
  initiatedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

/**
 * 1-21E — Distinctions EXPOSÉES (page hébergée seulement ; `null` sinon) :
 * - `checkout-open` : page valide, aucun paiement confirmé ;
 * - `checkout-expired` : page expirée, résultat de la tentative pas encore
 *   vérifié (aucun lien proposé ; « Vérifier » tranche) ;
 * - `checkout-link-missing` : paiement ouvert dont la page n'est pas (encore)
 *   connue (réponse perdue) ; « Vérifier » la retrouve sans en créer ;
 * - `attempt-unresolved` : page close APRÈS une transaction non réussie :
 *   SasPay ne garantit pas qu'elle ne puisse plus aboutir → rapprochement ;
 * - `closure-unconfirmed` : page close, mais l'absence de transaction n'est
 *   pas affirmée par SasPay (réponse incomplète) → rapprochement ;
 * - `checkout-closed` : page close sans aucune transaction (clos, `failed`) ;
 * - `renewal-suspended` : une tentative remplacée du même renouvellement a
 *   été encaissée ; la poursuite de celle-ci est suspendue (aucun lien) ;
 * - `collected-in-resolution` : paiement REÇU (encaissement confirmé), dont
 *   la prise en compte exige une résolution (aucune période attribuée) ;
 * - `refunded` : encaissement remboursé hors de Stock Master, consigné.
 */
export type PaymentSituation =
  | 'checkout-open'
  | 'checkout-expired'
  | 'checkout-link-missing'
  | 'attempt-unresolved'
  | 'closure-unconfirmed'
  | 'checkout-closed'
  | 'renewal-suspended'
  | 'collected-in-resolution'
  | 'refunded';

/**
 * 1-21E — Issue de « Changer de forfait » (`abandonPayment`) :
 * - `released` : page fermée chez le prestataire (ou déjà close) sans aucune
 *   transaction, paiement clos : un nouveau paiement est possible ;
 * - `succeeded` : le paiement avait abouti (période attribuée) ;
 * - `in-progress` : une transaction est en cours de validation ;
 * - `attempt-recorded` : une tentative (échouée) existe sur la page encore
 *   ouverte : la page n'est pas fermée (SasPay permet de rejouer une
 *   transaction échouée) ; le payeur peut encore finaliser sur la même page ;
 * - `awaiting-resolution` : page close après une tentative, ou paiement en
 *   vérification : rapprochement nécessaire ;
 * - `not-found-at-provider` : page introuvable chez le prestataire (réponse
 *   perdue) : jamais une preuve d'absence ;
 * - `provider-incomplete` : réponse de SasPay sans affirmation explicite de
 *   l'absence de transaction (champ manquant) : rien n'est fermé ;
 * - `cancel-unconfirmed` : fermeture demandée mais page encore ouverte à la
 *   relecture : rien n'est libéré.
 */
export type PaymentAbandonOutcome =
  | 'released'
  | 'succeeded'
  | 'in-progress'
  | 'attempt-recorded'
  | 'awaiting-resolution'
  | 'not-found-at-provider'
  | 'provider-incomplete'
  | 'cancel-unconfirmed';

/** 1-21E — Vérification serveur : vue + statut OBSERVÉ chez le prestataire. */
interface ConfirmationCheck {
  view: SubscriptionPaymentView;
  /** `null` : aucun statut lu (état local terminal, introuvable…). */
  observed: ProviderPaymentStatus | null;
}

export type PaymentRecord = SubscriptionPayment & { _id: Types.ObjectId };

/**
 * 1-21E — REÇU DE PAIEMENT (jamais une facture) : uniquement pour un
 * encaissement CONFIRMÉ côté serveur. Valeurs ENREGISTRÉES (montant débité,
 * sinon montant figé ; devise ; durée), jamais le tarif courant. Aucun
 * secret, aucun lien de paiement, aucun téléphone, aucun net marchand.
 */
export interface PaymentReceiptView {
  kind: 'payment-receipt';
  /** Référence stable : la référence marchand du paiement. */
  receiptNumber: string;
  paymentId: string;
  issuer: { name: 'Stock Master' };
  organization: { name: string };
  term: SubscriptionTerm;
  months: number;
  /** Montant payé par le client (centimes de la devise), tel qu'encaissé. */
  amountPaidMinor: number;
  currency: 'XAF';
  /** Date de l'encaissement confirmé (ISO). */
  paidAt: string;
  /** Prestataire et transaction (référence non secrète), si connue. */
  provider: string;
  providerTransactionId: string | null;
  /**
   * `applied` : période attribuée ; `in-resolution` : encaissement reçu,
   * prise en compte en attente de résolution (aucune période) ;
   * `refunded` : remboursé hors de Stock Master (aucune période).
   */
  application: 'applied' | 'in-resolution' | 'refunded';
  /** Date du remboursement consigné (ISO), sinon `null`. */
  refundedAt: string | null;
  /** Période RÉELLEMENT attribuée par ce paiement, sinon `null`. */
  period: { startsAt: string; endsAt: string } | null;
}

/** États pouvant encore aboutir à un succès VÉRIFIÉ (jamais `review`). */
const FINALIZABLE_STATUSES: readonly SubscriptionPaymentStatus[] =
  Object.freeze([...OPEN_PAYMENT_STATUSES, SubscriptionPaymentStatus.FAILED]);

const isStrictObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

/**
 * 1-21E — Encaissement CONFIRMÉ (statut financier) : enregistré depuis
 * 1-21E (`collectedAt`) ; avant, un paiement `succeeded` l'était forcément.
 */
export const isCollected = (
  payment: Pick<PaymentRecord, 'status' | 'collectedAt'>,
): boolean =>
  !!payment.collectedAt ||
  payment.status === SubscriptionPaymentStatus.SUCCEEDED;

/**
 * 1-14D.2B — Demandes de paiement d'abonnement et moteur de confirmation.
 *
 * - Initiation : demande + référence marchand PERSISTÉES avant tout effet
 *   externe ; l'insertion (index `open` et `clientOperationId`) RÉSERVE
 *   atomiquement le droit d'initier : un seul appel réseau par paiement,
 *   jamais relancé.
 * - Confirmation (`confirmPayment`) : UNIQUE point d'entrée (refresh
 *   propriétaire, webhook 1-14D.2F inactif en production, futurs scripts). Statut lu hors transaction,
 *   concordance vérifiée, puis attribution `source: payment` et marquage
 *   `succeeded` dans UNE transaction (`runInGrantTransaction`), sans réseau.
 * - Aucun échec automatique sur délai : seul un refus CONFIRMÉ par le
 *   prestataire ferme un paiement.
 * - Ne modifie jamais un rôle, une permission ni `Organization.status`.
 *
 * 1-15F — signaux temps réel (`SubscriptionSignalsService`, payload `{}`),
 * émis APRÈS l'écriture validée et seulement si elle a changé l'état
 * visible : `payments:changed` (création, `pending`, `failed`, `review`,
 * `succeeded`) et `subscription:changed` (période attribuée, après le
 * commit de `runInGrantTransaction`, jamais dans son callback rejouable).
 * Rien sur un rejeu, un refus, un rollback, une écriture conditionnelle
 * sans effet ni la seule date de consultation. Un signal ne déclenche
 * jamais de consultation du prestataire.
 */
@Injectable()
export class SubscriptionPaymentsService {
  private readonly fingerprintKey: Buffer;
  private readonly logger = new Logger('SubscriptionPayments');

  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPaymentDocument>,
    // 1-21E : reçu (nom de l'organisation, période réellement attribuée).
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<OrganizationDocument>,
    @InjectModel(SubscriptionPeriod.name)
    private readonly periodModel: Model<SubscriptionPeriodDocument>,
    private readonly subscriptions: SubscriptionsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(SUBSCRIPTION_CLOCK) private readonly clock: SubscriptionClock,
    private readonly signals: SubscriptionSignalsService,
    config: ConfigService,
    // 1-16A : optionnel (tests unitaires construits sans module push).
    @Optional() private readonly pushOutbox?: PushOutboxService,
    // 1-21B : adaptateurs des paiements déjà engagés (facultatif).
    @Optional()
    @Inject(PAYMENT_CONFIRMATION_PROVIDERS)
    private readonly confirmers?: readonly PaymentProvider[],
    // 1-21B : origine publique du web (URL de retour), jamais une requête.
    @Optional()
    @Inject(PAYMENT_RETURN_ORIGIN)
    private readonly returnOrigin?: string | null,
  ) {
    this.fingerprintKey = derivePaymentFingerprintKey(
      config.getOrThrow<string>('JWT_SECRET'),
    );
  }

  /** 1-21B — vérifications concurrentes d'un même paiement regroupées. */
  private readonly confirmations = new Map<
    string,
    Promise<ConfirmationCheck>
  >();

  /** 1-21B — moyen de paiement proposé pour une NOUVELLE tentative. */
  capabilities(): PaymentCapabilities {
    const pricing = {
      version: SUBSCRIPTION_PRICING_VERSION,
      currency: SUBSCRIPTION_PRICING_CURRENCY,
      prices: listSubscriptionPrices().map(({ term, months, amount }) => ({
        term,
        months,
        amount,
      })),
    };
    if (!this.provider.available) {
      return { available: false, method: null, pricing };
    }
    return {
      available: true,
      method:
        this.provider.requiresPayerPhone === false
          ? 'hosted-checkout'
          : 'mobile-money',
      pricing,
    };
  }

  // ─── Initiation ────────────────────────────────────────────────────────────

  async createPayment(
    context: PaymentRequestContext,
    input: CreatePaymentInput,
  ): Promise<{ payment: SubscriptionPaymentView; replayed: boolean }> {
    let price: ReturnType<typeof getSubscriptionPrice>;
    try {
      price = getSubscriptionPrice(input.term);
    } catch (error) {
      if (error instanceof SubscriptionPricingError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    // 1-21B : numéro facultatif ; s'il est fourni, il doit être valide et
    // entre dans l'empreinte (rejeu identique quel que soit le prestataire
    // actif au moment du rejeu).
    const provided =
      input.payerPhone === undefined ||
      input.payerPhone === null ||
      input.payerPhone.trim() === ''
        ? null
        : input.payerPhone;
    const payerPhone = provided === null ? null : normalizePayerPhone(provided);
    if (provided !== null && !payerPhone) throw invalidPayerPhone();

    const organizationId = new Types.ObjectId(context.organizationId);
    const requestedBy = new Types.ObjectId(context.userId);
    const clientOperationId = input.clientOperationId.toLowerCase();
    const fingerprint = computePaymentRequestFingerprint(this.fingerprintKey, {
      requestedBy: requestedBy.toHexString(),
      term: price.term,
      payerPhone: payerPhone ?? '',
    });

    // 1. Rejeu AVANT toute nouvelle initiation (aucun réseau).
    const existing = await this.findOperation(
      organizationId,
      clientOperationId,
    );
    if (existing) return this.replay(existing, requestedBy, fingerprint);

    // 2. Prestataire indisponible : aucune écriture, aucun réseau.
    if (!this.provider.available) throw paymentServiceUnavailable();
    const needsPhone = this.provider.requiresPayerPhone !== false;
    if (needsPhone && !payerPhone) throw invalidPayerPhone();
    if (!needsPhone && !input.payer) throw paymentServiceUnavailable();

    // 3. Un seul paiement ouvert par organisation.
    const open = await this.paymentModel
      .findOne({ organizationId, open: true })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (open) throw paymentAlreadyPending(String(open._id));

    // 1-22D : appel au prestataire réservé AVANT toute écriture ; un refus
    // (quota de l'organisation, capacité) ne crée ni ne ferme aucun paiement.
    return this.withOwnerCalls(
      this.provider,
      context,
      this.provider.callAdmission?.costs.initiate ?? 0,
      'create',
      () =>
        this.reserveAndInitiate(
          organizationId,
          requestedBy,
          clientOperationId,
          fingerprint,
          price,
          payerPhone,
          needsPhone,
          input.payer,
        ),
    );
  }

  /** Étapes 4 et 5 de `createPayment`, dans la réservation d'appels. */
  private async reserveAndInitiate(
    organizationId: Types.ObjectId,
    requestedBy: Types.ObjectId,
    clientOperationId: string,
    fingerprint: string,
    price: ReturnType<typeof getSubscriptionPrice>,
    payerPhone: string | null,
    needsPhone: boolean,
    payer: { email: string; name: string } | undefined,
  ): Promise<{ payment: SubscriptionPaymentView; replayed: boolean }> {
    // 4. Persistance + réservation atomique (tarif FIGÉ à cet instant).
    const _id = new Types.ObjectId();
    const merchantReference = merchantReferenceFor(_id);
    // 1-21E : même renouvellement que la dernière tentative non aboutie
    // (relation durable, écrite à l'insertion), sinon nouveau.
    const renewal = await this.renewalFor(organizationId, _id);
    try {
      await this.paymentModel.create({
        _id,
        organizationId,
        requestedBy,
        clientOperationId,
        requestFingerprint: fingerprint,
        term: price.term,
        amount: price.amount,
        currency: price.currency,
        pricingVersion: price.pricingVersion,
        provider: this.provider.name,
        merchantReference,
        providerReference: null,
        status: SubscriptionPaymentStatus.INITIATING,
        open: true,
        payerPhoneMasked:
          needsPhone && payerPhone ? maskPayerPhone(payerPhone) : null,
        renewalId: renewal.renewalId,
        replacesPaymentId: renewal.replacesPaymentId,
      });
    } catch (error) {
      const index = subscriptionPaymentDuplicateKeyIndex(error);
      if (index === 'organizationId_1_clientOperationId_1') {
        // Double clic concurrent : l'autre appel a réservé ; rejeu.
        const winner = await this.findOperation(
          organizationId,
          clientOperationId,
        );
        if (winner) return this.replay(winner, requestedBy, fingerprint);
      }
      if (
        index === 'organizationId_1_single_open_payment' ||
        // 1-21E : création concurrente qui a remplacé la même tentative.
        index === 'replacesPaymentId_1'
      ) {
        const other = await this.paymentModel
          .findOne({ organizationId, open: true })
          .select({ _id: 1 })
          .lean()
          .exec();
        throw paymentAlreadyPending(String(other?._id ?? ''));
      }
      throw error;
    }

    // 1-15F : paiement créé (écriture validée) → un signal en fin de
    // traitement, quelle que soit l'issue de l'initiation.
    try {
      return await this.initiateReserved(
        _id,
        price,
        needsPhone ? payerPhone : null,
        needsPhone ? undefined : payer,
      );
    } finally {
      this.signalPayments(organizationId);
    }
  }

  /**
   * 1-21E — Renouvellement d'une NOUVELLE tentative. Elle rejoint celui de
   * la dernière tentative de l'organisation si celle-ci est close sans
   * encaissement (page fermée, expirée, échec) et que ce renouvellement n'a
   * reçu aucune attribution automatique : elle la REMPLACE. Sinon (premier
   * paiement, renouvellement terminé, achat supplémentaire volontaire) :
   * nouveau renouvellement. Dérivé de la base seule (aucun état mémoire).
   */
  private async renewalFor(
    organizationId: Types.ObjectId,
    _id: Types.ObjectId,
  ): Promise<{
    renewalId: Types.ObjectId;
    replacesPaymentId: Types.ObjectId | null;
  }> {
    const fresh = { renewalId: _id, replacesPaymentId: null };
    const last = await this.paymentModel
      .findOne({ organizationId })
      .sort({ _id: -1 })
      .select({
        _id: 1,
        status: 1,
        open: 1,
        renewalId: 1,
        collectedAt: 1,
      })
      .lean<
        Pick<
          PaymentRecord,
          '_id' | 'status' | 'open' | 'renewalId' | 'collectedAt'
        >
      >()
      .exec();
    if (
      !last ||
      last.open ||
      last.collectedAt ||
      last.status !== SubscriptionPaymentStatus.FAILED
    ) {
      return fresh;
    }
    const renewalId = last.renewalId ?? last._id;
    const granted = await this.paymentModel
      .exists({
        $or: [
          { autoGrantRenewalId: renewalId },
          {
            renewalId,
            status: SubscriptionPaymentStatus.SUCCEEDED,
          },
        ],
      })
      .exec();
    if (granted) return fresh;
    return { renewalId, replacesPaymentId: last._id };
  }

  /** Étape 5 de `createPayment`, sur le paiement RÉSERVÉ `_id`. */
  private async initiateReserved(
    _id: Types.ObjectId,
    price: ReturnType<typeof getSubscriptionPrice>,
    payerPhone: string | null,
    payer: { email: string; name: string } | undefined,
  ): Promise<{ payment: SubscriptionPaymentView; replayed: boolean }> {
    const merchantReference = merchantReferenceFor(_id);
    const returnUrl = this.returnOrigin
      ? `${this.returnOrigin}${PAYMENT_RETURN_PATH}?payment=${_id.toHexString()}`
      : undefined;
    // 5. UN SEUL appel réseau, hors de toute transaction.
    let result: PaymentInitiationResult;
    try {
      result = await this.provider.initiate({
        merchantReference,
        amount: price.amount,
        currency: PAYMENT_CURRENCY,
        payerPhone,
        // 1-21B : page hébergée → référence aussi dans le libellé (indice
        // lisible par l'opérateur, jamais une preuve) ; CamPay inchangé.
        description: payer
          ? `Abonnement Stock Master (${price.months} mois) ${merchantReference}`
          : `Abonnement Stock Master (${price.months} mois)`,
        ...(payer ? { customer: payer } : {}),
        ...(returnUrl ? { returnUrl } : {}),
      });
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) {
        // Requête certainement non transmise : aucune collecte possible.
        await this.transition(_id, [SubscriptionPaymentStatus.INITIATING], {
          status: SubscriptionPaymentStatus.FAILED,
          open: false,
          failedAt: this.clock(),
          incidentCode: SubscriptionPaymentIncident.PROVIDER_UNAVAILABLE,
        });
        throw paymentServiceUnavailable();
      }
      // Issue inconnue : la collecte existe PEUT-ÊTRE. Paiement conservé,
      // même référence, ouvert ; jamais réinitié, jamais déclaré échoué.
      await this.transition(_id, [SubscriptionPaymentStatus.INITIATING], {
        status: SubscriptionPaymentStatus.UNCERTAIN,
        incidentCode: SubscriptionPaymentIncident.INITIATION_UNCERTAIN,
      });
      return { payment: await this.viewById(_id), replayed: false };
    }

    if (result.outcome === 'rejected') {
      await this.transition(_id, [SubscriptionPaymentStatus.INITIATING], {
        status: SubscriptionPaymentStatus.FAILED,
        open: false,
        failedAt: this.clock(),
        incidentCode: SubscriptionPaymentIncident.INITIATION_REJECTED,
      });
    } else {
      await this.recordPending(
        _id,
        result.providerReference,
        [SubscriptionPaymentStatus.INITIATING],
        {
          checkoutUrl: result.redirectUrl ?? null,
          checkoutExpiresAt: result.checkoutExpiresAt ?? null,
        },
      );
    }
    return { payment: await this.viewById(_id), replayed: false };
  }

  // ─── Lectures locales (toujours possibles, prestataire indisponible) ───────

  async getPayment(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<SubscriptionPaymentView> {
    return this.toView(await this.findScoped(context, paymentId));
  }

  async listPayments(
    context: PaymentRequestContext,
    query: { limit?: number; before?: string },
  ): Promise<{ items: SubscriptionPaymentView[]; nextCursor: string | null }> {
    const limit = Math.min(
      Math.max(query.limit ?? PAYMENT_HISTORY_DEFAULT_LIMIT, 1),
      PAYMENT_HISTORY_MAX_LIMIT,
    );
    const filter: Record<string, unknown> = {
      organizationId: new Types.ObjectId(context.organizationId),
    };
    if (query.before !== undefined) {
      if (!isStrictObjectId(query.before)) throw paymentNotFound();
      filter._id = { $lt: new Types.ObjectId(query.before) };
    }
    const rows = await this.paymentModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<PaymentRecord[]>()
      .exec();
    const page = rows.slice(0, limit);
    return {
      items: page.map((p) => this.toView(p)),
      nextCursor:
        rows.length > limit ? page[page.length - 1]._id.toHexString() : null,
    };
  }

  // ─── Reçu (1-21E) ──────────────────────────────────────────────────────────

  /**
   * 1-21E — Reçu d'un paiement ENCAISSÉ de l'organisation COURANTE (404
   * uniforme sinon ; 409 s'il n'est pas encaissé). Lecture locale seule.
   */
  async receipt(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<PaymentReceiptView> {
    const payment = await this.findScoped(context, paymentId);
    if (!isCollected(payment)) throw paymentReceiptUnavailable();
    const paidAt = payment.collectedAt ?? payment.confirmedAt;
    if (!paidAt) throw paymentReceiptUnavailable();
    const organization = await this.organizationModel
      .findById(payment.organizationId)
      .select({ name: 1 })
      .lean<{ name?: string }>()
      .exec();
    let period: PaymentReceiptView['period'] = null;
    if (
      payment.status === SubscriptionPaymentStatus.SUCCEEDED &&
      payment.periodId
    ) {
      const granted = await this.periodModel
        .findOne({
          _id: payment.periodId,
          organizationId: payment.organizationId,
        })
        .select({ startsAt: 1, endsAt: 1 })
        .lean<{ startsAt: Date; endsAt: Date }>()
        .exec();
      if (granted) {
        period = {
          startsAt: new Date(granted.startsAt).toISOString(),
          endsAt: new Date(granted.endsAt).toISOString(),
        };
      }
    }
    return {
      kind: 'payment-receipt',
      receiptNumber: payment.merchantReference,
      paymentId: payment._id.toHexString(),
      issuer: { name: 'Stock Master' },
      organization: { name: organization?.name ?? '' },
      term: payment.term,
      months: TERM_MONTHS[payment.term],
      amountPaidMinor:
        typeof payment.paidAmountMinor === 'number'
          ? payment.paidAmountMinor
          : payment.amount * 100,
      currency: payment.currency,
      paidAt: new Date(paidAt).toISOString(),
      provider: payment.provider,
      providerTransactionId: payment.providerTransactionId ?? null,
      application: payment.refundedAt
        ? 'refunded'
        : period
          ? 'applied'
          : 'in-resolution',
      refundedAt: payment.refundedAt
        ? new Date(payment.refundedAt).toISOString()
        : null,
      period,
    };
  }

  // ─── Confirmation ──────────────────────────────────────────────────────────

  /** Refresh propriétaire : paiement de l'organisation COURANTE seulement. */
  async refreshPayment(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<SubscriptionPaymentView> {
    const payment = await this.findScoped(context, paymentId);
    const provider = confirmationProviderFor(
      payment.provider,
      this.provider,
      this.confirmers,
    );
    return this.withOwnerCalls(
      provider,
      context,
      this.statusCost(payment, provider),
      'status',
      () => this.confirmPaymentShared(payment._id),
    );
  }

  /**
   * 1-22D — Action propriétaire : réserve `cost` appels au prestataire pour
   * l'organisation COURANTE (contexte serveur), exécute `work` dans cette
   * réservation, puis rend la part non utilisée. Refus : 429 (quota de
   * l'organisation) ou 503 (capacité), avec `Retry-After`, sans aucun effet.
   */
  private async withOwnerCalls<T>(
    provider: PaymentProvider | null,
    context: PaymentRequestContext,
    cost: number,
    kind: 'create' | 'status',
    work: () => Promise<T>,
  ): Promise<T> {
    const admission = provider?.callAdmission;
    if (!admission || cost <= 0) return work();
    const decision = admission.budget.reserve(context.organizationId, cost);
    if (!decision.admitted) {
      if (decision.reason === 'organization') {
        throw paymentRateLimited(decision.retryAfterSeconds);
      }
      throw kind === 'create'
        ? paymentServiceUnavailable(decision.retryAfterSeconds)
        : paymentStatusUnavailable(decision.retryAfterSeconds);
    }
    const permit: PaymentCallPermit = decision.permit;
    try {
      return await admission.budget.run(permit, work);
    } finally {
      permit.release();
    }
  }

  /** 1-22D — Appels maximaux d'une vérification (0 : état local terminal). */
  private statusCost(
    payment: PaymentRecord,
    provider: PaymentProvider | null,
  ): number {
    const costs = provider?.callAdmission?.costs;
    if (
      !costs ||
      payment.status === SubscriptionPaymentStatus.SUCCEEDED ||
      payment.status === SubscriptionPaymentStatus.REVIEW
    ) {
      return 0;
    }
    if (payment.providerReference) return costs.statusByProvider;
    return provider.supportsMerchantReferenceLookup
      ? costs.statusByMerchant
      : 0;
  }

  /**
   * Point d'entrée UNIQUE de confirmation (refresh, futurs webhook et
   * scripts). Ne fait confiance qu'au statut LU chez le prestataire et
   * vérifié contre les valeurs figées.
   *
   * - `succeeded` local → rejeu, aucun réseau, aucune nouvelle période ;
   * - `review` → inchangé (traitement opérateur) ;
   * - statut indisponible → 503, état conservé ;
   * - discordance → `review`, aucune attribution ;
   * - refus confirmé → `failed` (jamais après un succès) ;
   * - succès concordant → attribution + `succeeded`, atomiquement.
   */
  async confirmPayment(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    return (await this.checkOnce(paymentId)).view;
  }

  /**
   * 1-21B — Même confirmation, REGROUPÉE : une seule vérification en cours
   * par paiement dans ce processus (refresh, retour du payeur, webhooks
   * SasPay concurrents) ; les appels simultanés partagent son résultat et
   * n'appellent le prestataire qu'une fois. La garantie d'attribution
   * unique reste celle de la transaction (plusieurs processus).
   */
  async confirmPaymentShared(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    return (await this.checkShared(paymentId)).view;
  }

  /**
   * 1-22D — Vérification démarrée APRÈS cet appel (notification) : une
   * vérification déjà en cours a pu lire le statut avant le changement
   * notifié. Les appels concurrents partagent UNE seule relecture suivante.
   */
  async confirmPaymentFresh(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    return (await this.checkFresh(paymentId)).view;
  }

  /** Vérification regroupée (voir `confirmPaymentShared`), statut compris. */
  private checkShared(paymentId: Types.ObjectId): Promise<ConfirmationCheck> {
    const key = paymentId.toHexString();
    const running = this.confirmations.get(key);
    if (running) return running;
    const started = this.checkOnce(paymentId).finally(() => {
      this.confirmations.delete(key);
    });
    this.confirmations.set(key, started);
    return started;
  }

  /**
   * 1-21E — Vérification démarrée APRÈS cet appel : jamais le résultat d'une
   * vérification commencée avant (ex. avant la fermeture d'une page).
   */
  private async checkFresh(
    paymentId: Types.ObjectId,
  ): Promise<ConfirmationCheck> {
    const running = this.confirmations.get(paymentId.toHexString());
    if (running) await running.catch(() => undefined);
    return this.checkShared(paymentId);
  }

  private async checkOnce(
    paymentId: Types.ObjectId,
  ): Promise<ConfirmationCheck> {
    const local = (
      view: SubscriptionPaymentView,
      observed: ProviderPaymentStatus | null = null,
    ): ConfirmationCheck => ({ view, observed });
    const payment = await this.findById(paymentId);
    if (!payment) throw paymentNotFound();
    if (payment.status === SubscriptionPaymentStatus.SUCCEEDED) {
      return local(this.toView(payment));
    }
    if (payment.status === SubscriptionPaymentStatus.REVIEW) {
      return local(this.toView(payment));
    }
    // 1-21B : chaque paiement est confirmé par SON prestataire, jamais par
    // un autre ; disponible même si les nouvelles tentatives sont coupées.
    const provider = confirmationProviderFor(
      payment.provider,
      this.provider,
      this.confirmers,
    );
    if (!provider) throw paymentServiceUnavailable();

    const lookup = this.lookupFor(payment, provider);
    // Initiation incertaine sans recherche par référence marchand : rien ne
    // permet de conclure ; état conservé (jamais une nouvelle collecte).
    if (!lookup) return local(this.toView(payment));

    let status: ProviderPaymentStatus | null;
    try {
      status = await provider.fetchStatus(lookup);
    } catch (error) {
      if (error instanceof PaymentProviderInconsistencyError) {
        // Jamais départagé arbitrairement : vérification opérateur.
        if (
          await this.markReview(
            payment._id,
            SubscriptionPaymentIncident.PROVIDER_INCONSISTENT,
          )
        ) {
          this.signalPayments(payment.organizationId);
        }
        return local(await this.viewById(payment._id));
      }
      throw paymentStatusUnavailable();
    }
    // Date de consultation seule : absente de la vue, aucun signal.
    await this.paymentModel
      .updateOne(
        { _id: payment._id },
        { $set: { lastCheckedAt: this.clock() } },
      )
      .exec();
    if (!status) return local(await this.viewById(payment._id));

    // 1-15F : `changed` n'est vrai qu'après une écriture validée qui a
    // modifié l'état visible ; le signal part ensuite, même si la relecture
    // finale échoue.
    let changed = false;
    try {
      if (!this.concordant(payment, status)) {
        changed = await this.markReview(payment._id);
        return local(await this.viewById(payment._id), status);
      }

      switch (status.state) {
        case 'pending':
          changed = await this.recordPending(
            payment._id,
            status.providerReference,
            [
              SubscriptionPaymentStatus.INITIATING,
              SubscriptionPaymentStatus.PENDING,
              SubscriptionPaymentStatus.UNCERTAIN,
            ],
            {
              checkoutUrl: status.checkoutUrl,
              providerTransactionId: status.providerTransactionId,
              checkoutExpiresAt: status.checkoutExpiresAt,
            },
          );
          break;
        case 'unresolved':
          // 1-21E : page close et absence de transaction AFFIRMÉE par SasPay
          // (champs présents et nuls), aucune rattachée ici → clos. Sinon
          // (champ manquant, tentative échouée `FAILED` rejouable) : en
          // résolution, jamais libéré.
          changed =
            status.checkoutClosed === true &&
            status.transactionAbsenceConfirmed === true &&
            status.providerTransactionId === null &&
            payment.providerTransactionId === null
              ? await this.recordClosed(payment._id, status)
              : await this.recordUnresolved(payment._id, status);
          break;
        case 'failed':
          changed = await this.recordFailure(
            payment._id,
            status.providerReference,
          );
          break;
        case 'succeeded': {
          const outcome = await this.finalize(payment._id, status);
          changed = outcome !== 'unchanged';
          // Transaction VALIDÉE (`runInGrantTransaction` a rendu la main
          // après le commit) : nouvelle période visible.
          if (outcome === 'granted') {
            void this.signals.subscriptionChanged(
              payment.organizationId.toHexString(),
            );
          }
          break;
        }
      }
      return local(await this.viewById(payment._id), status);
    } finally {
      if (changed) this.signalPayments(payment.organizationId);
    }
  }

  // ─── Changement de forfait (1-21E) ─────────────────────────────────────────

  /**
   * 1-21E — « Changer de forfait » : libère une nouvelle tentative SEULEMENT
   * si la page actuelle ne peut plus être payée et qu'aucune transaction n'y
   * a été engagée, vérifié chez le prestataire.
   *
   * 1. Vérification complète d'abord : un succès est attribué (jamais
   *    abandonné) ; une transaction en cours ou une tentative échouée bloque.
   * 2. Page ouverte SANS transaction → fermeture OFFICIELLE chez le
   *    prestataire (`cancelCheckout`), puis vérification démarrée après
   *    elle : seule une page relue close, toujours sans transaction, clôt le
   *    paiement (`failed` + `checkout_closed`).
   * Jamais : suppression, changement de montant, `pending`/`uncertain`
   * converti en échec sans cette preuve, nouvelle session créée ici.
   */
  async abandonPayment(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<{
    outcome: PaymentAbandonOutcome;
    payment: SubscriptionPaymentView;
  }> {
    const payment = await this.findScoped(context, paymentId);
    if (payment.status === SubscriptionPaymentStatus.SUCCEEDED) {
      return { outcome: 'succeeded', payment: this.toView(payment) };
    }
    if (payment.status === SubscriptionPaymentStatus.FAILED) {
      return { outcome: 'released', payment: this.toView(payment) };
    }
    if (payment.status === SubscriptionPaymentStatus.REVIEW) {
      return { outcome: 'awaiting-resolution', payment: this.toView(payment) };
    }
    const provider = confirmationProviderFor(
      payment.provider,
      this.provider,
      this.confirmers,
    );
    if (!provider) throw paymentServiceUnavailable();
    // Collecte poussée sur le téléphone (aucune page à fermer) : inchangé.
    if (!provider.cancelCheckout) throw paymentChangeUnavailable();

    // 1-22D : vérification, fermeture et relecture réservées ensemble.
    const costs = provider.callAdmission?.costs;
    const cost = costs
      ? this.statusCost(payment, provider) +
        costs.cancel +
        costs.statusByProvider
      : 0;
    return this.withOwnerCalls(provider, context, cost, 'status', () =>
      this.closeCheckout(payment._id, provider),
    );
  }

  /** Étapes 1 et 2 de `abandonPayment`. */
  private async closeCheckout(
    paymentId: Types.ObjectId,
    provider: PaymentProvider,
  ): Promise<{
    outcome: PaymentAbandonOutcome;
    payment: SubscriptionPaymentView;
  }> {
    const first = await this.checkFresh(paymentId);
    const settled = this.abandonOutcome(first);
    if (settled) return { outcome: settled, payment: first.view };

    try {
      await provider.cancelCheckout!(first.observed!.providerReference);
    } catch (error) {
      // Demande certainement non transmise : rien n'a changé.
      if (error instanceof PaymentProviderUnavailableError) {
        throw paymentServiceUnavailable();
      }
      // Issue inconnue : la relecture tranche.
    }
    const second = await this.checkFresh(paymentId);
    return {
      outcome: this.abandonOutcome(second) ?? 'cancel-unconfirmed',
      payment: second.view,
    };
  }

  /** `null` : page ouverte sans transaction → fermeture à demander. */
  private abandonOutcome(
    check: ConfirmationCheck,
  ): PaymentAbandonOutcome | null {
    const { view, observed } = check;
    if (view.status === SubscriptionPaymentStatus.SUCCEEDED) return 'succeeded';
    if (view.status === SubscriptionPaymentStatus.FAILED) return 'released';
    if (view.status === SubscriptionPaymentStatus.REVIEW) {
      return 'awaiting-resolution';
    }
    if (!observed) return 'not-found-at-provider';
    if (observed.transactionState === 'pending') return 'in-progress';
    if (observed.checkoutClosed || observed.state !== 'pending') {
      return 'awaiting-resolution';
    }
    if (
      typeof observed.providerTransactionId === 'string' ||
      observed.transactionState
    ) {
      return 'attempt-recorded';
    }
    // Champ manquant ou réponse incomplète : jamais une preuve d'absence.
    if (observed.transactionAbsenceConfirmed !== true) {
      return 'provider-incomplete';
    }
    return null;
  }

  /**
   * 1-14D.2F — Localisation d'un paiement EXISTANT pour une notification du
   * prestataire, en LECTURE SEULE (aucune création, aucune référence
   * adoptée) :
   * - `found` : référence prestataire PERSISTÉE identique → le déclencheur
   *   appellera `confirmPayment` (statut relu chez le prestataire) ;
   * - `not-ready` : aucune correspondance, mais l'indice marchand (non
   *   prouvé) désigne un paiement encore `initiating` sans référence
   *   prestataire : notification possiblement arrivée avant l'enregistrement
   *   de la réponse d'initiation → réponse temporaire ;
   * - `unknown` : rien à faire.
   */
  async locateProviderNotification(
    providerName: string,
    providerReference: string,
    merchantReferenceHint: string | null,
  ): Promise<
    | { kind: 'found'; paymentId: Types.ObjectId }
    | { kind: 'not-ready' }
    | { kind: 'unknown' }
  > {
    const payment = await this.paymentModel
      .findOne({ provider: providerName, providerReference })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    if (payment) return { kind: 'found', paymentId: payment._id };
    if (merchantReferenceHint) {
      const initiating = await this.paymentModel
        .findOne({
          provider: providerName,
          merchantReference: merchantReferenceHint,
          status: SubscriptionPaymentStatus.INITIATING,
          providerReference: null,
        })
        .select({ _id: 1 })
        .lean()
        .exec();
      if (initiating) return { kind: 'not-ready' };
    }
    return { kind: 'unknown' };
  }

  // ─── Internes ──────────────────────────────────────────────────────────────

  private lookupFor(
    payment: PaymentRecord,
    provider: PaymentProvider,
  ): PaymentStatusLookup | null {
    if (payment.providerReference) {
      return { by: 'provider', providerReference: payment.providerReference };
    }
    return provider.supportsMerchantReferenceLookup
      ? { by: 'merchant', merchantReference: payment.merchantReference }
      : null;
  }

  /**
   * Concordance STRICTE avec les valeurs figées : référence marchand,
   * référence prestataire (si déjà connue), montant brut exact (nombre
   * entier, aucune conversion), devise.
   */
  private concordant(
    payment: Pick<
      PaymentRecord,
      | 'merchantReference'
      | 'providerReference'
      | 'amount'
      | 'currency'
      | 'providerTransactionId'
    >,
    status: ProviderPaymentStatus,
  ): boolean {
    return (
      paymentConcordanceMismatches(payment, status, payment.providerReference)
        .length === 0
    );
  }

  /**
   * Succès VÉRIFIÉ → transaction complète (socle 1-14D.2A, sans réseau) :
   * relecture, revérification des valeurs figées, attribution
   * `payment:<id>`, marquage conditionnel `succeeded` + période.
   */
  private async finalize(
    paymentId: Types.ObjectId,
    verified: ProviderPaymentStatus,
  ): Promise<'granted' | 'review' | 'unchanged'> {
    let outcome:
      | 'granted'
      | 'replayed'
      | 'not-finalizable'
      | 'mismatch'
      | 'replaced'
      | 'renewal-granted';
    try {
      outcome = await this.subscriptions.runInGrantTransaction(
        async (session) => {
          const current = await this.paymentModel
            .findById(paymentId)
            .session(session)
            .lean<PaymentRecord>()
            .exec();
          if (!current) throw new Error('Subscription payment vanished');
          if (current.status === SubscriptionPaymentStatus.SUCCEEDED) {
            return 'replayed' as const;
          }
          if (!FINALIZABLE_STATUSES.includes(current.status)) {
            return 'not-finalizable' as const;
          }
          if (!this.concordant(current, verified)) {
            return 'mismatch' as const;
          }
          // 1-21E : tentative REMPLACÉE (changement de forfait) → jamais
          // d'attribution silencieuse de l'ancien forfait.
          const replaced = await this.paymentModel
            .exists({ replacesPaymentId: current._id })
            .session(session)
            .exec();
          if (replaced) return 'replaced' as const;
          // 1-21E : renouvellement déjà attribué par une autre tentative.
          const renewalId = current.renewalId ?? current._id;
          const other = await this.paymentModel
            .exists({
              autoGrantRenewalId: renewalId,
              _id: { $ne: current._id },
            })
            .session(session)
            .exec();
          if (other) return 'renewal-granted' as const;
          await this.grantAndMarkSucceededInSession(session, current, verified);
          // 1-16A — « paiement confirmé » enregistré dans CETTE transaction,
          // après attribution et passage à `succeeded` : annulé par un
          // rollback, unique par paiement sur un rejeu du callback. Jamais
          // pour `pending`, `uncertain` ni `review`.
          await this.pushOutbox?.paymentSucceededInSession(session, {
            organizationId: current.organizationId,
            paymentId: current._id,
          });
          return 'granted' as const;
        },
        { budgetMs: PAYMENT_CONFIRMATION_BUDGET_MS },
      );
    } catch (error) {
      // Budget épuisé ou contention persistante : réponse TEMPORAIRE, aucun
      // changement d'état (jamais `failed`), aucune nouvelle collecte. Un
      // commit éventuellement validé sera retrouvé (rejeu) au prochain appel.
      if (
        error instanceof SubscriptionGrantError &&
        (error.code === 'GRANT_TIMEOUT' || error.code === 'GRANT_CONTENTION')
      ) {
        throw paymentConfirmationPending();
      }
      // Référence prestataire déjà portée par un autre paiement : anomalie.
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate === 'provider_1_providerReference_1' ||
        duplicate === 'provider_1_providerTransactionId_1'
      ) {
        return (await this.markReview(paymentId)) ? 'review' : 'unchanged';
      }
      // 1-21E : attribution automatique du renouvellement validée en même
      // temps par une autre tentative (index unique, autre processus).
      if (duplicate !== 'autoGrantRenewalId_1') throw error;
      outcome = 'renewal-granted';
    }
    if (outcome === 'granted') return 'granted';
    if (outcome === 'replaced' || outcome === 'renewal-granted') {
      const incident =
        outcome === 'replaced'
          ? SubscriptionPaymentIncident.REPLACED_PAYMENT_COLLECTED
          : SubscriptionPaymentIncident.RENEWAL_ALREADY_GRANTED;
      const recorded = await this.recordCollectedConflict(
        paymentId,
        verified,
        incident,
      );
      if (outcome === 'replaced') await this.suspendReplacements(paymentId);
      return recorded ? 'review' : 'unchanged';
    }
    if (outcome === 'mismatch') {
      return (await this.markReview(paymentId)) ? 'review' : 'unchanged';
    }
    return 'unchanged';
  }

  /**
   * Attribution `source: payment` (`payment:<id>`, `payment:<prestataire>`)
   * et marquage `succeeded` + période, dans la transaction ACTIVE de
   * l'appelant (aucun réseau). Écriture conditionnelle vérifiée sur l'état
   * LU dans la session : sinon exception, donc annulation de la transaction
   * (aucune période sans paiement marqué). Partagé par la confirmation
   * (`finalize`) et le rapprochement opérateur (1-14D.2G).
   */
  async grantAndMarkSucceededInSession(
    session: MongooseSession,
    current: PaymentRecord,
    verified: ProviderPaymentStatus,
    options: {
      /**
       * 1-21E — `false` : attribution MANUELLE explicite de l'opérateur
       * (encaissement en conflit, accord du client) ; ne revendique pas
       * l'attribution automatique du renouvellement.
       */
      claimRenewal?: boolean;
    } = {},
  ): Promise<Types.ObjectId> {
    const granted = await this.subscriptions.grantSubscriptionInSession(
      {
        organizationId: current.organizationId.toHexString(),
        term: current.term,
        source: SubscriptionSource.PAYMENT,
        sourceReference: paymentGrantReference(current._id),
        grantedBy: `payment:${current.provider}`,
      },
      session,
    );
    const periodId = new Types.ObjectId(granted.periodId);
    const marked = await this.paymentModel
      .updateOne(
        {
          _id: current._id,
          status: current.status,
          periodId: null,
          // 1-21E : jamais d'attribution d'un paiement remboursé.
          refundedAt: null,
        },
        {
          $set: {
            status: SubscriptionPaymentStatus.SUCCEEDED,
            open: false,
            periodId,
            providerReference: verified.providerReference,
            ...(typeof verified.providerTransactionId === 'string'
              ? { providerTransactionId: verified.providerTransactionId }
              : {}),
            providerCheckoutUrl: null,
            confirmedAt: this.clock(),
            // 1-21E : statut financier et montant débité (reçu).
            collectedAt: current.collectedAt ?? this.clock(),
            ...(typeof verified.paidAmountMinor === 'number'
              ? { paidAmountMinor: verified.paidAmountMinor }
              : {}),
            // 1-21E : index unique → une attribution automatique par
            // renouvellement, garantie par la base (entre processus).
            ...(options.claimRenewal === false
              ? {}
              : { autoGrantRenewalId: current.renewalId ?? current._id }),
          },
        },
        { session },
      )
      .exec();
    if (marked.modifiedCount !== 1) {
      throw new Error('Subscription payment finalization lost its race');
    }
    return periodId;
  }

  /**
   * Collecte acceptée / en attente : référence prestataire adoptée. Vrai si
   * l'état visible a changé (`pending` ou `review`).
   */
  private async recordPending(
    paymentId: Types.ObjectId,
    providerReference: string,
    from: readonly SubscriptionPaymentStatus[],
    attached: {
      checkoutUrl?: string | null;
      providerTransactionId?: string | null;
      /** 1-21E : fin de validité lue ou demandée ; absente = inchangée. */
      checkoutExpiresAt?: Date | null;
    } = {},
  ): Promise<boolean> {
    const before = await this.findById(paymentId);
    const transactionId =
      typeof attached.providerTransactionId === 'string'
        ? attached.providerTransactionId
        : null;
    try {
      const updated = await this.paymentModel
        .updateOne(
          {
            _id: paymentId,
            status: { $in: from },
            providerReference: { $in: [null, providerReference] },
            // 1-21B : une transaction rattachée n'est jamais remplacée.
            ...(transactionId
              ? { providerTransactionId: { $in: [null, transactionId] } }
              : {}),
          },
          {
            $set: {
              status: SubscriptionPaymentStatus.PENDING,
              providerReference,
              initiatedAt: before?.initiatedAt ?? this.clock(),
              incidentCode: null,
              ...(transactionId
                ? { providerTransactionId: transactionId }
                : {}),
              ...(attached.checkoutUrl !== undefined
                ? { providerCheckoutUrl: attached.checkoutUrl }
                : {}),
              ...(attached.checkoutExpiresAt
                ? { providerCheckoutExpiresAt: attached.checkoutExpiresAt }
                : {}),
            },
          },
        )
        .exec();
      if (updated.matchedCount === 1) {
        // Visible seulement si l'état, l'incident ou la page ont changé.
        return (
          before?.status !== SubscriptionPaymentStatus.PENDING ||
          before?.incidentCode !== null ||
          (attached.checkoutUrl !== undefined &&
            before?.providerCheckoutUrl !== attached.checkoutUrl)
        );
      }
    } catch (error) {
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate !== 'provider_1_providerReference_1' &&
        duplicate !== 'provider_1_providerTransactionId_1'
      ) {
        throw error;
      }
      return this.markReview(paymentId);
    }
    // Non appliqué : état déjà avancé par une autre confirmation, ou
    // référence prestataire différente déjà enregistrée (anomalie).
    const current = await this.findById(paymentId);
    if (
      current &&
      ((current.providerReference !== null &&
        current.providerReference !== providerReference) ||
        (transactionId !== null &&
          current.providerTransactionId !== null &&
          current.providerTransactionId !== transactionId))
    ) {
      return this.markReview(paymentId);
    }
    return false;
  }

  /**
   * 1-21B — Page de paiement close ou tentative échouée SANS succès
   * constaté : le paiement reste OUVERT (`uncertain`, incident
   * `checkout_unresolved`), toujours vérifiable (succès tardif accepté) ;
   * aucune nouvelle tentative libérée, aucune relance de débit. Clôture par
   * le rapprochement opérateur seulement. Vrai si l'état visible a changé.
   */
  private async recordUnresolved(
    paymentId: Types.ObjectId,
    status: ProviderPaymentStatus,
  ): Promise<boolean> {
    const before = await this.findById(paymentId);
    if (!before) return false;
    const transactionId =
      typeof status.providerTransactionId === 'string'
        ? status.providerTransactionId
        : null;
    try {
      const updated = await this.paymentModel
        .updateOne(
          {
            _id: paymentId,
            status: {
              $in: [
                SubscriptionPaymentStatus.INITIATING,
                SubscriptionPaymentStatus.PENDING,
                SubscriptionPaymentStatus.UNCERTAIN,
              ],
            },
            providerReference: { $in: [null, status.providerReference] },
            ...(transactionId
              ? { providerTransactionId: { $in: [null, transactionId] } }
              : {}),
          },
          {
            $set: {
              status: SubscriptionPaymentStatus.UNCERTAIN,
              incidentCode: SubscriptionPaymentIncident.CHECKOUT_UNRESOLVED,
              providerReference: status.providerReference,
              providerCheckoutUrl: status.checkoutUrl ?? null,
              ...(transactionId
                ? { providerTransactionId: transactionId }
                : {}),
            },
          },
        )
        .exec();
      if (updated.matchedCount !== 1) return false;
    } catch (error) {
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate !== 'provider_1_providerReference_1' &&
        duplicate !== 'provider_1_providerTransactionId_1'
      ) {
        throw error;
      }
      return this.markReview(paymentId);
    }
    return (
      before.status !== SubscriptionPaymentStatus.UNCERTAIN ||
      before.incidentCode !== SubscriptionPaymentIncident.CHECKOUT_UNRESOLVED
    );
  }

  /**
   * 1-21E — Rapprochement PÉRIODIQUE borné (webhook jamais reçu, client
   * absent) : au plus `limit` paiements par passe, chacun revérifié par le
   * moteur UNIQUE (`confirmPaymentShared`) :
   * - paiements OUVERTS (`pending`, `uncertain`) ;
   * - tentatives CLOSES sans encaissement (`checkout_closed`) depuis moins
   *   de `lateWindowMs` : un succès tardif y est retrouvé et traité ;
   * non vérifiés depuis `staleMs`. Chaque paiement est RÉSERVÉ par une
   * écriture conditionnelle de `lastCheckedAt` (plusieurs processus : un
   * seul le vérifie par période). Prestataires sans adaptateur disponible
   * ignorés. Aucune création, aucune relance de débit.
   */
  async sweepOnce(options: {
    limit: number;
    staleMs: number;
    lateWindowMs: number;
  }): Promise<{ examined: number; failed: number }> {
    const providers = [this.provider, ...(this.confirmers ?? [])]
      .filter((p) => p.available)
      .map((p) => p.name);
    const report = { examined: 0, failed: 0 };
    if (providers.length === 0) return report;
    for (let i = 0; i < options.limit; i += 1) {
      // 1-22D : budget des confirmations insuffisant → passe interrompue
      // AVANT de réserver un paiement (repris à la passe suivante).
      if (!this.confirmationCapacityFor(providers)) break;
      const now = this.clock();
      const claimed = await this.paymentModel
        .findOneAndUpdate(
          {
            provider: { $in: providers },
            $and: [
              {
                $or: [
                  {
                    open: true,
                    status: {
                      $in: [
                        SubscriptionPaymentStatus.PENDING,
                        SubscriptionPaymentStatus.UNCERTAIN,
                      ],
                    },
                  },
                  {
                    status: SubscriptionPaymentStatus.FAILED,
                    incidentCode: SubscriptionPaymentIncident.CHECKOUT_CLOSED,
                    failedAt: {
                      $gte: new Date(now.getTime() - options.lateWindowMs),
                    },
                  },
                ],
              },
              {
                $or: [
                  { lastCheckedAt: null },
                  {
                    lastCheckedAt: {
                      $lt: new Date(now.getTime() - options.staleMs),
                    },
                  },
                ],
              },
            ],
          },
          { $set: { lastCheckedAt: now } },
          { sort: { lastCheckedAt: 1, _id: 1 }, projection: { _id: 1 } },
        )
        .lean<{ _id: Types.ObjectId }>()
        .exec();
      if (!claimed) break;
      report.examined += 1;
      try {
        await this.confirmPaymentShared(claimed._id);
      } catch {
        report.failed += 1;
      }
    }
    return report;
  }

  /** 1-22D — Chaque prestataire balayé peut encore lire un statut complet. */
  private confirmationCapacityFor(names: readonly string[]): boolean {
    return names.every((name) => {
      const admission = confirmationProviderFor(
        name,
        this.provider,
        this.confirmers,
      )?.callAdmission;
      return (
        !admission ||
        admission.budget.confirmationHeadroom() >=
          admission.costs.statusByMerchant
      );
    });
  }

  /**
   * 1-21E — Encaissement en CONFLIT de renouvellement : tentative
   * remplacée, ou renouvellement déjà attribué par une autre tentative.
   * Lecture seule (rapprochement opérateur).
   */
  /**
   * 1-21E — Renouvellement du paiement déjà RÉGLÉ par une autre tentative
   * (attribution automatique ou manuelle « forfait initial retenu »).
   */
  async renewalSettledByOther(
    payment: Pick<PaymentRecord, '_id' | 'renewalId'>,
  ): Promise<boolean> {
    const found = await this.paymentModel
      .exists({
        autoGrantRenewalId: payment.renewalId ?? payment._id,
        _id: { $ne: payment._id },
      })
      .exec();
    return found !== null;
  }

  async renewalConflictOf(
    payment: Pick<
      PaymentRecord,
      '_id' | 'renewalId' | 'incidentCode' | 'collectedAt'
    >,
  ): Promise<boolean> {
    if (
      payment.incidentCode &&
      COLLECTED_CONFLICT_INCIDENTS.includes(payment.incidentCode)
    ) {
      return true;
    }
    const renewalId = payment.renewalId ?? payment._id;
    const found = await this.paymentModel
      .exists({
        $or: [
          { replacesPaymentId: payment._id },
          { autoGrantRenewalId: renewalId, _id: { $ne: payment._id } },
        ],
      })
      .exec();
    return found !== null;
  }

  /**
   * 1-21E — Encaissement CONFIRMÉ sans attribution automatique possible
   * (tentative remplacée, renouvellement déjà attribué) : statut financier
   * enregistré (`collectedAt`, transaction, montant débité), paiement en
   * `review` avec l'incident, fermé (`open: false`). Jamais `failed`, jamais
   * supprimé, aucune période. Signalé à l'opérateur (journal + incident,
   * CLI `inspect`). Vrai si l'état a changé.
   */
  private async recordCollectedConflict(
    paymentId: Types.ObjectId,
    verified: ProviderPaymentStatus,
    incident: SubscriptionPaymentIncident,
  ): Promise<boolean> {
    const transactionId =
      typeof verified.providerTransactionId === 'string'
        ? verified.providerTransactionId
        : null;
    let changed: boolean;
    try {
      changed = await this.transition(paymentId, FINALIZABLE_STATUSES, {
        status: SubscriptionPaymentStatus.REVIEW,
        open: false,
        incidentCode: incident,
        collectedAt: this.clock(),
        providerReference: verified.providerReference,
        providerCheckoutUrl: null,
        ...(transactionId ? { providerTransactionId: transactionId } : {}),
        ...(typeof verified.paidAmountMinor === 'number'
          ? { paidAmountMinor: verified.paidAmountMinor }
          : {}),
      });
    } catch (error) {
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate !== 'provider_1_providerReference_1' &&
        duplicate !== 'provider_1_providerTransactionId_1'
      ) {
        throw error;
      }
      changed = await this.markReview(paymentId);
    }
    if (changed) {
      // Identifiants internes seulement (aucune donnée personnelle).
      this.logger.warn(
        `Encaissement à résoudre (${incident}) : paiement ${paymentId.toHexString()}.`,
      );
    }
    return changed;
  }

  /**
   * 1-21E — Tentative remplacée ENCAISSÉE : la poursuite des tentatives
   * OUVERTES du même renouvellement est suspendue (lien retiré aussitôt),
   * puis leur page est fermée chez le prestataire si c'est sûr (même règle
   * que « Changer de forfait »). Une tentative déjà engagée (transaction)
   * reste vérifiable : son succès éventuel est attribué normalement.
   * Au mieux : une erreur n'interrompt jamais la confirmation en cours.
   */
  async suspendReplacements(paymentId: Types.ObjectId): Promise<void> {
    const paid = await this.findById(paymentId);
    if (!paid) return;
    const renewalId = paid.renewalId ?? paid._id;
    const open = await this.paymentModel
      .find({ renewalId, open: true, _id: { $ne: paid._id } })
      .select({ _id: 1, provider: 1, organizationId: 1 })
      .lean<Pick<PaymentRecord, '_id' | 'provider' | 'organizationId'>[]>()
      .exec();
    for (const other of open) {
      await this.paymentModel
        .updateOne(
          { _id: other._id, renewalConflictAt: null },
          { $set: { renewalConflictAt: this.clock() } },
        )
        .exec();
      this.signalPayments(other.organizationId);
      try {
        const provider = confirmationProviderFor(
          other.provider,
          this.provider,
          this.confirmers,
        );
        if (!provider?.cancelCheckout) continue;
        const check = await this.checkFresh(other._id);
        if (this.abandonOutcome(check) !== null) continue;
        await provider
          .cancelCheckout(check.observed!.providerReference)
          .catch(() => undefined);
        await this.checkFresh(other._id);
      } catch {
        // Suspension conservée ; la vérification suivante tranchera.
      }
    }
  }

  /**
   * 1-21E — Page close SANS aucune transaction, revérifiée chez le
   * prestataire : aucun débit possible → paiement clos (`failed`, incident
   * `checkout_closed`), nouvelle tentative libérée. Écriture conditionnelle
   * (ouvert, même session, aucune transaction rattachée) : jamais après un
   * succès ni une autre issue. Un succès vérifié ultérieur reste attribué
   * (`failed` est finalisable ; candidat du webhook, `unattachedCandidates`).
   * Vrai si le paiement a été clos.
   */
  private async recordClosed(
    paymentId: Types.ObjectId,
    status: ProviderPaymentStatus,
  ): Promise<boolean> {
    try {
      return await this.transition(
        paymentId,
        [
          SubscriptionPaymentStatus.PENDING,
          SubscriptionPaymentStatus.UNCERTAIN,
        ],
        {
          status: SubscriptionPaymentStatus.FAILED,
          open: false,
          failedAt: this.clock(),
          incidentCode: SubscriptionPaymentIncident.CHECKOUT_CLOSED,
          providerReference: status.providerReference,
          providerCheckoutUrl: null,
        },
        {
          providerReference: { $in: [null, status.providerReference] },
          providerTransactionId: null,
        },
      );
    } catch (error) {
      if (
        subscriptionPaymentDuplicateKeyIndex(error) !==
        'provider_1_providerReference_1'
      ) {
        throw error;
      }
      return this.markReview(paymentId);
    }
  }

  /**
   * 1-21B — Paiement auquel une transaction du prestataire est RATTACHÉE
   * (notification) ; `null` sinon. Lecture seule.
   */
  async findByProviderTransaction(
    providerName: string,
    providerTransactionId: string,
  ): Promise<Types.ObjectId | null> {
    const found = await this.paymentModel
      .findOne({ provider: providerName, providerTransactionId })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    return found?._id ?? null;
  }

  /**
   * 1-21B — Candidats BORNÉS au rattachement d'une transaction notifiée
   * avant d'être connue : paiements ouverts de ce prestataire, session
   * connue, aucune transaction rattachée, initiés depuis `since` ; les plus
   * récents d'abord, au plus `limit`. Jamais tous les paiements ouverts.
   * 1-21E : aussi les paiements clos `checkout_closed` (page close sans
   * transaction) : une transaction tardive y serait rattachée par SA session
   * et un succès vérifié attribué, jamais ignoré.
   */
  async unattachedCandidates(
    providerName: string,
    since: Date,
    limit: number,
  ): Promise<Types.ObjectId[]> {
    const rows = await this.paymentModel
      .find({
        provider: providerName,
        $or: [
          {
            open: true,
            status: {
              $in: [
                SubscriptionPaymentStatus.PENDING,
                SubscriptionPaymentStatus.UNCERTAIN,
              ],
            },
          },
          {
            status: SubscriptionPaymentStatus.FAILED,
            incidentCode: SubscriptionPaymentIncident.CHECKOUT_CLOSED,
          },
        ],
        providerReference: { $type: 'string' },
        providerTransactionId: null,
        initiatedAt: { $gte: since },
      })
      .sort({ initiatedAt: -1 })
      .limit(limit)
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return rows.map((r) => r._id);
  }

  /**
   * Refus CONFIRMÉ : ferme un paiement ouvert. Jamais de régression d'un
   * `succeeded` (réponse tardive ou désordonnée) : incident consigné (absent
   * de la vue). Vrai seulement si le paiement est passé à `failed`.
   */
  private async recordFailure(
    paymentId: Types.ObjectId,
    providerReference: string,
  ): Promise<boolean> {
    const updated = await this.paymentModel
      .updateOne(
        {
          _id: paymentId,
          status: { $in: OPEN_PAYMENT_STATUSES },
          providerReference: { $in: [null, providerReference] },
        },
        {
          $set: {
            status: SubscriptionPaymentStatus.FAILED,
            open: false,
            providerReference,
            failedAt: this.clock(),
          },
        },
      )
      .exec();
    if (updated.matchedCount === 1) return true;
    await this.paymentModel
      .updateOne(
        {
          _id: paymentId,
          status: SubscriptionPaymentStatus.SUCCEEDED,
          incidentCode: null,
        },
        {
          $set: {
            incidentCode:
              SubscriptionPaymentIncident.LATE_FAILURE_AFTER_SUCCESS,
          },
        },
      )
      .exec();
    return false;
  }

  /**
   * Discordance : `review`, `open` conservé ; jamais depuis `succeeded`.
   * Vrai si le paiement est passé à `review`.
   */
  private async markReview(
    paymentId: Types.ObjectId,
    incident: SubscriptionPaymentIncident = SubscriptionPaymentIncident.PROVIDER_MISMATCH,
  ): Promise<boolean> {
    return this.transition(paymentId, FINALIZABLE_STATUSES, {
      status: SubscriptionPaymentStatus.REVIEW,
      incidentCode: incident,
    });
  }

  private async transition(
    paymentId: Types.ObjectId,
    from: readonly SubscriptionPaymentStatus[],
    set: Partial<SubscriptionPayment>,
    where: Record<string, unknown> = {},
  ): Promise<boolean> {
    const updated = await this.paymentModel
      .updateOne(
        { ...where, _id: paymentId, status: { $in: from } },
        { $set: set },
      )
      .exec();
    return updated.matchedCount === 1;
  }

  /** 1-15F : best effort, jamais d'exception (voir le service de signaux). */
  private signalPayments(organizationId: Types.ObjectId): void {
    void this.signals.paymentsChanged(organizationId.toHexString());
  }

  private replay(
    existing: PaymentRecord,
    requestedBy: Types.ObjectId,
    fingerprint: string,
  ): { payment: SubscriptionPaymentView; replayed: boolean } {
    if (
      !existing.requestedBy.equals(requestedBy) ||
      existing.requestFingerprint !== fingerprint
    ) {
      throw paymentOperationConflict();
    }
    return { payment: this.toView(existing), replayed: true };
  }

  private findOperation(
    organizationId: Types.ObjectId,
    clientOperationId: string,
  ): Promise<PaymentRecord | null> {
    return this.paymentModel
      .findOne({ organizationId, clientOperationId })
      .lean<PaymentRecord>()
      .exec();
  }

  private findById(paymentId: Types.ObjectId): Promise<PaymentRecord | null> {
    return this.paymentModel.findById(paymentId).lean<PaymentRecord>().exec();
  }

  /** 404 UNIFORME : id invalide, inexistant ou d'une autre organisation. */
  private async findScoped(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<PaymentRecord> {
    if (!isStrictObjectId(paymentId)) throw paymentNotFound();
    const payment = await this.paymentModel
      .findOne({
        _id: new Types.ObjectId(paymentId),
        organizationId: new Types.ObjectId(context.organizationId),
      })
      .lean<PaymentRecord>()
      .exec();
    if (!payment) throw paymentNotFound();
    return payment;
  }

  private async viewById(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    const payment = await this.findById(paymentId);
    if (!payment) throw paymentNotFound();
    return this.toView(payment);
  }

  /**
   * 1-21E — Fin de validité de la page : enregistrée, sinon (paiement
   * antérieur) création + durée demandée par SON prestataire (la création
   * précède la demande : jamais plus tard que l'échéance réelle).
   */
  private checkoutExpiry(payment: PaymentRecord): Date | null {
    if (payment.providerCheckoutExpiresAt) {
      return new Date(payment.providerCheckoutExpiresAt);
    }
    const ttl = confirmationProviderFor(
      payment.provider,
      this.provider,
      this.confirmers,
    )?.checkoutTtlMs;
    if (!payment.providerCheckoutUrl || !ttl || !payment.createdAt) {
      return null;
    }
    return new Date(new Date(payment.createdAt).getTime() + ttl);
  }

  /** 1-21E — voir `PaymentSituation` ; `null` hors page hébergée. */
  private situation(
    payment: PaymentRecord,
    linkValid: boolean,
    expiry: Date | null,
  ): PaymentSituation | null {
    // Page hébergée : aucun numéro demandé (Mobile Money : toujours masqué).
    if (payment.payerPhoneMasked) return null;
    const incident = payment.incidentCode ?? null;
    if (payment.refundedAt) return 'refunded';
    if (
      payment.status === SubscriptionPaymentStatus.REVIEW &&
      payment.collectedAt &&
      incident !== null &&
      COLLECTED_CONFLICT_INCIDENTS.includes(incident)
    ) {
      return 'collected-in-resolution';
    }
    if (payment.open && payment.renewalConflictAt) return 'renewal-suspended';
    switch (payment.status) {
      case SubscriptionPaymentStatus.FAILED:
        return incident === SubscriptionPaymentIncident.CHECKOUT_CLOSED
          ? 'checkout-closed'
          : null;
      case SubscriptionPaymentStatus.UNCERTAIN:
        if (incident === SubscriptionPaymentIncident.CHECKOUT_UNRESOLVED) {
          return payment.providerTransactionId
            ? 'attempt-unresolved'
            : 'closure-unconfirmed';
        }
        return expiry ? 'checkout-expired' : 'checkout-link-missing';
      case SubscriptionPaymentStatus.PENDING:
        if (linkValid) return 'checkout-open';
        return expiry ? 'checkout-expired' : 'checkout-link-missing';
      case SubscriptionPaymentStatus.INITIATING:
        return 'checkout-link-missing';
      default:
        return null;
    }
  }

  private toView(payment: PaymentRecord): SubscriptionPaymentView {
    const expiry = this.checkoutExpiry(payment);
    const remaining = expiry ? expiry.getTime() - this.clock().getTime() : 0;
    // Page proposée : paiement ouvert en attente, page connue, encore valide.
    const linkValid =
      payment.open &&
      payment.status === SubscriptionPaymentStatus.PENDING &&
      !!payment.providerCheckoutUrl &&
      // 1-21E : poursuite suspendue (tentative remplacée encaissée).
      !payment.renewalConflictAt &&
      (expiry === null || remaining > 0);
    return {
      paymentId: payment._id.toHexString(),
      reference: payment.merchantReference,
      status: payment.status,
      term: payment.term,
      amount: payment.amount,
      currency: payment.currency,
      payerPhoneMasked: payment.payerPhoneMasked ?? null,
      checkoutUrl: linkValid ? (payment.providerCheckoutUrl ?? null) : null,
      checkoutExpiresAt: iso(expiry),
      checkoutExpiresInMs: linkValid && expiry ? remaining : null,
      situation: this.situation(payment, linkValid, expiry),
      collected: isCollected(payment),
      createdAt: iso(payment.createdAt),
      initiatedAt: iso(payment.initiatedAt),
      confirmedAt: iso(payment.confirmedAt),
      failedAt: iso(payment.failedAt),
    };
  }
}
