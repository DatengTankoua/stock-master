/**
 * Codes d'erreur STABLES des lots (champ `code` du corps de réponse). Un
 * client classe l'erreur par code, jamais par le texte du message.
 */
export const PRODUCT_BATCH_ERROR_CODES = Object.freeze({
  /**
   * Opération qui modifierait le stock d'un produit suivi par lots sans
   * mettre à jour ses lots (vente, correction, annulation, ajout de stock,
   * date de la fiche). 409 : refus métier terminal (une outbox antérieure le
   * classe en conflit, sans bloquer les autres ventes).
   */
  PRODUCT_BATCH_TRACKED: 'PRODUCT_BATCH_TRACKED',
  PRODUCT_BATCHES_DISABLED: 'PRODUCT_BATCHES_DISABLED',
  /** Validateur ou index absents : activation impossible (503). */
  PRODUCT_BATCH_GUARD_MISSING: 'PRODUCT_BATCH_GUARD_MISSING',
  BATCH_TRACKING_ALREADY_ENABLED: 'BATCH_TRACKING_ALREADY_ENABLED',
  BATCH_TRACKING_NOT_ENABLED: 'BATCH_TRACKING_NOT_ENABLED',
  /** Le stock a changé depuis l'affichage de la répartition (409). */
  BATCH_STOCK_CHANGED: 'BATCH_STOCK_CHANGED',
  /** Somme des lots différente du total annoncé (400). */
  BATCH_ALLOCATION_MISMATCH: 'BATCH_ALLOCATION_MISMATCH',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  BATCH_DATE_IN_FUTURE: 'BATCH_DATE_IN_FUTURE',
  BATCH_RECEIVED_ON_REQUIRED: 'BATCH_RECEIVED_ON_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',

  // ─── Lot B : ventes, corrections, annulations ───────────────────────────
  /** Vente sans affectation sur un produit suivi (ancien client) : 409. */
  SALE_BATCH_ALLOCATION_REQUIRED: 'SALE_BATCH_ALLOCATION_REQUIRED',
  /** Lot épuisé ou quantité insuffisante à la confirmation : 409. */
  BATCH_INSUFFICIENT: 'BATCH_INSUFFICIENT',
  /** Lot absent, d'un autre produit/commerce, ou non disponible : 409. */
  BATCH_UNAVAILABLE: 'BATCH_UNAVAILABLE',
  /** Lot dépassé au jour déclaré de la vente : 409 définitif. */
  BATCH_EXPIRED: 'BATCH_EXPIRED',
  /** Vente déclarée avant péremption, reçue après : 409 régularisable. */
  BATCH_EXPIRED_AT_SYNC: 'BATCH_EXPIRED_AT_SYNC',
  /** Lot sans date choisi sans confirmation explicite : 409. */
  BATCH_EXPIRY_UNCONFIRMED: 'BATCH_EXPIRY_UNCONFIRMED',
  /** Correction de quantité sans préciser les lots concernés : 409. */
  SALE_BATCH_CORRECTION_REQUIRED: 'SALE_BATCH_CORRECTION_REQUIRED',
  /** Restitution d'unités au lot d'origine inconnu sans destination : 409. */
  SALE_BATCH_RESTITUTION_REQUIRED: 'SALE_BATCH_RESTITUTION_REQUIRED',
  /** Produit définitivement supprimé : aucune écriture de stock. */
  SALE_PRODUCT_PURGED: 'SALE_PRODUCT_PURGED',
  /** Demande de régularisation pour une vente qui n'en a pas besoin. */
  SALE_REGULARIZATION_NOT_NEEDED: 'SALE_REGULARIZATION_NOT_NEEDED',
  /** Vente déjà enregistrée pour cette opération : rien à régulariser. */
  SALE_REGULARIZATION_ALREADY_APPLIED: 'SALE_REGULARIZATION_ALREADY_APPLIED',
  /** Demande déjà décidée (rejetée) : décision définitive. */
  SALE_REGULARIZATION_DECIDED: 'SALE_REGULARIZATION_DECIDED',

  // ─── Lot C : mise à l'écart, pertes ─────────────────────────────────────
  /** Le lot est déjà dans l'état demandé (ou transition impossible). */
  BATCH_STATUS_UNCHANGED: 'BATCH_STATUS_UNCHANGED',
  /** Motif « autre » sans commentaire. */
  LOSS_COMMENT_REQUIRED: 'LOSS_COMMENT_REQUIRED',
  LOSS_NOT_FOUND: 'LOSS_NOT_FOUND',
  /** Correction au-delà des unités perdues non encore corrigées. */
  LOSS_CORRECTION_EXCEEDS: 'LOSS_CORRECTION_EXCEEDS',
} as const);

/** Erreur métier des lots : `{ code, message }` (+ détails non sensibles). */
export function batchError(
  code: keyof typeof PRODUCT_BATCH_ERROR_CODES,
  message: string,
  extra: Record<string, unknown> = {},
): { code: string; message: string } & Record<string, unknown> {
  return { code: PRODUCT_BATCH_ERROR_CODES[code], message, ...extra };
}

export const PRODUCT_BATCH_TRACKED_MESSAGE =
  "Ce produit est suivi par lots : cette opération n'est pas encore disponible pour lui.";

/** Corps 409 commun aux opérations incompatibles avec le suivi par lots. */
export function productBatchTrackedBody(): { code: string; message: string } {
  return {
    code: PRODUCT_BATCH_ERROR_CODES.PRODUCT_BATCH_TRACKED,
    message: PRODUCT_BATCH_TRACKED_MESSAGE,
  };
}
