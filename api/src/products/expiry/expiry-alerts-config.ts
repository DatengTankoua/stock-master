import {
  OrganizationScope,
  inOrganizationScope,
  parseOrganizationScope,
} from '../../common/organization-scope';
/**
 * Lot C — activation des alertes de péremption, DISTINCTE du suivi par lots
 * (`PRODUCT_BATCHES_ENABLED`) : elles concernent aussi la date facultative
 * des produits sans lots.
 *
 * - `EXPIRY_ALERTS_ENABLED` absent, vide ou `false` : aucun balayage, aucune
 *   alerte (défaut, production) ; le réglage du délai reste refusé (403).
 * - `true` : balayage planifié par le traitement de fond des notifications.
 * - Toute autre valeur : désactivé et signalé au démarrage.
 * Prérequis : index partiels et marques initiales
 * (`migrate:expiry-alerts -- --apply`).
 */
export const EXPIRY_ALERTS_FLAG = 'EXPIRY_ALERTS_ENABLED';

export function expiryAlertsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[EXPIRY_ALERTS_FLAG] === 'true';
}

export function expiryAlertsFlagInvalid(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[EXPIRY_ALERTS_FLAG];
  return (
    value !== undefined && value !== '' && value !== 'true' && value !== 'false'
  );
}

/**
 * Portée par commerce (`EXPIRY_ALERTS_ORGANIZATIONS`), explicite : `all` =
 * tous les commerces (activation GLOBALE) ; liste d'identifiants = commerces
 * pilotes seuls ;
 * absente, vide ou invalide = AUCUN commerce. Voir
 * `common/organization-scope.ts`.
 */
export const EXPIRY_ALERTS_ORGANIZATIONS_FLAG = 'EXPIRY_ALERTS_ORGANIZATIONS';

export function expiryAlertsScope(
  env: NodeJS.ProcessEnv = process.env,
): OrganizationScope {
  return parseOrganizationScope(env[EXPIRY_ALERTS_ORGANIZATIONS_FLAG]);
}

/** Activée pour CE commerce (drapeau global ET commerce dans la portée). */
export function expiryAlertsEnabledFor(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    expiryAlertsEnabled(env) &&
    inOrganizationScope(expiryAlertsScope(env), organizationId)
  );
}
