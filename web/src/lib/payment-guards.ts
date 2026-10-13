// 1-21D — Décisions PURES du panneau de paiement (sans React ni réseau),
// testées par `api/src/subscriptions/payment-guards.spec.ts`. Chemins
// relatifs uniquement (module chargé hors de Next).

/** Réponse de `GET …/payments/capabilities` (champs utiles). */
export interface CapabilitiesLike {
  available: boolean;
  method: "hosted-checkout" | "mobile-money" | null;
}

/**
 * Moyen proposé pour une NOUVELLE tentative :
 * - `unavailable` : l'API répond `available: false` (paiements désactivés) :
 *   aucune création ni formulaire, consultation et « Vérifier » conservés ;
 * - `mobile-money` : API antérieure (404 traduit par le client) ou moyen
 *   Mobile Money ;
 * - `hosted-checkout` : page de paiement du prestataire ;
 * - `unknown` : capacités illisibles (réseau) : comportement antérieur, le
 *   serveur reste l'autorité (503 si indisponible).
 */
export type PaymentAvailability =
  "hosted-checkout" | "mobile-money" | "unavailable" | "unknown";

export function paymentAvailability(
  capabilities: CapabilitiesLike | null,
): PaymentAvailability {
  if (!capabilities) return "unknown";
  if (!capabilities.available) return "unavailable";
  return capabilities.method === "hosted-checkout"
    ? "hosted-checkout"
    : "mobile-money";
}

/**
 * Montant ENREGISTRÉ par le serveur différent du prix affiché dans cet
 * onglet (tarif changé depuis le chargement de la page) : à signaler et à
 * faire confirmer avant de continuer. Le montant du paiement n'est jamais
 * modifié ; `null` si identique ou si aucun prix n'était affiché.
 */
export function chargedAmountChange(
  displayedXaf: number | null | undefined,
  chargedXaf: number,
): { displayedXaf: number; chargedXaf: number } | null {
  if (
    displayedXaf === null ||
    displayedXaf === undefined ||
    !Number.isSafeInteger(displayedXaf) ||
    displayedXaf === chargedXaf
  ) {
    return null;
  }
  return { displayedXaf, chargedXaf };
}

// ─── 1-21E : page hébergée — échéance, situation, changement de forfait ─────

/** Situations exposées par l'API (`SubscriptionPaymentView.situation`). */
export type PaymentSituation =
  | "checkout-open"
  | "checkout-expired"
  | "checkout-link-missing"
  | "attempt-unresolved"
  | "closure-unconfirmed"
  | "checkout-closed"
  | "renewal-suspended"
  | "collected-in-resolution"
  | "refunded";

/** Issues de `POST …/payments/:id/abandon` (établies par le serveur). */
export type PaymentAbandonOutcome =
  | "released"
  | "succeeded"
  | "in-progress"
  | "attempt-recorded"
  | "awaiting-resolution"
  | "not-found-at-provider"
  | "provider-incomplete"
  | "cancel-unconfirmed";

/**
 * Marge avant l'échéance : le lien est retiré un peu AVANT, pour ne jamais
 * envoyer le payeur sur une page qui expire pendant qu'il paie.
 */
export const CHECKOUT_EXPIRY_MARGIN_MS = 30_000;

/**
 * Échéance locale du lien : instant de RÉCEPTION + validité restante donnée
 * par le serveur (indépendant de l'horloge de l'appareil). `null` sans lien.
 */
export function checkoutDeadline(
  expiresInMs: number | null | undefined,
  receivedAt: number,
): number | null {
  if (
    typeof expiresInMs !== "number" ||
    !Number.isFinite(expiresInMs) ||
    expiresInMs < 0
  ) {
    return null;
  }
  return receivedAt + expiresInMs;
}

/** Phase affichée ; `null` : API antérieure ou hors page hébergée. */
export type CheckoutPhase =
  | "open"
  | "expired"
  | "link-missing"
  | "attempt-unresolved"
  | "closure-unconfirmed"
  | "closed"
  | "renewal-suspended"
  | "collected-in-resolution"
  | "refunded";

export interface CheckoutViewLike {
  status: string;
  situation?: PaymentSituation | null;
  checkoutDeadline?: number | null;
}

/**
 * Phase du paiement à l'instant `now` : une page ouverte devient `expired`
 * dès l'échéance locale (moins la marge), sans attendre le serveur.
 */
export function checkoutPhase(
  view: CheckoutViewLike,
  now: number,
): CheckoutPhase | null {
  switch (view.situation) {
    case "checkout-open":
      return typeof view.checkoutDeadline === "number" &&
        now >= view.checkoutDeadline - CHECKOUT_EXPIRY_MARGIN_MS
        ? "expired"
        : "open";
    case "checkout-expired":
      return "expired";
    case "checkout-link-missing":
      return "link-missing";
    case "attempt-unresolved":
      return "attempt-unresolved";
    case "closure-unconfirmed":
      return "closure-unconfirmed";
    case "checkout-closed":
      return "closed";
    case "renewal-suspended":
      return "renewal-suspended";
    case "collected-in-resolution":
      return "collected-in-resolution";
    case "refunded":
      return "refunded";
    default:
      return null;
  }
}

/**
 * Instant où une page ouverte passe d'elle-même à `expired` (minuteur
 * unique, éventuellement déjà passé : à appliquer aussitôt) ; `null` sinon.
 */
export function nextPhaseChangeAt(view: CheckoutViewLike): number | null {
  if (view.situation !== "checkout-open") return null;
  if (typeof view.checkoutDeadline !== "number") return null;
  return view.checkoutDeadline - CHECKOUT_EXPIRY_MARGIN_MS;
}

/**
 * « Changer de forfait » / « Annuler cette tentative » proposés : paiement
 * par page hébergée, NON confirmé, ni clos, ni en vérification opérateur.
 * Le serveur décide seul de l'issue (aucune annulation locale).
 */
export function canRequestAbandon(
  view: CheckoutViewLike,
  now: number,
): boolean {
  if (view.status === "succeeded" || view.status === "failed") return false;
  if (view.status === "review") return false;
  const phase = checkoutPhase(view, now);
  return (
    phase !== null &&
    phase !== "closed" &&
    phase !== "collected-in-resolution" &&
    phase !== "refunded"
  );
}

/**
 * 1-21E — Reçu proposé : encaissement CONFIRMÉ par le serveur (`collected`),
 * ou paiement `succeeded` d'une API antérieure (toujours encaissé).
 */
export function receiptAvailable(view: {
  status: string;
  collected?: boolean;
}): boolean {
  return view.collected === true || view.status === "succeeded";
}

/** Montant en unités mineures → unités et centimes (entiers, sans flottant). */
export function minorToMajor(minor: number): {
  major: number;
  cents: number;
} {
  const major = Math.trunc(minor / 100);
  return { major, cents: Math.abs(minor - major * 100) };
}

/** Une nouvelle tentative n'est libérée que par `released`. */
export function abandonReleases(
  outcome: PaymentAbandonOutcome,
): outcome is "released" {
  return outcome === "released";
}
