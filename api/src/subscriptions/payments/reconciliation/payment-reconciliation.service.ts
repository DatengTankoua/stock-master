import { createHash } from 'crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from '../../subscriptions.service';
import { SUBSCRIPTION_CLOCK } from '../../subscription-clock';
import type { SubscriptionClock } from '../../subscription-clock';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentIncident,
  SubscriptionPaymentStatus,
} from '../schemas/subscription-payment.schema';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
  PaymentProviderInconsistencyError,
  confirmationProviderFor,
} from '../payment-provider';
import type {
  PaymentProvider,
  ProviderPaymentStatus,
} from '../payment-provider';
import {
  ConcordanceField,
  paymentConcordanceMismatches,
} from '../payment-concordance';
import {
  PAYMENT_CONFIRMATION_BUDGET_MS,
  PaymentRecord,
  SubscriptionPaymentsService,
} from '../subscription-payments.service';
import {
  subscriptionPaymentDuplicateKeyIndex,
  verifySubscriptionPaymentIndexes,
} from '../subscription-payment-indexes';
import {
  ReconciliationAction,
  ReconciliationReason,
  SubscriptionPaymentReconciliation,
  SubscriptionPaymentReconciliationDocument,
} from './subscription-payment-reconciliation.schema';
import {
  isReconciliationOperationDuplicate,
  verifyReconciliationIndexes,
} from './subscription-payment-reconciliation-indexes';

/**
 * 1-14D.2G — Rapprochement OPÉRATEUR d'un paiement `uncertain` ou `review`.
 *
 * Accès : CLI uniquement (aucune route HTTP, aucun droit propriétaire).
 * L'autorisation repose sur l'accès privilégié à l'environnement d'exécution
 * (base de production, secrets) ; l'identifiant opérateur sert à l'AUDIT.
 *
 * Règles :
 * - la référence CamPay consultée est la référence PERSISTÉE, sinon une
 *   référence CANDIDATE fournie par l'opérateur (simple indice) ; une
 *   référence persistée n'est jamais remplacée ; une candidate déjà portée
 *   par un autre paiement est refusée ;
 * - consultation UNIQUEMENT par référence prestataire (`fetchStatus`), HORS
 *   transaction, avec le budget HTTP de l'adaptateur ; aucune recherche par
 *   référence marchand, aucun autre endpoint, aucune initiation ;
 * - concordance EXACTE (référence CamPay = consultée, référence marchand,
 *   montant entier validé lexicalement, devise) : sinon AUCUNE mutation, état
 *   et référence conservés — même pour un paiement `review` ;
 * - action DÉDUITE du statut vérifié : `succeeded` → attribution
 *   `source: payment` (`payment:<id>`) + `succeeded` via la fonction du
 *   moteur unique ; `pending` → paiement ouvert `pending` ; `failed` →
 *   fermeture `failed` ;
 * - simulation par défaut ; `apply` relit le paiement, reconsulte le
 *   prestataire et exige le MÊME plan (jeton) : sinon `PLAN_STALE` ;
 * - mutation, rattachement, période et audit dans UNE transaction (budget
 *   de 30 s), identifiant d'opération idempotent.
 * Fournisseur injecté (`PAYMENT_PROVIDER`) : avec `UnavailablePaymentProvider`
 * (production), aucune consultation ni mutation n'est possible.
 */

export const RECONCILABLE_STATUSES: readonly SubscriptionPaymentStatus[] =
  Object.freeze([
    SubscriptionPaymentStatus.UNCERTAIN,
    SubscriptionPaymentStatus.REVIEW,
  ]);

export type ReconciliationBlockReason =
  | 'status-not-reconcilable'
  | 'closed-review-cannot-reopen'
  | 'provider-unavailable'
  | 'reference-required'
  | 'reference-differs-from-persisted'
  | 'reference-already-attached'
  | 'provider-status-unavailable'
  | 'provider-transaction-not-found'
  | 'mismatch'
  // 1-21B : session close sans succès ; clôture seulement sur demande
  // explicite de l'opérateur (`--close-unresolved`).
  | 'provider-unresolved'
  | 'close-unresolved-not-applicable'
  | 'provider-inconsistent'
  // 1-21E : encaissement d'une tentative remplacée ou d'un renouvellement
  // déjà attribué : aucune période sans décision explicite (accord du
  // client, `--grant-renewal-conflict`).
  | 'renewal-conflict'
  | 'grant-renewal-conflict-not-applicable'
  // 1-21E : renouvellement déjà réglé par une autre tentative (le forfait
  // initial ne peut plus être retenu ; achat supplémentaire seulement).
  | 'renewal-already-settled'
  // 1-21E : remboursement consigné → plus aucune action ; option sans objet.
  | 'refunded'
  | 'record-refund-not-applicable'
  | 'conflicting-options'
  // 1-22D.3 : recherche par référence marchand (aucune référence connue).
  // Sans résultat : jamais une preuve d'absence.
  | 'lookup-not-found'
  | 'lookup-incomplete'
  | 'lookup-unavailable'
  // 1-22D.3 : clôture exceptionnelle sans session (preuve externe exigée).
  | 'close-without-session-not-applicable'
  | 'proof-required';

/**
 * 1-22D.3 — Résultat AFFICHÉ de la recherche par référence marchand :
 * `not-found` (liste lue jusqu'au bout), `incomplete` (borne atteinte),
 * `unavailable`, `inconsistent` (plusieurs sessions). Jamais une preuve
 * d'absence (`proofOfAbsence` toujours `false`).
 */
export interface MerchantLookupReport {
  outcome:
    'found' | 'not-found' | 'incomplete' | 'unavailable' | 'inconsistent';
  providerReference: string | null;
  pagesRead: number | null;
  proofOfAbsence: false;
}

/** Faits VÉRIFIÉS exposés (normalisés) ; jamais la réponse brute. */
export interface VerifiedFacts {
  state: ProviderPaymentStatus['state'];
  providerReference: string | null;
  merchantReference: string | null;
  amount: number | null;
  currency: string | null;
}

export interface PlanBefore {
  status: SubscriptionPaymentStatus;
  open: boolean;
  providerReference: string | null;
}

export type ReconciliationPlan =
  | {
      decision: 'blocked';
      reason: ReconciliationBlockReason;
      paymentId: string;
      before: PlanBefore;
      consultedReference: string | null;
      verified: VerifiedFacts | null;
      mismatches: ConcordanceField[];
      lookup?: MerchantLookupReport;
    }
  | {
      decision: 'ready';
      action: ReconciliationAction;
      paymentId: string;
      before: PlanBefore;
      /** `null` seulement pour une clôture sans session (1-22D.3). */
      consultedReference: string | null;
      referenceAttach: boolean;
      verified: VerifiedFacts | null;
      lookup?: MerchantLookupReport;
      after: {
        status: SubscriptionPaymentStatus;
        open: boolean;
        grantsPeriod: boolean;
      };
      planToken: string;
    };

/** 1-21B — options de plan (simulation ET application, même jeton). */
export interface ReconciliationOptions {
  /**
   * Clôturer (`failed`) un paiement dont la page de paiement est close sans
   * succès : l'opérateur atteste que le prestataire a confirmé l'absence de
   * débit. Sans effet sur tout autre état vérifié.
   */
  closeUnresolved?: boolean;
  /**
   * 1-21E — Attribuer une période à un encaissement EN CONFLIT de
   * renouvellement (tentative remplacée, renouvellement déjà attribué) :
   * l'opérateur atteste l'accord du client (achat supplémentaire, ou ancien
   * forfait retenu). Attribution manuelle : ne revendique pas l'attribution
   * automatique du renouvellement. Sans effet sur tout autre paiement.
   */
  grantRenewalConflict?: GrantRenewalConflictMode;
  /**
   * 1-21E — Consigner un remboursement effectué HORS de Stock Master pour un
   * encaissement en résolution (aucune période attribuée). Définitif.
   */
  recordRefund?: boolean;
  /**
   * 1-22D.3 — Clôture EXCEPTIONNELLE d'une création incertaine dont aucune
   * session n'est retrouvée : référence de la preuve EXTERNE (ticket ou
   * confirmation écrite du prestataire), reprise dans le plan et l'audit.
   */
  closeWithoutSessionProof?: string;
}

/**
 * 1-21E — `renewal` : le client retient le forfait de CE paiement pour son
 * renouvellement (règle le renouvellement : une seule attribution, toute
 * attribution ultérieure du même renouvellement est refusée) ;
 * `additional` : achat SUPPLÉMENTAIRE explicitement accepté (période en
 * plus, le renouvellement n'est pas réglé par ce paiement).
 */
export type GrantRenewalConflictMode = 'renewal' | 'additional';

/** 1-21E — options du plan, dans l'empreinte et le jeton. */
function optionMarkers(options: ReconciliationOptions): string[] {
  return [
    ...(options.closeUnresolved ? ['close-unresolved'] : []),
    ...(options.grantRenewalConflict
      ? [`grant-renewal-conflict:${options.grantRenewalConflict}`]
      : []),
    ...(options.recordRefund ? ['record-refund'] : []),
    ...(options.closeWithoutSessionProof !== undefined
      ? [`close-without-session:${options.closeWithoutSessionProof}`]
      : []),
  ];
}

export interface ReconciliationOperation {
  operationId: string;
  operatorId: string;
  reasonCode: ReconciliationReason;
  reasonTicket: string | null;
  planToken: string;
}

export interface AppliedReconciliation {
  result: 'applied' | 'replayed';
  operationId: string;
  paymentId: string;
  action: ReconciliationAction;
  consultedReference: string | null;
  referenceAttached: boolean;
  before: {
    status: SubscriptionPaymentStatus;
    providerReference: string | null;
  };
  after: {
    status: SubscriptionPaymentStatus;
    providerReference: string | null;
    periodId: string | null;
  };
  appliedAt: string;
}

export type ReconciliationErrorCode =
  | 'PAYMENT_NOT_FOUND'
  | 'INVALID_REFERENCE'
  | 'PLAN_STALE'
  | 'OPERATION_CONFLICT'
  | 'CONFIRMATION_PENDING'
  | 'PROOF_REQUIRED';

export class ReconciliationError extends Error {
  constructor(
    readonly code: ReconciliationErrorCode,
    message: string,
    readonly currentPlan: ReconciliationPlan | null = null,
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

export interface PaymentInspection {
  paymentId: string;
  organizationId: string;
  provider: string;
  status: SubscriptionPaymentStatus;
  open: boolean;
  reconcilable: boolean;
  term: string;
  amount: number;
  currency: string;
  merchantReference: string;
  providerReference: string | null;
  incidentCode: string | null;
  /** 1-21E — encaissement confirmé (statut financier), ISO ou `null`. */
  collectedAt: string | null;
  /** 1-21E — renouvellement, tentative remplacée, attribution automatique. */
  renewalId: string;
  replacesPaymentId: string | null;
  renewalAutoGranted: boolean;
  periodId: string | null;
  createdAt: string | null;
  initiatedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  lastCheckedAt: string | null;
  reconciliations: {
    operationId: string;
    operatorId: string;
    reasonCode: ReconciliationReason;
    reasonTicket: string | null;
    action: ReconciliationAction;
    beforeStatus: SubscriptionPaymentStatus;
    afterStatus: SubscriptionPaymentStatus;
    consultedReference: string | null;
    referenceAttached: boolean;
    appliedAt: string;
  }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStrictObjectId = (value: string) => /^[0-9a-fA-F]{24}$/.test(value);
const iso = (date: Date | null | undefined) =>
  date ? date.toISOString() : null;

type ReconciliationRecord = SubscriptionPaymentReconciliation & {
  _id: Types.ObjectId;
};

/** Plan interne : conserve le statut vérifié complet (jamais exposé brut). */
type InternalPlan =
  | { plan: Extract<ReconciliationPlan, { decision: 'blocked' }> }
  | {
      plan: Extract<ReconciliationPlan, { decision: 'ready' }>;
      /** `null` : clôture sans session (aucun statut lu). */
      status: ProviderPaymentStatus | null;
    };

/** 1-22D.3 — Recherche sans session exploitable → motif du blocage. */
const LOOKUP_BLOCK: Readonly<
  Record<MerchantLookupReport['outcome'], ReconciliationBlockReason>
> = Object.freeze({
  found: 'lookup-unavailable',
  'not-found': 'lookup-not-found',
  incomplete: 'lookup-incomplete',
  unavailable: 'lookup-unavailable',
  inconsistent: 'provider-inconsistent',
});

const ACTION_BY_STATE: Readonly<
  Record<
    Exclude<ProviderPaymentStatus['state'], 'unresolved'>,
    ReconciliationAction
  >
> = Object.freeze({
  succeeded: ReconciliationAction.SUCCEED,
  pending: ReconciliationAction.MARK_PENDING,
  failed: ReconciliationAction.FAIL,
});

function facts(status: ProviderPaymentStatus): VerifiedFacts {
  return {
    state: status.state,
    providerReference:
      typeof status.providerReference === 'string'
        ? status.providerReference
        : null,
    merchantReference:
      typeof status.merchantReference === 'string'
        ? status.merchantReference
        : null,
    amount:
      typeof status.amount === 'number' && Number.isSafeInteger(status.amount)
        ? status.amount
        : null,
    currency: typeof status.currency === 'string' ? status.currency : null,
  };
}

const sha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class PaymentReconciliationService {
  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPaymentDocument>,
    @InjectModel(SubscriptionPaymentReconciliation.name)
    private readonly reconciliationModel: Model<SubscriptionPaymentReconciliationDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly subscriptions: SubscriptionsService,
    private readonly payments: SubscriptionPaymentsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(SUBSCRIPTION_CLOCK) private readonly clock: SubscriptionClock,
    @Optional()
    @Inject(PAYMENT_CONFIRMATION_PROVIDERS)
    private readonly confirmers?: readonly PaymentProvider[],
  ) {}

  /** Normalise une référence candidate (UUID, minuscules) ; sinon erreur. */
  static normalizeReference(reference: string | null): string | null {
    if (reference === null) return null;
    if (!UUID.test(reference)) {
      throw new ReconciliationError(
        'INVALID_REFERENCE',
        'Référence du prestataire invalide (UUID attendu).',
      );
    }
    return reference.toLowerCase();
  }

  // ─── Inspection (locale, aucun réseau) ─────────────────────────────────────

  async inspect(paymentId: string): Promise<PaymentInspection> {
    const payment = await this.load(paymentId);
    const history = await this.reconciliationModel
      .find({ paymentId: payment._id })
      .sort({ _id: 1 })
      .lean<ReconciliationRecord[]>()
      .exec();
    return {
      paymentId: payment._id.toHexString(),
      organizationId: payment.organizationId.toHexString(),
      provider: payment.provider,
      status: payment.status,
      open: payment.open,
      reconcilable: RECONCILABLE_STATUSES.includes(payment.status),
      term: payment.term,
      amount: payment.amount,
      currency: payment.currency,
      merchantReference: payment.merchantReference,
      providerReference: payment.providerReference ?? null,
      incidentCode: payment.incidentCode ?? null,
      collectedAt: payment.collectedAt
        ? new Date(payment.collectedAt).toISOString()
        : null,
      renewalId: (payment.renewalId ?? payment._id).toHexString(),
      replacesPaymentId: payment.replacesPaymentId?.toHexString() ?? null,
      renewalAutoGranted: payment.autoGrantRenewalId != null,
      periodId: payment.periodId ? payment.periodId.toHexString() : null,
      createdAt: iso(payment.createdAt),
      initiatedAt: iso(payment.initiatedAt),
      confirmedAt: iso(payment.confirmedAt),
      failedAt: iso(payment.failedAt),
      lastCheckedAt: iso(payment.lastCheckedAt),
      reconciliations: history.map((r) => ({
        operationId: r.operationId,
        operatorId: r.operatorId,
        reasonCode: r.reasonCode,
        reasonTicket: r.reasonTicket ?? null,
        action: r.action,
        beforeStatus: r.beforeStatus,
        afterStatus: r.afterStatus,
        consultedReference: r.consultedReference ?? null,
        referenceAttached: r.referenceAttached,
        appliedAt: r.appliedAt.toISOString(),
      })),
    };
  }

  // ─── Simulation (consultation en lecture, aucune écriture) ─────────────────

  async plan(
    paymentId: string,
    candidateReference: string | null,
    options: ReconciliationOptions = {},
  ): Promise<ReconciliationPlan> {
    return (await this.buildPlan(paymentId, candidateReference, options)).plan;
  }

  // ─── Application ───────────────────────────────────────────────────────────

  async apply(
    paymentId: string,
    candidateReference: string | null,
    operation: ReconciliationOperation,
    options: ReconciliationOptions = {},
  ): Promise<AppliedReconciliation | ReconciliationPlan> {
    // Index requis AVANT toute mutation (aucune création automatique).
    await verifySubscriptionPaymentIndexes(this.connection);
    await verifyReconciliationIndexes(this.connection);

    const candidate =
      PaymentReconciliationService.normalizeReference(candidateReference);
    // 1-22D.3 : la clôture sans session exige SON motif et la MÊME preuve
    // que la simulation ; ce motif ne vaut pour aucune autre action.
    const closing = options.closeWithoutSessionProof !== undefined;
    if (
      closing !==
        (operation.reasonCode === ReconciliationReason.PROVIDER_NO_SESSION) ||
      (closing &&
        (!options.closeWithoutSessionProof ||
          operation.reasonTicket !== options.closeWithoutSessionProof))
    ) {
      throw new ReconciliationError(
        'PROOF_REQUIRED',
        'Clôture sans session : --reason=provider-no-session et --ticket=<preuve> identiques à la simulation exigés. Aucune mutation.',
      );
    }
    const fingerprint = sha256([
      'reconciliation-v1',
      paymentId.toLowerCase(),
      candidate,
      operation.operatorId,
      operation.reasonCode,
      operation.reasonTicket,
      operation.planToken,
      // 1-21B : absent des anciennes empreintes (rejeu inchangé).
      ...optionMarkers(options),
    ]);

    // 1. Rejeu AVANT tout réseau : même identifiant → même résultat.
    const previous = await this.findOperation(operation.operationId);
    if (previous) return this.replay(previous, fingerprint);

    // 2. Plan RECALCULÉ (relecture + reconsultation) ; jeton identique exigé.
    const built = await this.buildPlan(paymentId, candidate, options);
    if (!('status' in built)) return built.plan;
    if (built.plan.planToken !== operation.planToken) {
      throw new ReconciliationError(
        'PLAN_STALE',
        'Plan obsolète : le paiement ou le statut vérifié a changé. Aucune mutation.',
        built.plan,
      );
    }
    const { plan, status } = built;

    // 3. Mutation + audit dans UNE transaction (aucun réseau).
    let outcome:
      | { kind: 'applied'; record: ReconciliationRecord }
      | { kind: 'replay'; record: ReconciliationRecord }
      | { kind: 'stale' };
    try {
      outcome = await this.subscriptions.runInGrantTransaction(
        async (session) => {
          const already = await this.reconciliationModel
            .findOne({ operationId: operation.operationId })
            .session(session)
            .lean<ReconciliationRecord>()
            .exec();
          if (already) return { kind: 'replay' as const, record: already };

          const current = await this.paymentModel
            .findById(plan.paymentId)
            .session(session)
            .lean<PaymentRecord>()
            .exec();
          // Préconditions du plan revérifiées DANS la session.
          if (
            !current ||
            current.status !== plan.before.status ||
            current.open !== plan.before.open ||
            (current.providerReference ?? null) !==
              plan.before.providerReference ||
            (current.periodId ?? null) !== null ||
            (status === null || plan.consultedReference === null
              ? // 1-22D.3 : clôture sans session — toujours sans
                // rattachement, transaction ni encaissement.
                !this.closableWithoutSession(current)
              : paymentConcordanceMismatches(
                  current,
                  status,
                  plan.consultedReference,
                ).length > 0)
          ) {
            return { kind: 'stale' as const };
          }

          const now = this.clock();
          let periodId: Types.ObjectId | null = null;
          if (plan.action === ReconciliationAction.CLOSE_WITHOUT_SESSION) {
            // 1-22D.3 : paiement, référence marchand, opération et
            // renouvellement conservés ; tentative close comme une page
            // fermée sans transaction (succès tardif encore relu, 1-21E).
            const updated = await this.paymentModel
              .updateOne(
                {
                  _id: current._id,
                  status: SubscriptionPaymentStatus.UNCERTAIN,
                  open: true,
                  providerReference: null,
                  providerTransactionId: null,
                  collectedAt: null,
                  periodId: null,
                  refundedAt: null,
                },
                {
                  $set: {
                    status: SubscriptionPaymentStatus.FAILED,
                    open: false,
                    failedAt: now,
                    incidentCode: SubscriptionPaymentIncident.CHECKOUT_CLOSED,
                    lastCheckedAt: now,
                  },
                },
                { session },
              )
              .exec();
            if (updated.modifiedCount !== 1) {
              throw new Error('Reconciliation lost its race');
            }
          } else if (plan.action === ReconciliationAction.SUCCEED) {
            periodId = await this.payments.grantAndMarkSucceededInSession(
              session,
              current,
              status!,
              { claimRenewal: options.grantRenewalConflict !== 'additional' },
            );
          } else if (plan.action === ReconciliationAction.RECORD_REFUND) {
            const updated = await this.paymentModel
              .updateOne(
                {
                  _id: current._id,
                  status: SubscriptionPaymentStatus.REVIEW,
                  periodId: null,
                  refundedAt: null,
                },
                {
                  $set: {
                    refundedAt: now,
                    incidentCode: SubscriptionPaymentIncident.REFUNDED_OUTSIDE,
                    open: false,
                    lastCheckedAt: now,
                  },
                },
                { session },
              )
              .exec();
            if (updated.modifiedCount !== 1) {
              throw new Error('Reconciliation lost its race');
            }
          } else {
            const set =
              plan.action === ReconciliationAction.MARK_PENDING
                ? {
                    status: SubscriptionPaymentStatus.PENDING,
                    providerReference: plan.consultedReference,
                    incidentCode: null,
                    initiatedAt: current.initiatedAt ?? now,
                    lastCheckedAt: now,
                  }
                : {
                    status: SubscriptionPaymentStatus.FAILED,
                    open: false,
                    providerReference: plan.consultedReference,
                    failedAt: now,
                    lastCheckedAt: now,
                  };
            const updated = await this.paymentModel
              .updateOne(
                {
                  _id: current._id,
                  status: current.status,
                  providerReference: current.providerReference ?? null,
                  periodId: null,
                },
                { $set: set },
                { session },
              )
              .exec();
            if (updated.modifiedCount !== 1) {
              throw new Error('Reconciliation lost its race');
            }
          }

          const [record] = await this.reconciliationModel.create(
            [
              {
                operationId: operation.operationId,
                requestFingerprint: fingerprint,
                operatorId: operation.operatorId,
                reasonCode: operation.reasonCode,
                reasonTicket: operation.reasonTicket,
                paymentId: current._id,
                organizationId: current.organizationId,
                planToken: plan.planToken,
                action: plan.action,
                consultedReference: plan.consultedReference,
                referenceAttached: plan.referenceAttach,
                beforeStatus: current.status,
                beforeProviderReference: current.providerReference ?? null,
                afterStatus: plan.after.status,
                afterProviderReference: plan.consultedReference,
                afterPeriodId: periodId,
                verifiedState: status?.state ?? 'no-session',
                // Égalités revérifiées ci-dessus dans la session.
                verifiedProviderReference: plan.consultedReference,
                verifiedMerchantReference: current.merchantReference,
                verifiedAmount: current.amount,
                verifiedCurrency: current.currency,
                result: 'applied',
                appliedAt: now,
              },
            ],
            { session },
          );
          return {
            kind: 'applied' as const,
            record: record.toObject(),
          };
        },
        { budgetMs: PAYMENT_CONFIRMATION_BUDGET_MS },
      );
    } catch (error) {
      if (
        error instanceof SubscriptionGrantError &&
        (error.code === 'GRANT_TIMEOUT' || error.code === 'GRANT_CONTENTION')
      ) {
        // Résultat de commit INCONNU : rejouer avec le MÊME identifiant
        // retrouve un commit validé (audit), sans seconde période.
        throw new ReconciliationError(
          'CONFIRMATION_PENDING',
          'Rapprochement non confirmé dans le délai : rejouer la même opération.',
        );
      }
      if (isReconciliationOperationDuplicate(error)) {
        const concurrent = await this.findOperation(operation.operationId);
        if (concurrent) return this.replay(concurrent, fingerprint);
      }
      // 1-21E : renouvellement réglé entre-temps par une autre tentative
      // (index unique) : rollback complet, aucune seconde période.
      if (
        subscriptionPaymentDuplicateKeyIndex(error) === 'autoGrantRenewalId_1'
      ) {
        return {
          decision: 'blocked',
          reason: 'renewal-already-settled',
          paymentId: plan.paymentId,
          before: plan.before,
          consultedReference: plan.consultedReference,
          verified: plan.verified,
          mismatches: [],
        };
      }
      if (
        subscriptionPaymentDuplicateKeyIndex(error) ===
        'provider_1_providerReference_1'
      ) {
        // Référence rattachée à un autre paiement entre-temps : rollback
        // complet (ni rattachement, ni audit, ni période).
        return {
          decision: 'blocked',
          reason: 'reference-already-attached',
          paymentId: plan.paymentId,
          before: plan.before,
          consultedReference: plan.consultedReference,
          verified: plan.verified,
          mismatches: [],
        };
      }
      throw error;
    }

    if (outcome.kind === 'replay')
      return this.replay(outcome.record, fingerprint);
    if (outcome.kind === 'stale') {
      throw new ReconciliationError(
        'PLAN_STALE',
        'Plan obsolète : le paiement a changé pendant l’application. Aucune mutation.',
        (await this.buildPlan(paymentId, candidate, options).catch(() => null))
          ?.plan ?? null,
      );
    }
    // 1-21E : forfait initial retenu → le renouvellement est réglé ; la
    // poursuite des autres tentatives ouvertes est suspendue (au mieux).
    if (
      plan.action === ReconciliationAction.SUCCEED &&
      options.grantRenewalConflict !== 'additional'
    ) {
      await this.payments
        .suspendReplacements(new Types.ObjectId(plan.paymentId))
        .catch(() => undefined);
    }
    return this.toApplied(outcome.record, 'applied');
  }

  // ─── Internes ──────────────────────────────────────────────────────────────

  private async load(paymentId: string): Promise<PaymentRecord> {
    const payment = isStrictObjectId(paymentId)
      ? await this.paymentModel
          .findById(new Types.ObjectId(paymentId))
          .lean<PaymentRecord>()
          .exec()
      : null;
    if (!payment) {
      throw new ReconciliationError(
        'PAYMENT_NOT_FOUND',
        'Paiement introuvable.',
      );
    }
    return payment;
  }

  private async buildPlan(
    paymentId: string,
    candidateReference: string | null,
    options: ReconciliationOptions = {},
  ): Promise<InternalPlan> {
    const candidate =
      PaymentReconciliationService.normalizeReference(candidateReference);
    const payment = await this.load(paymentId);
    const before: PlanBefore = {
      status: payment.status,
      open: payment.open,
      providerReference: payment.providerReference ?? null,
    };
    // 1-22D.3 : recherche par référence marchand, affichée dans le plan.
    let lookup: MerchantLookupReport | undefined;
    const blocked = (
      reason: ReconciliationBlockReason,
      consultedReference: string | null = null,
      verified: VerifiedFacts | null = null,
      mismatches: ConcordanceField[] = [],
    ): InternalPlan => ({
      plan: {
        decision: 'blocked',
        reason,
        paymentId: payment._id.toHexString(),
        before,
        consultedReference,
        verified,
        mismatches,
        ...(lookup ? { lookup } : {}),
      },
    });

    // 1-21E : remboursement consigné → définitif, plus aucune action.
    if (payment.refundedAt) return blocked('refunded');
    if (optionMarkers(options).length > 1)
      return blocked('conflicting-options');
    // 1-21E : tentative close sans encaissement (`checkout_closed`), au-delà
    // des fenêtres automatiques : rapprochable pour un succès tardif SEULEMENT.
    const closedAttempt =
      payment.status === SubscriptionPaymentStatus.FAILED &&
      payment.incidentCode === SubscriptionPaymentIncident.CHECKOUT_CLOSED;
    if (!RECONCILABLE_STATUSES.includes(payment.status) && !closedAttempt) {
      return blocked('status-not-reconcilable');
    }
    // 1-21B : adaptateur DU paiement (jamais celui d'un autre prestataire).
    const provider = confirmationProviderFor(
      payment.provider,
      this.provider,
      this.confirmers,
    );
    if (!provider) return blocked('provider-unavailable');
    const persisted = payment.providerReference ?? null;
    if (persisted !== null && candidate !== null && candidate !== persisted) {
      return blocked('reference-differs-from-persisted', persisted);
    }
    let reference = persisted ?? candidate;
    const closing = options.closeWithoutSessionProof !== undefined;
    // 1-22D.3 : clôture sans session seulement pour une création incertaine
    // jamais rattachée, sans encaissement ; jamais avec une référence.
    if (closing) {
      if (reference !== null || !this.closableWithoutSession(payment)) {
        return blocked('close-without-session-not-applicable', reference);
      }
      if (!options.closeWithoutSessionProof) return blocked('proof-required');
    }
    if (reference === null) {
      if (!provider.lookupByMerchantReference) {
        return blocked('reference-required');
      }
      lookup = await this.lookupSession(provider, payment.merchantReference);
      if (lookup.outcome === 'found' && lookup.providerReference) {
        // Session retrouvée : rattachement par les contrôles habituels ;
        // une clôture n'a plus d'objet.
        if (closing) {
          return blocked(
            'close-without-session-not-applicable',
            lookup.providerReference,
          );
        }
        reference = lookup.providerReference;
      } else if (closing && lookup.outcome === 'not-found') {
        return this.closurePlan(payment, before, lookup, options);
      } else {
        return blocked(LOOKUP_BLOCK[lookup.outcome]);
      }
    }
    if (persisted === null) {
      const holder = await this.paymentModel
        .findOne({
          provider: payment.provider,
          providerReference: reference,
          _id: { $ne: payment._id },
        })
        .select({ _id: 1 })
        .lean()
        .exec();
      if (holder) return blocked('reference-already-attached', reference);
    }

    // Consultation HORS transaction (budget HTTP de l'adaptateur).
    let status: ProviderPaymentStatus | null;
    try {
      status = await provider.fetchStatus({
        by: 'provider',
        providerReference: reference,
      });
    } catch (error) {
      if (error instanceof PaymentProviderInconsistencyError) {
        return blocked('provider-inconsistent', reference);
      }
      return blocked('provider-status-unavailable', reference);
    }
    if (!status) return blocked('provider-transaction-not-found', reference);

    const verified = facts(status);
    const mismatches = paymentConcordanceMismatches(payment, status, reference);
    if (mismatches.length > 0) {
      return blocked('mismatch', reference, verified, mismatches);
    }

    // 1-21E : remboursement externe d'un encaissement EN RÉSOLUTION (aucune
    // période), toujours réussi chez le prestataire.
    if (options.recordRefund) {
      if (
        payment.status !== SubscriptionPaymentStatus.REVIEW ||
        !payment.collectedAt ||
        payment.periodId ||
        status.state !== 'succeeded'
      ) {
        return blocked('record-refund-not-applicable', reference, verified);
      }
      const refundAfter = {
        status: SubscriptionPaymentStatus.REVIEW,
        open: false,
        grantsPeriod: false,
      };
      const refundToken = sha256([
        'reconciliation-plan-v1',
        payment._id.toHexString(),
        before,
        reference,
        ReconciliationAction.RECORD_REFUND,
        verified,
        ...optionMarkers(options),
        ...(lookup ? [lookup] : []),
      ]).slice(0, 32);
      return {
        plan: {
          decision: 'ready',
          action: ReconciliationAction.RECORD_REFUND,
          paymentId: payment._id.toHexString(),
          before,
          consultedReference: reference,
          referenceAttach: persisted === null,
          verified,
          ...(lookup ? { lookup } : {}),
          after: refundAfter,
          planToken: refundToken,
        },
        status,
      };
    }

    if (options.closeUnresolved && status.state !== 'unresolved') {
      return blocked('close-unresolved-not-applicable', reference, verified);
    }
    if (status.state === 'unresolved' && !options.closeUnresolved) {
      return blocked('provider-unresolved', reference, verified);
    }
    const action =
      status.state === 'unresolved'
        ? ReconciliationAction.FAIL
        : ACTION_BY_STATE[status.state];
    // 1-21E : jamais d'attribution silencieuse d'un encaissement en conflit
    // de renouvellement ; l'option n'a d'effet que sur ce cas.
    if (closedAttempt && action !== ReconciliationAction.SUCCEED) {
      return blocked('status-not-reconcilable', reference, verified);
    }
    const conflict =
      action === ReconciliationAction.SUCCEED &&
      (await this.payments.renewalConflictOf(payment));
    if (
      conflict &&
      options.grantRenewalConflict === 'renewal' &&
      (await this.payments.renewalSettledByOther(payment))
    ) {
      return blocked('renewal-already-settled', reference, verified);
    }
    if (options.grantRenewalConflict && !conflict) {
      return blocked(
        'grant-renewal-conflict-not-applicable',
        reference,
        verified,
      );
    }
    if (conflict && !options.grantRenewalConflict) {
      return blocked('renewal-conflict', reference, verified);
    }
    if (action === ReconciliationAction.MARK_PENDING && !payment.open) {
      // `review` issu d'un paiement fermé : jamais de réouverture (index du
      // paiement ouvert unique), traitement hors de ce CLI.
      return blocked('closed-review-cannot-reopen', reference, verified);
    }
    const after = {
      status:
        action === ReconciliationAction.SUCCEED
          ? SubscriptionPaymentStatus.SUCCEEDED
          : action === ReconciliationAction.FAIL
            ? SubscriptionPaymentStatus.FAILED
            : SubscriptionPaymentStatus.PENDING,
      open: action === ReconciliationAction.MARK_PENDING,
      grantsPeriod: action === ReconciliationAction.SUCCEED,
    };
    const paymentKey = payment._id.toHexString();
    const planToken = sha256([
      'reconciliation-plan-v1',
      paymentKey,
      before,
      reference,
      action,
      verified,
      ...optionMarkers(options),
      ...(lookup ? [lookup] : []),
    ]).slice(0, 32);
    return {
      plan: {
        decision: 'ready',
        action,
        paymentId: paymentKey,
        before,
        consultedReference: reference,
        referenceAttach: persisted === null,
        verified,
        ...(lookup ? { lookup } : {}),
        after,
        planToken,
      },
      status,
    };
  }

  /**
   * 1-22D.3 — Création incertaine jamais rattachée : aucune référence ni
   * transaction prestataire, aucun encaissement, aucune période.
   */
  private closableWithoutSession(payment: PaymentRecord): boolean {
    return (
      payment.status === SubscriptionPaymentStatus.UNCERTAIN &&
      payment.incidentCode ===
        SubscriptionPaymentIncident.INITIATION_UNCERTAIN &&
      payment.open &&
      !payment.providerReference &&
      !payment.providerTransactionId &&
      !payment.collectedAt &&
      !payment.periodId &&
      !payment.refundedAt
    );
  }

  /**
   * 1-22D.3 — Plan de clôture EXCEPTIONNELLE : recherche COMPLÈTE sans
   * résultat (contrôle de sécurité, jamais la preuve) ET preuve externe
   * référencée (`closeWithoutSessionProof`, dans le jeton). Effet prévu :
   * `failed` / `checkout_closed`, paiement et liens conservés.
   */
  private closurePlan(
    payment: PaymentRecord,
    before: PlanBefore,
    lookup: MerchantLookupReport,
    options: ReconciliationOptions,
  ): InternalPlan {
    const paymentKey = payment._id.toHexString();
    const action = ReconciliationAction.CLOSE_WITHOUT_SESSION;
    return {
      plan: {
        decision: 'ready',
        action,
        paymentId: paymentKey,
        before,
        consultedReference: null,
        referenceAttach: false,
        verified: null,
        lookup,
        after: {
          status: SubscriptionPaymentStatus.FAILED,
          open: false,
          grantsPeriod: false,
        },
        planToken: sha256([
          'reconciliation-plan-v1',
          paymentKey,
          before,
          null,
          action,
          lookup,
          ...optionMarkers(options),
        ]).slice(0, 32),
      },
      status: null,
    };
  }

  /** 1-22D.3 — Recherche bornée par référence marchand, jamais une preuve. */
  private async lookupSession(
    provider: PaymentProvider,
    merchantReference: string,
  ): Promise<MerchantLookupReport> {
    const report = (
      outcome: MerchantLookupReport['outcome'],
      providerReference: string | null = null,
      pagesRead: number | null = null,
    ): MerchantLookupReport => ({
      outcome,
      providerReference,
      pagesRead,
      proofOfAbsence: false,
    });
    try {
      const found =
        await provider.lookupByMerchantReference!(merchantReference);
      return found.outcome === 'found'
        ? report('found', found.providerReference)
        : report(
            found.complete ? 'not-found' : 'incomplete',
            null,
            found.pagesRead,
          );
    } catch (error) {
      return report(
        error instanceof PaymentProviderInconsistencyError
          ? 'inconsistent'
          : 'unavailable',
      );
    }
  }

  private findOperation(
    operationId: string,
  ): Promise<ReconciliationRecord | null> {
    return this.reconciliationModel
      .findOne({ operationId })
      .lean<ReconciliationRecord>()
      .exec();
  }

  private replay(
    record: ReconciliationRecord,
    fingerprint: string,
  ): AppliedReconciliation {
    if (record.requestFingerprint !== fingerprint) {
      throw new ReconciliationError(
        'OPERATION_CONFLICT',
        'Identifiant d’opération déjà utilisé avec d’autres paramètres. Aucune mutation.',
      );
    }
    return this.toApplied(record, 'replayed');
  }

  private toApplied(
    record: ReconciliationRecord,
    result: 'applied' | 'replayed',
  ): AppliedReconciliation {
    return {
      result,
      operationId: record.operationId,
      paymentId: record.paymentId.toHexString(),
      action: record.action,
      consultedReference: record.consultedReference ?? null,
      referenceAttached: record.referenceAttached,
      before: {
        status: record.beforeStatus,
        providerReference: record.beforeProviderReference ?? null,
      },
      after: {
        status: record.afterStatus,
        providerReference: record.afterProviderReference ?? null,
        periodId: record.afterPeriodId
          ? record.afterPeriodId.toHexString()
          : null,
      },
      appliedAt: record.appliedAt.toISOString(),
    };
  }
}
