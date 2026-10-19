import {
  OrganizationScope,
  inOrganizationScope,
  parseOrganizationScope,
} from '../../common/organization-scope';
/**
 * Suivi des produits par lots — drapeau d'activation (lot A).
 *
 * - `PRODUCT_BATCHES_ENABLED` absent, vide ou `false` : DÉSACTIVÉ (défaut,
 *   production). Les routes des lots répondent 403
 *   `PRODUCT_BATCHES_DISABLED` et le contexte annonce la fonctionnalité
 *   indisponible au web.
 * - `PRODUCT_BATCHES_ENABLED=true` : activé (recette isolée uniquement tant
 *   que les ventes par lots — lot B — n'existent pas).
 * - Toute autre valeur : désactivé ET signalé (jamais une activation
 *   implicite).
 *
 * Lu à chaque requête (aucun état figé) : un redémarrage n'est pas requis
 * pour les tests. Les PROTECTIONS (refus des ventes et ajustements d'un
 * produit suivi par lots) ne dépendent JAMAIS de ce drapeau : elles suivent
 * les données du produit.
 */
export const PRODUCT_BATCHES_FLAG = 'PRODUCT_BATCHES_ENABLED';

export function productBatchesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PRODUCT_BATCHES_FLAG] === 'true';
}

/** Valeur non reconnue (ni absente, ni `true`, ni `false`). */
export function productBatchesFlagInvalid(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[PRODUCT_BATCHES_FLAG];
  return (
    value !== undefined && value !== '' && value !== 'true' && value !== 'false'
  );
}

/**
 * Portée par commerce (`PRODUCT_BATCHES_ORGANIZATIONS`), explicite : `all` =
 * tous les commerces (activation GLOBALE) ; liste d'identifiants = commerces
 * pilotes seuls ;
 * absente, vide ou invalide = AUCUN commerce. Voir
 * `common/organization-scope.ts`.
 */
export const PRODUCT_BATCHES_ORGANIZATIONS_FLAG =
  'PRODUCT_BATCHES_ORGANIZATIONS';

export function productBatchesScope(
  env: NodeJS.ProcessEnv = process.env,
): OrganizationScope {
  return parseOrganizationScope(env[PRODUCT_BATCHES_ORGANIZATIONS_FLAG]);
}

/** Activée pour CE commerce (drapeau global ET commerce dans la portée). */
export function productBatchesEnabledFor(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    productBatchesEnabled(env) &&
    inOrganizationScope(productBatchesScope(env), organizationId)
  );
}
