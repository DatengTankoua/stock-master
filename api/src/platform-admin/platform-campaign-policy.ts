import { parsePublicAppOrigin } from '../organizations/invitation-link';
import {
  parseUnsubscribeSecret,
  type UnsubscribeKey,
} from '../marketing-consent/marketing-unsubscribe';

/**
 * Campagnes promotionnelles — règles chiffrées. Les reprises, le verrou et
 * la fenêtre d'incertitude sont ceux des messages de service
 * (`platform-message-policy.ts`), éprouvés : mêmes valeurs, même sens.
 */

/** Campagnes par page de la liste. */
export const CAMPAIGN_PAGE_SIZE = 10;
/** Livraisons par page des résultats. */
export const CAMPAIGN_RESULTS_PAGE_SIZE = 20;
/** Accords examinés par étape de préparation d'audience. */
export const CAMPAIGN_AUDIENCE_PAGE = 200;
/**
 * Bail de constitution de l'audience (requête de lancement). Au-delà,
 * l'audience est close telle quelle : aucune évaluation tardive.
 */
export const CAMPAIGN_CONSTITUTION_LEASE_MS = 10 * 60_000;
/** Livraisons réservées par passe. */
export const CAMPAIGN_DELIVERY_BATCH = 20;
/**
 * Intervalle minimal entre deux appels au prestataire pour une campagne :
 * au plus 2 par seconde, sur les 10 requêtes par seconde partagées par
 * toute l'équipe Resend (documentation officielle, octobre 2026). Le reste
 * reste disponible pour les e-mails nécessaires au compte (vérification,
 * réinitialisation, invitations, messages de service).
 */
export const CAMPAIGN_SEND_INTERVAL_MS = 500;
/** Intervalle du traitement de fond des campagnes au repos. */
export const CAMPAIGN_POLL_INTERVAL_MS = 10_000;

/**
 * Interrupteur SERVEUR des envois marketing, désactivé par défaut : seule la
 * valeur exacte `true` l'active. Arrêté : aucun nouvel appel au prestataire
 * pour une campagne (les livraisons restent en attente). Sans effet sur le
 * désabonnement et sur les messages de service.
 */
export function isMarketingEmailsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MARKETING_EMAILS_ENABLED === 'true';
}

/** Configuration nécessaire à un envoi (sinon : aucun appel). */
export interface CampaignSendConfig {
  appOrigin: string;
  unsubscribeKey: UnsubscribeKey;
}

export function campaignSendConfig(
  env: NodeJS.ProcessEnv = process.env,
): CampaignSendConfig | null {
  const appOrigin = parsePublicAppOrigin(env.PUBLIC_APP_URL ?? env.WEB_URL);
  const unsubscribeKey = parseUnsubscribeSecret(
    env.MARKETING_UNSUBSCRIBE_SECRET,
  );
  return appOrigin && unsubscribeKey ? { appOrigin, unsubscribeKey } : null;
}

/**
 * Clé d'idempotence du prestataire : campagne, livraison ET empreinte de
 * l'adresse. Une adresse différente ne peut jamais réutiliser la clé d'une
 * autre (la livraison n'est d'ailleurs jamais envoyée à une autre adresse
 * que celle figée au premier envoi).
 */
export function campaignEmailIdempotencyKey(
  campaignId: string,
  deliveryId: string,
  addressSha256: string,
): string {
  return `marketing-campaign/${campaignId}/${deliveryId}/${addressSha256.slice(0, 32)}`;
}
