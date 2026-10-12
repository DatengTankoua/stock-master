/**
 * 1-14D.2A — Catalogue tarifaire SERVEUR (pur, aucune I/O).
 *
 * Autorité unique du montant d'un abonnement : une demande de paiement
 * (lots suivants) lit son montant ICI à partir de la seule durée, jamais
 * depuis le navigateur. Aucune fonction n'accepte de montant libre.
 *
 * - Devise `XAF` (affichée « FCFA » côté web), montants entiers positifs.
 * - Montant TOTAL facturé au client pour la durée, avant déduction des
 *   frais du prestataire de paiement.
 * - `SUBSCRIPTION_PRICING_VERSION` : à incrémenter à tout changement de
 *   tarif ; un paiement figera la version appliquée.
 * - Durées : exactement celles de `SubscriptionTerm` / `TERM_MONTHS`.
 *
 * SOURCE UNIQUE des tarifs courants (1-21D) : le web importe CE module au
 * build (`web/src/lib/subscription-offers.ts`, sans table de prix propre)
 * pour la page publique, l'espace Abonnement et les conditions
 * d'abonnement. Il doit donc rester PUR (aucune dépendance Nest ni I/O ;
 * seul import : `subscription-terms`). Jamais d'import du frontend par le
 * code de production de l'API.
 */
import {
  SubscriptionTerm,
  TERM_MONTHS,
  isSubscriptionTerm,
} from './subscription-terms';

/**
 * Historique (les paiements gardent la version et le montant figés à leur
 * création, jamais réécrits ni comparés au tarif courant) :
 * - 1 : 3 000 / 8 500 / 16 000 / 30 000 XAF (1-14C.2 à 1-21C) ;
 * - 2 : 3 500 / 10 000 / 18 500 / 35 000 XAF (1-21D, frais SasPay absorbés ;
 *   remplace avant toute publication la grille intermédiaire
 *   3 500 / 9 000 / 16 500 / 30 500, jamais déployée).
 */
export const SUBSCRIPTION_PRICING_VERSION = 2;

export const SUBSCRIPTION_PRICING_CURRENCY = 'XAF';
export type SubscriptionPricingCurrency = typeof SUBSCRIPTION_PRICING_CURRENCY;

/** Montant total (XAF) par durée. */
export const SUBSCRIPTION_PRICES_XAF: Readonly<
  Record<SubscriptionTerm, number>
> = Object.freeze({
  [SubscriptionTerm.MONTHLY]: 3500,
  [SubscriptionTerm.QUARTERLY]: 10000,
  [SubscriptionTerm.SEMIANNUAL]: 18500,
  [SubscriptionTerm.ANNUAL]: 35000,
});

/** Prix figé d'une durée (copie immuable, sans référence partagée). */
export interface SubscriptionPrice {
  readonly term: SubscriptionTerm;
  readonly months: number;
  readonly amount: number;
  readonly currency: SubscriptionPricingCurrency;
  readonly pricingVersion: number;
}

export class SubscriptionPricingError extends Error {
  readonly code = 'UNKNOWN_SUBSCRIPTION_TERM';

  constructor() {
    super('Durée d’abonnement inconnue.');
    this.name = 'SubscriptionPricingError';
  }
}

/**
 * Prix de la durée demandée. Toute valeur qui n'est pas exactement une
 * durée connue (`monthly | quarterly | semiannual | annual`) est refusée.
 */
export function getSubscriptionPrice(term: unknown): SubscriptionPrice {
  if (!isSubscriptionTerm(term)) throw new SubscriptionPricingError();
  return Object.freeze({
    term,
    months: TERM_MONTHS[term],
    amount: SUBSCRIPTION_PRICES_XAF[term],
    currency: SUBSCRIPTION_PRICING_CURRENCY,
    pricingVersion: SUBSCRIPTION_PRICING_VERSION,
  });
}

/** Catalogue complet, dans l'ordre des durées. */
export function listSubscriptionPrices(): readonly SubscriptionPrice[] {
  return Object.freeze(
    Object.values(SubscriptionTerm).map((term) => getSubscriptionPrice(term)),
  );
}

// Cohérence vérifiée au chargement : une durée sans prix, un prix sans
// durée ou un montant non entier positif empêche le démarrage.
const pricedTerms = Object.keys(SUBSCRIPTION_PRICES_XAF).sort();
const knownTerms = Object.values(SubscriptionTerm).map(String).sort();
if (
  pricedTerms.length !== knownTerms.length ||
  pricedTerms.some((term, i) => term !== knownTerms[i])
) {
  throw new Error('Catalogue tarifaire incohérent avec les durées.');
}
for (const term of Object.values(SubscriptionTerm)) {
  const amount = SUBSCRIPTION_PRICES_XAF[term];
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Tarif ${term} invalide.`);
  }
}
