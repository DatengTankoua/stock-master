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
