import type { TFunction } from "i18next";
import type { SubscriptionOffer } from "./subscription-offers";

/**
 * 1-21D — Accroche d'une durée (page publique et espace Abonnement) : titre
 * propre à la durée, complété des mois offerts s'il y en a (calcul réel,
 * `freeMonths`) ; texte : économie calculée si elle existe, sinon le texte
 * du mensuel. Aucun montant dans les traductions : ils sont passés en
 * variables, formatés par l'écran.
 */
export function offerPitch(
  offer: SubscriptionOffer,
  t: TFunction<"subscription">,
  fcfa: (amount: number) => string,
): { title: string; text: string } {
  const base = t(`offers.pitch.${offer.term}.title`);
  const title =
    offer.freeMonths > 0
      ? t("offers.pitch.withFreeMonths", {
          title: base,
          count: offer.freeMonths,
        })
      : base;
  if (offer.savingXaf > 0) {
    return {
      title,
      text: t("offers.pitch.saving", { amount: fcfa(offer.savingXaf) }),
    };
  }
  return {
    title,
    text: offer.term === "monthly" ? t("offers.pitch.monthly.text") : "",
  };
}
