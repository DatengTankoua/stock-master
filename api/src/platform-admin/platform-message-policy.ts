import { EmailDeliveryError } from '../email-verification/email-sender';
import { SUPPORT_UNCERTAIN_RETRY_WINDOW_MS } from '../support/support-constants';

/**
 * Communications de service de la plateforme — règles chiffrées, adaptées
 * à une petite plateforme (un administrateur, une instance API). Toutes
 * appliquées CÔTÉ SERVEUR ; un dépassement est refusé, jamais tronqué.
 */

/** Messages par organisation sur une fenêtre glissante. */
export const MESSAGE_ORGANIZATION_LIMIT = Object.freeze({
  max: 10,
  windowMs: 24 * 60 * 60 * 1000,
});

/** Messages par administrateur sur une fenêtre glissante. */
export const MESSAGE_ACTOR_LIMIT = Object.freeze({
  max: 30,
  windowMs: 60 * 60 * 1000,
});

/** Envois automatiques d'une livraison (premier compris). */
export const MESSAGE_MAX_ATTEMPTS = 5;

/** Délais avant la reprise n (après l'échec n). */
export const MESSAGE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
]);

/** Relances manuelles d'une même livraison (après échec ou incertitude). */
export const MESSAGE_MANUAL_RETRY_MAX = 3;

/** Verrou d'une livraison réservée (au-delà : reprise, crash supposé). */
export const MESSAGE_SEND_LOCK_MS = 60_000;

/** Intervalle du traitement de fond quand rien n'est à traiter. */
export const MESSAGE_POLL_INTERVAL_MS = 5_000;

/** Livraisons traitées par passe. */
export const MESSAGE_DELIVERY_BATCH = 20;

/**
 * Fenêtre d'un renvoi d'e-mail après un résultat INCONNU : même clé
 * d'idempotence, tant que le prestataire la conserve (Resend : 24 h ; marge
 * d'une heure, comme l'assistance). Au-delà : aucun renvoi, le résultat
 * reste « incertain ».
 */
export const MESSAGE_UNCERTAIN_RETRY_WINDOW_MS =
  SUPPORT_UNCERTAIN_RETRY_WINDOW_MS;

/** Pages de l'historique des messages d'une organisation. */
export const MESSAGE_HISTORY_PAGE_SIZE = 10;

/** Messages archivés ou restaurés en une seule demande (sélection). */
export const MESSAGE_ARCHIVE_BATCH_MAX = 50;

/** Clé d'idempotence du prestataire : une par message et destinataire. */
export function messageEmailIdempotencyKey(
  messageId: string,
  userId: string,
): string {
  return `platform-message/${messageId}/${userId}`;
}

/** Clé d'événement de la notification du centre (et de son push). */
export function messageEventKey(messageId: string, userId: string): string {
  return `platform-message:${messageId}:${userId}`;
}

/**
 * Issue d'un échec d'envoi d'e-mail :
 * - `retry` : refus certain mais passager (429) → reprise sans risque ;
 * - `failed` : refus certain et définitif (configuration absente, 4xx) ;
 * - `unknown` : le prestataire a PU accepter (délai, réseau, 5xx, 409
 *   d'idempotence, erreur inattendue) → renvoi seulement avec la même clé,
 *   dans la fenêtre du prestataire.
 */
export function classifyEmailFailure(error: unknown): {
  outcome: 'retry' | 'failed' | 'unknown';
  reason: string;
} {
  if (!(error instanceof EmailDeliveryError)) {
    return { outcome: 'unknown', reason: 'unexpected' };
  }
  if (error.reason === 'not_configured') {
    return { outcome: 'failed', reason: 'email_not_configured' };
  }
  if (error.reason === 'timeout' || error.reason === 'network') {
    return { outcome: 'unknown', reason: error.reason };
  }
  const status = error.providerStatus;
  if (status === undefined) return { outcome: 'failed', reason: 'rejected' };
  if (status === 429) return { outcome: 'retry', reason: 'rejected_429' };
  if (status === 409 || status >= 500) {
    return { outcome: 'unknown', reason: `rejected_${status}` };
  }
  return { outcome: 'failed', reason: `rejected_${status}` };
}

export function retryDelayMs(attempts: number): number {
  return MESSAGE_RETRY_DELAYS_MS[
    Math.min(Math.max(attempts - 1, 0), MESSAGE_RETRY_DELAYS_MS.length - 1)
  ];
}
