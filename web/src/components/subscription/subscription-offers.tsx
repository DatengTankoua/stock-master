"use client";

import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import {
  BEST_SAVING_TERM,
  SUBSCRIPTION_OFFERS,
  monthlyEquivalentXaf,
  type SubscriptionOffer,
  type SubscriptionTerm,
} from "@/lib/subscription-offers";
import { offerPitch } from "@/lib/subscription-offer-pitch";

// 1-14C.2 — Grille des quatre durées de l'offre unique. 1-21D : accroche,
// puis montant TOTAL « payés en une fois » (le plus visible), équivalent
// mensuel présenté comme une simple comparaison, économie calculée.
// Aucune action de paiement ici : présentation uniquement.

function OfferBody({ offer }: { offer: SubscriptionOffer }) {
  const { t } = useT("subscription");
  const { fcfa } = useFormat();
  const label = t(`offers.term.${offer.term}`);
  const pitch = offerPitch(offer, t, fcfa);
  return (
    <>
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        {offer.term === BEST_SAVING_TERM && (
          <span className="rounded-full bg-(--brand-orange)/15 px-2 py-0.5 text-[11px] font-semibold text-(--brand-ink)">
            {t("offers.best")}
          </span>
        )}
      </span>
      <span className="mt-1 block text-sm font-medium text-pretty">
        {pitch.title}
      </span>
      <span
        className="mt-2 block text-2xl font-bold tracking-tight tabular-nums"
        data-testid={`offer-total-${offer.term}`}
      >
        {fcfa(offer.totalXaf)}
      </span>
      <span className="block text-xs font-medium">
        {t("offers.paidOnce", { term: label })}
      </span>
      {offer.months > 1 && (
        <span className="block text-xs text-muted-foreground tabular-nums">
          {t("offers.monthlyEquivalent", {
            amount: fcfa(monthlyEquivalentXaf(offer)),
          })}
        </span>
      )}
      <span className="mt-2 block text-xs text-muted-foreground text-pretty">
        {pitch.text}
      </span>
    </>
  );
}

const PUBLIC_INCLUDED = [
  "catalog",
  "converter",
  "analytics",
  "members",
] as const;

/**
 * Grille publique : quatre cartes, la durée recommandée mise en avant.
 * `cta` (inscription ouverte uniquement) ajoute un bouton d'essai par
 * carte — l'essai ne dépend pas de la durée : aucune durée n'est réservée
 * ni attribuée depuis le navigateur.
 */
export function OfferGrid({ cta }: { cta?: { href: string; label: string } }) {
  const { t } = useT("subscription");
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-stretch">
      {SUBSCRIPTION_OFFERS.map((offer) => {
        const recommended = offer.term === BEST_SAVING_TERM;
        return (
          <li
            key={offer.term}
            className={`relative flex flex-col rounded-2xl border bg-background p-5 shadow-sm transition-shadow hover:shadow-md ${
              recommended
                ? "border-(--brand-ink) ring-2 ring-(--brand-ink) lg:-my-2 lg:py-7"
                : "border-border"
            }`}
          >
            <OfferBody offer={offer} />
            {/* `mb-5` + `mt-auto` du bouton : boutons alignés en bas de
            toutes les cartes, quelle que soit la hauteur du texte. */}
            <ul className="mt-4 mb-5 space-y-1.5 text-xs text-muted-foreground">
              {PUBLIC_INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-1.5">
                  <CheckIcon
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--brand-ink)"
                    aria-hidden
                  />
                  {t(`offers.included.${item}`)}
                </li>
              ))}
            </ul>
            {cta && (
              <Link
                href={cta.href}
                className={`mt-auto inline-flex h-11 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) ${
                  recommended
                    ? "bg-(--brand-solid) text-white hover:bg-(--brand-solid)/90"
                    : "border border-(--brand-ink) text-(--brand-ink) hover:bg-(--brand-ink)/5"
                }`}
                aria-label={t("offers.ctaLabel", {
                  label: cta.label,
                  term: t(`offers.term.${offer.term}`),
                })}
              >
                {cta.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Sélection d'une durée (renouvellement) : groupe radio accessible. */
export function OfferSelector({
  selected,
  onSelect,
}: {
  selected: SubscriptionTerm | null;
  onSelect: (term: SubscriptionTerm) => void;
}) {
  const { t } = useT("subscription");
  return (
    <div
      role="radiogroup"
      aria-label={t("offers.selectorLabel")}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {SUBSCRIPTION_OFFERS.map((offer) => {
        const checked = selected === offer.term;
        return (
          <button
            key={offer.term}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onSelect(offer.term)}
            className={`relative rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              checked
                ? "border-primary bg-muted"
                : "border-border hover:bg-muted"
            }`}
          >
            {checked && (
              <CheckIcon
                className="absolute right-3 bottom-3 h-4 w-4"
                aria-hidden
              />
            )}
            <OfferBody offer={offer} />
          </button>
        );
      })}
    </div>
  );
}

/** Rappel commun des conditions validées. */
export function OfferConditions() {
  const { t } = useT("subscription");
  return (
    <ul className="space-y-1 text-sm text-muted-foreground">
      <li>{t("offers.conditions.features")}</li>
      <li>{t("offers.conditions.perShop")}</li>
      <li>{t("offers.conditions.noAutoPay")}</li>
    </ul>
  );
}
