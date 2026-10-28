import { createHash } from 'crypto';

/**
 * Libellés VERSIONNÉS de l'accord aux e-mails promotionnels (canal `email`,
 * finalité `promotions`). Une version publiée n'est jamais réécrite : un
 * changement de texte impose une nouvelle version (ajoutée ici, avec son
 * empreinte), et l'ancienne reste pour lire les preuves déjà enregistrées.
 * L'empreinte figée est contrôlée par les tests unitaires, qui vérifient
 * aussi que les ressources i18n du web affichent exactement ce texte.
 *
 * Le texte présenté est archivé en base (`marketing_consent_wordings`) à sa
 * première utilisation, comme les documents juridiques (`$setOnInsert`).
 */
export const MARKETING_CHANNEL = 'email';
export const MARKETING_PURPOSE = 'promotions';
export const MARKETING_LOCALES = ['fr', 'en'] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

export interface MarketingWordingVersion {
  /** Date de mise en service du libellé (AAAA-MM-JJ). */
  publishedAt: string;
  texts: Record<MarketingLocale, { text: string; sha256: string }>;
}

export const MARKETING_EMAIL_WORDINGS: Readonly<
  Record<string, MarketingWordingVersion>
> = Object.freeze({
  '1': {
    publishedAt: '2026-10-28',
    texts: {
      fr: {
        text: 'Je souhaite recevoir par e-mail les offres et promotions de Stock Master. Je peux me désinscrire à tout moment.',
        sha256:
          '30db7e855ad19ecde0e4af42675d2fba42153011cc1f2ad0603f228c19541cae',
      },
      en: {
        text: 'I would like to receive Stock Master offers and promotions by email. I can unsubscribe at any time.',
        sha256:
          'aa78f661ca69fa7131bb5daebd858992e088f16029bc6bba0c3b7dddc21dd3c7',
      },
    },
  },
});

/** Seule version acceptée pour un NOUVEL accord. */
export const MARKETING_EMAIL_CURRENT_WORDING = '1';

export interface ResolvedMarketingWording {
  /** `_id` dans `marketing_consent_wordings`. */
  id: string;
  version: string;
  locale: MarketingLocale;
  text: string;
  sha256: string;
  publishedAt: string;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Libellé d'une version connue, contrôlé contre son empreinte figée. */
export function resolveMarketingWording(
  version: string,
  locale: MarketingLocale,
): ResolvedMarketingWording | null {
  const entry = Object.prototype.hasOwnProperty.call(
    MARKETING_EMAIL_WORDINGS,
    version,
  )
    ? MARKETING_EMAIL_WORDINGS[version]
    : undefined;
  const wording = entry?.texts[locale];
  if (!entry || !wording) return null;
  if (sha256Hex(wording.text) !== wording.sha256) {
    throw new Error(`Libellé marketing altéré : ${version}/${locale}`);
  }
  return {
    id: `${MARKETING_CHANNEL}.${MARKETING_PURPOSE}@${version}/${locale}`,
    version,
    locale,
    text: wording.text,
    sha256: wording.sha256,
    publishedAt: entry.publishedAt,
  };
}
