import { apiClient } from "./api";

// Accord FACULTATIF et individuel aux e-mails promotionnels de Stock Master.
// Le libellé affiché (i18n `legal`, `marketing.label`) est celui de la
// version ci-dessous : l'API en garde le texte exact et son empreinte, et
// ses tests vérifient que les ressources FR/EN l'affichent mot pour mot.
// Changer le texte impose une nouvelle version, ici ET dans l'API.
export const MARKETING_EMAIL_WORDING_VERSION = "1";

export const MARKETING_CONSENT_WORDING_OUTDATED =
  "MARKETING_CONSENT_WORDING_OUTDATED";
export const MARKETING_CONSENT_UNAVAILABLE = "MARKETING_CONSENT_UNAVAILABLE";

export interface MarketingConsentPayload {
  granted: boolean;
  wordingVersion: string;
  locale: "fr" | "en";
}

export function buildMarketingConsent(
  granted: boolean,
  locale: string,
): MarketingConsentPayload {
  return {
    granted,
    wordingVersion: MARKETING_EMAIL_WORDING_VERSION,
    locale: locale === "en" ? "en" : "fr",
  };
}

export interface MarketingConsentState {
  granted: boolean;
  /** Accord donné pour une autre adresse : sans effet pour l'actuelle. */
  grantedForPreviousAddress: boolean;
  changedAt: string | null;
  emailVerified: boolean;
  wordingVersion: string;
}

// `token` : jeton explicite (session LIMITÉE, écran /access) ; absent =
// JWT applicatif courant. Route d'identité : ni organisation, ni droit, ni
// abonnement actif exigés.
const withToken = (token?: string) =>
  token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;

export async function fetchMarketingConsent(
  token?: string,
): Promise<MarketingConsentState> {
  const { data } = await apiClient.get<MarketingConsentState>(
    "/auth/me/marketing-consent",
    withToken(token),
  );
  return data;
}

/** Accord ou retrait du compte connecté (aucun mot de passe ni MFA). */
export async function updateMarketingConsent(
  granted: boolean,
  locale: string,
  token?: string,
): Promise<MarketingConsentState> {
  const { data } = await apiClient.put<MarketingConsentState>(
    "/auth/me/marketing-consent",
    buildMarketingConsent(granted, locale),
    withToken(token),
  );
  return data;
}

export type MarketingConsentErrorKey =
  "marketing.errors.outdated" | "marketing.errors.unavailable";

export function marketingConsentErrorKey(
  code: unknown,
): MarketingConsentErrorKey | null {
  switch (code) {
    case MARKETING_CONSENT_WORDING_OUTDATED:
      return "marketing.errors.outdated";
    case MARKETING_CONSENT_UNAVAILABLE:
      return "marketing.errors.unavailable";
    default:
      return null;
  }
}

/**
 * Désabonnement par le lien d'un e-mail promotionnel : aucune session, le
 * jeton fait foi (corps de la requête, jamais l'URL de l'API).
 */
export async function confirmUnsubscribe(token: string): Promise<void> {
  await apiClient.post("/marketing/unsubscribe", { token });
}
