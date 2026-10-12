// 1-14C.2 — Offre commerciale Stock Master : UNE offre, quatre durées.
//
// Présentation UNIQUEMENT (page publique, espace Abonnement, conditions
// d'abonnement). Ces montants ne servent JAMAIS à attribuer une période
// depuis le navigateur : le serveur fixe le montant d'un paiement à partir
// de la seule durée. Devise XAF, affichée « FCFA ».
//
// 1-21D — AUCUNE table de prix ici : durées, mois et montants viennent du
// catalogue SERVEUR (`api/src/subscriptions/subscription-pricing.ts`),
// importé au build ; économies, mois offerts, meilleure économie et
// équivalents mensuels en sont CALCULÉS. Changer un tarif = ce seul fichier
// serveur (voir son en-tête).

import { listSubscriptionPrices } from "../../../api/src/subscriptions/subscription-pricing";
import type { SubscriptionTerm as ServerSubscriptionTerm } from "../../../api/src/subscriptions/subscription-terms";

/** Durées du serveur, en valeurs littérales (`"monthly" | …`). */
export type SubscriptionTerm = `${ServerSubscriptionTerm}`;

// 1-16G : libellés et accroches dans le namespace `subscription`
// (`offers.term.*`, `offers.pitch.*`), sans aucun montant : ceux-ci sont
// passés en variables, depuis les valeurs calculées ici.
export interface SubscriptionOffer {
  term: SubscriptionTerm;
  months: number;
  /** Montant TOTAL payé en une fois pour la durée choisie (XAF). */
  totalXaf: number;
  /** Économie par rapport à `months` paiements mensuels (XAF), calculée. */
  savingXaf: number;
  /**
   * Mois offerts : l'économie vaut exactement `freeMonths` mensualités
   * (ex. 12 mois au prix de 10 → 2). Sinon 0 : aucune mention.
   */
  freeMonths: number;
}

/** Durée de l'essai gratuit (jours), attribué par le serveur à l'inscription. */
export const TRIAL_DAYS = 7;

const SERVER_PRICES = listSubscriptionPrices();

/** Prix mensuel de référence (XAF), celui de la durée d'un mois. */
export const MONTHLY_PRICE_XAF = (() => {
  const monthly = SERVER_PRICES.find((price) => price.months === 1);
  if (!monthly) throw new Error("Tarif mensuel absent du catalogue serveur.");
  return monthly.amount;
})();

/** Mois offerts : économie multiple exact (non nul) du prix mensuel. */
export function freeMonthsFor(savingXaf: number, monthlyXaf: number): number {
  if (savingXaf <= 0 || monthlyXaf <= 0 || savingXaf % monthlyXaf !== 0) {
    return 0;
  }
  return savingXaf / monthlyXaf;
}

export const SUBSCRIPTION_OFFERS: readonly SubscriptionOffer[] =
  SERVER_PRICES.map((price) => {
    const savingXaf = price.months * MONTHLY_PRICE_XAF - price.amount;
    // Une durée plus longue ne doit jamais coûter plus cher que des mois
    // payés un par un : un tel catalogue échoue au build/prérendu.
    if (savingXaf < 0) throw new Error(`Offre ${price.term} incohérente.`);
    return {
      term: `${price.term}` as SubscriptionTerm,
      months: price.months,
      totalXaf: price.amount,
      savingXaf,
      freeMonths: freeMonthsFor(savingXaf, MONTHLY_PRICE_XAF),
    };
  });

/**
 * Badge « Meilleure économie » : la durée à la plus forte économie, si elle
 * est unique et positive ; sinon aucune.
 */
export const BEST_SAVING_TERM: SubscriptionTerm | null = (() => {
  const best = Math.max(...SUBSCRIPTION_OFFERS.map((o) => o.savingXaf));
  const winners = SUBSCRIPTION_OFFERS.filter((o) => o.savingXaf === best);
  return best > 0 && winners.length === 1 ? winners[0].term : null;
})();

/** Équivalent mensuel ARRONDI, toujours présenté comme tel (jamais prélevé). */
export function monthlyEquivalentXaf(offer: SubscriptionOffer): number {
  return Math.round(offer.totalXaf / offer.months);
}

/** Durée connue du serveur, sinon `null` (libellé générique « — »). */
export function knownTerm(
  term: string | null | undefined,
): SubscriptionTerm | null {
  return SUBSCRIPTION_OFFERS.find((offer) => offer.term === term)?.term ?? null;
}

// Chemin relatif : ce module est aussi chargé par un test de l'API
// (`subscription-pricing.spec.ts`), sans l'alias `@/`.
/** Montant XAF formaté « 12 345 FCFA » (fr) ou « 12,345 FCFA » (en). */
export { formatFcfa } from "../i18n/format";
