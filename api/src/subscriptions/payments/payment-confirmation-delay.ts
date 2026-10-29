import { SASPAY_PROVIDER_NAME } from './saspay/saspay-config';

/**
 * Retards de confirmation SasPay — règles PURES (sans base ni réseau),
 * partagées par la vue du propriétaire et l'alerte de l'administration.
 * Testées par `payment-confirmation-delay.spec.ts`.
 *
 * SasPay annonce que certains paiements réussis peuvent rester
 * temporairement « en attente » et demande d'ouvrir un ticket, avec la
 * référence de transaction, si le statut n'est pas actualisé après 24 h.
 * SasPay ne fournit ni nouvel état, ni délai d'expiration, ni garantie : ce
 * seuil sert seulement à informer (client, opérateur). Il ne change JAMAIS
 * l'état d'un paiement (aucun `failed`, `review` ni `succeeded` sur délai).
 */

/** Seuil annoncé par SasPay avant d'ouvrir un ticket d'assistance. */
export const PAYMENT_CONFIRMATION_DELAY_MS = 24 * 60 * 60 * 1000;

/** États ouverts non résolus (voir `SubscriptionPaymentStatus`). */
const UNRESOLVED_STATUSES: readonly string[] = Object.freeze([
  'initiating',
  'pending',
  'uncertain',
]);

export interface DelayFacts {
  provider?: unknown;
  status?: unknown;
  open?: unknown;
  createdAt?: unknown;
  collectedAt?: unknown;
  refundedAt?: unknown;
  periodId?: unknown;
  providerTransactionId?: unknown;
  providerCheckoutExpiresAt?: unknown;
}

/**
 * Date de départ du délai : `createdAt` du paiement. Écrit une fois à
 * l'insertion (horodatage Mongoose, immuable), avant tout appel à SasPay,
 * jamais modifié par une vérification ou un rapprochement (contrairement à
 * `updatedAt`). Le débit ne peut pas la précéder : l'écart avec l'instant
 * réel du paiement est borné par la validité de la page (30 min demandées).
 */
export function confirmationDelayStart(payment: DelayFacts): Date | null {
  return payment.createdAt instanceof Date ? payment.createdAt : null;
}

export function confirmationDelayExceeded(
  payment: DelayFacts,
  now: Date,
): boolean {
  const start = confirmationDelayStart(payment);
  return (
    start !== null &&
    now.getTime() - start.getTime() >= PAYMENT_CONFIRMATION_DELAY_MS
  );
}

/**
 * Paiement SasPay NON RÉSOLU : ouvert (`initiating`, `pending`,
 * `uncertain`), ni encaissé, ni remboursé, sans période. Exclus : `review`
 * (déjà signalé, traitement opérateur), `succeeded`, `failed`. Une page
 * encore valide sans transaction attend le payeur, pas une confirmation.
 */
export function paymentUnresolvedAtSasPay(
  payment: DelayFacts,
  now: Date,
): boolean {
  if (payment.provider !== SASPAY_PROVIDER_NAME) return false;
  if (payment.open !== true) return false;
  if (!UNRESOLVED_STATUSES.includes(payment.status as string)) return false;
  if (payment.collectedAt || payment.refundedAt || payment.periodId) {
    return false;
  }
  const checkoutOpen =
    payment.providerCheckoutExpiresAt instanceof Date &&
    payment.providerCheckoutExpiresAt.getTime() > now.getTime();
  return !(
    payment.status === 'pending' &&
    typeof payment.providerTransactionId !== 'string' &&
    checkoutOpen
  );
}

/** Alerte de l'administration : non résolu depuis le seuil. */
export function paymentConfirmationDelayed(
  payment: DelayFacts,
  now: Date,
): boolean {
  return (
    paymentUnresolvedAtSasPay(payment, now) &&
    confirmationDelayExceeded(payment, now)
  );
}

/**
 * Message du propriétaire : paiement RÉELLEMENT en cours de confirmation,
 * c'est-à-dire une transaction SasPay rattachée (le payeur a validé) dont
 * SasPay n'a pas encore donné l'issue (`pending`), page close. Une page
 * encore proposée garde son parcours habituel : une transaction échouée y
 * reste rejouable, son état n'étant pas conservé.
 */
export function paymentAwaitingConfirmation(
  payment: DelayFacts & { renewalConflictAt?: unknown },
  linkOffered: boolean,
): boolean {
  return (
    payment.provider === SASPAY_PROVIDER_NAME &&
    payment.open === true &&
    payment.status === 'pending' &&
    typeof payment.providerTransactionId === 'string' &&
    !linkOffered &&
    !payment.renewalConflictAt &&
    !payment.collectedAt &&
    confirmationDelayStart(payment) !== null
  );
}
